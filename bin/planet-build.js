'use strict'
const path = require('bare-path')
const { withDraft } = require('../lib/build/publish')
const { buildPlanet, FLUSH_PUTS, FLUSH_BYTES } = require('../lib/build/planet-build')
const { parseFlags, intFlag } = require('./flags')

const FLAGS = ['--resume', '--sorted', '--inline-value-size', '--flush-puts', '--flush-bytes']

function parseArgs (argv) {
  const { flags, args } = parseFlags(argv, FLAGS)
  const [storeDir, keysDir, name, zoom, ...archives] = args
  if (!storeDir || !keysDir || !name || !zoom || archives.length === 0) {
    throw new Error('usage: planet-build.js [--resume] [--sorted] [--inline-value-size=N] [--flush-puts=N] [--flush-bytes=N] <storeDir> <keysDir> <draftName> <expandRunsUpToZoom> <archive.pmtiles>...')
  }
  // checked here rather than in buildPlanet, which only sees it after withDraft has opened the store
  if (!/^\d+$/.test(zoom)) throw new Error(`expandRunsUpToZoom must be a non-negative integer, got ${zoom}`)
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
  await withDraft(args, async ({ draft, bee }) => {
    const progressFile = path.join(args.storeDir, 'planet-build.progress')
    console.log(`draft ${args.name} length ${draft.length} resume ${args.resume} sorted ${args.sorted} inlineValueSize ${args.inlineValueSize ?? 'default'} flushPuts ${args.flushPuts ?? FLUSH_PUTS} flushBytes ${args.flushBytes ?? FLUSH_BYTES} progress ${progressFile}`)
    const totals = await buildPlanet(bee, args.archives, { ...args, progressFile })
    const last = totals.lastKey ? await bee.get(totals.lastKey) : null
    console.log(`done puts ${totals.puts} bytes ${totals.bytes} flushes ${totals.flushes} fillerRuns ${totals.fillerRuns} fillerTiles ${totals.fillerTiles} elapsed ${(totals.elapsedMs / 1000).toFixed(1)} s`)
    console.log(`draft.length ${draft.length} byteLength ${draft.byteLength} lastKey ${totals.lastKey ? totals.lastKey.toString() : null} readable ${!!last}`)
  })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
