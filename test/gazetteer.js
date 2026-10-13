'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { lonLatToTile, quadkey, subtreeRange } = require('../scripts/tiles')
const { GAZ_ZOOM, haversineKm, gazKeys } = require('../scripts/gazetteer-lib')
const { tmpStore, JAIPUR_CENTRE } = require('./helpers')

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
