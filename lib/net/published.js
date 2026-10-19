'use strict'
const Corestore = require('corestore')
const HypercoreId = require('hypercore-id-encoding')
const crypto = require('hypercore-crypto')

// Opens a core someone else published, from a store on disk, read-only. Both the seeder and the
// local check want exactly this and nothing else — one grows a swarm on top, the other a bee —
// and when they each had their own copy the two drifted: one named the key it could not find, the
// other echoed whatever the user typed.
//
// The hasCore check has to come before get(): a key the store does not hold is one corestore would
// create, and creating needs a write the read-only open forbids, so ready() dies inside RocksDB
// instead of naming the key. The store is closed here if the core is absent, so a caller that
// throws never leaks it.
async function openPublished (storeDir, key) {
  const store = new Corestore(storeDir, { readOnly: true })
  try {
    await store.ready()
    if (!await store.storage.hasCore(crypto.discoveryKey(key))) {
      throw new Error(`${storeDir} holds no core ${HypercoreId.encode(key)}`)
    }
    const core = store.get({ key, writable: false })
    await core.ready()
    return { store, core }
  } catch (err) {
    await store.close().catch(() => {})
    throw err
  }
}

module.exports = { openPublished }
