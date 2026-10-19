'use strict'
const fs = require('bare-fs')
const test = require('brittle')
const {
  STATE_ARCHIVE,
  JAIPUR_ARCHIVE,
  JAIPUR_Z15_ARCHIVE,
  LUGANO_ARCHIVE,
  LUGANO_Z15_ARCHIVE,
  ATLANTIC_ARCHIVE,
  GAZETTEER_JSON,
  GAZETTEER_LUGANO_JSON,
  AREAS_JSON,
  AREAS_LUGANO_JSON,
  SIGNED_STORE,
  KEYS_FILE
} = require('./helpers')

// A clean clone has no data/ (docs/TESTING.md stage 2). Without this preflight the first data-dependent
// test opens a missing archive and the ENOENT aborts the runtime mid-suite rather than failing one
// test, so: data-free modules first, then the rest only if every fixture is on disk. A partial
// setup run is the likely case, so a missing gazetteer JSON counts as much as a missing extract.
const FIXTURES = [
  STATE_ARCHIVE,
  JAIPUR_ARCHIVE,
  JAIPUR_Z15_ARCHIVE,
  LUGANO_ARCHIVE,
  LUGANO_Z15_ARCHIVE,
  ATLANTIC_ARCHIVE,
  GAZETTEER_JSON,
  GAZETTEER_LUGANO_JSON,
  AREAS_JSON,
  AREAS_LUGANO_JSON,
  SIGNED_STORE,
  KEYS_FILE
]

test.pause()

require('./tiles')
require('./keys')
require('./flags')
require('./value-size')
require('./probe-helpers')
require('./address-derive')
require('./file-source')
require('./areas')

const missing = FIXTURES.filter((p) => !fs.existsSync(p))

if (missing.length > 0) {
  test('data fixtures are present', { skip: true }, () => {})
  console.error(
    'skipping the data-dependent suite: run docs/TESTING.md stage 2 first\nmissing:\n  ' + missing.join('\n  ')
  )
} else {
  require('./archive')
  require('./multisig')
  require('./sparse-read')
  require('./sparse-z8-block')
  require('./sparse-swarm')
  require('./gazetteer')
  require('./address')
  require('./preview')
  require('./z15')
  require('./address-accuracy')
  require('./address-accuracy-lugano')
  require('./planet-build')
  require('./seed-probe')
  require('./second-publish')
  require('./chunked-commit')
  require('./seeder-sees')
  require('./cell-2x2')
  require('./top-levels')
  require('./render-svg')
  require('./app-ops')
}

test.resume()
