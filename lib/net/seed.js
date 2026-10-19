'use strict'
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const b4a = require('b4a')
const { openPublished } = require('./published')

// Serves one published core from a store opened read-only, as a seeder would.
async function seed ({ storeDir, key, bootstrap, interval = 10000, log = console.log }) {
  const { store, core } = await openPublished(storeDir, key)
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

module.exports = { seed }
