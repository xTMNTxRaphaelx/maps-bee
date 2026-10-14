'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { lonLatToTile, quadkey, subtreeRange } = require('../scripts/tiles')
const { GAZ_ZOOM, haversineKm, gazKeys, putGazetteer } = require('../scripts/gazetteer-lib')
const { collect } = require('../scripts/gazetteer')
const { readLabel } = require('../scripts/preview')
const { tmpStore, spyPuts, inlinedValues, JAIPUR_ARCHIVE, JAIPUR_BBOX, JAIPUR_CENTRE } = require('./helpers')
const { cities } = require('./atlas')

const GAZ = path.join(__dirname, '..', 'data', 'gazetteer.json')

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
  t.ok(some.entries.length > 0)
  t.ok(some.entries.every((e) => e.kind_detail === 'city' || e.kind_detail === 'town'), 'only city and town')
  t.ok(some.entries.length < all.entries.length, 'fewer than every locality')
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
