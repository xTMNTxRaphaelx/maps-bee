'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { buildBee } = require('../scripts/bee-build')
const { gazKeys, haversineKm } = require('../scripts/gazetteer-lib')
const { lonLatToTile } = require('../scripts/tiles')
const { decodeGzip } = require('../scripts/mvt')
const { readPreview, DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM } = require('../scripts/preview')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const GAZ = path.join(__dirname, '..', 'data', 'gazetteer.json')
const POINTS = {
  jaipur: JAIPUR_CENTRE, // inside the z14 box
  jodhpur: { lon: 73.02, lat: 26.29 }, // state coverage only: z10 fallback
  edge: { lon: 73.13, lat: 26.29 }, // the nearest city sits in the neighbouring z8 cell
  mumbai: { lon: 72.88, lat: 19.08 } // outside the atlas
}

function cities () {
  return JSON.parse(fs.readFileSync(GAZ, 'utf8')).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
}

function nearestByScan (places, pt) {
  return places.map((p) => ({ ...p, km: haversineKm(pt, p) })).sort((a, b) => a.km - b.km)[0]
}

// tiles and the city+town gazetteer in one bee, as the signed planet bee would hold them
async function atlas (t, store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await buildBee(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE], () => {})
  const w = bee.write()
  for (const { key, value } of gazKeys(cities())) w.tryPut(key, value)
  await w.flush()
  t.teardown(() => bee.close())
  return bee
}

function assertCell (t, p, zoom, point) {
  t.is(p.zoom, zoom)
  t.alike(p.cell, lonLatToTile(point.lon, point.lat, zoom - 2))
  t.is(p.tiles.length, 16)
  t.is(p.tiles.filter((v) => v && Object.keys(decodeGzip(v).layers).length > 0).length, 16, 'all 16 tiles decode as MVT')
}

function assertLabel (t, p, places, point) {
  const truth = nearestByScan(places, point)
  t.is(p.label.name, truth.name)
  t.is(p.label.kind, truth.kind_detail)
  t.ok(Math.abs(p.label.km - truth.km) < 1e-9, 'distance matches a full scan')
  t.comment(`label ${p.label.name} (${p.label.kind}) ${p.label.km.toFixed(2)} km`)
}

test('readPreview: z14 cell, z10 fallback, neighbour-cell label, outside the atlas', async (t) => {
  const bee = await atlas(t, await tmpStore(t, 'preview'))
  const places = cities()
  t.comment(`atlas core.length ${bee.core.length}`)

  const jaipur = await readPreview(bee, POINTS.jaipur.lat, POINTS.jaipur.lon)
  assertCell(t, jaipur, DETAIL_ZOOM, POINTS.jaipur)
  assertLabel(t, jaipur, places, POINTS.jaipur)

  const jodhpur = await readPreview(bee, POINTS.jodhpur.lat, POINTS.jodhpur.lon)
  assertCell(t, jodhpur, FALLBACK_ZOOM, POINTS.jodhpur)
  assertLabel(t, jodhpur, places, POINTS.jodhpur)

  const edge = await readPreview(bee, POINTS.edge.lat, POINTS.edge.lon)
  const truth = nearestByScan(places, POINTS.edge)
  t.unlike(lonLatToTile(truth.lon, truth.lat, LABEL_ZOOM), lonLatToTile(POINTS.edge.lon, POINTS.edge.lat, LABEL_ZOOM), 'nearest place is in another z8 cell')
  assertLabel(t, edge, places, POINTS.edge)

  const mumbai = await readPreview(bee, POINTS.mumbai.lat, POINTS.mumbai.lon)
  t.is(mumbai.zoom, null)
  t.is(mumbai.tiles, null)
  t.is(mumbai.label, null)
})

async function coldClient (t, seederStore, key, delayMs) {
  const client = await tmpStore(t, 'preview-client')
  const wire = h.link(seederStore, client, delayMs)
  t.teardown(() => wire.destroy())
  const core = await h.openClientCore(client, { key })
  const upd = await h.measure(core, wire, () => core.update({ wait: true }))
  const bee = new Hyperbee(client, { core, writable: false })
  await bee.ready()
  return { core, bee, wire, upd }
}

test('readPreview over a piped link: one call per message, then served locally', async (t) => {
  const seederStore = await tmpStore(t, 'preview-seed')
  const seed = await atlas(t, seederStore)
  const L = seed.core.length
  for (const delayMs of [0, 50]) {
    const tag = `preview-rtt${2 * delayMs}`
    const { core, bee, wire, upd } = await coldClient(t, seederStore, seed.core.key, delayMs)
    t.comment(h.fmt(tag, 'update', upd, L))

    const cold = await h.measure(core, wire, () => readPreview(bee, POINTS.jaipur.lat, POINTS.jaipur.lon))
    t.is(cold.result.zoom, DETAIL_ZOOM)
    t.is(cold.result.label.name, 'Jaipur')
    t.ok(cold.blocks < L, 'sparse: fewer blocks than the core')
    t.comment(h.fmt(tag + '-jaipur', 'read-cold', cold, L))

    const again = await h.measure(core, wire, () => readPreview(bee, POINTS.jaipur.lat, POINTS.jaipur.lon))
    t.is(again.blocks, 0, 'repeat preview is served locally')
    t.comment(h.fmt(tag + '-jaipur', 'read-local', again, L))

    const fb = await h.measure(core, wire, () => readPreview(bee, POINTS.jodhpur.lat, POINTS.jodhpur.lon))
    t.is(fb.result.zoom, FALLBACK_ZOOM)
    t.is(fb.result.label.name, 'Jodhpur')
    t.comment(h.fmt(tag + '-jodhpur-fallback', 'read-cold', fb, L))
  }
})

test('readPreview with no peer rejects after the timeout', async (t) => {
  const seederStore = await tmpStore(t, 'preview-seed')
  const seed = await atlas(t, seederStore)
  const { bee, wire } = await coldClient(t, seederStore, seed.core.key, 0)
  wire.destroy()
  await t.exception(readPreview(bee, POINTS.jaipur.lat, POINTS.jaipur.lon, { timeout: 200 }), /timed out/i)
})
