'use strict'
const HypercoreId = require('hypercore-id-encoding')
const { seed } = require('../lib/net/seed')
const { parseFlags, bootstrapFlag } = require('./flags')

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--bootstrap'])
  const [storeDir, id] = args
  if (!storeDir || !id) throw new Error('usage: seed.js [--bootstrap=host:port,...] <storeDir> <coreKey>')
  const s = await seed({ storeDir, key: HypercoreId.decode(id), bootstrap: bootstrapFlag(flags, '--bootstrap') })
  const Signal = require('bare-signals')
  const sigint = new Signal('SIGINT')
  sigint.on('signal', () => {
    sigint.stop()
    console.log('stopping: ' + s.line())
    s.close().catch((err) => {
      console.error(err)
      Bare.exitCode = 1
    })
  }).start()
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
