'use strict'
// Harvests place labels out of a pmtiles archive, for the g/ and a/ keys a published atlas holds.
// collect() opens an archive and hands it to collectFrom(), which walks the entry table rather
// than the bbox rectangle; both accumulate into the caller's byName/counts so several archives can
// feed one output.
//
// areas = false collects localities for g/ keys. areas = true collects the neighbourhood, suburb
// and village labels deriveAddress wants, for a/ keys; harvest those from z13, where 91% of the
// neighbourhood labels are already present and a z14 pass costs four times as many tile entries.
const perf = require('bare-performance')
const { Compression, tileIdToZxy } = require('pmtiles')
const { openArchive, readValues, readEntryTable, valueChunks } = require('./pmtiles-file')
const { assertBbox, lonLatToTile } = require('../tiles')
const { decodeGzip } = require('../mvt')
const { haversineKm, areaClass } = require('../gazetteer-lib')

const DUP_KM = 5
// neighbourhoods sit a few hundred metres apart, so the locality dedupe would merge them
const AREA_DUP_KM = 0.3

// one BigUint64 per tile: MAX_ZOOM - z in bits 58-63, y in 42-57, x in 26-41, entry index in 0-25,
// so a numeric sort is the visit order — deepest zoom first, then row-major from the top left.
// That order is what the dedupe below reads: it keeps the first point it sees for a name, so the
// deepest tile wins, and a change of order silently changes which point every duplicate keeps.
const MAX_ZOOM = 16
const MAX_ENTRIES = 2 ** 26
const Z_SHIFT = 58n
const Y_SHIFT = 42n
const X_SHIFT = 26n
const COORD_MASK = 0xffffn
const ENTRY_MASK = (1n << X_SHIFT) - 1n

// a chunk's values are held in memory at once, so it is bounded by bytes as well as by tiles
const CHUNK_TILES = 20000
const CHUNK_BYTES = 64 * 1024 * 1024

// kind_detail is null for a locality the build left unclassified, so rejection needs its own value
const SKIP = Symbol('skip')

function inBbox (p, b) {
  return p.lon >= b[0] && p.lat >= b[1] && p.lon <= b[2] && p.lat <= b[3]
}

// the tile range the bbox spans at one zoom, the rectangle the pass used to walk tile by tile
function bboxRange (bbox, z) {
  const tl = lonLatToTile(bbox[0], bbox[3], z)
  const br = lonLatToTile(bbox[2], bbox[1], z)
  return { minX: tl.x, maxX: br.x, minY: tl.y, maxY: br.y }
}

// the kind the pass records for a feature, or SKIP. Properties only: the run probe asks this
// without a tile to place the geometry in.
function keptKind (p, kinds, areas) {
  if (areas) return areaClass(p) || SKIP
  if (p.kind !== 'locality' || !p.name) return SKIP
  if (kinds && !kinds.has(p.kind_detail)) return SKIP
  return p.kind_detail || null
}

function hasKept (tile, kinds, areas) {
  const layer = decodeGzip(tile).layers.places
  if (!layer) return false
  for (let i = 0; i < layer.length; i++) {
    if (keptKind(layer.feature(i).properties, kinds, areas) !== SKIP) return true
  }
  return false
}

// kinds: a Set of kind_detail values to keep, or null for every locality
async function collect (path, bbox, minz, maxz, byName, counts, kinds = null, areas = false, log = null) {
  const archive = openArchive(path)
  try {
    const header = await archive.getHeader()
    return await collectFrom(archive, header, bbox, minz, maxz, byName, counts, kinds, areas, log)
  } finally {
    await archive.close()
  }
}

