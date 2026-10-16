'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const perf = require('bare-performance')
const Corestore = require('corestore')
const { Compression, tileIdToZxy } = require('pmtiles')
const { openArchive, directories, readValues } = require('./pmtiles-file')
const { tileKey, mortonCode, mortonToXY } = require('./tiles')
const { load } = require('./keys')
const { openDraft } = require('./publish')
const { parseFlags, intFlag } = require('./flags')

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

// Every tile the directory walk would put, in key order, with each entry's offset and length so
// values can be read in chunks of that order.
async function collectSorted (archive, header, expandRunsUpToZoom) {
  if (header.maxZoom > MAX_SORTED_ZOOM) throw new Error(`sorted build packs zooms up to ${MAX_SORTED_ZOOM}, archive has ${header.maxZoom}`)
  if (header.numTileEntries >= MAX_SORTED_ENTRIES) throw new Error(`sorted build packs up to ${MAX_SORTED_ENTRIES} entries, archive has ${header.numTileEntries}`)
  const tileIds = new Float64Array(header.numTileEntries)
  const runLengths = new Uint32Array(header.numTileEntries)
  const offsets = new Float64Array(header.numTileEntries)
  const lengths = new Uint32Array(header.numTileEntries)
  const stats = { entries: 0, tiles: 0, dirs: 0, fillerRuns: 0, fillerTiles: 0, sortMs: 0 }
  for await (const { tiles } of directories(archive, header)) {
    stats.dirs++
    for (const e of tiles) {
      if (stats.entries === header.numTileEntries) throw new Error(`archive has more tile entries than its header's ${header.numTileEntries}`)
      const i = stats.entries++
      tileIds[i] = e.tileId
      runLengths[i] = e.runLength
      offsets[i] = e.offset
      lengths[i] = e.length
      if (e.runLength === 1 || tileIdToZxy(e.tileId)[0] <= expandRunsUpToZoom) {
        stats.tiles += e.runLength
      } else {
        stats.fillerRuns++
        stats.fillerTiles += e.runLength
      }
    }
  }
  const packed = new BigUint64Array(stats.tiles)
  let k = 0
  for (let i = 0; i < stats.entries; i++) {
    const [z] = tileIdToZxy(tileIds[i])
    if (runLengths[i] !== 1 && z > expandRunsUpToZoom) continue
    for (let r = 0; r < runLengths[i]; r++) {
      const [rz, rx, ry] = tileIdToZxy(tileIds[i] + r)
      packed[k++] = (BigInt(rz) << Z_SHIFT) | (BigInt(mortonCode(rx, ry, rz)) << MORTON_SHIFT) | BigInt(i)
    }
  }
  const ts = perf.now()
  packed.sort()
  stats.sortMs = Math.round(perf.now() - ts)
  return { packed, offsets, lengths, stats }
}

function unpack (v) {
  const z = Number(v >> Z_SHIFT)
  const { x, y } = mortonToXY(Number((v >> MORTON_SHIFT) & MORTON_MASK), z)
  return { z, x, y, entry: Number(v & ENTRY_MASK) }
}

// logs the phase on each tick it has not changed, to name the await a hung build is stuck on
// (results/planet-c1-sorted.txt run 1 went idle with no error); returns the stop function
function stallWatch (phase, ms, log) {
  let last = phase()
  const timer = setInterval(() => {
    const now = phase()
    if (now === last) log(`stall ${ms / 1000} s in ${now}`)
    last = now
  }, ms)
  return () => clearInterval(timer)
}

