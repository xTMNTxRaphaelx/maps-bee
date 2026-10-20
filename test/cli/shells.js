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
// fail fast — it starts a DHT and runs until killed. scripts/study/bare-display.js and
// village-gap.js are excluded for the same reason: no arguments, so they run to completion
// against data/ rather than stopping at a usage line.
//
// The two study scripts that are here earn their place: scripts/study/ is otherwise untested, it
// imports from lib/ by path, and the reorganisation could have broken any of those requires.
// Note what this does not cover — a usage-line exit never reads a gazetteer, so it would not have
// caught the day the harvest format changed under these scripts.
const SHELLS = [
  'bin/gazetteer-put.js',
  'bin/gazetteer.js',
  'bin/keys.js',
  'bin/local-check.js',
  'bin/planet-build.js',
  'bin/planet-commit.js',
  'bin/probe.js',
  'bin/publish.js',
  'bin/seed.js',
  'scripts/study/address-shapes.js',
  'scripts/study/fixture-points.js'
]

function run (file) {
  return new Promise((resolve, reject) => {
    const child = spawn(BARE, [file], { cwd: ROOT })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('every shell resolves its modules and refuses missing arguments', async (t) => {
  for (const file of SHELLS) {
    const { code, out } = await run(file)
    // a usage line can only be reached once every require in the file has resolved
    t.ok(/usage:/.test(out), `${file}: prints its usage, so its requires resolve`)
    t.is(code, 1, `${file}: exits non-zero`)
  }
})
