'use strict'
// .default because the package is ESM-only via its exports field; both bare and node hand back
// the module namespace rather than the class
const CheapRuler = require('cheap-ruler').default

// Thresholds from the 20 Jaipur points against Nominatim (README.md, Address): urban named-road
// candidates <= 223 m, the dropped ones 408, 604, 2454 m; Nominatim's roads <= 47 m, points it
// gives no road >= 61 m; neighbourhood hits <= 623 m, blanks >= 716 m; suburb hits <= 2495 m,
// first wrong at 3206 m. Villages (31 points, Jaipur and Lugano): right at 154, 263, 586 m, wrong from
// 815 m; hamlet labels (population 200) were wrong at every distance, so only kind_detail village counts.
// HOUSE_M and NEAR_M are unmeasured. The figures predate cheap-ruler, which reads 0.2-0.5% higher,
// so each is a metre or two larger now — well inside the gaps above, which is why they still hold.
const HOUSE_M = 30
const ROAD_M = 300
const ROAD_ON_M = 50
const NEAR_M = 150
const NEIGHBOURHOOD_M = 800
const SUBURB_M = 3000
const VILLAGE_M = 700

// the lon/lat of a tile-local point: the arithmetic of VectorTileFeature.toGeoJSON
// (@mapbox/vector-tile/index.js:158-170), called directly because toGeoJSON builds a whole Feature,
// properties clone included, to carry two numbers — and this runs per feature on the preview path
function project (f, tile, p) {
  const size = f.extent * Math.pow(2, tile.zoom)
  const x0 = f.extent * tile.x
  const y0 = f.extent * tile.y
  return [
    (p.x + x0) * 360 / size - 180,
    360 / Math.PI * Math.atan(Math.exp((1 - (p.y + y0) * 2 / size) * Math.PI)) - 90
  ]
}

// One ruler at the pin's latitude, where cheap-ruler's scale factors are the exact WGS84 degree
// lengths, so roads and places are measured on the same metric — they used to be on two that
// disagreed by about 0.5% at Lugano. Built once per call: it is the latitude that is fixed.
function origin (point) {
  return { p: [point.lon, point.lat], ruler: new CheapRuler(point.lat, 'meters') }
}

function lineMetres (o, f, tile) {
  let best = Infinity
  for (const line of f.loadGeometry()) {
    let b = line.length > 0 ? project(f, tile, line[0]) : null
    for (let j = 1; j < line.length; j++) {
      const a = b
      b = project(f, tile, line[j])
      best = Math.min(best, o.ruler.pointToSegmentDistance(o.p, a, b))
    }
  }
  return best
}

// Every type-1 feature in these layers is a single Point: the first point of the first ring.
// A feature with no geometry is out of range rather than an error, because a malformed tile from a
// peer must not throw out of readPreview on the viewer's device.
function pointMetres (o, f, tile) {
  const g = f.loadGeometry()
  if (g.length === 0 || g[0].length === 0) return Infinity
  return o.ruler.distance(o.p, project(f, tile, g[0][0]))
}

// One walk of `layer` returning the nearest feature per spec ({ keep, max }); the three places
// lookups below would otherwise walk it three times over. Distance is measured only when a
// predicate matches, once per feature. Strict < keeps the first of equal candidates, because tiles
// of two zooms carry the same feature.
function nearestEach (tiles, layer, type, specs, metres, o) {
  const best = specs.map(() => null)
  for (const tile of tiles) {
    const l = tile.vt.layers[layer]
    if (!l) continue
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i)
      if (f.type !== type) continue
      const p = f.properties
      let m = -1
      for (let s = 0; s < specs.length; s++) {
        if (!specs[s].keep(p)) continue
        if (m < 0) m = metres(o, f, tile)
        if (m <= specs[s].max && (!best[s] || m < best[s].metres)) best[s] = { f, metres: m }
      }
    }
  }
  return best
}

function nearest (tiles, layer, type, keep, metres, o, max) {
  return nearestEach(tiles, layer, type, [{ keep, max }], metres, o)[0]
}

// At most three parts, like a short map label: one specific feature only when it is close (the house
// number within HOUSE_M, followed by the road when that is within ROAD_ON_M; else the road alone within
// ROAD_ON_M; else a poi within NEAR_M), then the nearest area label after it, or the two nearest without
// it in small-to-large order (neighbourhood, then suburb or village), then the city. The nearest label is
// the best guess of the area that contains the pin: in Lugano the neighbourhood is 121 m away and the
// next municipality's village label 987 m. A road beyond ROAD_ON_M is not the pin's street, so it stays
// in the object and out of the display.
function display (a) {
  const road = a.road && a.road.metres <= ROAD_ON_M ? a.road.name : null
  const specific = a.housenumber
    ? (road ? `${a.housenumber.value} ${road}` : a.housenumber.value)
    : road || (a.near ? `near ${a.near.name}` : null)
  const areas = [[a.neighbourhood, 0], [a.suburb, 1], [a.village, 1]].filter(([p]) => p).sort(([p], [q]) => p.metres - q.metres)
  const chosen = specific ? areas.slice(0, 1) : areas.slice(0, 2).sort(([p, r], [q, s]) => r - s || p.metres - q.metres)
  const parts = [specific, ...chosen.map(([p]) => p.name)]
  if (a.city) parts.push(a.city.name)
  return parts.filter(Boolean).join(', ')
}

// tiles: decoded tiles placed on the globe, [{ vt, x, y, zoom }]; label: the gazetteer place or null
function deriveAddress ({ point, tiles, label }) {
  const o = origin(point)
  const hn = nearest(tiles, 'buildings', 1, (p) => p.kind === 'address' && Boolean(p.addr_housenumber), pointMetres, o, HOUSE_M)
  const road = nearest(tiles, 'roads', 2, (p) => Boolean(p.name), lineMetres, o, ROAD_M)
  const [nb, sub, vil] = nearestEach(tiles, 'places', 1, [
    { keep: (p) => Boolean(p.name) && p.kind === 'neighbourhood' && p.kind_detail === 'neighbourhood', max: NEIGHBOURHOOD_M },
    { keep: (p) => Boolean(p.name) && ((p.kind === 'neighbourhood' && p.kind_detail === 'suburb') || p.kind === 'macrohood'), max: SUBURB_M },
    { keep: (p) => Boolean(p.name) && p.kind === 'locality' && p.kind_detail === 'village', max: VILLAGE_M }
  ], pointMetres, o)
  const near = nearest(tiles, 'pois', 1, (p) => Boolean(p.name), pointMetres, o, NEAR_M)
  const a = {
    housenumber: hn && { value: hn.f.properties.addr_housenumber, metres: hn.metres },
    road: road && { name: road.f.properties.name, kind: road.f.properties.kind, metres: road.metres },
    neighbourhood: nb && { name: nb.f.properties.name, metres: nb.metres },
    suburb: sub && { name: sub.f.properties.name, metres: sub.metres },
    village: vil && { name: vil.f.properties.name, kind: vil.f.properties.kind_detail, metres: vil.metres },
    city: label,
    region: null,
    country: null,
    near: near && { name: near.f.properties.name, kind: near.f.properties.kind, metres: near.metres }
  }
  a.display = display(a)
  return a
}

module.exports = { HOUSE_M, ROAD_M, ROAD_ON_M, NEAR_M, NEIGHBOURHOOD_M, SUBURB_M, VILLAGE_M, deriveAddress }
