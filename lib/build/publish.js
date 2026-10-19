'use strict'
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const { load } = require('./keys')
const { manifestFor, publishDraft } = require('./sign')

// the multisig core of the key set, its named draft session and a writable bee over the draft;
// a named session resumes from storage, so a draft survives a process restart (hypercore session-state.js:1224)
async function openDraft (store, keyPairs, name) {
  const m = store.get({ manifest: manifestFor(keyPairs.map((k) => k.publicKey)) })
  await m.ready()
  const draft = m.session({ name })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  return { m, draft, bee }
}

// The draft of a key set with the store around it, put down however fn ends: a planet build or a
// chunked commit runs for hours, and a throw partway must still close both. fn is handed the
// key pairs along with the draft, since committing one needs them again.
async function withDraft ({ storeDir, keysDir, name = 'draft' }, fn) {
  const keyPairs = load(keysDir)
  const store = new Corestore(storeDir)
  try {
    const open = await openDraft(store, keyPairs, name)
    try {
      return await fn({ ...open, keyPairs })
    } finally {
      await open.draft.close()
    }
  } finally {
    await store.close()
  }
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

module.exports = { withDraft, commitDraft, mapsLine }
