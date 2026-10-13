'use strict'
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const HypercoreId = require('hypercore-id-encoding')
const { buildBee } = require('./bee-build')
const { load } = require('./keys')
const { manifestFor, publishDraft } = require('./sign')

async function main () {
  const [storeDir, keysDir, ...archives] = Bare.argv.slice(2)
  const keyPairs = load(keysDir)
  const store = new Corestore(storeDir)
  const m = store.get({ manifest: manifestFor(keyPairs.map((k) => k.publicKey)) })
  await m.ready()
  if (m.length > 0) throw new Error(`core already has ${m.length} blocks; use an empty store dir`)
  const draft = m.session({ name: 'draft' })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  await buildBee(bee, archives)

  // signers a (0) and b (1); c is the spare
  const res = await publishDraft(m, draft, [{ index: 0, keyPair: keyPairs[0] }, { index: 1, keyPair: keyPairs[1] }])
  if (!res) throw new Error('commit returned null')
  console.log(`commit ${JSON.stringify(res)} draft.length ${draft.length} m.length ${m.length} m.signedLength ${m.signedLength}`)
  console.log(`maps: { "key": "${HypercoreId.encode(m.key)}", "length": ${m.signedLength} }`)
  await draft.close()
  await store.close()
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
