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
const CONNECT_TIMEOUT = 30000

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
    // flush() resolves when the lookups settle, peer or no peer, so only this await distinguishes
    // "nobody is seeding the key" from "still connecting" — unbounded, it is an unkillable wait
    await swarm.flush()
    await withDeadline(connected, connectTimeout, `no peer for ${HypercoreId.encode(key)} within ${connectTimeout} ms`)
    const connectMs = perf.now() - t0
    const upd = await timed(dl, () => core.update({ wait: true }))
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    return { store, core, swarm, bee, dl, connectMs, upd, close }
  } catch (err) {
    await close()
    throw err
  }
}

// A cold client as an app would open one, optionally the top `levels` tree levels as an app would
// ship them, one preview per point, then the first point again to show the repeat cost. Every read
// counts blocks and bytes downloaded.
async function probe ({ key, points, bootstrap, levels = 0, timeout = 10000, deadline = 30000, connectTimeout = CONNECT_TIMEOUT, log = console.log }) {
  const c = await openClient({ key, bootstrap, connectTimeout })
  const results = []
  try {
    const { core, bee, dl, connectMs, upd } = c
    log(connectLine(connectMs, upd, core))
    let prefetch = null
    if (levels > 0) {
      prefetch = await timed(dl, () => prefetchTop(bee, levels, { timeout }))
      log(prefetchLine(levels, prefetch))
    }
    const run = async (point, phase) => {
      const r = await timed(dl, () => readPreview(bee, point, { timeout, deadline }))
      const out = { point, phase, ms: r.ms, blocks: r.blocks, bytes: r.bytes, zoom: r.value.zoom, present: tilesPresent(r.value), label: r.value.label }
      log(previewLine(phase, point, r))
      results.push(out)
      return out
    }
    for (const point of points) await run(point, 'cold')
    if (points.length > 0) await run(points[0], 'repeat')
    return { results, coreLength: core.length, connectMs, update: { ms: upd.ms, blocks: upd.blocks, bytes: upd.bytes }, prefetch }
  } finally {
    await c.close()
  }
}

module.exports = { probe, openClient, timed }
