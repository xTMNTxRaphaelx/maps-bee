'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const perf = require('bare-performance')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const Hyperswarm = require('hyperswarm')
const HypercoreId = require('hypercore-id-encoding')
const { readPreview, prefetchTop } = require('./preview')

const TMP = path.join(__dirname, '..', 'store', 'tmp')

// A cold client: fresh store, swarm lookup by discovery key, update, optionally the top `levels`
// tree levels as an app would ship them, one preview per point, then the first point again to show
// the repeat cost. Every read counts blocks and bytes downloaded.
async function probe ({ key, points, bootstrap, dir = null, levels = 0, timeout = 10000, deadline = 30000, log = console.log }) {
  if (!dir) {
    fs.mkdirSync(TMP, { recursive: true })
    dir = fs.mkdtempSync(path.join(TMP, 'probe-'))
  }
  const store = new Corestore(dir)
  const core = store.get({ key, writable: false })
  await core.ready()
  const dl = { blocks: 0, bytes: 0 }
  core.on('download', (index, byteLength) => {
    dl.blocks++
    dl.bytes += byteLength
  })
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => store.replicate(conn))
  const results = []
  try {
    const t0 = perf.now()
    const connected = new Promise((resolve) => swarm.once('connection', resolve))
    swarm.join(core.discoveryKey, { client: true, server: false })
    await swarm.flush()
    await connected
    const connectMs = perf.now() - t0
    const timed = async (fn) => {
      const b = dl.blocks
      const by = dl.bytes
      const t = perf.now()
      const value = await fn()
      return { value, ms: Math.round((perf.now() - t) * 10) / 10, blocks: dl.blocks - b, bytes: dl.bytes - by }
    }
    const upd = await timed(() => core.update({ wait: true }))
    log(`connect ms ${Math.round(connectMs * 10) / 10}\tupdate ms ${upd.ms} blocks ${upd.blocks} bytes ${upd.bytes}\tcore.length ${core.length}`)
    const bee = new Hyperbee(store, { core, writable: false })
    await bee.ready()
    let prefetch = null
    if (levels > 0) {
      prefetch = await timed(() => prefetchTop(bee, levels, { timeout }))
      log(`prefetch levels ${levels} nodes ${prefetch.value.nodes.join('/')}\tms ${prefetch.ms}\tblocks ${prefetch.blocks}\tbytes ${prefetch.bytes}`)
    }
    const run = async (point, phase) => {
      const r = await timed(() => readPreview(bee, point, { timeout, deadline }))
      const present = r.value.tiles ? r.value.tiles.filter(Boolean).length : 0
      const label = r.value.label ? `${r.value.label.name} (${r.value.label.kind}, ${r.value.label.km.toFixed(1)} km)` : 'null'
      const out = { point, phase, ms: r.ms, blocks: r.blocks, bytes: r.bytes, zoom: r.value.zoom, present, label: r.value.label }
      log(`${phase}\t${point.lat},${point.lon}\tms ${r.ms}\tblocks ${r.blocks}\tbytes ${r.bytes}\tzoom ${r.value.zoom}\ttiles ${present}/4\tlabel ${label}`)
      results.push(out)
      return out
    }
    for (const point of points) await run(point, 'cold')
    if (points.length > 0) await run(points[0], 'repeat')
    return { results, coreLength: core.length, connectMs, update: { ms: upd.ms, blocks: upd.blocks, bytes: upd.bytes }, prefetch }
  } finally {
    await swarm.destroy()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
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
  const argv = Bare.argv.slice(2)
  const flag = argv.find((a) => a.startsWith('--levels='))
  const levels = flag ? Number(flag.slice('--levels='.length)) : 0
  if (!(Number.isInteger(levels) && levels >= 0)) throw new Error('--levels must be a non-negative integer')
  const [id, ...rest] = argv.filter((a) => !a.startsWith('--'))
  if (!id || rest.length === 0) throw new Error('usage: probe.js [--levels=N] <coreKey> <lat,lon>...')
  await probe({ key: HypercoreId.decode(id), points: parsePoints(rest), levels })
}

module.exports = { probe, parsePoints }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
