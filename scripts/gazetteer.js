'use strict'
// usage: gazetteer.js <out.json> [--kinds=a,b] [--areas] (<archive> <bbox> <minz> <maxz>)...
// --areas collects the neighbourhood, suburb and village labels deriveAddress wants instead of
// localities, and writes them for a/ keys; harvest them from z13, where 91% of the neighbourhood
// labels are already present and a z14 pass costs four times as many tile entries.
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const perf = require('bare-performance')
const { Compression, tileIdToZxy } = require('pmtiles')
const { openArchive, directories, readValues } = require('./pmtiles-file')
const { assertBbox, lonLatToTile, parseBbox } = require('./tiles')
const { parseFlags } = require('./flags')
const { decodeGzip } = require('./mvt')
const { haversineKm, gazKeys, areaKeys, areaClass } = require('./gazetteer-lib')

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

// Every tile of the archive the rectangle walk would have decoded, in that walk's order, with each
// entry's offset and length so the values can be read in file order.
async function collectTiles (archive, header, bbox, minz, maxz, kinds, areas, stats) {
  assertBbox(bbox)
  // the values come straight off the archive now rather than through getZxy, which decompressed
  // whatever the header named
  if (header.tileCompression !== Compression.Gzip) throw new Error(`tileCompression ${header.tileCompression} is not gzip`)
  if (header.maxZoom > MAX_ZOOM) throw new Error(`the pass packs zooms up to ${MAX_ZOOM}, archive has ${header.maxZoom}`)
  if (header.numTileEntries >= MAX_ENTRIES) throw new Error(`the pass packs up to ${MAX_ENTRIES} entries, archive has ${header.numTileEntries}`)
  const n = header.numTileEntries
  const tileIds = new Float64Array(n)
  const runLengths = new Uint32Array(n)
  const offsets = new Float64Array(n)
  const lengths = new Uint32Array(n)
  const keep = new Uint8Array(n)
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
  for await (const { tiles } of directories(archive, header)) {
    stats.dirs++
    for (const e of tiles) {
      if (stats.entries === n) throw new Error(`archive has more tile entries than its header's ${n}`)
      const i = stats.entries++
      tileIds[i] = e.tileId
      runLengths[i] = e.runLength
      offsets[i] = e.offset
      lengths[i] = e.length
      if (e.runLength === 1) {
        const [z, x, y] = tileIdToZxy(e.tileId)
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
      const [z0] = tileIdToZxy(e.tileId)
      const [z1] = tileIdToZxy(e.tileId + e.runLength - 1)
      if (z1 < minz || z0 > maxz) continue
      let has = probed.get(e.offset)
      if (has === undefined) {
        stats.runBlobs++
        const [value] = await readValues(archive, header, [{ offset: e.offset, length: e.length }])
        has = hasKept(value, kinds, areas)
        probed.set(e.offset, has)
      }
      if (!has) {
        stats.fillerRuns++
        stats.fillerTiles += e.runLength
        continue
      }
      let kept = 0
      for (let r = 0; r < e.runLength; r++) {
        const [z, x, y] = tileIdToZxy(e.tileId + r)
        if (inRange(z, x, y)) kept++
      }
      if (kept === 0) continue
      keep[i] = 1
      stats.tiles += kept
    }
  }
  const packed = new BigUint64Array(stats.tiles)
  let k = 0
  for (let i = 0; i < stats.entries; i++) {
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
  return { packed, offsets, lengths }
}

function unpack (v) {
  return {
    z: MAX_ZOOM - Number(v >> Z_SHIFT),
    y: Number((v >> Y_SHIFT) & COORD_MASK),
    x: Number((v >> X_SHIFT) & COORD_MASK),
    entry: Number(v & ENTRY_MASK)
  }
}

function collectTile (value, { z, x, y }, bbox, byName, counts, kinds, areas) {
  const layer = decodeGzip(value).layers.places
  if (!layer) return
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    const p = f.properties
    if (p.kind === 'region') counts.regionFeatures++
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
  const { packed, offsets, lengths } = await collectTiles(archive, header, bbox, minz, maxz, kinds, areas, stats)
  if (log) log(`walk entries ${stats.entries} tiles ${stats.tiles} dirs ${stats.dirs} fillerRuns ${stats.fillerRuns} fillerTiles ${stats.fillerTiles} runBlobs ${stats.runBlobs}\tsort ms ${stats.sortMs}\tms ${Math.round(perf.now() - tw)}`)
  const t0 = perf.now()
  let j = 0
  while (j < packed.length) {
    const chunk = []
    let bytes = 0
    while (j < packed.length && chunk.length < CHUNK_TILES && bytes < CHUNK_BYTES) {
      const t = unpack(packed[j++])
      bytes += lengths[t.entry]
      chunk.push(t)
    }
    // one coalesced read per chunk: the visit order is not file order, so the entries are sorted
    // back into file order to read and then decoded in visit order
    const entries = [...new Set(chunk.map((t) => t.entry))].sort((p, q) => offsets[p] - offsets[q])
    const values = await readValues(archive, header, entries.map((e) => ({ offset: offsets[e], length: lengths[e] })))
    const byEntry = new Map(entries.map((e, i) => [e, values[i]]))
    for (const t of chunk) collectTile(byEntry.get(t.entry), t, bbox, byName, counts, kinds, areas)
    if (log) {
      const s = (perf.now() - t0) / 1000
      log(`tile ${j}/${packed.length}\tkept ${counts.entries.length}\telapsed ${s.toFixed(1)} s\ttiles/s ${Math.round(j / s)}`)
    }
  }
  return stats
}

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--kinds', '--areas'])
  const areas = flags.has('--areas')
  const kindsFlag = flags.get('--kinds')
  const kinds = kindsFlag ? new Set(kindsFlag.split(',')) : null
  const [out, ...rest] = args
  // the sources are read four at a time, so a missing or misspelt one shifts every later argument
  // into the wrong slot; unchecked, that once left minz/maxz NaN and reported a successful empty run
  if (!out || rest.length === 0 || rest.length % 4 !== 0) {
    throw new Error('usage: gazetteer.js [--kinds=a,b] <out.json> (<archive.pmtiles> <minLon,minLat,maxLon,maxLat> <minz> <maxz>)...')
  }
  const byName = new Map()
  const counts = { regionFeatures: 0, entries: [] }
  for (let i = 0; i < rest.length; i += 4) {
    const [path, bbox, minz, maxz] = rest.slice(i, i + 4)
    for (const [label, v] of [['minz', minz], ['maxz', maxz]]) {
      if (!/^\d+$/.test(v)) throw new Error(`${path}: ${label} must be a non-negative integer, got ${JSON.stringify(v)}`)
    }
    const before = counts.entries.length
    await collect(path, parseBbox(bbox), Number(minz), Number(maxz), byName, counts, kinds, areas, (line) => console.log(`${path}\t${line}`))
    console.log(`${path} bbox ${bbox} z${minz}-${maxz}: +${counts.entries.length - before} ${areas ? 'areas' : 'localities'}`)
  }
  const entries = counts.entries
  const perKind = {}
  for (const e of entries) perKind[e.kind_detail] = (perKind[e.kind_detail] || 0) + 1
  console.log(`region features seen (not deduped, all zooms) ${counts.regionFeatures}`)
  console.log(`${areas ? 'areas' : 'localities'} ${entries.length} by kind_detail ${JSON.stringify(perKind)}`)
  const kv = areas ? areaKeys(entries) : gazKeys(entries)
  const rawKV = kv.reduce((n, e) => n + e.key.byteLength + e.value.byteLength, 0)
  const json = Buffer.from(JSON.stringify(entries))
  console.log(`raw key+value bytes ${rawKV}`)
  console.log(`json bytes ${json.byteLength} gzip bytes ${zlib.gzipSync(json, { level: 9 }).byteLength}`)
  for (const k of areas ? ['neighbourhood', 'suburb', 'village'] : ['city', 'town']) {
    const sub = Buffer.from(JSON.stringify(entries.filter((e) => e.kind_detail === k)))
    console.log(`subset ${k}: json ${sub.byteLength} gzip ${zlib.gzipSync(sub, { level: 9 }).byteLength}`)
  }
  fs.writeFileSync(out, JSON.stringify(entries, null, 1) + '\n')
  console.log(`wrote ${out}`)
}

module.exports = { collect, collectFrom }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
