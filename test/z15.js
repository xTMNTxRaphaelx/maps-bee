'use strict'
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const { lonLatToTile, pinTiles } = require('../scripts/tiles')
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

test('readPreview with z15: the 2x2 is z15 where the atlas has it, z14 and z10 where it does not', async (t) => {
  const bee = await atlas15(await tmpStore(t, 'z15'))

  const centre = await readPreview(bee, CENTRE, OPTS)
  t.is(centre.zoom, DETAIL_ZOOM, 'z15 is the first zoom in the walk and this atlas has it')
  t.is(centre.tiles.length, 4)
  t.is(centre.label.name, 'Jaipur')
  // the pin's own tile is one of the four now, not a fifth read
  t.alike(pinTiles(CENTRE.lon, CENTRE.lat, 15).tiles.some(([x, y]) => {
    const p = lonLatToTile(CENTRE.lon, CENTRE.lat, 15)
    return x === p.x && y === p.y
  }), true, 'the 2x2 contains the pin tile')
  t.ok(centre.tiles.some((v) => v && decodeGzip(v).layers.buildings), 'the z15 cell carries the buildings layer')
  t.is(centre.address.housenumber, null, 'the nearest address point is 437.6 m away')
  t.alike({ name: centre.address.near.name, kind: centre.address.near.kind }, { name: 'High court circle', kind: 'bus_stop' })
  t.ok(Math.abs(centre.address.near.metres - 106) < 1, `near ${centre.address.near.metres} m`)
  t.is(centre.address.display, 'near High court circle, Kachi Basti, Jaipur')

  const noaddr = await readPreview(bee, NOADDR, OPTS)
  t.is(noaddr.zoom, DETAIL_ZOOM)
  t.is(noaddr.address.housenumber, null)
  t.is(noaddr.address.display, 'Hasanpura-A, Bani Park, Jaipur')

  // west of the z15 box: the walk finds a partial z15 cell there, and still answers
  const partial = await readPreview(bee, PARTIAL, OPTS)
  t.is(partial.address.display, 'Chomu')

  const jodhpur = await readPreview(bee, JODHPUR, OPTS)
  t.is(jodhpur.zoom, FALLBACK_ZOOM, 'no z15 and no z14 out there, so the walk reaches z10')
  t.is(jodhpur.address.city.name, 'Jodhpur')
})

// What the switch to a z15 detail cell costs the client. The same features spread over four times
// as many tiles, so a z15 2x2 carries fewer bytes than the z14 2x2 it replaces even though it is
// four tiles either way (results/address-shapes.txt measured 70.1 -> 40.6 KiB a point over Jaipur).
test('z15 cost: the z15 2x2 against the z14 2x2 it replaces, three Jaipur points', async (t) => {
  const seederStore = await tmpStore(t, 'z15-seed')
  const seed = await atlas15(seederStore)
  const L = seed.core.length
  t.comment('atlas core.length ' + L)
  for (const delayMs of [0, 50]) {
    for (const p of [CENTRE, NORTH, EAST]) {
      const tag = `rtt${2 * delayMs}-${p.lat},${p.lon}`
      const a = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const z14 = await h.measure(a.core, a.wire, () => Promise.all([readTiles(a.bee, p, 14, OPTS), readLabel(a.bee, p, OPTS)]))
      const b = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const z15 = await h.measure(b.core, b.wire, () => Promise.all([readTiles(b.bee, p, 15, OPTS), readLabel(b.bee, p, OPTS)]))
      const c = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const full = await h.measure(c.core, c.wire, () => readPreview(c.bee, p, OPTS))
      const addr = full.result.address
      t.is(full.result.zoom, DETAIL_ZOOM, 'the detail cell is z15')
      t.ok(addr)
      t.comment(h.fmt(tag + '-z14cell+label', 'read-cold', z14, L))
      t.comment(h.fmt(tag + '-z15cell+label', 'read-cold', z15, L))
      t.comment(h.fmt(tag + '-full-preview', 'read-cold', full, L))
      t.comment(`cell cost z15/z14 blocks ${(z15.blocks / z14.blocks).toFixed(2)}x bytes ${(z15.blockBytes / z14.blockBytes).toFixed(2)}x`)
      t.comment(`address ${p.lat},${p.lon}\t${addr.display}`)
    }
  }
})
