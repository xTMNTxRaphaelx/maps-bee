'use strict'
const b4a = require('b4a')
const Hypercore = require('hypercore')
const { REQUEST_TIMEOUT } = require('hypercore-errors')
const { lonLatToTile, pinTiles, quadkey, tileKey, subtreeRange } = require('./tiles')
const { GAZ_ZOOM, AREA_ZOOM, AREA_QUERY_ZOOM, haversineKm } = require('./gazetteer-lib')
const { decodeGzip } = require('./mvt')
const { deriveAddress } = require('./address')

// The 2x2 is read at the first of these that has a tile. z15 carries the complete road network and
// the address points, and its tiles are smaller than z14's because the same features spread over
// four times as many — one 2x2 now serves the thumbnail and the near address together, where it
// used to take a z14 2x2 plus a separate z15 pin tile (results/address-shapes.txt).
// z14 stays as the tier between: a z15 run is filler in open country, and without z14 such a pin
// would fall straight to a 35 km view. It costs the client nothing — the walk stops at the first
// zoom that answers, so a pin with z15 never reads z14 at all — and it only costs the publisher
// storage, which is not the constrained resource here.
const ZOOMS = [15, 14, 10]
const DETAIL_ZOOM = ZOOMS[0]
const FALLBACK_ZOOM = ZOOMS[ZOOMS.length - 1]
const LABEL_ZOOM = 8

const NO_TILES = { zoom: null, origin: null, tiles: null }

// The replicator requests of one call, so a failed call leaves nothing in flight. A hyperbee2 range
// stream kills its own list when it ends (hyperbee2/lib/ranges.js:204), so each stream gets a list
// of its own and the parallel gets share one.
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

