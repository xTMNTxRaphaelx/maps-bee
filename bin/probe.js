'use strict'
const HypercoreId = require('hypercore-id-encoding')
const { probe } = require('../lib/net/client')
const { parseFlags, intFlag, bootstrapFlag, parsePoints } = require('./flags')

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--levels', '--bootstrap'])
  const levels = intFlag(flags, '--levels', 0) ?? 0
  const [id, ...rest] = args
  if (!id || rest.length === 0) throw new Error('usage: probe.js [--levels=N] [--bootstrap=host:port,...] <coreKey> <lat,lon>...')
  await probe({ key: HypercoreId.decode(id), points: parsePoints(rest), levels, bootstrap: bootstrapFlag(flags, '--bootstrap') })
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
