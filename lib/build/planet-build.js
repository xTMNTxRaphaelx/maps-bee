'use strict'
const fs = require('bare-fs')
const perf = require('bare-performance')
const { Compression, tileIdToZxy, zxyToTileId } = require('pmtiles')
const { openArchive, directories, readValues, readEntryTable, valueChunks } = require('./pmtiles-file')
const { tileKey, mortonCode, mortonToXY } = require('../tiles')

const FLUSH_PUTS = 20000
const FLUSH_BYTES = 64 * 1024 * 1024
const STALL_MS = 60000

// one BigUint64 per tile: zoom in bits 58-63, quadkey in 26-57 (z <= 16), entry index in 0-25,
// so a numeric sort is key order (keys are zz/quadkey)
const Z_SHIFT = 58n
const MORTON_SHIFT = 26n
const MAX_SORTED_ZOOM = 16
const MAX_SORTED_ENTRIES = 2 ** 26
const MORTON_MASK = (1n << (Z_SHIFT - MORTON_SHIFT)) - 1n
const ENTRY_MASK = (1n << MORTON_SHIFT) - 1n

// Every tile the directory walk would put, in key order, over the archive's entry table so the
// values can be read in chunks of that order.
async function collectSorted (archive, header, expandRunsUpToZoom) {
  if (header.maxZoom > MAX_SORTED_ZOOM) throw new Error(`sorted build packs zooms up to ${MAX_SORTED_ZOOM}, archive has ${header.maxZoom}`)
  if (header.numTileEntries >= MAX_SORTED_ENTRIES) throw new Error(`sorted build packs up to ${MAX_SORTED_ENTRIES} entries, archive has ${header.numTileEntries}`)
  const table = await readEntryTable(archive, header)
  const { tileIds, runLengths } = table
  const stats = { entries: table.count, tiles: 0, dirs: table.dirs, fillerRuns: 0, fillerTiles: 0, sortMs: 0 }
  // A tile deeper than expandRunsUpToZoom is filler the build drops, so it takes no slot in
  // packed. Counted per tile, not per run: pmtiles ids are contiguous across zooms, so a run can
  // begin at the last tile of one zoom and continue into the next, and classifying the whole run
  // by its first tile would write keys at a zoom meant to stay filler — drifting the
  // puts + fillerTiles == 4^zoom check that is the build's only coverage proof. Ids below the
  // first of expandRunsUpToZoom + 1 are exactly the tiles at or above it, so the split is one
  // subtraction rather than a walk.
  // A lone tile is real data and is always kept, at any zoom — expandRunsUpToZoom bounds how deep
  // a *run* is expanded, not which tiles exist.
  const firstDeeper = zxyToTileId(expandRunsUpToZoom + 1, 0, 0)
  const expandCount = (i) => (runLengths[i] === 1 ? 1 : Math.min(Math.max(firstDeeper - tileIds[i], 0), runLengths[i]))
  for (let i = 0; i < stats.entries; i++) {
    const n = expandCount(i)
    stats.tiles += n
    if (n < runLengths[i]) {
      stats.fillerRuns++
      stats.fillerTiles += runLengths[i] - n
    }
  }
  const packed = new BigUint64Array(stats.tiles)
  let k = 0
  for (let i = 0; i < stats.entries; i++) {
    const n = expandCount(i)
    for (let r = 0; r < n; r++) {
      const [rz, rx, ry] = tileIdToZxy(tileIds[i] + r)
      packed[k++] = (BigInt(rz) << Z_SHIFT) | (BigInt(mortonCode(rx, ry, rz)) << MORTON_SHIFT) | BigInt(i)
    }
  }
  const ts = perf.now()
  packed.sort()
  stats.sortMs = Math.round(perf.now() - ts)
  return { packed, table, stats }
}

function * unpackAll (packed) {
  for (const v of packed) {
    const z = Number(v >> Z_SHIFT)
    const { x, y } = mortonToXY(Number((v >> MORTON_SHIFT) & MORTON_MASK), z)
    yield { z, x, y, entry: Number(v & ENTRY_MASK) }
  }
}

