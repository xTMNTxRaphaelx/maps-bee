'use strict'
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { parseFlags, bootstrapFlag } = require('./flags')

// Serves one published core from a store opened read-only, as a seeder would.
async function seed ({ storeDir, key, bootstrap, interval = 10000, log = console.log }) {
  const store = new Corestore(storeDir, { readOnly: true })
  // before get(): a key the store does not hold is one corestore would create, and creating needs
  // a write the read-only open forbids, so ready() dies inside RocksDB instead of naming the key
  await store.ready()
  if (!await store.storage.hasCore(crypto.discoveryKey(key))) {
    await store.close()
    throw new Error(`${storeDir} holds no core ${HypercoreId.encode(key)}`)
  }
  const core = store.get({ key, writable: false })
  await core.ready()
  const stats = { peers: 0, uploads: 0, uploadBytes: 0 }
  core.on('upload', (index, byteLength) => {
    stats.uploads++
    stats.uploadBytes += byteLength
  })
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => {
    const id = b4a.toString(conn.remotePublicKey, 'hex').slice(0, 8)
    stats.peers++
    log(`peer ${id} open, peers ${stats.peers}`)
    conn.on('close', () => {
      stats.peers--
      log(`peer ${id} close, peers ${stats.peers}`)
    })
    store.replicate(conn)
  })
  await swarm.join(core.discoveryKey, { server: true, client: false }).flushed()
  log(`seeding ${HypercoreId.encode(core.key)} length ${core.length} byteLength ${core.byteLength}`)
  const line = () => `length ${core.length}\tpeers ${stats.peers}\tuploads ${stats.uploads}\tuploadBytes ${stats.uploadBytes}`
  const timer = interval > 0 ? setInterval(() => log(line()), interval) : null
  let closed = null
  return {
    core,
    swarm,
    store,
    stats,
    line,
    close () {
      if (!closed) {
        if (timer) clearInterval(timer)
        closed = swarm.destroy().then(() => store.close())
      }
      return closed
    }
  }
}

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--bootstrap'])
  const [storeDir, id] = args
  if (!storeDir || !id) throw new Error('usage: seed.js [--bootstrap=host:port,...] <storeDir> <coreKey>')
  const s = await seed({ storeDir, key: HypercoreId.decode(id), bootstrap: bootstrapFlag(flags, '--bootstrap') })
  const Signal = require('bare-signals')
  const sigint = new Signal('SIGINT')
  sigint.on('signal', () => {
    sigint.stop()
    console.log('stopping: ' + s.line())
    s.close().catch((err) => {
      console.error(err)
      Bare.exitCode = 1
    })
  }).start()
}

module.exports = { seed }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
