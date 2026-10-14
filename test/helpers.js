'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')

const DATA = path.join(__dirname, '..', 'data')
const STATE_ARCHIVE = path.join(DATA, 'extract', 'rajasthan-z10.pmtiles')
const JAIPUR_ARCHIVE = path.join(DATA, 'extract', 'jaipur-z11-14.pmtiles')

const TMP = path.join(__dirname, '..', 'store', 'tmp')
const SINGLE_STORE = path.join(__dirname, '..', 'store', 'single')
const SIGNED_STORE = path.join(__dirname, '..', 'store', 'signed')
const PUBLISH_OUT = path.join(__dirname, '..', 'results', 'publish.txt')

const JAIPUR_CENTRE = { lon: 75.8, lat: 26.9 }
const JAIPUR_BBOX = [75.65, 26.75, 75.95, 27.05]
const RAJASTHAN_BBOX = [69.5, 23.0, 78.3, 30.2]

// fresh RocksDB dir per test; a copied store is refused by RocksDB, so never share one
async function tmpStore (t, name) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, name + '-'))
  const store = new Corestore(dir)
  await store.ready()
  t.teardown(async () => {
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return store
}

// every key passed to tryPut on any batch the bee hands out, in put order
function spyPuts (bee) {
  const keys = []
  const write = bee.write.bind(bee)
  bee.write = (opts) => {
    const w = write(opts)
    const tryPut = w.tryPut.bind(w)
    w.tryPut = (key, value) => {
      keys.push(key)
      return tryPut(key, value)
    }
    return w
  }
  return keys
}

// key records across the whole core that carry their value inline
async function inlinedValues (core) {
  let n = 0
  for (let i = 0; i < core.length; i++) {
    const blk = decodeBlock(await core.get(i), i)
    if (blk.keys) n += blk.keys.filter((k) => k.value).length
  }
  return n
}

module.exports = {
  inlinedValues,
  JAIPUR_CENTRE,
  JAIPUR_BBOX,
  RAJASTHAN_BBOX,
  STATE_ARCHIVE,
  JAIPUR_ARCHIVE,
  SINGLE_STORE,
  SIGNED_STORE,
  PUBLISH_OUT,
  tmpStore,
  spyPuts
}
