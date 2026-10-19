'use strict'
const { buildBee } = require('../lib/build/bee-build')
const { withDraft, commitDraft, mapsLine } = require('../lib/build/publish')
const { parseFlags } = require('./flags')

async function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [storeDir, keysDir, ...archives] = args
  if (!storeDir || !keysDir || archives.length === 0) {
    throw new Error('usage: publish.js <storeDir> <keysDir> <archive.pmtiles>...')
  }
  // the "already has N blocks" throw lands after openDraft has opened the store and the draft
  await withDraft({ storeDir, keysDir }, async ({ m, draft, bee, keyPairs }) => {
    if (m.length > 0) throw new Error(`core already has ${m.length} blocks; use an empty store dir`)
    await buildBee(bee, archives)
    const res = await commitDraft(m, draft, keyPairs)
    console.log(`commit ${JSON.stringify(res)} draft.length ${draft.length} m.length ${m.length} m.signedLength ${m.signedLength}`)
    console.log(mapsLine(m))
  })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
