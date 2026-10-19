'use strict'
// TEST KEYS ONLY. Never use a set from here for a real publish.
const { generate } = require('../lib/build/keys')
const { parseFlags } = require('./flags')

function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [dir] = args
  if (!dir) throw new Error('usage: keys.js <keysDir>')
  generate(dir)
}

try {
  main()
} catch (err) {
  console.error(err)
  Bare.exitCode = 1
}
