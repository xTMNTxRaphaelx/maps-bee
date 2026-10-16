'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { lonLatToTile, quadkey, subtreeRange } = require('../scripts/tiles')
const { GAZ_ZOOM, haversineKm, gazKeys, putGazetteer } = require('../scripts/gazetteer-lib')
const { collect, collectFrom } = require('../scripts/gazetteer')
const { openArchive } = require('../scripts/pmtiles-file')
const { readLabel } = require('../scripts/preview')
const { tmpStore, spyPuts, inlinedValues, JAIPUR_ARCHIVE, JAIPUR_BBOX, JAIPUR_CENTRE, STATE_ARCHIVE, ATLANTIC_ARCHIVE, ATLANTIC_BBOX, GAZETTEER_JSON: GAZ } = require('./helpers')
const { cities } = require('./atlas')


async function buildBee (t, name, kv) {
  const store = await tmpStore(t, name)
  const core = store.get({ name })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  const w = bee.write()
  for (const { key, value } of kv) w.tryPut(key, value)
  await w.flush()
  t.teardown(() => bee.close())
  return bee
}

test('city+town gazetteer: nearest entry to the Jaipur centre is Jaipur', async (t) => {
  const entries = JSON.parse(fs.readFileSync(GAZ, 'utf8'))

  // size of the full locality set, for comparison only
  const all = await buildBee(t, 'gaz', gazKeys(entries))
  t.comment(`gazetteer entries ${entries.length} core.length ${all.core.length} core.byteLength ${all.core.byteLength}`)

  const cities = entries.filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
  const bee = await buildBee(t, 'gaz-city', gazKeys(cities))
  t.comment(`city+town only entries ${cities.length} core.length ${bee.core.length} core.byteLength ${bee.core.byteLength}`)
  t.is(cities.length, 825)

  // one z8 cell of z10-keyed places, the lookup a client would make
  const { x, y } = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 8)
  const range = subtreeRange(GAZ_ZOOM, quadkey(x, y, 8), 'g/')
  const found = []
  for await (const e of bee.createReadStream(range)) found.push(JSON.parse(b4a.toString(e.value)))
  const scored = found.map((p) => ({ ...p, km: haversineKm(JAIPUR_CENTRE, p) })).sort((a, b) => a.km - b.km)
  t.comment(`city+town range ${b4a.toString(range.gte)}..${b4a.toString(range.lt)} returned ${found.length} entries; nearest 3 ${JSON.stringify(scored.slice(0, 3).map((p) => [p.name, p.kind_detail, p.km.toFixed(2)]))}`)
  t.is(scored[0].name, 'Jaipur')
  t.ok(scored[0].km < 3)
  t.comment(`nearest ${scored[0].name} (${scored[0].kind_detail}) ${scored[0].km.toFixed(2)} km; next nearest ${scored[1].name} (${scored[1].kind_detail}) ${scored[1].km.toFixed(2)} km`)

  // full scan, no range: shows what a single z8 cell misses near its edge
  const full = cities.map((p) => ({ ...p, km: haversineKm(JAIPUR_CENTRE, p) })).sort((a, b) => a.km - b.km)
  t.is(full[0].name, 'Jaipur')
  t.comment(`full scan of city+town: nearest ${full[0].name} ${full[0].km.toFixed(2)} km; next nearest ${full[1].name} (${full[1].kind_detail}) ${full[1].km.toFixed(2)} km (inside the z8 range: ${found.some((p) => p.name === full[1].name)})`)
})

test('collect keeps only the requested kinds', async (t) => {
  const all = { regionFeatures: 0, entries: [] }
  const some = { regionFeatures: 0, entries: [] }
  await collect(JAIPUR_ARCHIVE, JAIPUR_BBOX, 11, 14, new Map(), all)
  await collect(JAIPUR_ARCHIVE, JAIPUR_BBOX, 11, 14, new Map(), some, new Set(['city', 'town']))
  t.comment(`localities ${all.entries.length}, city+town ${some.entries.length}`)
  // this archive on its own; results/gazetteer.txt shows 74 for the same archive because the
  // Rajasthan pass ran first there and its entries had already claimed the shared names
  t.is(all.entries.length, 98)
  t.is(some.entries.length, 1)
  t.ok(some.entries.every((e) => e.kind_detail === 'city' || e.kind_detail === 'town'), 'only city and town')
  t.ok(some.entries.length < all.entries.length, 'fewer than every locality')
})

