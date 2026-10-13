'use strict'
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const { buildBee } = require('./bee-build')

async function main () {
  const [storeDir, ...archives] = Bare.argv.slice(2)
  const store = new Corestore(storeDir)
  const core = store.get({ name: 'maps-draft' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  if (core.length > 0) throw new Error(`store ${storeDir} already holds ${core.length} blocks; use an empty dir`)
  const start = Date.now()
  await buildBee(bee, archives)
  console.log(`build ms ${Date.now() - start}`)
  await bee.close()
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
