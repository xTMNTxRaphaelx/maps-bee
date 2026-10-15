'use strict'
const HypercoreId = require('hypercore-id-encoding')
const { readPreview, prefetchTop, DETAIL_ZOOM } = require('../scripts/preview')
const { openClient, timed, tilesPresent, labelText, connectLine, prefetchLine, previewLine } = require('../scripts/probe')
const { decodeGzip } = require('../scripts/mvt')
const { renderThumbnail, pinOffset, pinTileOffset } = require('../scripts/render-svg')

const PREFETCH_LEVELS = 2
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
      const client = await openClient({ key: HypercoreId.decode(key), bootstrap })
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
    const pinTile = v.pinTile && v.zoom === DETAIL_ZOOM ? { tile: decodeGzip(v.pinTile.tile), ...pinTileOffset(v.pinTile, v.origin) } : null
    const svg = v.tiles ? renderThumbnail(v.tiles.map((gz) => gz && decodeGzip(gz)), pinOffset(point, v.origin, v.zoom), pinTile) : null
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

module.exports = { PREFETCH_LEVELS, TIMEOUT, DEADLINE, createOps, serve }
