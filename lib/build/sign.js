'use strict'

function manifestFor (publicKeys) {
  return {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 2,
    signers: publicKeys.map((publicKey) => ({ publicKey }))
  }
}

// signers: [{ index, keyPair }]; each signs the draft's tree at length, by default the whole draft
async function signDraft (m, draft, signers, length = draft.length) {
  const batch = draft.state.createTreeBatch()
  if (length !== batch.length) await batch.restore(length)
  const verifier = m.core.verifier
  const partials = signers.map(({ index, keyPair }) => ({
    signer: index,
    signature: verifier.signers[index].sign(batch, keyPair),
    patch: 0,
    nodes: null
  }))
  return verifier.assemble(partials)
}

async function publishDraft (m, draft, signers, length = draft.length) {
  const signature = await signDraft(m, draft, signers, length)
  return m.commit(draft, { length, signature })
}

module.exports = { manifestFor, publishDraft }
