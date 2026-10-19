'use strict'
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const { openArchive, readTile } = require('./pmtiles-file')
const { bboxTiles, tileKey } = require('./tiles')

// Writes every present tile of the archives into bee, one write batch per zoom.
// The bbox rectangle is the right walk here and only here: an extract is clipped to its own bbox,
// so the rectangle is the data, where on a planet archive it is 67M lookups for a few million tiles
// (gazetteer.js, planet-build.js both walk the directory entries instead). This path also re-gzips
// through readTile rather than copying the archive's stored bytes, and the two differ — 40 of 40
// tiles sampled — so moving it to the entry walk would rewrite every value in store/signed, and
// with it PUBLISHED_LENGTH and the exact block counts the sparse tests assert.
async function buildBee (bee, paths, log = console.log) {
  // opened up front so the finally below closes every fd on any throw, including one from
  // getHeader partway through the list; openArchive itself touches no fd until the first read
  const archives = paths.map((path) => ({ archive: openArchive(path) }))
  try {
    return await build(bee, archives, log)
  } finally {
    for (const a of archives) await a.archive.close()
  }
}

async function build (bee, archives, log) {
  for (const a of archives) {
    const h = await a.archive.getHeader()
    a.bbox = [h.minLon, h.minLat, h.maxLon, h.maxLat]
    a.minZoom = h.minZoom
    a.maxZoom = h.maxZoom
  }
  const minZ = Math.min(...archives.map((a) => a.minZoom))
  const maxZ = Math.max(...archives.map((a) => a.maxZoom))
  const core = bee.core
  const seen = new Set()
  const totals = { puts: 0, gzip: 0, dupes: 0 }
  log('z\tputs\tgzipBytes\tblocksBefore\tblocksAfter\tbyteLengthAfter')
  for (let z = minZ; z <= maxZ; z++) {
    const w = bee.write()
    let puts = 0
    let gzip = 0
    for (const a of archives) {
      if (z < a.minZoom || z > a.maxZoom) continue
      for (const { x, y } of bboxTiles(a.bbox, z)) {
        const key = tileKey(z, x, y)
        const id = b4a.toString(key)
        if (seen.has(id)) {
          totals.dupes++
          continue
        }
        const t = await readTile(a.archive, z, x, y)
        if (!t) continue
        seen.add(id)
        w.tryPut(key, t.gz)
        puts++
        gzip += t.gz.byteLength
      }
    }
    const before = core.length
    await w.flush()
    log(`${z}\t${puts}\t${gzip}\t${before}\t${core.length}\t${core.byteLength}`)
    totals.puts += puts
    totals.gzip += gzip
  }
  log(`total puts ${totals.puts} dupesSkipped ${totals.dupes} gzipBytes ${totals.gzip} core.length ${core.length} core.byteLength ${core.byteLength}`)
  return totals
}

async function main () {
  const [storeDir, ...archives] = Bare.argv.slice(2)
  const store = new Corestore(storeDir)
  // the "already holds N blocks" throw below lands after ready(), so without the finally it leaves
  // the store and its core open; bee.close() only closes the store anyway (hyperbee2/index.js:189)
  try {
    const core = store.get({ name: 'maps-draft' })
    const bee = new Hyperbee(store, { core, writable: true })
    await bee.ready()
    if (core.length > 0) throw new Error(`store ${storeDir} already holds ${core.length} blocks; use an empty dir`)
    const start = Date.now()
    await buildBee(bee, archives)
    console.log(`build ms ${Date.now() - start}`)
  } finally {
    await store.close()
  }
}

module.exports = { buildBee }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
