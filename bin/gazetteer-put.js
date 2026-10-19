'use strict'
const fs = require('bare-fs')
const { withDraft } = require('../lib/build/publish')
const { putGazetteer, gazKeys, areaKeys, readGazetteer } = require('../lib/gazetteer-lib')
const { parseFlags, intFlag } = require('./flags')

// Adds a gazetteer.js output to the named draft, after the tiles; commit with planet-commit.js.
// --areas must match the run that produced the file, or the labels go under the other prefix and
// the atlas signs them. A harvest now records which pass wrote it, so that is checked here. A
// file from before the marker is a bare array and says nothing, so it is accepted with a warning
// — the claim is the operator's then, as it always was.
//
// --prune is for a republish over a draft that already holds a gazetteer: it deletes the places
// this file no longer has. Off by default because on a first publish there is nothing to delete
// and the scan is wasted, and because it is the only thing here that removes signed content.
async function main () {
  const argv = Bare.argv.slice(2)
  const { flags, args } = parseFlags(argv, ['--inline-value-size', '--areas', '--prune'])
  const inlineValueSize = intFlag(flags, '--inline-value-size', 0)
  const areas = flags.has('--areas')
  const prune = flags.has('--prune')
  const [storeDir, keysDir, name, file] = args
  if (!storeDir || !keysDir || !name || !file) throw new Error('usage: gazetteer-put.js [--inline-value-size=N] [--areas] [--prune] <storeDir> <keysDir> <draftName> <gazetteer.json>')
  const { areas: wrote, entries } = readGazetteer(JSON.parse(fs.readFileSync(file, 'utf8')))
  if (wrote === null) {
    console.log(`warning: ${file} predates the harvest marker, so --areas cannot be checked against it`)
  } else if (wrote !== areas) {
    const was = wrote ? 'an --areas harvest' : 'a locality harvest'
    throw new Error(`${file} is ${was}, but --areas was ${areas ? 'given' : 'not given'}`)
  }
  await withDraft({ storeDir, keysDir, name }, async ({ draft, bee }) => {
    const before = draft.length
    const { puts, pruned } = await putGazetteer(bee, entries, { inlineValueSize, keys: areas ? areaKeys : gazKeys, prune })
    console.log(`${areas ? 'area' : 'gazetteer'} puts ${puts} pruned ${pruned} draft.length ${draft.length} (+${draft.length - before}) byteLength ${draft.byteLength}`)
  })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
