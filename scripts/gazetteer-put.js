'use strict'
const fs = require('bare-fs')
const Corestore = require('corestore')
const { load } = require('./keys')
const { openDraft } = require('./publish')
const { putGazetteer } = require('./gazetteer-lib')

// Adds a gazetteer.js output to the named draft as g/ keys, after the tiles; commit with planet-commit.js.
async function main () {
  const [storeDir, keysDir, name, file] = Bare.argv.slice(2)
  if (!storeDir || !keysDir || !name || !file) throw new Error('usage: gazetteer-put.js <storeDir> <keysDir> <draftName> <gazetteer.json>')
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  const store = new Corestore(storeDir)
  const { draft, bee } = await openDraft(store, load(keysDir), name)
  const before = draft.length
  const puts = await putGazetteer(bee, entries)
  console.log(`gazetteer puts ${puts} draft.length ${draft.length} (+${draft.length - before}) byteLength ${draft.byteLength}`)
  await draft.close()
  await store.close()
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
