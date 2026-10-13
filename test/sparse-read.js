'use strict'
const test = require('brittle')
const { lonLatToTile } = require('../scripts/tiles')
const { JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const C14 = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
const C10 = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 10)
const P12 = { x: C14.x >> 2, y: C14.y >> 2 }

const SCENARIOS = [
  { name: 'a-3x3-z14-gets', read: (bee) => h.readNine(bee, 14, C14.x, C14.y), n: 9, blocks: 14 },
  { name: 'b-block16-z14-stream', read: (bee) => h.readRange(bee, h.subtreeRange(14, h.quadkey(P12.x, P12.y, 12))), n: 16, blocks: 18 },
  { name: 'b2-block16-z14-gets', read: (bee) => h.readCell(bee, 14, P12.x, P12.y), n: 16 },
  { name: 'd-3x3-z10-gets', read: (bee) => h.readNine(bee, 10, C10.x, C10.y), n: 9 }
]

async function cold (t, seeder, sc, delayMs) {
  const { core, bee, wire, upd } = await h.coldClient(t, seeder.store, seeder.ref.key, delayMs)
  const rd = await h.measure(core, wire, () => sc.read(bee))
  h.assertTiles(t, rd.result, sc.n)
  t.ok(rd.blocks < seeder.core.length, 'sparse: fewer blocks than the core')
  if (sc.blocks) t.is(rd.blocks, sc.blocks, sc.name + ' block count')
  return { core, bee, wire, upd, rd }
}

for (const delayMs of [0, 50]) {
  test(`sparse reads over a piped stream, one-way delay ${delayMs} ms`, async (t) => {
    const seeder = await h.openSeeder(t)
    const L = seeder.core.length
    t.comment(`seeder key ${seeder.ref.id} length ${L} RTT ${2 * delayMs} ms`)
    const timing = {}
    for (const sc of SCENARIOS) {
      const r = await cold(t, seeder, sc, delayMs)
      timing[sc.name] = r.rd.ms
      t.comment(h.fmt(sc.name, 'update', r.upd, L))
      t.comment(h.fmt(sc.name, 'read-cold', r.rd, L))
      t.comment(`${sc.name}\tindices ${r.rd.indices.join(',')}`)
      if (sc.name === 'a-3x3-z14-gets') {
        const again = await h.measure(r.core, r.wire, () => h.readNine(r.bee, 14, C14.x, C14.y))
        h.assertTiles(t, again.result, 9)
        t.is(again.blocks, 0, 'repeat read is served locally')
        t.comment(h.fmt('a-3x3-z14-gets-repeat', 'read-local', again, L))
      }
    }
    if (delayMs > 0) {
      t.ok(timing['b2-block16-z14-gets'] * 3 < timing['b-block16-z14-stream'], 'parallel gets beat the range stream by 3x or more under latency')
    }
  })
}
