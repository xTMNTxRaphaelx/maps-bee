'use strict'
const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const { lonLatToTile } = require('../scripts/tiles')
const { JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const C14 = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
const P12 = { x: C14.x >> 2, y: C14.y >> 2 }

const SCENARIOS = [
  { name: 'a-3x3-z14-gets', read: (bee) => h.readNine(bee, 14, C14.x, C14.y), n: 9, blocks: 14 },
  { name: 'b-block16-z14-stream', read: (bee) => h.readRange(bee, h.subtreeRange(14, h.quadkey(P12.x, P12.y, 12))), n: 16, blocks: 18 },
  { name: 'b2-block16-z14-gets', read: (bee) => h.readCell(bee, 14, P12.x, P12.y), n: 16, blocks: 18 }
]

test('sparse reads over hyperswarm on a localhost testnet', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())
  const seeder = await h.openSeeder(t)
  const L = seeder.core.length
  const dk = seeder.core.discoveryKey

  const seedSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.teardown(() => seedSwarm.destroy())
  seedSwarm.on('connection', (conn) => seeder.store.replicate(conn))
  await seedSwarm.join(dk, { server: true, client: false }).flushed()
  t.comment(`seeder announced ${seeder.ref.id} length ${L}`)

  for (const sc of SCENARIOS) {
    const client = await h.tmpStore(t, 'swarm-client')
    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    t.teardown(() => swarm.destroy())
    let raw = null
    let tConn = 0
    const t0 = h.perf.now()
    const connected = new Promise((resolve) => {
      swarm.once('connection', (conn) => {
        tConn = h.perf.now() - t0
        raw = conn.rawStream
        client.replicate(conn)
        resolve()
      })
    })
    // byte counters come from the udx stream instead of a piped Counter
    const wire = {
      down: { get bytes () { return raw ? raw.bytesReceived : 0 } },
      up: { get bytes () { return raw ? raw.bytesTransmitted : 0 } }
    }
    const core = await h.openClientCore(client, seeder.ref)
    swarm.join(dk, { client: true, server: false })
    await swarm.flush()
    await connected
    const upd = await h.measure(core, wire, () => core.update({ wait: true }))
    const bee = new h.Hyperbee(client, { core, writable: false })
    await bee.ready()
    const rd = await h.measure(core, wire, () => sc.read(bee))
    const total = h.perf.now() - t0
    h.assertTiles(t, rd.result, sc.n)
    t.is(rd.blocks, sc.blocks, sc.name + ' block count')
    t.comment(`${sc.name}\tconnect ms ${Math.round(tConn * 10) / 10}\ttotal cold ms (join to last value) ${Math.round(total * 10) / 10}`)
    t.comment(h.fmt(sc.name, 'update', upd, L))
    t.comment(h.fmt(sc.name, 'read-cold', rd, L))
    await swarm.destroy()
  }
})
