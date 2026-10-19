'use strict'
const fs = require('bare-fs')
const { withDraft } = require('../lib/build/publish')
const { putGazetteer, gazKeys, areaKeys } = require('../lib/gazetteer-lib')
const { parseFlags, intFlag } = require('./flags')

// Adds a gazetteer.js output to the named draft, after the tiles; commit with planet-commit.js.
// --areas must match the run that produced the file. Nothing checks it: the JSON records which
// pass wrote it nowhere, and kind_detail alone cannot tell an areas file from an unfiltered
// locality one. Getting it wrong writes the labels under the other prefix and the atlas signs it.
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
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
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
