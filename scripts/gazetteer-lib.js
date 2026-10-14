'use strict'
const b4a = require('b4a')
const { lonLatToTile, quadkey } = require('./tiles')

const GAZ_ZOOM = 10

function haversineKm (a, b) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// g/10/<quadkey of the point at z10>/<n>; n separates places that share a z10 tile.
// The value holds only what readLabel reads.
function gazKeys (entries) {
  const counters = new Map()
  return entries.map((e) => {
    const { x, y } = lonLatToTile(e.lon, e.lat, GAZ_ZOOM)
    const base = 'g/' + String(GAZ_ZOOM).padStart(2, '0') + '/' + quadkey(x, y, GAZ_ZOOM)
    const n = counters.get(base) || 0
    counters.set(base, n + 1)
    const value = { name: e.name, kind_detail: e.kind_detail, lat: e.lat, lon: e.lon }
    return { key: b4a.from(base + '/' + n), value: b4a.from(JSON.stringify(value)) }
  })
}

// puts the entries' g/ keys in key order, flushPuts per write batch; returns the number of puts
async function putGazetteer (bee, entries, { flushPuts = 20000 } = {}) {
  const kv = gazKeys(entries).sort((a, b) => b4a.compare(a.key, b.key))
  for (let i = 0; i < kv.length; i += flushPuts) {
    const w = bee.write()
    for (const { key, value } of kv.slice(i, i + flushPuts)) w.tryPut(key, value)
    await w.flush()
  }
  return kv.length
}

module.exports = { GAZ_ZOOM, haversineKm, gazKeys, putGazetteer }
