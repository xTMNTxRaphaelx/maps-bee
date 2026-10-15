'use strict'
const b4a = require('b4a')
const { lonLatToTile, quadkey } = require('./tiles')

const GAZ_ZOOM = 10

// Areas are keyed deeper than cities and queried over a much smaller window. A city label can be
// 50 km away in open country, so readLabel sweeps 9 z8 cells — 286 km across at Berlin. The area
// thresholds top out at SUBURB_M, 3 km, and a 3x3 of AREA_QUERY_ZOOM is about 18 km there: still
// six times the reach needed, but 1/256th of the area, so the read stays flat as label density
// rises. Mixing areas into the z8 sweep would make every preview in a dense city read every
// neighbourhood for 300 km around.
const AREA_ZOOM = 14
const AREA_QUERY_ZOOM = 12

// the three classes deriveAddress looks for, each as one kind_detail
function areaClass (p) {
  if (!p.name) return null
  if (p.kind === 'neighbourhood' && p.kind_detail === 'neighbourhood') return 'neighbourhood'
  if ((p.kind === 'neighbourhood' && p.kind_detail === 'suburb') || p.kind === 'macrohood') return 'suburb'
  if (p.kind === 'locality' && p.kind_detail === 'village') return 'village'
  return null
}

function haversineKm (a, b) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// <prefix>/<zz>/<quadkey of the point at that zoom>/<n>; n separates places sharing a tile.
// The value holds only what the client reads back.
function pointKeys (entries, prefix, zoom) {
  const counters = new Map()
  return entries.map((e) => {
    const { x, y } = lonLatToTile(e.lon, e.lat, zoom)
    const base = prefix + '/' + String(zoom).padStart(2, '0') + '/' + quadkey(x, y, zoom)
    const n = counters.get(base) || 0
    counters.set(base, n + 1)
    const value = { name: e.name, kind_detail: e.kind_detail, lat: e.lat, lon: e.lon }
    return { key: b4a.from(base + '/' + n), value: b4a.from(JSON.stringify(value)) }
  })
}

// g/10/... the nearest city or town, swept wide by readLabel
function gazKeys (entries) {
  return pointKeys(entries, 'g', GAZ_ZOOM)
}

// a/14/... the area labels, read over the tight window above. A separate prefix because the two
// are queried at different zooms over different radii, so they must not share a key range.
function areaKeys (entries) {
  return pointKeys(entries, 'a', AREA_ZOOM)
}

// inlineValueSize goes to every write batch (hyperbee2/lib/write.js:22).
async function putGazetteer (bee, entries, { flushPuts = 20000, inlineValueSize, keys = gazKeys } = {}) {
  const kv = keys(entries).sort((a, b) => b4a.compare(a.key, b.key))
  for (let i = 0; i < kv.length; i += flushPuts) {
    const w = bee.write({ inlineValueSize })
    for (const { key, value } of kv.slice(i, i + flushPuts)) w.tryPut(key, value)
    await w.flush()
  }
  return kv.length
}

module.exports = { GAZ_ZOOM, AREA_ZOOM, AREA_QUERY_ZOOM, areaClass, haversineKm, pointKeys, gazKeys, areaKeys, putGazetteer }
