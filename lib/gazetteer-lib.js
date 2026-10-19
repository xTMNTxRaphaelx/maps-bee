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

// <prefix>/<zz>/<quadkey of the point at that zoom>/<name>|<kind>|<lat>,<lon>.
// The value holds only what the client reads back.
//
// The suffix identifies the place rather than its position in the input, which is what makes a
// republish cheap. A counter numbered entries in harvest order, so any change of order rewrote
// every value in the tile and warm clients re-fetched blocks whose content had not changed —
// against the republish property in README "Design". Keyed this way an unchanged place puts
// identical bytes, which hyperbee does not append, so only what actually moved costs anything.
//
// Readers never see this: subtreeRange bounds the quadkey prefix and scanPlaces parses the value,
// so the suffix is opaque to them and its shape is the writer's business alone. It mirrors the
// dedupe identity in collect() — name and kind — plus the coordinates, which collect() has
// already rounded to 1e-5, so it is deterministic and cannot collide for two distinct places.
function pointKeys (entries, prefix, zoom) {
  return entries.map((e) => {
    const { x, y } = lonLatToTile(e.lon, e.lat, zoom)
    const base = prefix + '/' + String(zoom).padStart(2, '0') + '/' + quadkey(x, y, zoom)
    const id = e.name + '|' + (e.kind_detail || '') + '|' + e.lat + ',' + e.lon
    const value = { name: e.name, kind_detail: e.kind_detail, lat: e.lat, lon: e.lon }
    return { key: b4a.from(base + '/' + id), value: b4a.from(JSON.stringify(value)) }
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

// A harvest records which pass wrote it, because the entries cannot be made to say: kind_detail
// 'village' comes out of both an --areas run and an unfiltered locality run, so no inspection of
// the data distinguishes them. Without the marker, gazetteer-put --areas was a claim nothing
// could check, and getting it wrong writes a/ content under g/ keys into a signed atlas.
//
// A bare array is a harvest from before the marker. Those are read, with areas unknown, rather
// than rejected: nothing about them is wrong, they are only unlabelled, and re-running a planet
// harvest to add a field costs hours. The caller decides what to do about not knowing.
function readGazetteer (parsed) {
  if (Array.isArray(parsed)) return { areas: null, kinds: null, entries: parsed }
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new TypeError('not a gazetteer file: expected an array of entries, or { entries: [...] }')
  }
  return { areas: parsed.areas === true, kinds: parsed.kinds || null, entries: parsed.entries }
}

// inlineValueSize goes to every write batch (hyperbee2/lib/write.js:22).
// Deletes the keys under this prefix that the new set no longer holds. Nothing else in the
// library deletes, and readers range-scan a quadkey prefix rather than asking for known keys, so
// without this a republish of a tile that lost a place keeps serving the one that went — there is
// no later pass that would ever notice. Only what actually went is deleted, so the unchanged keys
// still put identical bytes and still append nothing.
async function pruneGazetteer (bee, kv, flushPuts, inlineValueSize) {
  if (kv.length === 0) return 0
  // '/' is 0x2f and '0' is 0x30, so <prefix>0 is the first key past every <prefix>/... key
  const prefix = b4a.toString(kv[0].key).split('/')[0]
  const want = new Set(kv.map((e) => b4a.toString(e.key)))
  const stale = []
  for await (const e of bee.createReadStream({ gte: b4a.from(prefix + '/'), lt: b4a.from(prefix + '0') })) {
    if (!want.has(b4a.toString(e.key))) stale.push(e.key)
  }
  for (let i = 0; i < stale.length; i += flushPuts) {
    const w = bee.write({ inlineValueSize })
    for (const key of stale.slice(i, i + flushPuts)) w.tryDelete(key)
    await w.flush()
  }
  return stale.length
}

async function putGazetteer (bee, entries, { flushPuts = 20000, inlineValueSize, keys = gazKeys, prune = false } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('putGazetteer needs an array of gazetteer entries')
  const kv = keys(entries).sort((a, b) => b4a.compare(a.key, b.key))
  for (let i = 0; i < kv.length; i += flushPuts) {
    const w = bee.write({ inlineValueSize })
    for (const { key, value } of kv.slice(i, i + flushPuts)) w.tryPut(key, value)
    await w.flush()
  }
  // after the puts, never before: a prune that ran first and then failed to write would have
  // removed places without putting their replacements
  const pruned = prune ? await pruneGazetteer(bee, kv, flushPuts, inlineValueSize) : 0
  return { puts: kv.length, pruned }
}

module.exports = { GAZ_ZOOM, AREA_ZOOM, AREA_QUERY_ZOOM, areaClass, haversineKm, gazKeys, areaKeys, putGazetteer, readGazetteer }
