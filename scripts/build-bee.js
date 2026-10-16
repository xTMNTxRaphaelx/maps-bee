'use strict'
const Corestore = require('corestore')
const Hyperbee = require('hyperbee2')
const { buildBee } = require('./bee-build')

async function main () {
  const [storeDir, ...archives] = Bare.argv.slice(2)
  const store = new Corestore(storeDir)
  // the "already holds N blocks" throw below lands after ready(), so without the finally it leaves
  // the store and its core open; bee.close() only closes the store anyway (hyperbee2/index.js:189)
  try {
    const core = store.get({ name: 'maps-draft' })
    const bee = new Hyperbee(store, { core, writable: true })
    await bee.ready()
    if (core.length > 0) throw new Error(`store ${storeDir} already holds ${core.length} blocks; use an empty dir`)
    const start = Date.now()
    await buildBee(bee, archives)
    console.log(`build ms ${Date.now() - start}`)
  } finally {
    await store.close()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
