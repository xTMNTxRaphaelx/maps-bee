'use strict'
const test = require('brittle')
const { lonLatToTile } = require('../../lib/tiles')
const { JAIPUR_CENTRE } = require('../helpers/helpers')
const h = require('../helpers/sparse-harness')

const C10 = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 10)
const P8 = { x: C10.x >> 2, y: C10.y >> 2 }
const NAME = 'e-z8-block16-z10-gets'

for (const delayMs of [0, 50]) {
  test(`statewide preview block: 16 z10 tiles of one z8 cell, one-way delay ${delayMs} ms`, async (t) => {
    const seeder = await h.openSeeder(t)
    const L = seeder.core.length
    const { core, bee, wire, upd } = await h.coldClient(t, seeder.store, seeder.ref.key, delayMs)
    const rd = await h.measure(core, wire, () => h.readCell(bee, 10, P8.x, P8.y))
    h.assertTiles(t, rd.result, 16)
    t.is(rd.blocks, 20)
    t.comment(h.fmt(NAME, 'update', upd, L))
    t.comment(h.fmt(NAME, 'read-cold', rd, L))
    t.comment(`${NAME}\tindices ${rd.indices.join(',')}`)
  })
}
