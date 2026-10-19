'use strict'
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const { haversineKm } = require('../../lib/gazetteer-lib')
const { lonLatToTile, pinTiles } = require('../../lib/tiles')
const { decodeGzip } = require('../../lib/mvt')
const { openArchive, readTile } = require('../../lib/build/pmtiles-file')
const { readPreview, FALLBACK_ZOOM, LABEL_ZOOM } = require('../../lib/preview')

// This atlas is built from the z11-14 extract alone, so the ZOOMS walk skips z15 and serves z14.
// Named here rather than taken from DETAIL_ZOOM: the zoom this fixture can answer at is a property
// of the fixture, not of whichever zoom the client happens to prefer.
const ATLAS_ZOOM = 14
const { tmpStore, JAIPUR_ARCHIVE, JAIPUR_CENTRE } = require('../helpers/helpers')
const { cities, fillAtlas } = require('../helpers/atlas')
const h = require('../helpers/sparse-harness')

const OPTS = { timeout: 5000 }
const POINTS = {
  jaipur: JAIPUR_CENTRE, // inside the z14 box
  partial: { lon: 75.64, lat: 27.04 }, // its 2x2 straddles the west edge of the z14 box: x 11634 in, 11633 out
  jodhpur: { lon: 73.02, lat: 26.29 }, // state coverage only: z10 fallback
  edge: { lon: 73.13, lat: 26.29 }, // the nearest city sits in the neighbouring z8 cell
  mumbai: { lon: 72.88, lat: 19.08 } // outside the atlas
}

function nearestByScan (places, pt) {
  return places.map((p) => ({ ...p, km: haversineKm(pt, p) })).sort((a, b) => a.km - b.km)[0]
}

// the store from tmpStore owns the core and closes it; bee.close would close the store a second time
async function atlas (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee)
  return bee
}

// which of the 4 tiles of the point's 2x2 the extract holds, in pinTiles order
async function presentInArchive (point) {
  const archive = openArchive(JAIPUR_ARCHIVE)
  const present = []
  for (const [x, y] of pinTiles(point.lon, point.lat, ATLAS_ZOOM).tiles) present.push(Boolean(await readTile(archive, ATLAS_ZOOM, x, y)))
  await archive.close()
  return present
}

function assertCell (t, p, zoom, point) {
  t.is(p.zoom, zoom)
  t.alike(p.origin, pinTiles(point.lon, point.lat, zoom).origin)
  t.is(p.tiles.length, 4)
  t.is(p.tiles.filter((v) => v && Object.keys(decodeGzip(v).layers).length > 0).length, 4, 'all 4 tiles decode as MVT')
}

function assertLabel (t, p, places, point) {
  const truth = nearestByScan(places, point)
  t.is(p.label.name, truth.name)
  t.is(p.label.kind, truth.kind_detail)
  t.ok(Math.abs(p.label.km - truth.km) < 1e-9, 'distance matches a full scan')
  t.comment(`label ${p.label.name} (${p.label.kind}) ${p.label.km.toFixed(2)} km`)
}

test('readPreview: z14 cell, partial cell, z10 fallback, neighbour-cell label, outside the atlas', async (t) => {
  const bee = await atlas(await tmpStore(t, 'preview'))
  const places = cities()
  t.comment(`atlas core.length ${bee.core.length}`)

  const jaipur = await readPreview(bee, POINTS.jaipur, OPTS)
  assertCell(t, jaipur, ATLAS_ZOOM, POINTS.jaipur)
  assertLabel(t, jaipur, places, POINTS.jaipur)
  t.is(jaipur.address.housenumber, null)
  t.is(jaipur.address.road.name, 'Elevated Hawa Sadak')
  t.ok(Math.abs(jaipur.address.road.metres - 112) < 1, `road ${jaipur.address.road.metres} m`)
  t.is(jaipur.address.neighbourhood.name, 'Kachi Basti')
  t.is(jaipur.address.suburb.name, 'Sudarshanpura')
  t.is(jaipur.address.city.name, 'Jaipur')
  t.is(jaipur.address.near, null)
  t.is(jaipur.address.display, 'Kachi Basti, Sudarshanpura, Jaipur')

  const partial = await readPreview(bee, POINTS.partial, OPTS)
  const expected = await presentInArchive(POINTS.partial)
  const n = expected.filter(Boolean).length
  t.ok(n > 0 && n < 4, `the extract holds ${n} of the 4 tiles of this 2x2`)
  t.is(partial.zoom, ATLAS_ZOOM, 'a partly published 2x2 stays at its zoom, no fallback')
  t.alike(partial.tiles.map(Boolean), expected, 'missing tiles are null, present ones in place')
  t.is(partial.tiles.filter((v) => v && Object.keys(decodeGzip(v).layers).length > 0).length, n, 'present tiles decode as MVT')

  const jodhpur = await readPreview(bee, POINTS.jodhpur, OPTS)
  assertCell(t, jodhpur, FALLBACK_ZOOM, POINTS.jodhpur)
  assertLabel(t, jodhpur, places, POINTS.jodhpur)
  t.is(jodhpur.address.road, null, 'z10 roads carry no names')
  t.is(jodhpur.address.neighbourhood, null)
  t.is(jodhpur.address.suburb, null)
  t.is(jodhpur.address.display, 'Jodhpur')

  const edge = await readPreview(bee, POINTS.edge, OPTS)
  const truth = nearestByScan(places, POINTS.edge)
  t.unlike(lonLatToTile(truth.lon, truth.lat, LABEL_ZOOM), lonLatToTile(POINTS.edge.lon, POINTS.edge.lat, LABEL_ZOOM), 'nearest place is in another z8 cell')
  assertLabel(t, edge, places, POINTS.edge)

  const mumbai = await readPreview(bee, POINTS.mumbai, OPTS)
  t.is(mumbai.zoom, null)
  t.is(mumbai.origin, null)
  t.is(mumbai.tiles, null)
  t.is(mumbai.label, null)
  t.is(mumbai.address, null)
})

