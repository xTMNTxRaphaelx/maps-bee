'use strict'
const HypercoreId = require('hypercore-id-encoding')
const { readPreview, prefetchTop } = require('../lib/preview')
const { openClient, timed } = require('../lib/net/client')
const { tilesPresent, labelText, connectLine, prefetchLine, previewLine } = require('../lib/net/report')
const { decodeGzip } = require('../lib/mvt')
const { renderThumbnail, pinOffset } = require('../lib/render-svg')

// One level, not two. On the planet atlas level 1 is free to the byte — its 17 blocks are the root
// the first preview fetches anyway — and only moves ~200 ms off that first read. Level 2 costs
// 2.77 MB up front to save ~83 KB per preview after the first, so it does not break even until
// about 18 previews in one session (results/planet-probe-quadrants.txt).
const PREFETCH_LEVELS = 1
const TIMEOUT = 10000
const DEADLINE = 30000

// One cold client per key, kept open across runs so a second run shows the repeat cost.
function createOps ({ bootstrap } = {}) {
  let session = null

  async function close () {
    if (!session) return
    const { client } = session
    session = null
    await client.close()
  }

  async function run ({ key, lat, lon, prefetch }) {
    const lines = []
    if (!session || session.id !== key) {
      await close()
      const client = await openClient({ key: HypercoreId.decode(key), bootstrap, connectTimeout: DEADLINE })
      session = { id: key, client, prefetched: false, seen: new Set() }
      lines.push(connectLine(client.connectMs, client.upd, client.core))
    }
    const { bee, dl } = session.client
    if (prefetch && !session.prefetched) {
      const p = await timed(dl, () => prefetchTop(bee, PREFETCH_LEVELS, { timeout: TIMEOUT }))
      session.prefetched = true
      lines.push(prefetchLine(PREFETCH_LEVELS, p))
    }
    const point = { lat, lon }
    const phase = session.seen.has(`${lat},${lon}`) ? 'repeat' : 'cold'
    const r = await timed(dl, () => readPreview(bee, point, { timeout: TIMEOUT, deadline: DEADLINE }))
    session.seen.add(`${lat},${lon}`)
    lines.push(previewLine(phase, point, r))
    const v = r.value
    const svg = v.tiles ? renderThumbnail(v.tiles.map((gz) => gz && decodeGzip(gz)), pinOffset(point, v.origin, v.zoom)) : null
    return { lines, svg, label: labelText(v.label), address: v.address, zoom: v.zoom, present: tilesPresent(v), ms: r.ms, blocks: r.blocks, bytes: r.bytes }
  }

  return { run, close }
}

// JSON requests { id, op, ...req } in, { id, ok, result | error } out
function serve (pipe, ops) {
  pipe.on('data', async (data) => {
    // parse inside the try: a malformed frame throws before id is bound, and a reply without an id
    // is a reply the caller's pending promise can never match, so the window waits forever
    let id = null
    try {
      const { id: frameId, op, ...req } = JSON.parse(data.toString())
      id = frameId
      if (typeof ops[op] !== 'function') throw new Error(`unknown op ${op}`)
      const result = await ops[op](req)
      pipe.write(JSON.stringify({ id, ok: true, result }))
    } catch (err) {
      pipe.write(JSON.stringify({ id, ok: false, error: err.message }))
    }
  })
}

module.exports = { createOps, serve }