function readProgress (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
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
  const core = bee.core
  const done = resume && progressFile ? readProgress(progressFile) : null
  const totals = { puts: 0, bytes: 0, flushes: 0, fillerRuns: 0, fillerTiles: 0, dirs: 0, lastKey: null }
  const t0 = perf.now()
  let batch = bee.write({ inlineValueSize })
  let batchPuts = 0
  let batchBytes = 0
  let completed = null
  let phase = null

  const checkpoint = () => {
    if (progressFile && completed) fs.writeFileSync(progressFile, JSON.stringify(completed) + '\n')
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
    const { packed, offsets, lengths, stats } = await collectSorted(archive, header, expandRunsUpToZoom)
    totals.dirs += stats.dirs
    totals.fillerRuns += stats.fillerRuns
    totals.fillerTiles += stats.fillerTiles
    log(`archive ${a + 1}/${archives.length}\tcollect entries ${stats.entries} tiles ${stats.tiles} dirs ${stats.dirs} fillerRuns ${stats.fillerRuns} fillerTiles ${stats.fillerTiles}\tsort ms ${stats.sortMs}\tms ${Math.round(perf.now() - tc)}`)
    let j = 0
    let chunk = 0
    while (j < packed.length) {
      const tiles = []
      let bytes = 0
      while (j < packed.length && tiles.length < flushPuts && bytes < flushBytes) {
        const t = unpack(packed[j++])
        bytes += lengths[t.entry]
        tiles.push(t)
      }
      const entries = [...new Set(tiles.map((t) => t.entry))].sort((p, q) => offsets[p] - offsets[q])
      phase = `read chunk ${chunk} (${entries.length} entries, ${tiles.length} tiles)`
      const values = await readValues(archive, header, entries.map((e) => ({ offset: offsets[e], length: lengths[e] })))
      const byEntry = new Map(entries.map((e, i) => [e, values[i]]))
      for (const t of tiles) put(tileKey(t.z, t.x, t.y), byEntry.get(t.entry))
      phase = `flush ${chunk}`
      await flush(a, `tile ${j}/${packed.length}`)
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
          } else if (z <= expandRunsUpToZoom) {
            for (let r = 0; r < e.runLength; r++) {
              const [rz, rx, ry] = tileIdToZxy(e.tileId + r)
              put(tileKey(rz, rx, ry), values[i])
            }
          } else {
            totals.fillerRuns++
            totals.fillerTiles += e.runLength
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

const FLAGS = ['--resume', '--sorted', '--inline-value-size', '--flush-puts', '--flush-bytes']

function parseArgs (argv) {
  const { flags, args } = parseFlags(argv, FLAGS)
  const [storeDir, keysDir, name, zoom, ...archives] = args
  if (!storeDir || !keysDir || !name || !zoom || archives.length === 0) {
    throw new Error('usage: planet-build.js [--resume] [--sorted] [--inline-value-size=N] [--flush-puts=N] [--flush-bytes=N] <storeDir> <keysDir> <draftName> <expandRunsUpToZoom> <archive.pmtiles>...')
  }
  return {
    storeDir,
    keysDir,
    name,
    expandRunsUpToZoom: Number(zoom),
    archives,
    resume: flags.has('--resume'),
    sorted: flags.has('--sorted'),
    inlineValueSize: intFlag(flags, '--inline-value-size', 0),
    flushPuts: intFlag(flags, '--flush-puts', 1),
    flushBytes: intFlag(flags, '--flush-bytes', 1)
  }
}

async function main () {
  const args = parseArgs(Bare.argv.slice(2))
  const store = new Corestore(args.storeDir)
  // a planet build runs for hours; a throw partway must still put the draft and the store down
  try {
    const { draft, bee } = await openDraft(store, load(args.keysDir), args.name)
    try {
      const progressFile = path.join(args.storeDir, 'planet-build.progress')
      console.log(`draft ${args.name} length ${draft.length} resume ${args.resume} sorted ${args.sorted} inlineValueSize ${args.inlineValueSize ?? 'default'} flushPuts ${args.flushPuts ?? FLUSH_PUTS} flushBytes ${args.flushBytes ?? FLUSH_BYTES} progress ${progressFile}`)
      const totals = await buildPlanet(bee, args.archives, { ...args, progressFile })
      const last = totals.lastKey ? await bee.get(totals.lastKey) : null
      console.log(`done puts ${totals.puts} bytes ${totals.bytes} flushes ${totals.flushes} fillerRuns ${totals.fillerRuns} fillerTiles ${totals.fillerTiles} elapsed ${(totals.elapsedMs / 1000).toFixed(1)} s`)
      console.log(`draft.length ${draft.length} byteLength ${draft.byteLength} lastKey ${totals.lastKey ? totals.lastKey.toString() : null} readable ${!!last}`)
    } finally {
      await draft.close()
    }
  } finally {
    await store.close()
  }
}

module.exports = { buildPlanet, stallWatch }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