// logs the phase on each tick it has not changed, to name the await a hung build is stuck on
// (results/planet-c1-sorted.txt run 1 went idle with no error; results/planet-build-hardening.txt
// is the run that added this). returns the stop function
function stallWatch (phase, ms, log) {
  let last = phase()
  const timer = setInterval(() => {
    const now = phase()
    if (now === last) log(`stall ${ms / 1000} s in ${now}`)
    last = now
  }, ms)
  return () => clearInterval(timer)
}

// A checkpoint that does not parse, or parses to the wrong shape, used to read as "start from the
// beginning" in silence — which is the one outcome --resume exists to avoid, and costs a day on a
// planet run. Unusable is still not fatal, but it says so.
function readProgress (file, log) {
  let raw = null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    log(`resume: no progress file at ${file}, starting from the first archive`)
    return null
  }
  try {
    const p = JSON.parse(raw)
    if (!p || !Number.isInteger(p.archive) || !Number.isInteger(p.dir)) throw new Error('not a checkpoint')
    return p
  } catch {
    log(`resume: ${file} is not a usable checkpoint, starting from the first archive`)
    return null
  }
}

// Every unique tile of the archives, as gzip bytes copied raw from the archive.
// A run of identical tiles expands to one key per tile up to expandRunsUpToZoom, so those zooms are
// complete and the client can tell land from ocean; deeper runs are filler, and a missing key there
// means blank. progressFile records the last fully flushed directory; resume skips to it, redoing an
// interrupted directory from its start. sorted puts each archive in key order so consecutive puts
// share leaves — archives must not overlap in zoom, and the run has no checkpoint.
async function buildPlanet (bee, archives, opts = {}) {
  const {
    expandRunsUpToZoom,
    flushPuts = FLUSH_PUTS,
    flushBytes = FLUSH_BYTES,
    progressFile = null,
    resume = false,
    maxDirs = Infinity,
    sorted = false,
    inlineValueSize,
    log = console.log
  } = opts
  if (!Number.isInteger(expandRunsUpToZoom)) throw new TypeError('expandRunsUpToZoom must be an integer zoom')
  if (sorted && resume) throw new Error('a sorted build cannot resume')
  if (sorted) await checkZoomOrder(archives)
  // the first tile id past expandRunsUpToZoom, for the per-tile run split below; collectSorted
  // computes the same bound for its own pass
  const firstDeeper = zxyToTileId(expandRunsUpToZoom + 1, 0, 0)
  const core = bee.core
  const done = resume && progressFile ? readProgress(progressFile, log) : null
  const totals = { puts: 0, bytes: 0, flushes: 0, fillerRuns: 0, fillerTiles: 0, dirs: 0, lastKey: null }
  const t0 = perf.now()
  let batch = bee.write({ inlineValueSize })
  let batchPuts = 0
  let batchBytes = 0
  let completed = null
  let phase = null

  const checkpoint = () => {
    if (!progressFile || !completed) return
    // written on every flush, so a kill eventually lands inside one. writeFileSync truncates
    // first, so an interrupted write leaves a file that parses to nothing; rename is atomic, so
    // the reader sees either the previous checkpoint or this one.
    fs.writeFileSync(progressFile + '.tmp', JSON.stringify(completed) + '\n')
    fs.renameSync(progressFile + '.tmp', progressFile)
  }
  const flush = async (a, progress) => {
    await batch.flush()
    totals.flushes++
    batch = bee.write({ inlineValueSize })
    batchPuts = 0
    batchBytes = 0
    checkpoint()
    const s = (perf.now() - t0) / 1000
    log(`archive ${a + 1}/${archives.length}\t${progress}\tputs ${totals.puts}\tfillerRuns ${totals.fillerRuns}\tfillerTiles ${totals.fillerTiles}\tbytes ${totals.bytes}\tcore.length ${core.length}\telapsed ${s.toFixed(1)} s\tputs/s ${Math.round(totals.puts / s)}`)
  }
  const put = (key, value) => {
    batch.tryPut(key, value)
    totals.puts++
    totals.bytes += value.byteLength
    batchPuts++
    batchBytes += value.byteLength
    totals.lastKey = key
  }

  // one batch per chunk of the sorted order; each chunk reads its entries in file order, puts in key order
  const putSorted = async (archive, header, a) => {
    const tc = perf.now()
    const { packed, table, stats } = await collectSorted(archive, header, expandRunsUpToZoom)
    totals.dirs += stats.dirs
    totals.fillerRuns += stats.fillerRuns
    totals.fillerTiles += stats.fillerTiles
    log(`archive ${a + 1}/${archives.length}\tcollect entries ${stats.entries} tiles ${stats.tiles} dirs ${stats.dirs} fillerRuns ${stats.fillerRuns} fillerTiles ${stats.fillerTiles}\tsort ms ${stats.sortMs}\tms ${Math.round(perf.now() - tc)}`)
    let chunk = 0
    const chunks = valueChunks(archive, header, unpackAll(packed), table, {
      maxTiles: flushPuts,
      maxBytes: flushBytes,
      onRead: (entries, tiles) => { phase = `read chunk ${chunk} (${entries} entries, ${tiles} tiles)` }
    })
    for await (const c of chunks) {
      for (const t of c.tiles) put(tileKey(t.z, t.x, t.y), c.value(t))
      phase = `flush ${chunk}`
      await flush(a, `tile ${c.read}/${packed.length}`)
      chunk++
    }
  }

  for (let a = 0; a < archives.length; a++) {
    if (done && a < done.archive) continue
    const archive = openArchive(archives[a])
    // the fd goes back in a finally: the gzip check, readValues and every put can throw
    try {
      const header = await archive.getHeader()
      if (header.tileCompression !== Compression.Gzip) {
        throw new Error(`${archives[a]}: tileCompression ${header.tileCompression} is not gzip`)
      }
      if (sorted) {
        phase = `collect archive ${a + 1}`
        const stop = stallWatch(() => phase, STALL_MS, log)
        try {
          await putSorted(archive, header, a)
        } finally {
          stop()
        }
        continue
      }
      let dir = 0
      let total = 1
      for await (const { tiles, pending } of directories(archive, header)) {
        total += pending
        if (totals.dirs >= maxDirs) break
        if (done && a === done.archive && dir <= done.dir) {
          dir++
          continue
        }
        const values = await readValues(archive, header, tiles)
        for (let i = 0; i < tiles.length; i++) {
          const e = tiles[i]
          const [z, x, y] = tileIdToZxy(e.tileId)
          if (e.runLength === 1) {
            put(tileKey(z, x, y), values[i])
            continue
          }
          // per tile, as collectSorted counts them; see the note there
          const n = Math.min(Math.max(firstDeeper - e.tileId, 0), e.runLength)
          for (let r = 0; r < n; r++) {
            const [rz, rx, ry] = tileIdToZxy(e.tileId + r)
            put(tileKey(rz, rx, ry), values[i])
          }
          if (n < e.runLength) {
            totals.fillerRuns++
            totals.fillerTiles += e.runLength - n
          }
          if (batchPuts >= flushPuts || batchBytes >= flushBytes) await flush(a, `dir ${dir}/${total}`)
        }
        completed = { archive: a, dir }
        totals.dirs++
        dir++
      }
      if (batchPuts > 0) await flush(a, `dir ${dir}/${total}`)
      else checkpoint()
    } finally {
      await archive.close()
    }
    if (totals.dirs >= maxDirs) break
  }
  totals.elapsedMs = perf.now() - t0
  return totals
}

// keys in a sorted build ascend across archives only if each archive's zooms lie above the last's
async function checkZoomOrder (archives) {
  let prev = null
  for (const file of archives) {
    const archive = openArchive(file)
    const header = await archive.getHeader()
    await archive.close()
    if (prev && header.minZoom <= prev.maxZoom) {
      throw new Error(`sorted build needs archives in zoom order: ${file} starts at z${header.minZoom}, the one before ends at z${prev.maxZoom}`)
    }
    prev = header
  }
}

// collectSorted is exported for test/build/planet-build.js alone: no fixture archive contains a
// run that crosses a zoom boundary, so the only way to cover that split is to hand it one.
module.exports = { buildPlanet, stallWatch, collectSorted, FLUSH_PUTS, FLUSH_BYTES }
