'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('hypercore-crypto')
const createTestnet = require('hyperdht/testnet')
const { openClient } = require('../../lib/net/client')

const TMP = path.join(__dirname, '..', '..', 'store', 'tmp')

function probeDirs () {
  try {
    return fs.readdirSync(TMP).filter((d) => d.startsWith('probe-'))
  } catch {
    return []
  }
}

// swarm.flush() resolves once the DHT lookups settle, peer or no peer, so the first-connection
// await is the one that never returns when nothing is seeding the key. Without a deadline a client
// cannot tell "no peer reachable" from "still connecting", which is what the app's Run button and
// every seeding diagnosis ran into.
test('openClient rejects instead of hanging when no peer serves the key', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())
  const before = probeDirs().length

  const key = crypto.keyPair().publicKey
  const started = Date.now()
  await t.exception(openClient({ key, bootstrap: testnet.bootstrap, connectTimeout: 1000 }), /no peer/)
  const waited = Date.now() - started

  t.ok(waited < 10000, `gave up after ${waited} ms`)
  t.is(probeDirs().length, before, 'the temp store it opened is gone')
})
