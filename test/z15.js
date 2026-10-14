'use strict'
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const { lonLatToTile } = require('../scripts/tiles')
const { decodeGzip } = require('../scripts/mvt')
const { readPreview, readTiles, readLabel, DETAIL_ZOOM, FALLBACK_ZOOM } = require('../scripts/preview')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const h = require('./sparse-harness')

const OPTS = { timeout: 5000 }
const CENTRE = { lon: 75.8, lat: 26.9 }
const NORTH = { lon: 75.8, lat: 26.95 }
const EAST = { lon: 75.83, lat: 26.91 }
const NOADDR = { lon: 75.78, lat: 26.92 } // its z15 tile holds no address point
const PARTIAL = { lon: 75.64, lat: 27.04 } // west of the z15 box, which starts at 75.65
const JODHPUR = { lon: 73.02, lat: 26.29 }

// the store from tmpStore owns the core and closes it; bee.close would close the store a second time
async function atlas15 (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE])
  return bee
}

test('readPreview with z15: pin tile and address parts, no house number when the tile has none, null pin tile outside z15, z14 and z10 unchanged', async (t) => {
  const bee = await atlas15(await tmpStore(t, 'z15'))

  const centre = await readPreview(bee, CENTRE, OPTS)
  t.is(centre.zoom, DETAIL_ZOOM)
  t.is(centre.tiles.length, 4)
  t.is(centre.label.name, 'Jaipur')
  t.is(centre.pinTile.zoom, 15)
  t.alike({ x: centre.pinTile.x, y: centre.pinTile.y }, lonLatToTile(CENTRE.lon, CENTRE.lat, 15))
  t.ok(decodeGzip(centre.pinTile.tile).layers.buildings)
  t.is(centre.address.housenumber, null, 'the nearest address point is 437.6 m away')
  t.alike({ name: centre.address.near.name, kind: centre.address.near.kind }, { name: 'High court circle', kind: 'bus_stop' })
  t.ok(Math.abs(centre.address.near.metres - 106) < 1, `near ${centre.address.near.metres} m`)
  t.is(centre.address.display, 'near High court circle, Kachi Basti, Jaipur')

  const noaddr = await readPreview(bee, NOADDR, OPTS)
  t.ok(noaddr.pinTile)
  t.is(noaddr.address.housenumber, null)
  t.is(noaddr.address.display, 'Hasanpura-A, Bani Park, Jaipur')

  const partial = await readPreview(bee, PARTIAL, OPTS)
  t.is(partial.zoom, DETAIL_ZOOM)
  t.is(partial.pinTile, null)
  t.is(partial.address.display, 'Chomu')

  const jodhpur = await readPreview(bee, JODHPUR, OPTS)
  t.is(jodhpur.zoom, FALLBACK_ZOOM)
  t.is(jodhpur.pinTile, null)
  t.is(jodhpur.address.city.name, 'Jodhpur')
})

test('z15 cost: cold readPreview against z14 plus label alone, three Jaipur points', async (t) => {
  const seederStore = await tmpStore(t, 'z15-seed')
  const seed = await atlas15(seederStore)
  const L = seed.core.length
  t.comment('atlas core.length ' + L)
  for (const delayMs of [0, 50]) {
    for (const p of [CENTRE, NORTH, EAST]) {
      const tag = `rtt${2 * delayMs}-${p.lat},${p.lon}`
      const a = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      // readPreview's work before z15 when the z14 2x2 is present
      const without = await h.measure(a.core, a.wire, () => Promise.all([readTiles(a.bee, p, DETAIL_ZOOM, OPTS), readLabel(a.bee, p, OPTS)]))
      const b = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const withz = await h.measure(b.core, b.wire, () => readPreview(b.bee, p, OPTS))
      const addr = withz.result.address
      t.is(withz.result.pinTile.zoom, 15)
      t.ok(addr)
      t.ok(withz.blocks > without.blocks, 'the z15 tile costs blocks')
      t.comment(h.fmt(tag + '-z14+label', 'read-cold', without, L))
      t.comment(h.fmt(tag + '-z14+z15+label', 'read-cold', withz, L))
      t.comment(`address ${p.lat},${p.lon}\t${addr.display}`)
    }
  }
})
