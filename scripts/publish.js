'use strict'
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const { buildBee } = require('./bee-build')
const { load } = require('./keys')
const { manifestFor, publishDraft } = require('./sign')

// the multisig core of the key set, its named draft session and a writable bee over the draft;
// a named session resumes from storage, so a draft survives a process restart (hypercore session-state.js:1224)
async function openDraft (store, keyPairs, name = 'draft') {
  const m = store.get({ manifest: manifestFor(keyPairs.map((k) => k.publicKey)) })
  await m.ready()
  const draft = m.session({ name })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  return { m, draft, bee }
}

// signers a (0) and b (1); c is the spare. A commit reads every block it moves into memory at once
// (hypercore session-state.js:912-931), so a large draft is committed in chunks of `chunk` blocks,
// each signed at its own length; the draft's dependency advances with every commit (:1086-1091).
async function commitDraft (m, draft, keyPairs, { chunk = Infinity, log = null } = {}) {
  const signers = [{ index: 0, keyPair: keyPairs[0] }, { index: 1, keyPair: keyPairs[1] }]
  let res = null
  while (m.length < draft.length) {
    const length = Math.min(m.length + chunk, draft.length)
    res = await publishDraft(m, draft, signers, length)
    if (!res) throw new Error(`commit at length ${length} returned null`)
    if (log) log(res)
  }
  if (!res) throw new Error('draft has nothing to commit')
  return res
}

function mapsLine (m) {
  return `maps: { "key": "${HypercoreId.encode(m.key)}", "length": ${m.signedLength} }`
}

async function main () {
  const [storeDir, keysDir, ...archives] = Bare.argv.slice(2)
  const keyPairs = load(keysDir)
  const store = new Corestore(storeDir)
  const { m, draft, bee } = await openDraft(store, keyPairs)
  if (m.length > 0) throw new Error(`core already has ${m.length} blocks; use an empty store dir`)
  await buildBee(bee, archives)
  const res = await commitDraft(m, draft, keyPairs)
  console.log(`commit ${JSON.stringify(res)} draft.length ${draft.length} m.length ${m.length} m.signedLength ${m.signedLength}`)
  console.log(mapsLine(m))
  await draft.close()
  await store.close()
}

module.exports = { openDraft, commitDraft, mapsLine }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
