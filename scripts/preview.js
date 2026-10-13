'use strict'
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { REQUEST_TIMEOUT } = require('hypercore-errors')
const { lonLatToTile, quadkey, tileKey, subtreeRange } = require('./tiles')
const { GAZ_ZOOM, haversineKm } = require('./gazetteer-lib')

const DETAIL_ZOOM = 14
const FALLBACK_ZOOM = 10
const LABEL_ZOOM = 8

const NO_TILES = { zoom: null, cell: null, tiles: null }

// The replicator requests of one call, so a failed call leaves nothing in flight. A hyperbee2 range
// stream marks its own request list dead when it ends (hyperbee2/lib/ranges.js:204), so each stream
// gets a list of its own and the parallel gets share one.
class Requests {
  constructor () {
    this.lists = []
  }

  list () {
    const l = []
    this.lists.push(l)
    return l
  }

  destroy (err) {
    for (const l of this.lists) Hypercore.destroyRequests(l, err)
  }
}

function readOpts (opts, list) {
  return { timeout: opts.timeout, wait: opts.wait, activeRequests: list }
}

// the 16 z tiles under the z-2 cell (px, py), row-major (y outer, x inner), as parallel gets
function readCell (bee, z, px, py, opts) {
  const gets = []
  for (let y = py << 2; y < (py << 2) + 4; y++) {
    for (let x = px << 2; x < (px << 2) + 4; x++) gets.push(bee.get(tileKey(z, x, y), opts))
  }
  return Promise.all(gets)
}

// Cell contract: zoom z with the 16 tiles of its z-2 cell in row-major order. When at least one tile
// is present the result stays at zoom z and each missing tile is null, which the client draws blank.
// When all 16 are missing the result is null: outside the atlas, or a filler cell the builder skipped.
async function readTiles (bee, point, z, opts = {}, requests = new Requests()) {
  const cell = lonLatToTile(point.lon, point.lat, z - 2)
  const entries = await readCell(bee, z, cell.x, cell.y, readOpts(opts, requests.list()))
  if (!entries.some(Boolean)) return null
  return { zoom: z, cell, tiles: entries.map((e) => (e ? e.value : null)) }
}

// null for a value that is not a place entry: the label is best effort and one bad entry must not sink it
function parsePlace (value) {
  let p = null
  try {
    p = JSON.parse(b4a.toString(value))
  } catch {
    return null
  }
  if (!p || typeof p.name !== 'string' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null
  return p
}

// nearest city or town in the z8 cell of the point and its 8 neighbours;
// one cell alone misses a nearer place across its edge (test/gazetteer.js)
async function readLabel (bee, point, opts = {}, requests = new Requests()) {
  const c = lonLatToTile(point.lon, point.lat, LABEL_ZOOM)
  const n = 2 ** LABEL_ZOOM
  const ranges = []
  for (let dy = -1; dy <= 1; dy++) {
    const y = c.y + dy
    if (y < 0 || y >= n) continue
    for (let dx = -1; dx <= 1; dx++) {
      ranges.push(subtreeRange(GAZ_ZOOM, quadkey((c.x + dx + n) % n, y, LABEL_ZOOM), 'g/'))
    }
  }
  const lists = ranges.map(() => requests.list())
  let best = null
  try {
    await Promise.all(ranges.map(async (range, i) => {
      for await (const e of bee.createReadStream({ ...range, ...readOpts(opts, lists[i]) })) {
        const p = parsePlace(e.value)
        if (!p) continue
        const km = haversineKm(point, p)
        if (!best || km < best.km) best = { name: p.name, kind: p.kind_detail, km }
      }
    }))
  } catch (err) {
    for (const l of lists) Hypercore.destroyRequests(l, err)
    throw err
  }
  return best
}

function checkOpts (opts) {
  if (!opts || !(Number.isFinite(opts.timeout) && opts.timeout > 0)) {
    throw new TypeError('readPreview needs opts.timeout, the per-block timeout in ms')
  }
  if (opts.deadline !== undefined && !(Number.isFinite(opts.deadline) && opts.deadline > 0)) {
    throw new TypeError('opts.deadline must be a positive number of ms')
  }
}

function noop () {}

// One call per shared location: the z14 cell, else the z10 cell, plus the nearest place.
// opts.timeout (required) bounds each block read and opts.deadline bounds the whole call; on either
// the call rejects with REQUEST_TIMEOUT and destroys every request it made, so the caller shows text
// instead. The label is best effort: its failure gives label null and never rejects the call.
async function readPreview (bee, point, opts) {
  checkOpts(opts)
  const requests = new Requests()
  let timer = null
  const deadline = opts.deadline === undefined
    ? null
    : new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(REQUEST_TIMEOUT('Preview deadline passed')), opts.deadline)
    })
  try {
    const work = Promise.all([
      readTiles(bee, point, DETAIL_ZOOM, opts, requests)
        .then((r) => r || readTiles(bee, point, FALLBACK_ZOOM, opts, requests)),
      readLabel(bee, point, opts, requests).catch(() => null)
    ])
    work.catch(noop) // when the deadline wins, the cancelled work rejects later with nobody waiting
    const [tiles, label] = await (deadline ? Promise.race([work, deadline]) : work)
    return { ...(tiles || NO_TILES), label }
  } catch (err) {
    requests.destroy(err)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = { DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM, readCell, readTiles, readLabel, readPreview }
