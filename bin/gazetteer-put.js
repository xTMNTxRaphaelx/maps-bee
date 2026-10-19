'use strict'
const fs = require('bare-fs')
const { withDraft } = require('../lib/build/publish')
const { putGazetteer, gazKeys, areaKeys } = require('../lib/gazetteer-lib')
const { parseFlags, intFlag } = require('./flags')

// Adds a gazetteer.js output to the named draft, after the tiles; commit with planet-commit.js.
// --areas must match the run that produced the file. Nothing checks it: the JSON records which
// pass wrote it nowhere, and kind_detail alone cannot tell an areas file from an unfiltered
// locality one. Getting it wrong writes the labels under the other prefix and the atlas signs it.
async function main () {
  const argv = Bare.argv.slice(2)
  const { flags, args } = parseFlags(argv, ['--inline-value-size', '--areas'])
  const inlineValueSize = intFlag(flags, '--inline-value-size', 0)
  const areas = flags.has('--areas')
  const [storeDir, keysDir, name, file] = args
  if (!storeDir || !keysDir || !name || !file) throw new Error('usage: gazetteer-put.js [--inline-value-size=N] [--areas] <storeDir> <keysDir> <draftName> <gazetteer.json>')
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  await withDraft({ storeDir, keysDir, name }, async ({ draft, bee }) => {
    const before = draft.length
    const puts = await putGazetteer(bee, entries, { inlineValueSize, keys: areas ? areaKeys : gazKeys })
    console.log(`${areas ? 'area' : 'gazetteer'} puts ${puts} draft.length ${draft.length} (+${draft.length - before}) byteLength ${draft.byteLength}`)
  })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
