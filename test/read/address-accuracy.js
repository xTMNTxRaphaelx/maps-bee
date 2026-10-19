'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE } = require('../helpers/helpers')
const { fillAtlas } = require('../helpers/atlas')
const { scoreRegion } = require('../helpers/address-score')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'jaipur-nominatim-wide.json')

// the store from tmpStore owns the core and closes it; bee.close would close the store a second time
async function atlas15 (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE])
  return bee
}

// [minHits, scored] per part, from results/address-accuracy-jaipur.txt (road 28/36,
// neighbourhood 21/21, suburb 32/36, village 2/10, city 48/56, housenumber 14/16), with a point
// of slack where there is room. 60 points over three strata, so housenumber and village finally
// carry denominators the 20-point set could not: housenumber was 0/0, which any quality passes.
const FLOORS = {
  road: [27, 36],
  neighbourhood: [20, 21],
  suburb: [31, 36],
  village: [1, 10],
  city: [47, 56],
  housenumber: [13, 16]
}

test('address accuracy: 60 Jaipur points against Nominatim, hit rate and distances per part', async (t) => {
  const bee = await atlas15(await tmpStore(t, 'address-accuracy'))
  const entries = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  t.is(entries.length, 60)
  await scoreRegion(t, bee, entries, FLOORS)
})
