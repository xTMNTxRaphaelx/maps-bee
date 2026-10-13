"use strict";

function manifestFor(publicKeys, quorum = 2) {
  return {
    version: 1,
    hash: "blake2b",
    allowPatch: false,
    quorum,
    signers: publicKeys.map((publicKey) => ({ publicKey })),
  };
}

// signers: [{ index, keyPair }]; each signs the draft's tree at its current length
function signDraft(m, draft, signers) {
  const batch = draft.state.createTreeBatch();
  const verifier = m.core.verifier;
  const partials = signers.map(({ index, keyPair }) => ({
    signer: index,
    signature: verifier.signers[index].sign(batch, keyPair),
    patch: 0,
    nodes: null,
  }));
  return verifier.assemble(partials);
}

async function publishDraft(m, draft, signers) {
  const signature = signDraft(m, draft, signers);
  return m.commit(draft, { length: draft.length, signature });
}

module.exports = { manifestFor, signDraft, publishDraft };
