'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const perf = require('bare-performance')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const { readPreview, prefetchTop } = require('../preview')
const { tilesPresent, connectLine, prefetchLine, previewLine } = require('./report')

const TMP = path.join(__dirname, '..', '..', 'store', 'tmp')
// The read regime a cold client runs under, exported so the app measures what the probe measures.
// CONNECT_TIMEOUT is the only one a caller overrides (app/ops.js passes its own).
const CONNECT_TIMEOUT = 30000
const TIMEOUT = 10000
const DEADLINE = 30000

// rejects if promise has not settled in ms; clears the timer either way so bare can exit
function withDeadline (promise, ms, message) {
  let timer = null
  const expiry = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

function counter (core) {
  const dl = { blocks: 0, bytes: 0 }
  core.on('download', (index, byteLength) => {
    dl.blocks++
    dl.bytes += byteLength
  })
  return dl
}

async function timed (dl, fn) {
  const b = dl.blocks
  const by = dl.bytes
  const t = perf.now()
  const value = await fn()
  return { value, ms: Math.round((perf.now() - t) * 10) / 10, blocks: dl.blocks - b, bytes: dl.bytes - by }
}

// A cold client: fresh store, swarm lookup by discovery key, first connection, update.
// close() removes the store dir.
async function openClient ({ key, bootstrap, connectTimeout = CONNECT_TIMEOUT }) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, 'probe-'))
  const store = new Corestore(dir)
  const core = store.get({ key, writable: false })
  await core.ready()
  const dl = counter(core)
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => store.replicate(conn))
  const close = async () => {
    await swarm.destroy()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  try {
    const t0 = perf.now()
    const connected = new Promise((resolve) => swarm.once('connection', resolve))
    swarm.join(core.discoveryKey, { client: true, server: false })
    // Both waits under one deadline measured from t0. flush() resolves when the lookups settle,
    // peer or no peer, so only the wait after it distinguishes "nobody is seeding the key" from
    // "still connecting" — but flush() has no clock of its own and waits on every pending
    // connection attempt, so a holepunch that never settles hangs here forever if the deadline
    // starts after it. Deadlining them separately would also make the message a lie by however
    // long flush took.
    await withDeadline(
      swarm.flush().then(() => connected),
      connectTimeout,
      `no peer for ${HypercoreId.encode(key)} within ${connectTimeout} ms`
    )
    const connectMs = perf.now() - t0
    const upd = await timed(dl, () => core.update({ wait: true }))
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    return { core, bee, dl, connectMs, upd, close }
  } catch (err) {
    // the open already failed; a teardown that fails too must not replace the diagnosis
    await close().catch(() => {})
    throw err
  }
}

// A cold client as an app would open one, optionally the top `levels` tree levels as an app would
// ship them, one preview per point, then the first point again to show the repeat cost. Every read
// counts blocks and bytes downloaded.
async function probe ({ key, points, bootstrap, levels = 0, log = console.log }) {
  const c = await openClient({ key, bootstrap })
  const results = []
  try {
    const { core, bee, dl, connectMs, upd } = c
    log(connectLine(connectMs, upd, core))
    let prefetch = null
    if (levels > 0) {
      prefetch = await timed(dl, () => prefetchTop(bee, levels, { timeout: TIMEOUT }))
      log(prefetchLine(levels, prefetch))
    }
    const run = async (point, phase) => {
      const r = await timed(dl, () => readPreview(bee, point, { timeout: TIMEOUT, deadline: DEADLINE }))
      const out = { point, phase, ms: r.ms, blocks: r.blocks, bytes: r.bytes, zoom: r.value.zoom, present: tilesPresent(r.value), label: r.value.label }
      log(previewLine(phase, point, r))
      results.push(out)
      return out
    }
    for (const point of points) await run(point, 'cold')
    if (points.length > 0) await run(points[0], 'repeat')
    return { results, coreLength: core.length, connectMs, update: { ms: upd.ms, blocks: upd.blocks, bytes: upd.bytes }, prefetch }
  } finally {
    // reported rather than thrown: in a finally a close failure would replace whatever the probe
    // was already throwing, and swallowing it silently would hide a leaked tmp store
    await c.close().catch((err) => log(`close failed: ${err.message}`))
  }
}

module.exports = { probe, openClient, timed, CONNECT_TIMEOUT, TIMEOUT, DEADLINE }
