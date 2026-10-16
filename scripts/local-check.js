'use strict'
// Reads a built atlas straight off disk and runs the real preview path over it — no swarm, no
// second process. From the outside a sound atlas behind a blocked DHT and a broken build look
// identical: the seeder announces, reports its length, and no client ever arrives. On 2026-10-16
// that ambiguity cost an hour at the end of a planet build. This resolves it — if the addresses
// come back here, the atlas is good and the problem is the network.
//
// usage: local-check.js <storeDir> <coreKey> <lat,lon>...
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const { readPreview } = require('./preview')
const { tilesPresent, labelText, parsePoints } = require('./probe')
const { parseFlags } = require('./flags')

const TIMEOUT = 5000

async function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [storeDir, id, ...rest] = args
  if (!storeDir || !id || rest.length === 0) {
    throw new Error('usage: local-check.js <storeDir> <coreKey> <lat,lon>...')
  }
  const points = parsePoints(rest)
  // read-only, so this runs against a store a seeder already holds open
  const store = new Corestore(storeDir, { readOnly: true })
  try {
    const core = store.get({ key: HypercoreId.decode(id), writable: false })
    await core.ready()
    console.log(`core.length ${core.length} byteLength ${core.byteLength}`)
    // an empty core here is the store and the key disagreeing, not an empty atlas
    if (core.length === 0) throw new Error(`${storeDir} holds no blocks for ${id}`)
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    for (const point of points) {
      const r = await readPreview(bee, point, { timeout: TIMEOUT })
      console.log(`${point.lat},${point.lon}\tzoom ${r.zoom}\ttiles ${tilesPresent(r)}/4\tlabel ${labelText(r.label)}\taddress ${r.address ? r.address.display : 'null'}`)
    }
  } finally {
    await store.close()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
