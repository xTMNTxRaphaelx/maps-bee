'use strict'
const test = require('brittle')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')

const ROOT = path.join(__dirname, '..', '..')
const BARE = path.join(ROOT, 'node_modules', 'bare-runtime', 'bin', 'bare')

// Nothing under lib/ or test/ requires bin/, by design — so without this the suite cannot catch a
// shell whose requires no longer resolve, which is exactly what moving scripts/ into lib/+bin/
// could have done to any of them. Running each with no arguments loads every module the file
// requires and then stops at its own usage error, so it covers resolution without touching a
// store, a swarm or a fixture.
//
// Excluded: flags.js is a library, not a shell. testnet.js takes no arguments, so it does not
// fail fast — it starts a DHT and runs until killed.
const SHELLS = [
  'gazetteer-put',
  'gazetteer',
  'keys',
  'local-check',
  'planet-build',
  'planet-commit',
  'probe',
  'publish',
  'seed'
]

function run (file) {
  return new Promise((resolve, reject) => {
    const child = spawn(BARE, [path.join('bin', file)], { cwd: ROOT })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('every bin/ shell resolves its modules and refuses missing arguments', async (t) => {
  for (const name of SHELLS) {
    const file = name + '.js'
    const { code, out } = await run(file)
    // a usage line can only be reached once every require in the file has resolved
    t.ok(/usage:/.test(out), `${file}: prints its usage, so its requires resolve`)
    t.is(code, 1, `${file}: exits non-zero`)
  }
})