// The ocean extract is the only fixture with run-length entries, and the planet is full of them:
// 7.7M runs covering 236.6M tiles at z14. A run is one blob repeated over consecutive tile ids, so
// the pass probes each distinct blob once and skips the whole run when it holds nothing to harvest.
// 102 read + 448 skipped is the archive's whole 550 addressed tiles (test/planet-build.js), so the
// skip drops tiles and never entries: the 114 localities are what a tile-by-tile walk finds too.
test('collect probes each distinct run blob once and skips the filler', async (t) => {
  const counts = { regionFeatures: 0, entries: [] }
  const stats = await collect(ATLANTIC_ARCHIVE, ATLANTIC_BBOX, 10, 10, new Map(), counts)
  t.comment(`entries ${stats.entries} tiles read ${stats.tiles} fillerRuns ${stats.fillerRuns} fillerTiles ${stats.fillerTiles} runBlobs ${stats.runBlobs}`)
  t.is(stats.fillerRuns, 137, '137 runs')
  t.is(stats.runBlobs, 3, 'three distinct blobs behind them, so three probe reads')
  t.is(stats.fillerTiles, 448)
  t.is(stats.tiles, 102)
  t.is(stats.tiles + stats.fillerTiles, 550, 'every addressed tile is read or skipped, none lost')
  t.is(counts.entries.length, 114)

  // --areas takes a different predicate into the probe, so it decides the same runs separately
  const areas = { regionFeatures: 0, entries: [] }
  const areaStats = await collect(ATLANTIC_ARCHIVE, ATLANTIC_BBOX, 10, 10, new Map(), areas, null, true)
  t.is(areaStats.fillerRuns, 137)
  t.is(areas.entries.length, 68)
})

// An inverted bbox selects no tiles, which looks exactly like an archive that holds none
test('collect refuses an inverted bbox', async (t) => {
  const counts = { regionFeatures: 0, entries: [] }
  await t.exception.all(collect(JAIPUR_ARCHIVE, [75.95, 26.75, 75.65, 27.05], 11, 14, new Map(), counts), /bbox is inverted/)
})

// The pass is driven by the archive's tile entries, not by the bbox. This bbox spans the world,
// so the rectangle it used to walk is 1,048,576 tiles at z10 against the 624 the archive holds —
// the shape of the planet area pass, where that rectangle is 67.1M tiles. Reads must stay with the
// entries: a rectangle walk asks for every tile of the world separately.
test('a world bbox costs the archive, not the rectangle', async (t) => {
  const archive = openArchive(STATE_ARCHIVE)
  t.teardown(() => archive.close())
  const header = await archive.getHeader()
  const getBytes = archive.source.getBytes.bind(archive.source)
  let reads = 0
  archive.source.getBytes = (offset, length) => {
    reads++
    return getBytes(offset, length)
  }
  const counts = { regionFeatures: 0, entries: [] }
  await collectFrom(archive, header, [-180, -85.05, 180, 85.05], 10, 10, new Map(), counts)
  t.comment(`world bbox at z10: ${counts.entries.length} localities in ${reads} reads`)
  t.is(counts.entries.length, 27533)
  t.ok(reads < 20, `reads with the entries, not the rectangle (${reads})`)
})

test('putGazetteer writes sorted g/ keys and readLabel finds Jaipur', async (t) => {
  const store = await tmpStore(t, 'gaz-put')
  const bee = new Hyperbee(store, { core: store.get({ name: 'gaz-put' }), writable: true })
  await bee.ready()
  const puts = spyPuts(bee)
  const n = await putGazetteer(bee, cities(), { flushPuts: 200 })
  t.is(n, 825)
  let ascending = 0
  for (let i = 1; i < puts.length; i++) if (b4a.compare(puts[i - 1], puts[i]) < 0) ascending++
  t.is(ascending, puts.length - 1, 'put in key order')
  const keys = []
  for await (const e of bee.createReadStream()) keys.push(b4a.toString(e.key))
  t.is(keys.length, 825)
  t.ok(keys.every((k) => k.startsWith('g/')), 'every key under g/')
  const label = await readLabel(bee, JAIPUR_CENTRE, { timeout: 5000 })
  t.is(label.name, 'Jaipur')
})

test('putGazetteer passes inlineValueSize to every write batch', async (t) => {
  const store = await tmpStore(t, 'gaz-inline')
  const out = new Hyperbee(store, { core: store.get({ name: 'gaz-noinline' }), writable: true })
  const inl = new Hyperbee(store, { core: store.get({ name: 'gaz-inline' }), writable: true })
  await out.ready()
  await inl.ready()
  await putGazetteer(out, cities(), { flushPuts: 200, inlineValueSize: 0 })
  await putGazetteer(inl, cities(), { flushPuts: 200 })
  t.is(await inlinedValues(out.core), 0, 'no inlined value with inlineValueSize 0')
  t.ok((await inlinedValues(inl.core)) > 0, 'the default inlines values')
  const label = await readLabel(out, JAIPUR_CENTRE, { timeout: 5000 })
  t.is(label.name, 'Jaipur')
})
