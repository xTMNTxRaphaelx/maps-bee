'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const zlib = require('bare-zlib')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { tileIdToZxy, zxyToTileId } = require('pmtiles')
const { buildPlanet, stallWatch, collectSorted } = require('../../lib/build/planet-build')
const { buildBee } = require('../../lib/build/bee-build')
const { openArchive, directories } = require('../../lib/build/pmtiles-file')
const { tileKey, parseTileKey } = require('../../lib/tiles')
const { decodeGzip } = require('../../lib/mvt')
const { tmpStore, spyPuts, inlinedValues, STATE_ARCHIVE, JAIPUR_ARCHIVE, ATLANTIC_ARCHIVE: ATLANTIC } = require('../helpers/helpers')

// z10 only, 550 tiles in 239 entries, mostly open Atlantic: extracted from the planet z10 file (README)

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
  const dir = fs.mkdtempSync(path.join(__dirname, '..', '..', 'store', 'tmp', 'progress-'))
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

test('sorted build puts keys in ascending order and the same set as the directory walk', async (t) => {
  const sorted = await newBee(t, 'planet-sorted')
  const walk = await newBee(t, 'planet-walk')
  const keys = spyPuts(sorted)
  const ts = await buildPlanet(sorted, ARCHIVES, { expandRunsUpToZoom: EXPAND, sorted: true, flushPuts: 200, log: () => {} })
  const tw = await buildPlanet(walk, ARCHIVES, { expandRunsUpToZoom: EXPAND, flushPuts: 200, log: () => {} })
  t.ok(ts.flushes > 1, `chunked into ${ts.flushes} flushes`)
  t.is(keys.length, ts.puts, 'one tryPut per put')
  let ascending = 0
  for (let i = 1; i < keys.length; i++) if (b4a.compare(keys[i - 1], keys[i]) < 0) ascending++
  t.is(ascending, keys.length - 1, 'every key above the one before it')
  t.is(ts.puts, tw.puts)
  t.is(ts.bytes, tw.bytes)
  t.is(ts.fillerTiles, tw.fillerTiles)

  const walkKeys = await keysOf(walk)
  t.alike(str(await keysOf(sorted)), str(walkKeys), 'same key set')
  let equal = 0
  for (const key of walkKeys) {
    const a = await sorted.get(key)
    const b = await walk.get(key)
    if (a && b4a.equals(a.value, b.value)) equal++
  }
  t.is(equal, walkKeys.length, 'every key readable with the same bytes')
})

test('inlineValueSize 0 leaves no value inlined in a key record', async (t) => {
  const inl = await newBee(t, 'atlantic-inline')
  const out = await newBee(t, 'atlantic-noinline')
  await buildPlanet(inl, [ATLANTIC], { expandRunsUpToZoom: 10, log: () => {} })
  await buildPlanet(out, [ATLANTIC], { expandRunsUpToZoom: 10, inlineValueSize: 0, log: () => {} })
  const a = await inlinedValues(inl.core)
  t.ok(a > 0, `default build inlines ${a} values (ocean tiles are 93 B)`)
  t.is(await inlinedValues(out.core), 0, 'no inlined value with inlineValueSize 0')
  t.comment(`core.length inline ${inl.core.length} byteLength ${inl.core.byteLength}; noinline ${out.core.length} byteLength ${out.core.byteLength}`)
  const keys = await keysOf(inl)
  let equal = 0
  for (const key of keys) {
    const x = await inl.get(key)
    const y = await out.get(key)
    if (y && b4a.equals(x.value, y.value)) equal++
  }
  t.is(equal, keys.length, 'same bytes for every key')
})

test('sorted build rejects --resume and archives out of zoom order', async (t) => {
  const bee = await newBee(t, 'planet-sorted-bad')
  await t.exception(buildPlanet(bee, [JAIPUR_ARCHIVE, STATE_ARCHIVE], { expandRunsUpToZoom: EXPAND, sorted: true, log: () => {} }), /zoom order/)
  await t.exception(buildPlanet(bee, ARCHIVES, { expandRunsUpToZoom: EXPAND, sorted: true, resume: true, log: () => {} }), /resume/)
  t.is(bee.core.length, 0, 'nothing written')
})

// why a dead sorted run is re-run rather than restarted: the second pass writes the same bytes, and
// a put that matches what is stored is not applied, so the batch appends nothing (README, planet build)
test('re-running a sorted build over its own output appends no block', async (t) => {
  const bee = await newBee(t, 'planet-sorted-again')
  const opts = { expandRunsUpToZoom: 10, sorted: true, inlineValueSize: 0, flushPuts: 200, log: () => {} }
  const first = await buildPlanet(bee, [ATLANTIC], opts)
  const length = bee.core.length
  t.ok(first.puts > 0 && length > 0, `${first.puts} puts in ${length} blocks`)

  const second = await buildPlanet(bee, [ATLANTIC], opts)
  t.is(second.puts, first.puts, 'every key is tried again')
  t.is(bee.core.length, length, 'and none of them appends a block')
  t.is((await keysOf(bee)).length, first.puts, 'one key per tile, not two')
})

test('stallWatch logs a phase that has not changed since the last tick', async (t) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const still = []
  const stop = stallWatch(() => 'put 12', 20, (msg) => still.push(msg))
  await wait(70)
  stop()
  t.ok(still.length > 0, `logged ${still.length} times`)
  t.ok(still.every((msg) => msg.includes('put 12')), 'names the phase')
  const n = still.length
  await wait(70)
  t.is(still.length, n, 'stop clears the interval')

  let tick = 0
  const moving = []
  const stopMoving = stallWatch(() => `put ${tick++}`, 20, (msg) => moving.push(msg))
  await wait(70)
  stopMoving()
  t.is(moving.length, 0, 'no log while the phase changes')
})

// pmtiles tile ids run contiguously across zoom boundaries, so a run of identical tiles can begin
// at the end of one zoom and continue into the next. Classifying the whole run by its first tile
// wrote real keys at a zoom meant to stay filler, and drifted the puts + fillerTiles == 4^zoom
// conservation check that is the build's only coverage proof. No fixture archive has such a run —
// measured across all fourteen, only the single-zoom ocean extract has runs at all — so the case
// is constructed here rather than left to a hypothetical.
test('collectSorted splits a run that crosses a zoom boundary', async (t) => {
  const firstZ11 = zxyToTileId(11, 0, 0)
  t.is(tileIdToZxy(firstZ11 - 1)[0], 10, 'the id before it is the last tile of z10')

  // four identical tiles starting two before z11: two at z10, two at z11
  const entries = [{ tileId: firstZ11 - 2, runLength: 4, offset: 0, length: 1 }]
  const archive = { source: null, cache: { getDirectory: () => Promise.resolve(entries) } }
  const header = { numTileEntries: 1, rootDirectoryOffset: 0, rootDirectoryLength: 0, leafDirectoryOffset: 0, maxZoom: 11 }

  const { packed, stats } = await collectSorted(archive, header, 10)
  t.is(stats.tiles, 2, 'the two tiles at or above the expand zoom are expanded')
  t.is(stats.fillerTiles, 2, 'the two past it are filler')
  t.is(stats.fillerRuns, 1, 'a partly expanded run counts once as a filler run')
  t.is(packed.length, 2, 'and only the expanded tiles take a slot')
  t.is(stats.tiles + stats.fillerTiles, 4, 'conservation holds across the boundary')
  for (const v of packed) t.is(Number(v >> 58n), 10, 'every packed tile is at z10')
})
