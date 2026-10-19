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
} = require('./helpers/helpers')

// A clean clone has no data/ (README "Fixtures"). Without this preflight the first data-dependent
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

require('./geo/tiles')
require('./build/keys')
require('./cli/flags')
require('./cli/shells')
require('./build/value-size')
require('./net/client')
require('./net/report')
require('./read/address-derive')
require('./build/file-source')
require('./read/areas')
require('./net/no-peer')

const missing = FIXTURES.filter((p) => !fs.existsSync(p))

if (missing.length > 0) {
  test('data fixtures are present', { skip: true }, () => {})
  console.error(
    'skipping the data-dependent suite: build the fixtures in README "Fixtures" first\nmissing:\n  ' + missing.join('\n  ')
  )
} else {
  require('./build/archive')
  require('./build/multisig')
  require('./net/sparse-read')
  require('./net/sparse-z8-block')
  require('./net/sparse-swarm')
  require('./build/gazetteer')
  require('./read/address')
  require('./read/preview')
  require('./read/z15')
  require('./read/address-accuracy')
  require('./read/address-accuracy-lugano')
  require('./build/planet-build')
  require('./net/seed-probe')
  require('./build/second-publish')
  require('./build/chunked-commit')
  require('./net/seeder-sees')
  require('./geo/cell-2x2')
  require('./read/top-levels')
  require('./read/render-svg')
  require('./app/ops')
}

test.resume()
