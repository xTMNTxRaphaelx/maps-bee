'use strict'
const createTestnet = require('hyperdht/testnet')
const Signal = require('bare-signals')

// A private DHT to point seed.js and probe.js at with --bootstrap, so replication can be exercised
// on one machine. The public DHT needs reachability this cannot assume: a seeder announcing a key
// with no client ever connecting looks identical to a broken build, which is how a sound atlas was
// mistaken for one twice.
async function main () {
  const testnet = await createTestnet(3)
  const list = testnet.bootstrap.map((n) => `${n.host}:${n.port}`).join(',')
  console.log(`testnet nodes ${testnet.nodes.length}`)
  console.log(`--bootstrap=${list}`)
  console.log('ctrl-c to stop; the DHT dies with this process, so start it before the seeder')
  const sigint = new Signal('SIGINT')
  sigint.on('signal', () => {
    sigint.stop()
    console.log('stopping')
    testnet.destroy().catch((err) => {
      console.error(err)
      Bare.exitCode = 1
    })
  }).start()
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
