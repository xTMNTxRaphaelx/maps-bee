'use strict'
const perf = require('bare-performance')
const { withDraft, commitDraft, mapsLine } = require('../lib/build/publish')
const { parseFlags } = require('./flags')

// Commits the named draft of a planet build with two of the three signatures, chunkBlocks at a time.
async function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [storeDir, keysDir, name, chunkArg] = args
  if (!storeDir || !keysDir || !name) throw new Error('usage: planet-commit.js <storeDir> <keysDir> <draftName> [chunkBlocks]')
  const chunk = chunkArg === undefined ? 20000 : Number(chunkArg)
  if (!(Number.isInteger(chunk) && chunk > 0)) throw new Error('chunkBlocks must be a positive integer')
  await withDraft({ storeDir, keysDir, name }, async ({ m, draft, keyPairs }) => {
    console.log(`draft ${name} length ${draft.length} byteLength ${draft.byteLength} signed ${m.signedLength} chunk ${chunk}`)
    if (draft.length <= m.signedLength) throw new Error('draft has nothing beyond the signed length')
    const t0 = perf.now()
    const log = (r) => console.log(`commit length ${r.length}/${draft.length} byteLength ${r.byteLength} elapsed ${((perf.now() - t0) / 1000).toFixed(1)} s`)
    const res = await commitDraft(m, draft, keyPairs, { chunk, log })
    console.log(`commit ${JSON.stringify(res)} m.length ${m.length} m.signedLength ${m.signedLength}`)
    console.log(mapsLine(m))
  })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
