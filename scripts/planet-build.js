'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const perf = require('bare-performance')
const Corestore = require('corestore')
const { Compression, tileIdToZxy } = require('pmtiles')
const { openArchive } = require('./pmtiles-file')
const { tileKey } = require('./tiles')
const { load } = require('./keys')
const { openDraft } = require('./publish')

const FLUSH_PUTS = 20000
const FLUSH_BYTES = 64 * 1024 * 1024

// Every directory of the archive in depth-first order: index 0 is the root's own tile entries,
// then each leaf as the root lists it (pmtiles getZxyAttempt follows runLength 0 entries the same way).
async function * directories (archive, header) {
  const walk = async function * (offset, length, isRoot) {
    const entries = await archive.cache.getDirectory(archive.source, offset, length, header)
    const tiles = []
    const dirs = []
    for (const e of entries) (e.runLength === 0 ? dirs : tiles).push(e)
    yield { tiles, pending: dirs.length }
    for (const d of dirs) yield * walk(header.leafDirectoryOffset + d.offset, d.length, false)
  }
  yield * walk(header.rootDirectoryOffset, header.rootDirectoryLength, true)
}

// One read for the whole span of a clustered directory, else one read per entry
async function readValues (archive, header, tiles) {
  if (tiles.length === 0) return []
  let lo = Infinity
  let hi = 0
  let sum = 0
  for (const e of tiles) {
    if (e.offset < lo) lo = e.offset
    if (e.offset + e.length > hi) hi = e.offset + e.length
    sum += e.length
  }
  if (header.clustered && hi - lo <= 2 * sum + 65536) {
    const { data } = await archive.source.getBytes(header.tileDataOffset + lo, hi - lo)
    const span = Buffer.from(data)
    return tiles.map((e) => Buffer.from(span.subarray(e.offset - lo, e.offset - lo + e.length)))
  }
  const out = []
  for (const e of tiles) {
    const { data } = await archive.source.getBytes(header.tileDataOffset + e.offset, e.length)
    out.push(Buffer.from(data))
  }
  return out
}

function readProgress (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Writes every unique tile of the archives into bee as gzip bytes copied raw from the archive.
// A run of identical tiles (runLength > 1) is expanded to one key per tile at zooms up to
// expandRunsUpToZoom, so those zooms are complete and the client can tell land from ocean; at
// deeper zooms the run is filler and skipped, so a missing key there means blank.
// Puts go to the core in batches of flushPuts or flushBytes; progressFile records the last
// directory whose puts are all flushed, and resume skips directories at or before it. A directory
// interrupted mid-batch is redone from its start, which rewrites the same values.
async function buildPlanet (bee, archives, opts = {}) {
  const {
    expandRunsUpToZoom,
    flushPuts = FLUSH_PUTS,
    flushBytes = FLUSH_BYTES,
    progressFile = null,
    resume = false,
    maxDirs = Infinity,
    log = console.log
  } = opts
  if (!Number.isInteger(expandRunsUpToZoom)) throw new TypeError('expandRunsUpToZoom must be an integer zoom')
  const core = bee.core
  const done = resume && progressFile ? readProgress(progressFile) : null
  const totals = { puts: 0, bytes: 0, flushes: 0, fillerRuns: 0, fillerTiles: 0, dirs: 0, lastKey: null }
  const t0 = perf.now()
  let batch = bee.write()
  let batchPuts = 0
  let batchBytes = 0
  let completed = null

  const checkpoint = () => {
    if (progressFile && completed) fs.writeFileSync(progressFile, JSON.stringify(completed) + '\n')
  }
  const flush = async (a, dir, total) => {
    await batch.flush()
    totals.flushes++
    batch = bee.write()
    batchPuts = 0
    batchBytes = 0
    checkpoint()
    const s = (perf.now() - t0) / 1000
    log(`archive ${a + 1}/${archives.length}\tdir ${dir}/${total}\tputs ${totals.puts}\tfillerRuns ${totals.fillerRuns}\tfillerTiles ${totals.fillerTiles}\tbytes ${totals.bytes}\tcore.length ${core.length}\telapsed ${s.toFixed(1)} s\tputs/s ${Math.round(totals.puts / s)}`)
  }
  const put = (key, value) => {
    batch.tryPut(key, value)
    totals.puts++
    totals.bytes += value.byteLength
    batchPuts++
    batchBytes += value.byteLength
    totals.lastKey = key
  }

  for (let a = 0; a < archives.length; a++) {
    if (done && a < done.archive) continue
    const archive = openArchive(archives[a])
    const header = await archive.getHeader()
    if (header.tileCompression !== Compression.Gzip) {
      throw new Error(`${archives[a]}: tileCompression ${header.tileCompression} is not gzip`)
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
        if (batchPuts >= flushPuts || batchBytes >= flushBytes) await flush(a, dir, total)
      }
      completed = { archive: a, dir }
      totals.dirs++
      dir++
    }
    if (batchPuts > 0) await flush(a, dir, total)
    else checkpoint()
    await archive.close()
    if (totals.dirs >= maxDirs) break
  }
  totals.elapsedMs = perf.now() - t0
  return totals
}

function parseArgs (argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const [storeDir, keysDir, name, zoom, ...archives] = argv.filter((a) => !a.startsWith('--'))
  if (!storeDir || !keysDir || !name || !zoom || archives.length === 0) {
    throw new Error('usage: planet-build.js [--resume] <storeDir> <keysDir> <draftName> <expandRunsUpToZoom> <archive.pmtiles>...')
  }
  return { storeDir, keysDir, name, expandRunsUpToZoom: Number(zoom), archives, resume: flags.has('--resume') }
}

async function main () {
  const args = parseArgs(Bare.argv.slice(2))
  const store = new Corestore(args.storeDir)
  const { draft, bee } = await openDraft(store, load(args.keysDir), args.name)
  const progressFile = path.join(args.storeDir, 'planet-build.progress')
  console.log(`draft ${args.name} length ${draft.length} resume ${args.resume} progress ${progressFile}`)
  const totals = await buildPlanet(bee, args.archives, { ...args, progressFile })
  const last = totals.lastKey ? await bee.get(totals.lastKey) : null
  console.log(`done puts ${totals.puts} bytes ${totals.bytes} flushes ${totals.flushes} fillerRuns ${totals.fillerRuns} fillerTiles ${totals.fillerTiles} elapsed ${(totals.elapsedMs / 1000).toFixed(1)} s`)
  console.log(`draft.length ${draft.length} byteLength ${draft.byteLength} lastKey ${totals.lastKey ? totals.lastKey.toString() : null} readable ${!!last}`)
  await draft.close()
  await store.close()
}

module.exports = { buildPlanet, directories, FLUSH_PUTS, FLUSH_BYTES }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