// Every tile of the archive the rectangle walk would have decoded, in that walk's order, over the
// archive's entry table so the values can be read in file order.
async function collectTiles (archive, header, bbox, minz, maxz, kinds, areas, stats) {
  assertBbox(bbox)
  // the values come straight off the archive now rather than through getZxy, which decompressed
  // whatever the header named
  if (header.tileCompression !== Compression.Gzip) throw new Error(`tileCompression ${header.tileCompression} is not gzip`)
  if (header.maxZoom > MAX_ZOOM) throw new Error(`the pass packs zooms up to ${MAX_ZOOM}, archive has ${header.maxZoom}`)
  if (header.numTileEntries >= MAX_ENTRIES) throw new Error(`the pass packs up to ${MAX_ENTRIES} entries, archive has ${header.numTileEntries}`)
  const table = await readEntryTable(archive, header)
  const { tileIds, runLengths, offsets, lengths } = table
  stats.entries = table.count
  stats.dirs = table.dirs
  const keep = new Uint8Array(table.count)
  const ranges = new Map()
  const inRange = (z, x, y) => {
    if (z < minz || z > maxz) return false
    let r = ranges.get(z)
    if (!r) {
      r = bboxRange(bbox, z)
      ranges.set(z, r)
    }
    return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY
  }
  // one entry per distinct run blob: does it hold anything this pass keeps
  const probed = new Map()
  for (let i = 0; i < table.count; i++) {
    if (runLengths[i] === 1) {
      const [z, x, y] = tileIdToZxy(tileIds[i])
      if (!inRange(z, x, y)) continue
      keep[i] = 1
      stats.tiles++
      continue
    }
    // A run is one blob repeated over consecutive tile ids — on the planet, the empty ocean
    // filler: 7.7M runs covering 236.6M tiles at z14. Probe each distinct blob once and skip the
    // whole run when it holds nothing to harvest, rather than walking tiles that cannot
    // contribute. A run that does hold a place is expanded tile by tile, because toGeoJSON puts
    // the same local geometry at a different lon/lat in each tile of the run.
    const [z0] = tileIdToZxy(tileIds[i])
    const [z1] = tileIdToZxy(tileIds[i] + runLengths[i] - 1)
    if (z1 < minz || z0 > maxz) continue
    let has = probed.get(offsets[i])
    if (has === undefined) {
      stats.runBlobs++
      const [value] = await readValues(archive, header, [{ offset: offsets[i], length: lengths[i] }])
      has = hasKept(value, kinds, areas)
      probed.set(offsets[i], has)
    }
    if (!has) {
      stats.fillerRuns++
      stats.fillerTiles += runLengths[i]
      continue
    }
    let kept = 0
    for (let r = 0; r < runLengths[i]; r++) {
      const [z, x, y] = tileIdToZxy(tileIds[i] + r)
      if (inRange(z, x, y)) kept++
    }
    if (kept === 0) continue
    keep[i] = 1
    stats.tiles += kept
  }
  const packed = new BigUint64Array(stats.tiles)
  let k = 0
  for (let i = 0; i < table.count; i++) {
    if (keep[i] === 0) continue
    for (let r = 0; r < runLengths[i]; r++) {
      const [z, x, y] = tileIdToZxy(tileIds[i] + r)
      if (!inRange(z, x, y)) continue
      packed[k++] = (BigInt(MAX_ZOOM - z) << Z_SHIFT) | (BigInt(y) << Y_SHIFT) | (BigInt(x) << X_SHIFT) | BigInt(i)
    }
  }
  const ts = perf.now()
  packed.sort()
  stats.sortMs = Math.round(perf.now() - ts)
  return { packed, table }
}

function * unpackAll (packed) {
  for (const v of packed) {
    yield {
      z: MAX_ZOOM - Number(v >> Z_SHIFT),
      y: Number((v >> Y_SHIFT) & COORD_MASK),
      x: Number((v >> X_SHIFT) & COORD_MASK),
      entry: Number(v & ENTRY_MASK)
    }
  }
}

function collectTile (value, { z, x, y }, bbox, byName, counts, kinds, areas) {
  const layer = decodeGzip(value).layers.places
  if (!layer) return
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    const p = f.properties
    const kindDetail = keptKind(p, kinds, areas)
    if (kindDetail === SKIP) continue
    const g = f.toGeoJSON(x, y, z).geometry
    if (g.type !== 'Point') continue
    const pt = { lon: Math.round(g.coordinates[0] * 1e5) / 1e5, lat: Math.round(g.coordinates[1] * 1e5) / 1e5 }
    if (!inBbox(pt, bbox)) continue
    const id = p.name + '|' + (kindDetail || '')
    const list = byName.get(id) || []
    if (list.some((q) => haversineKm(q, pt) < (areas ? AREA_DUP_KM : DUP_KM))) continue
    list.push(pt)
    byName.set(id, list)
    counts.entries.push({ name: p.name, kind_detail: kindDetail, population: p.population || null, lon: pt.lon, lat: pt.lat })
  }
}

// Driven by what the archive holds, not by the size of the bbox: the rectangle at z13 is 67.1M
// tiles whether the archive has 64 of them or 8M, and asking for the misses one by one cost 2 min
// of nothing on a Jaipur extract (results/gazetteer-entry-walk.txt).
async function collectFrom (archive, header, bbox, minz, maxz, byName, counts, kinds, areas = false, log = null) {
  const stats = { entries: 0, tiles: 0, dirs: 0, fillerRuns: 0, fillerTiles: 0, runBlobs: 0, sortMs: 0 }
  const tw = perf.now()
  const { packed, table } = await collectTiles(archive, header, bbox, minz, maxz, kinds, areas, stats)
  if (log) log(`walk entries ${stats.entries} tiles ${stats.tiles} dirs ${stats.dirs} fillerRuns ${stats.fillerRuns} fillerTiles ${stats.fillerTiles} runBlobs ${stats.runBlobs}\tsort ms ${stats.sortMs}\tms ${Math.round(perf.now() - tw)}`)
  const t0 = perf.now()
  const chunks = valueChunks(archive, header, unpackAll(packed), table, { maxTiles: CHUNK_TILES, maxBytes: CHUNK_BYTES })
  for await (const c of chunks) {
    for (const t of c.tiles) collectTile(c.value(t), t, bbox, byName, counts, kinds, areas)
    if (log) {
      const s = (perf.now() - t0) / 1000
      log(`tile ${c.read}/${packed.length}\tkept ${counts.entries.length}\telapsed ${s.toFixed(1)} s\ttiles/s ${Math.round(c.read / s)}`)
    }
  }
  return stats
}

module.exports = { collect, collectFrom }
