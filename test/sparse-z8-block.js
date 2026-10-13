'use strict'
const test = require('brittle')
const { lonLatToTile } = require('../scripts/tiles')
const { JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const C10 = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 10)
const P8 = { x: C10.x >> 2, y: C10.y >> 2 }
const NAME = 'e-z8-block16-z10-gets'

for (const delayMs of [0, 50]) {
  test(`statewide preview block: 16 z10 tiles of one z8 cell, one-way delay ${delayMs} ms`, async (t) => {
    const seeder = await h.openSeeder(t)
    const L = seeder.core.length
    const client = await h.tmpStore(t, 'client-z8')
    const wire = h.link(seeder.store, client, delayMs)
    t.teardown(() => wire.destroy())
    const core = await h.openClientCore(client, seeder.ref)
    const upd = await h.measure(core, wire, () => core.update({ wait: true }))
    const bee = new h.Hyperbee(client, { core, writable: false })
    await bee.ready()
    const rd = await h.measure(core, wire, () => h.readSubtreeGets(bee, 10, P8.x, P8.y))
    h.assertTiles(t, rd.result, 16)
    t.is(rd.blocks, 20)
    t.comment(h.fmt(NAME, 'update', upd, L))
    t.comment(h.fmt(NAME, 'read-cold', rd, L))
    t.comment(`${NAME}\tindices ${rd.indices.join(',')}`)
  })
}
