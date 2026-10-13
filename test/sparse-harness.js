'use strict'
const fs = require('bare-fs')
const perf = require('bare-performance')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const { Transform } = require('streamx')
const { decodeGzip } = require('../scripts/mvt')
const { tileKey, quadkey, subtreeRange } = require('../scripts/tiles')
const { tmpStore, SIGNED_STORE, PUBLISH_OUT } = require('./helpers')

function publishedRef () {
  const m = fs.readFileSync(PUBLISH_OUT, 'utf8').match(/maps: \{ "key": "([^"]+)", "length": (\d+) \}/)
  if (!m) throw new Error('results/publish.txt has no maps line; run scripts/publish.js first')
  return { key: HypercoreId.decode(m[1]), id: m[1], length: Number(m[2]) }
}

// readOnly: no device-file lock and no RocksDB writes, so store/signed stays untouched
async function openSeeder (t) {
  const ref = publishedRef()
  const store = new Corestore(SIGNED_STORE, { readOnly: true })
  const core = store.get({ key: ref.key, writable: false })
  await core.ready()
  t.is(core.length, ref.length, 'seeder holds the published length')
  t.teardown(() => store.close())
  return { store, core, ref }
}

class Counter extends Transform {
  constructor () {
    super()
    this.bytes = 0
  }

  _transform (data, cb) {
    this.bytes += data.byteLength
    cb(null, data)
  }
}

// Fixed one-way latency, FIFO; a link with RTT = 2 * ms makes round trips show up as time
class DelayLine extends Transform {
  constructor (ms) {
    super()
    this.ms = ms
    this.timers = new Set()
  }

  _transform (data, cb) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.push(data)
    }, this.ms)
    this.timers.add(timer)
    cb(null)
  }

  _destroy (cb) {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    cb(null)
  }
}

function link (seederStore, clientStore, delayMs) {
  const a = seederStore.replicate(true)
  const b = clientStore.replicate(false)
  const down = new Counter()
  const up = new Counter()
  const parts = [a, b, down, up]
  if (delayMs > 0) {
    const d1 = new DelayLine(delayMs)
    const d2 = new DelayLine(delayMs)
    parts.push(d1, d2)
    a.pipe(d1).pipe(down).pipe(b).pipe(d2).pipe(up).pipe(a)
  } else {
    a.pipe(down).pipe(b).pipe(up).pipe(a)
  }
  return { down, up, destroy: () => parts.forEach((s) => s.destroy()) }
}

function statsSnapshot (core) {
  const s = core.replicator.stats
  return { reqTx: s.wireRequest.tx, dataRx: s.wireData.rx }
}

async function measure (core, wire, fn) {
  const idx = []
  let bytes = 0
  const onDownload = (index, byteLength) => {
    idx.push(index)
    bytes += byteLength
  }
  core.on('download', onDownload)
  const s0 = statsSnapshot(core)
  const w0 = { rx: wire.down.bytes, tx: wire.up.bytes }
  const t0 = perf.now()
  const result = await fn()
  const ms = perf.now() - t0
  core.off('download', onDownload)
  const s1 = statsSnapshot(core)
  return {
    ms: Math.round(ms * 10) / 10,
    blocks: idx.length,
    blockBytes: bytes,
    wireRequestTx: s1.reqTx - s0.reqTx,
    wireDataRx: s1.dataRx - s0.dataRx,
    wireBytesRx: wire.down.bytes - w0.rx,
    wireBytesTx: wire.up.bytes - w0.tx,
    indices: idx.sort((x, y) => x - y),
    result
  }
}

function grid3 (cx, cy) {
  const out = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push({ x: cx + dx, y: cy + dy })
  return out
}

function readNine (bee, z, cx, cy) {
  return Promise.all(grid3(cx, cy).map(({ x, y }) => bee.get(tileKey(z, x, y))))
}

async function readRange (bee, range, opts = {}) {
  const out = []
  for await (const e of bee.createReadStream({ ...range, ...opts })) out.push(e)
  return out
}

// the 16 z(p+2) children of parent (px, py), as parallel gets instead of a range stream
function readSubtreeGets (bee, z, px, py) {
  const gets = []
  for (let y = py << 2; y < (py << 2) + 4; y++) {
    for (let x = px << 2; x < (px << 2) + 4; x++) gets.push(bee.get(tileKey(z, x, y)))
  }
  return Promise.all(gets)
}

function assertTiles (t, entries, n) {
  t.is(entries.length, n, `${n} entries`)
  let decoded = 0
  for (const e of entries) {
    if (e && e.value && Object.keys(decodeGzip(e.value).layers).length > 0) decoded++
  }
  t.is(decoded, n, 'every value decodes as MVT with layers')
}

async function openClientCore (client, ref, coreOpts) {
  const core = client.get({ key: ref.key, writable: false, ...coreOpts })
  await core.ready()
  return core
}

function fmt (name, phase, m, seederLength) {
  const pct = ((100 * m.blocks) / seederLength).toFixed(1)
  return `${name}\t${phase}\tms ${m.ms}\tblocks ${m.blocks} (${pct}% of ${seederLength})\tblockBytes ${m.blockBytes}\twireRequestTx ${m.wireRequestTx}\twireDataRx ${m.wireDataRx}\twireBytesRx ${m.wireBytesRx}\twireBytesTx ${m.wireBytesTx}`
}

module.exports = {
  Hyperbee,
  perf,
  tmpStore,
  openSeeder,
  link,
  measure,
  readNine,
  readRange,
  readSubtreeGets,
  assertTiles,
  openClientCore,
  fmt,
  quadkey,
  subtreeRange
}