// The 4 tiles of the pin's 2x2 (tiles.js pinTiles), row-major from origin. With at least one tile
// present the result stays at zoom z and each missing tile is null, drawn blank; with all 4 missing
// it is null — outside the atlas, or a filler 2x2 the builder skipped.
async function readTiles (bee, point, z, opts = {}, requests = new Requests()) {
  const { origin, tiles } = pinTiles(point.lon, point.lat, z)
  const o = readOpts(opts, requests.list())
  const entries = await Promise.all(tiles.map((t) => (t ? bee.get(tileKey(z, t[0], t[1]), o) : null)))
  if (!entries.some(Boolean)) return null
  return { zoom: z, origin, tiles: entries.map((e) => (e ? e.value : null)) }
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

// The cell the point is in and its 8 neighbours: one cell alone misses a nearer place across its
// edge (test/gazetteer.js). x wraps at the antimeridian; rows outside the world are skipped.
function cellRanges (point, queryZoom, keyZoom, prefix) {
  const c = lonLatToTile(point.lon, point.lat, queryZoom)
  const n = 2 ** queryZoom
  const ranges = []
  for (let dy = -1; dy <= 1; dy++) {
    const y = c.y + dy
    if (y < 0 || y >= n) continue
    for (let dx = -1; dx <= 1; dx++) {
      ranges.push(subtreeRange(keyZoom, quadkey((c.x + dx + n) % n, y, queryZoom), prefix))
    }
  }
  return ranges
}

// Every place in a set of key ranges, the ranges streamed in parallel on a request list each so a
// throw in any one of them cancels the requests of all of them. A value that is not a place entry
// is skipped rather than thrown on.
async function scanPlaces (bee, ranges, opts, requests, onPlace) {
  const lists = ranges.map(() => requests.list())
  try {
    await Promise.all(ranges.map(async (range, i) => {
      for await (const e of bee.createReadStream({ ...range, ...readOpts(opts, lists[i]) })) {
        const p = parsePlace(e.value)
        if (p) onPlace(p)
      }
    }))
  } catch (err) {
    for (const l of lists) Hypercore.destroyRequests(l, err)
    throw err
  }
}

// Every a/ area label near the point, for deriveAddress to measure and threshold. Queried over a
// 3x3 of AREA_QUERY_ZOOM rather than the z8 sweep readLabel uses: the area thresholds top out at
// 3 km, so a wide sweep would read every neighbourhood for hundreds of km in a dense city.
// Empty means the bee has no a/ keys, or none near: deriveAddress falls back to the tiles either way.
async function readAreas (bee, point, opts = {}, requests = new Requests()) {
  const out = []
  await scanPlaces(bee, cellRanges(point, AREA_QUERY_ZOOM, AREA_ZOOM, 'a/'), opts, requests, (p) => out.push(p))
  return out
}

// nearest city or town in the point's z8 cell and its 8 neighbours
async function readLabel (bee, point, opts = {}, requests = new Requests()) {
  let best = null
  await scanPlaces(bee, cellRanges(point, LABEL_ZOOM, GAZ_ZOOM, 'g/'), opts, requests, (p) => {
    const km = haversineKm(point, p)
    if (!best || km < best.km) best = { name: p.name, kind: p.kind_detail, km }
  })
  return best
}

// Inflates the top `levels` tree levels, a level at a time with its nodes in parallel, so later
// reads walk them locally. Inflating a node fetches the block of every key it references
// (hyperbee2/lib/inflate.js:18-31). Returns the node count per level.
async function prefetchTop (bee, levels, opts) {
  // the same guard readPreview gets: both are on the client surface, and an opts without a
  // timeout here waits forever against a peer that never answers
  checkOpts(opts)
  if (!Number.isInteger(levels) || levels < 1) throw new TypeError('prefetchTop needs levels, a positive integer')
  const list = []
  const config = bee.config.options(readOpts(opts, list))
  const nodes = []
  try {
    const root = await bee.bootstrap(config)
    let level = root ? [root] : []
    while (level.length > 0 && nodes.length < levels) {
      nodes.push(level.length)
      const values = await Promise.all(level.map((ptr) => bee.inflate(ptr, config)))
      level = []
      for (const v of values) {
        for (let i = 0; i < v.children.length; i++) level.push(v.children.get(i))
      }
    }
  } catch (err) {
    Hypercore.destroyRequests(list, err)
    throw err
  }
  return { nodes }
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

// The 2x2 at the first zoom in ZOOMS that has one; null when none do. The walk cannot outlive a
// deadline: destroy() cancels the gets of the round in flight, so readTiles rejects and the loop
// ends with it, and the gap between rounds is microtasks only, which no timer can land in. Measured
// by sweeping the deadline over a cold read at two latencies — 67 rejections, not one of them
// started a further round.
async function readFirst (bee, point, opts, requests) {
  for (const z of ZOOMS) {
    const r = await readTiles(bee, point, z, opts, requests)
    if (r) return r
  }
  return null
}

// the 2x2 of readTiles as decoded tiles placed on the globe, for deriveAddress
function placeCell (point, cell) {
  const placed = []
  const xy = pinTiles(point.lon, point.lat, cell.zoom).tiles
  for (let i = 0; i < xy.length; i++) {
    if (cell.tiles[i]) placed.push({ vt: decodeGzip(cell.tiles[i]), x: xy[i][0], y: xy[i][1], zoom: cell.zoom })
  }
  return placed
}

// One call per shared location: the 2x2 at the first zoom that has one, the nearest city and the
// area labels, read in parallel; the address is derived from what they return. opts.timeout bounds each block
// read, opts.deadline the whole call; on either it rejects with REQUEST_TIMEOUT and destroys its own
// requests. The label is best effort — its failure gives label null and never rejects.
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
      readFirst(bee, point, opts, requests),
      readLabel(bee, point, opts, requests).catch(() => null),
      readAreas(bee, point, opts, requests).catch(() => [])
    ])
    work.catch(noop) // when the deadline wins, the cancelled work rejects later with nobody waiting
    const [tiles, label, areas] = await (deadline ? Promise.race([work, deadline]) : work)
    const placed = tiles ? placeCell(point, tiles) : []
    // null outside the atlas, where no tile and no label exist
    // no a/ keys, or none near, means null rather than an empty list: deriveAddress reads the
    // places layer of the tiles instead of concluding there is no area
    const address = placed.length > 0 || label
      ? deriveAddress({ point, tiles: placed, label, areas: areas.length > 0 ? areas : null })
      : null
    return { ...(tiles || NO_TILES), address, label }
  } catch (err) {
    requests.destroy(err)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = { DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM, readTiles, readLabel, readAreas, readPreview, prefetchTop }
