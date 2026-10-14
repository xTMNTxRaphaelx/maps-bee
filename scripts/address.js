'use strict'
const { haversineKm } = require('./gazetteer-lib')

// Thresholds from the 20 Jaipur points against Nominatim (README.md, Address): urban named-road
// candidates <= 223 m, the dropped ones 408, 604, 2454 m; Nominatim's roads <= 47 m, points it
// gives no road >= 61 m; neighbourhood hits <= 623 m, blanks >= 716 m; suburb hits <= 2495 m,
// first wrong at 3206 m. Villages (31 points, Jaipur and Lugano): right at 154, 263, 586 m, wrong from
// 815 m; hamlet labels (population 200) were wrong at every distance, so only kind_detail village counts.
// HOUSE_M and NEAR_M are unmeasured.
const HOUSE_M = 30
const ROAD_M = 300
const ROAD_ON_M = 50
const NEAR_M = 150
const NEIGHBOURHOOD_M = 800
const SUBURB_M = 3000
const VILLAGE_M = 700

// equirectangular at the point's latitude, exact enough under a few km
function segmentMetres (point, a, b) {
  const kx = 111320 * Math.cos(point.lat * Math.PI / 180)
  const ky = 110574
  const ax = (a[0] - point.lon) * kx
  const ay = (a[1] - point.lat) * ky
  const dx = (b[0] - point.lon) * kx - ax
  const dy = (b[1] - point.lat) * ky - ay
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2))
  const x = ax + t * dx
  const y = ay + t * dy
  return Math.sqrt(x * x + y * y)
}

function lineMetres (point, f, tile) {
  const g = f.toGeoJSON(tile.x, tile.y, tile.zoom).geometry
  const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates
  let best = Infinity
  for (const line of lines) {
    for (let j = 1; j < line.length; j++) best = Math.min(best, segmentMetres(point, line[j - 1], line[j]))
  }
  return best
}

// every type-1 feature in the places, pois and buildings layers of the extracts is a single Point
function pointMetres (point, f, tile) {
  const [lon, lat] = f.toGeoJSON(tile.x, tile.y, tile.zoom).geometry.coordinates
  return 1000 * haversineKm(point, { lon, lat })
}

// The nearest feature of `layer` across the placed tiles that passes `keep`, within `max` metres.
// Strict < keeps the first of equal candidates: tiles of two zooms carry the same feature.
function nearest (tiles, layer, type, keep, metres, point, max) {
  let best = null
  for (const tile of tiles) {
    const l = tile.vt.layers[layer]
    if (!l) continue
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i)
      if (f.type !== type || !keep(f.properties)) continue
      const m = metres(point, f, tile)
      if (m <= max && (!best || m < best.metres)) best = { f, metres: m }
    }
  }
  return best
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
  const hn = nearest(tiles, 'buildings', 1, (p) => p.kind === 'address', pointMetres, point, HOUSE_M)
  const road = nearest(tiles, 'roads', 2, (p) => Boolean(p.name), lineMetres, point, ROAD_M)
  const nb = nearest(tiles, 'places', 1, (p) => p.kind === 'neighbourhood' && p.kind_detail === 'neighbourhood', pointMetres, point, NEIGHBOURHOOD_M)
  const sub = nearest(tiles, 'places', 1, (p) => (p.kind === 'neighbourhood' && p.kind_detail === 'suburb') || p.kind === 'macrohood', pointMetres, point, SUBURB_M)
  const vil = nearest(tiles, 'places', 1, (p) => p.kind === 'locality' && p.kind_detail === 'village', pointMetres, point, VILLAGE_M)
  const near = nearest(tiles, 'pois', 1, (p) => Boolean(p.name), pointMetres, point, NEAR_M)
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
