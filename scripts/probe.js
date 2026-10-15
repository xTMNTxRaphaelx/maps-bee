'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const perf = require('bare-performance')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const { readPreview, prefetchTop } = require('./preview')
const { parseFlags, intFlag } = require('./flags')

const TMP = path.join(__dirname, '..', 'store', 'tmp')

function counter (core) {
  const dl = { blocks: 0, bytes: 0 }
  core.on('download', (index, byteLength) => {
    dl.blocks++
    dl.bytes += byteLength
  })
  return dl
}

// fn's result with its wall time and the blocks and bytes dl counted while it ran
async function timed (dl, fn) {
  const b = dl.blocks
  const by = dl.bytes
  const t = perf.now()
  const value = await fn()
  return { value, ms: Math.round((perf.now() - t) * 10) / 10, blocks: dl.blocks - b, bytes: dl.bytes - by }
}

// A cold client: fresh store, swarm lookup by discovery key, first connection, update.
// close() removes the store dir.
async function openClient ({ key, bootstrap, dir = null }) {
  if (!dir) {
    fs.mkdirSync(TMP, { recursive: true })
    dir = fs.mkdtempSync(path.join(TMP, 'probe-'))
  }
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
    await swarm.flush()
    await connected
    const connectMs = perf.now() - t0
    const upd = await timed(dl, () => core.update({ wait: true }))
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    return { store, core, swarm, bee, dl, dir, connectMs, upd, close }
  } catch (err) {
    await close()
    throw err
  }
}

function tilesPresent (value) {
  return value.tiles ? value.tiles.filter(Boolean).length : 0
}

function labelText (label) {
  return label ? `${label.name} (${label.kind}, ${label.km.toFixed(1)} km)` : 'null'
}

function connectLine (connectMs, upd, core) {
  return `connect ms ${Math.round(connectMs * 10) / 10}\tupdate ms ${upd.ms} blocks ${upd.blocks} bytes ${upd.bytes}\tcore.length ${core.length}`
}

function prefetchLine (levels, prefetch) {
  return `prefetch levels ${levels} nodes ${prefetch.value.nodes.join('/')}\tms ${prefetch.ms}\tblocks ${prefetch.blocks}\tbytes ${prefetch.bytes}`
}

function previewLine (phase, point, r) {
  return `${phase}\t${point.lat},${point.lon}\tms ${r.ms}\tblocks ${r.blocks}\tbytes ${r.bytes}\tzoom ${r.value.zoom}\ttiles ${tilesPresent(r.value)}/4\tlabel ${labelText(r.value.label)}\taddress ${r.value.address ? r.value.address.display : 'null'}`
}

// A cold client as an app would open one, optionally the top `levels` tree levels as an app would
// ship them, one preview per point, then the first point again to show the repeat cost. Every read
// counts blocks and bytes downloaded.
async function probe ({ key, points, bootstrap, dir = null, levels = 0, timeout = 10000, deadline = 30000, log = console.log }) {
  const c = await openClient({ key, bootstrap, dir })
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

function parsePoints (args) {
  return args.map((s) => {
    const [lat, lon] = s.split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`bad point ${s}, want lat,lon`)
    return { lat, lon }
  })
}

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--levels'])
  const levels = intFlag(flags, '--levels', 0) ?? 0
  const [id, ...rest] = args
  if (!id || rest.length === 0) throw new Error('usage: probe.js [--levels=N] <coreKey> <lat,lon>...')
  await probe({ key: HypercoreId.decode(id), points: parsePoints(rest), levels })
}

module.exports = { probe, openClient, counter, timed, tilesPresent, labelText, connectLine, prefetchLine, previewLine, parsePoints }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
