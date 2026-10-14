'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const zlib = require('bare-zlib')
const Hyperbee = require('hyperbee2')
const { tileIdToZxy } = require('pmtiles')
const { buildPlanet, directories } = require('../scripts/planet-build')
const { buildBee } = require('../scripts/bee-build')
const { openArchive } = require('../scripts/pmtiles-file')
const { tileKey, parseTileKey } = require('../scripts/tiles')
const { decodeGzip } = require('../scripts/mvt')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE } = require('./helpers')

// z10 only, 550 tiles in 239 entries, mostly open Atlantic: extracted from the planet z10 file (README)
const ATLANTIC = path.join(__dirname, '..', 'data', 'extract', 'atlantic-z10.pmtiles')

const ARCHIVES = [STATE_ARCHIVE, JAIPUR_ARCHIVE]
const EXPAND = 10

async function newBee (t, name) {
  const store = await tmpStore(t, name)
  const core = store.get({ name: 'atlas' })
  await core.ready()
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  return bee
}

async function keysOf (bee) {
  const keys = []
  for await (const e of bee.createReadStream()) keys.push(e.key)
  return keys
}

const str = (keys) => keys.map((k) => k.toString())

// the tiles of every run entry (runLength > 1) above zoom EXPAND, which the new builder skips
async function runTilesAbove (zoom) {
  const out = []
  for (const file of ARCHIVES) {
    const archive = openArchive(file)
    const header = await archive.getHeader()
    for await (const { tiles } of directories(archive, header)) {
      for (const e of tiles) {
        if (e.runLength <= 1) continue
        for (let r = 0; r < e.runLength; r++) {
          const [z, x, y] = tileIdToZxy(e.tileId + r)
          if (z > zoom) out.push(tileKey(z, x, y).toString())
        }
      }
    }
    await archive.close()
  }
  return out.sort()
}

test('planet builder matches the bbox builder tile for tile and skips only deep runs', async (t) => {
  const fresh = await newBee(t, 'planet-new')
  const old = await newBee(t, 'planet-old')
  const totals = await buildPlanet(fresh, ARCHIVES, { expandRunsUpToZoom: EXPAND, flushPuts: 200, log: () => {} })
  await buildBee(old, ARCHIVES, () => {})
  t.ok(totals.flushes > 1, `chunked into ${totals.flushes} flushes`)
  t.comment(`new puts ${totals.puts} bytes ${totals.bytes} fillerRuns ${totals.fillerRuns} fillerTiles ${totals.fillerTiles} dirs ${totals.dirs}`)

  const newKeys = await keysOf(fresh)
  t.is(newKeys.length, totals.puts, 'one key per put')
  let equal = 0
  for (const key of newKeys) {
    const a = await fresh.get(key)
    const b = await old.get(key)
    if (b && Buffer.compare(zlib.gunzipSync(a.value), zlib.gunzipSync(b.value)) === 0) equal++
  }
  t.is(equal, newKeys.length, 'every new key is in the old build with the same tile bytes')

  const oldKeys = await keysOf(old)
  const newSet = new Set(str(newKeys))
  const missingLow = oldKeys.filter((k) => parseTileKey(k).z <= EXPAND && !newSet.has(k.toString()))
  t.is(missingLow.length, 0, `every old key at zoom <= ${EXPAND} is in the new build`)
  const missingHigh = str(oldKeys.filter((k) => parseTileKey(k).z > EXPAND && !newSet.has(k.toString()))).sort()
  const runs = await runTilesAbove(EXPAND)
  t.alike(missingHigh, runs, `the ${runs.length} deep keys the new build lacks are exactly the run tiles`)
  t.is(totals.fillerTiles, runs.length, 'filler count matches')
})

test('planet builder resumes from its checkpoint across archives', async (t) => {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', 'store', 'tmp', 'progress-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const progressFile = path.join(dir, 'planet-build.progress')
  const bee = await newBee(t, 'planet-resume')
  const first = await buildPlanet(bee, ARCHIVES, { expandRunsUpToZoom: EXPAND, progressFile, maxDirs: 1, log: () => {} })
  t.is(first.dirs, 1, 'first run stopped after one directory')
  t.alike(JSON.parse(fs.readFileSync(progressFile, 'utf8')), { archive: 0, dir: 0 })
  const second = await buildPlanet(bee, ARCHIVES, { expandRunsUpToZoom: EXPAND, progressFile, resume: true, log: () => {} })
  t.comment(`first puts ${first.puts} second puts ${second.puts}`)
  const straight = await newBee(t, 'planet-straight')
  const all = await buildPlanet(straight, ARCHIVES, { expandRunsUpToZoom: EXPAND, log: () => {} })
  t.is(first.puts + second.puts, all.puts, 'resumed run puts the same total')
  t.is((await keysOf(bee)).length, (await keysOf(straight)).length, 'resumed bee has the same key count')
})

function isOcean (gz) {
  const water = decodeGzip(gz).layers.water
  if (!water) return false
  for (let i = 0; i < water.length; i++) if (water.feature(i).properties.kind === 'ocean') return true
  return false
}

test('run entries expand at or below the expand zoom and are skipped above it', async (t) => {
  const archive = openArchive(ATLANTIC)
  const header = await archive.getHeader()
  const counts = { addressed: 0, unique: 0, runs: 0, runTiles: 0 }
  const firstRun = []
  for await (const { tiles } of directories(archive, header)) {
    for (const e of tiles) {
      counts.addressed += e.runLength
      if (e.runLength > 1) {
        counts.runs++
        counts.runTiles += e.runLength
        const [z, x, y] = tileIdToZxy(e.tileId + e.runLength - 1)
        firstRun.push(tileKey(z, x, y))
      } else counts.unique++
    }
  }
  await archive.close()
  t.is(counts.addressed, 550, 'addressed tiles as pmtiles show reports')
  t.ok(counts.runs > 0, `${counts.runs} runs covering ${counts.runTiles} tiles`)

  const full = await newBee(t, 'atlantic-full')
  const tf = await buildPlanet(full, [ATLANTIC], { expandRunsUpToZoom: 10, log: () => {} })
  t.is(tf.puts, counts.addressed, 'every addressed tile present when runs expand')
  t.is(tf.fillerTiles, 0)
  let ocean = 0
  for (const key of firstRun) {
    const e = await full.get(key)
    t.ok(e, 'last tile of each run is present')
    if (e && isOcean(e.value)) ocean++
  }
  t.ok(ocean > 0, `${ocean} of ${firstRun.length} runs are explicit ocean tiles`)

  const skip = await newBee(t, 'atlantic-skip')
  const ts = await buildPlanet(skip, [ATLANTIC], { expandRunsUpToZoom: 9, log: () => {} })
  t.is(ts.puts, counts.unique, 'only unique tiles when runs are filler')
  t.is(ts.fillerRuns, counts.runs)
  t.is(ts.fillerTiles, counts.runTiles)
  t.is(await skip.get(firstRun[0]), null, 'a run tile is absent')
})
