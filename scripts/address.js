'use strict'
// .default because the package is ESM-only via exports; bare and node both hand back the namespace
const CheapRuler = require('cheap-ruler').default
const { project } = require('./mvt')

// Thresholds measured against Nominatim (README.md, Address). Named roads: ours <= 223 m, dropped
// at 408+; theirs <= 47 m, none >= 61 m. Neighbourhood hits <= 623 m, blanks >= 716 m; suburb hits
// <= 2495 m, first wrong at 3206 m. Hamlets are wrong at every distance, so only kind_detail
// village counts. HOUSE_M and NEAR_M are unmeasured. The figures predate cheap-ruler (0.2-0.5%
// higher), so each is a metre or two larger now — well inside the gaps above.
//
// VILLAGE_M is the exception: it separates nothing. Over 105 points in two cities the villages it
// picks right reach 691 m and the ones it picks wrong start at 138 m, so no threshold splits them.
// Nominatim names the municipality the point lies inside; this picks the nearest village point,
// which in Ticino is often the neighbouring one. Every one of the 23 misses is a village the a/
// gazetteer does hold and the threshold excludes, so raising it buys hits and wrong labels
// together — at 2000 m, right 24 -> 34 and wrong 5 -> 11 (results/village-gap.txt). Measured and
// declined: 700 stands, because the 10 extra hits cost 6 wrong labels plus 5 villages named on
// points Nominatim names none for, and the containment mismatch survives either number. Moving
// this needs village extent, not a wider radius.
const HOUSE_M = 30
const ROAD_M = 300
const ROAD_ON_M = 50
const NEAR_M = 150
const NEIGHBOURHOOD_M = 800
const SUBURB_M = 3000
const VILLAGE_M = 700

// One ruler at the pin's latitude, whose scale factors are the exact WGS84 degree lengths, so roads
// and places share a metric — they used to be on two that disagreed by 0.5% at Lugano.
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

// Every type-1 feature in these layers is a single Point: the first point of the first ring. One
// with no geometry is out of range, not an error — a malformed tile must not throw out of readPreview.
function pointMetres (o, f, tile) {
  const g = f.loadGeometry()
  if (g.length === 0 || g[0].length === 0) return Infinity
  return o.ruler.distance(o.p, project(f, tile, g[0][0]))
}

// One walk of `layer` returning the nearest feature per spec ({ keep, max }); the three places
// lookups below would otherwise walk it three times. Distance is measured only when a predicate
// matches, once per feature. Strict < keeps the first of equals: two zooms carry the same feature.
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

// The nearest a/ gazetteer entry of one class. Measured on the same ruler as everything else, and
// against the same threshold, so swapping the source cannot quietly change the metric. A label
// beyond the threshold is dropped rather than clamped, as with the tile path.
function nearestLabel (areas, o, cls, max) {
  let best = null
  for (const a of areas) {
    if (a.kind_detail !== cls) continue
    const m = o.ruler.distance(o.p, [a.lon, a.lat])
    if (m <= max && (!best || m < best.metres)) best = { name: a.name, metres: m }
  }
  return best
}

// At most three parts, like a short map label: one specific feature when it is close (house number
// within HOUSE_M plus the road if within ROAD_ON_M; else that road; else a poi within NEAR_M), then
// one area label, or two in small-to-large order when there is no specific part, then the city. The
// nearest label is the best guess of the containing area — in Lugano the neighbourhood is 121 m away
// against the next municipality's village at 987 m. A road beyond ROAD_ON_M is not the pin's street,
// so it stays in the object and out of the display.
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

// Area labels from the a/ gazetteer when the bee holds it, else from the places layer of the tiles.
// The gazetteer is a radius query, so SUBURB_M means 3 km rather than "whatever fell inside the
// fetched tiles"; the tile path stays for a bee without a/ keys, and for tests that drive this
// without one. Measured over 225 points in four cities: the gazetteer wins 20 hits, nearly all
// suburb (results/address-shapes.txt).
function areaParts (areas, tiles, o) {
  if (areas) {
    return [
      nearestLabel(areas, o, 'neighbourhood', NEIGHBOURHOOD_M),
      nearestLabel(areas, o, 'suburb', SUBURB_M),
      nearestLabel(areas, o, 'village', VILLAGE_M)
    ]
  }
  const [nb, sub, vil] = nearestEach(tiles, 'places', 1, [
    { keep: (p) => Boolean(p.name) && p.kind === 'neighbourhood' && p.kind_detail === 'neighbourhood', max: NEIGHBOURHOOD_M },
    { keep: (p) => Boolean(p.name) && ((p.kind === 'neighbourhood' && p.kind_detail === 'suburb') || p.kind === 'macrohood'), max: SUBURB_M },
    { keep: (p) => Boolean(p.name) && p.kind === 'locality' && p.kind_detail === 'village', max: VILLAGE_M }
  ], pointMetres, o)
  const of = (e, extra) => e && { name: e.f.properties.name, ...extra(e), metres: e.metres }
  return [
    of(nb, () => ({})),
    of(sub, () => ({})),
    of(vil, (e) => ({ kind: e.f.properties.kind_detail }))
  ]
}

// tiles: decoded tiles placed on the globe, [{ vt, x, y, zoom }]; label: the gazetteer place or
// null; areas: a/ gazetteer entries near the point, or null to read them from the tiles
function deriveAddress ({ point, tiles, label, areas = null }) {
  const o = origin(point)
  const hn = nearest(tiles, 'buildings', 1, (p) => p.kind === 'address' && Boolean(p.addr_housenumber), pointMetres, o, HOUSE_M)
  const road = nearest(tiles, 'roads', 2, (p) => Boolean(p.name), lineMetres, o, ROAD_M)
  const [nb, sub, vil] = areaParts(areas, tiles, o)
  const near = nearest(tiles, 'pois', 1, (p) => Boolean(p.name), pointMetres, o, NEAR_M)
  const a = {
    housenumber: hn && { value: hn.f.properties.addr_housenumber, metres: hn.metres },
    road: road && { name: road.f.properties.name, kind: road.f.properties.kind, metres: road.metres },
    neighbourhood: nb,
    suburb: sub,
    village: vil,
    city: label,
    region: null,
    country: null,
    near: near && { name: near.f.properties.name, kind: near.f.properties.kind, metres: near.metres }
  }
  a.display = display(a)
  return a
}

module.exports = { HOUSE_M, ROAD_ON_M, NEIGHBOURHOOD_M, SUBURB_M, VILLAGE_M, origin, nearestLabel, display, deriveAddress }
