'use strict'
// Reads a built atlas straight off disk and runs the real preview path over it — no swarm, no
// second process. From the outside a sound atlas behind a blocked DHT and a broken build look
// identical: the seeder announces, reports its length, and no client ever arrives. On 2026-10-16
// that ambiguity cost an hour at the end of a planet build. This resolves it — if the addresses
// come back here, the atlas is good and the problem is the network.
//
// --json also dumps the whole address object, which is what distinguishes "nothing was found" from
// "something was found and display() dropped it": a road beyond ROAD_ON_M stays in the object and
// out of the string, so a pin that is not on a street shows the city alone and looks empty.
//
// usage: local-check.js [--json] <storeDir> <coreKey> <lat,lon>...
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')
const { readPreview } = require('../lib/preview')
const { tilesPresent, labelText } = require('../lib/net/report')
const { parseFlags, parsePoints } = require('./flags')

const TIMEOUT = 5000

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--json'])
  const [storeDir, id, ...rest] = args
  if (!storeDir || !id || rest.length === 0) {
    throw new Error('usage: local-check.js [--json] <storeDir> <coreKey> <lat,lon>...')
  }
  const points = parsePoints(rest)
  // read-only, so this runs against a store a seeder already holds open
  const store = new Corestore(storeDir, { readOnly: true })
  try {
    const key = HypercoreId.decode(id)
    // before get(), not after: a key the store does not hold is one corestore would create, and
    // creating needs a write the read-only open forbids, so ready() dies inside RocksDB instead
    await store.ready()
    if (!await store.storage.hasCore(crypto.discoveryKey(key))) throw new Error(`${storeDir} holds no core ${id}`)
    const core = store.get({ key, writable: false })
    await core.ready()
    console.log(`core.length ${core.length} byteLength ${core.byteLength}`)
    if (core.length === 0) throw new Error(`${storeDir} holds no blocks for ${id}`)
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    for (const point of points) {
      const r = await readPreview(bee, point, { timeout: TIMEOUT })
      console.log(`${point.lat},${point.lon}\tzoom ${r.zoom}\ttiles ${tilesPresent(r)}/4\tlabel ${labelText(r.label)}\taddress ${r.address ? r.address.display : 'null'}`)
      if (flags.has('--json')) console.log(JSON.stringify(r.address, null, 1))
    }
  } finally {
    await store.close()
  }
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