test('readPreview rejects bad opts and bad points before any read', async (t) => {
  const bee = await atlas(await tmpStore(t, 'preview-args'))
  await t.exception.all(readPreview(bee, POINTS.jaipur), /opts\.timeout/)
  await t.exception.all(readPreview(bee, POINTS.jaipur, { timeout: 0 }), /opts\.timeout/)
  await t.exception.all(readPreview(bee, POINTS.jaipur, { timeout: 5000, deadline: -1 }), /opts\.deadline/)
  await t.exception.all(readPreview(bee, { lat: 26.9, lon: NaN }, OPTS), /out of range/)
  await t.exception.all(readPreview(bee, { lat: 91, lon: 75.8 }, OPTS), /out of range/)
})

test('readPreview over a piped link: one call per message, then served locally', async (t) => {
  const seederStore = await tmpStore(t, 'preview-seed')
  const seed = await atlas(seederStore)
  const L = seed.core.length
  for (const delayMs of [0, 50]) {
    const tag = `preview-rtt${2 * delayMs}`
    const { core, bee, wire, upd } = await h.coldClient(t, seederStore, seed.core.key, delayMs)
    t.comment(h.fmt(tag, 'update', upd, L))

    const cold = await h.measure(core, wire, () => readPreview(bee, POINTS.jaipur, OPTS))
    t.is(cold.result.zoom, ATLAS_ZOOM)
    t.is(cold.result.label.name, 'Jaipur')
    t.ok(cold.blocks < L, 'sparse: fewer blocks than the core')
    t.comment(h.fmt(tag + '-jaipur', 'read-cold', cold, L))

    const again = await h.measure(core, wire, () => readPreview(bee, POINTS.jaipur, OPTS))
    t.is(again.blocks, 0, 'repeat preview is served locally')
    t.comment(h.fmt(tag + '-jaipur', 'read-local', again, L))

    const fb = await h.measure(core, wire, () => readPreview(bee, POINTS.jodhpur, OPTS))
    t.is(fb.result.zoom, FALLBACK_ZOOM)
    t.is(fb.result.label.name, 'Jodhpur')
    t.comment(h.fmt(tag + '-jodhpur-fallback', 'read-cold', fb, L))
  }
})

test('readPreview with no peer rejects after the per-block timeout', async (t) => {
  const seederStore = await tmpStore(t, 'preview-seed')
  const seed = await atlas(seederStore)
  const { bee, wire } = await h.coldClient(t, seederStore, seed.core.key, 0)
  wire.destroy()
  await t.exception(readPreview(bee, POINTS.jaipur, { timeout: 200 }), /timed out/i)
})

test('readPreview deadline: rejects early and sends no further requests', async (t) => {
  const seederStore = await tmpStore(t, 'preview-seed')
  const seed = await atlas(seederStore)
  const { core, bee, wire } = await h.coldClient(t, seederStore, seed.core.key, 50)
  const t0 = h.perf.now()
  let err = null
  try {
    await readPreview(bee, POINTS.jaipur, { timeout: 5000, deadline: 150 })
  } catch (e) {
    err = e
  }
  const ms = h.perf.now() - t0
  t.is(err && err.code, 'REQUEST_TIMEOUT')
  t.ok(ms < 350, `rejected after ${ms.toFixed(0)} ms, well before the cold read completes at RTT 100`)
  // replies already in flight still land; the check is that nothing new is asked for
  const after = await h.measure(core, wire, () => new Promise((resolve) => setTimeout(resolve, 400)))
  t.is(after.wireRequestTx, 0, 'no requests sent after the rejection')
  t.comment(`deadline: rejected at ${ms.toFixed(0)} ms; ${after.blocks} in-flight blocks landed afterwards, ${after.wireRequestTx} new requests`)
})
