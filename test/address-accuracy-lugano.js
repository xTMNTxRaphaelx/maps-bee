'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { tmpStore, LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE, GAZETTEER_LUGANO_JSON: GAZETTEER, AREAS_LUGANO_JSON: AREAS } = require('./helpers')
const { fillAtlas } = require('./atlas')
const { scoreRegion } = require('./address-score')

const FIXTURE = path.join(__dirname, 'fixtures', 'lugano-nominatim-wide.json')

async function atlasLugano (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE], GAZETTEER, AREAS)
  return bee
}

// [minHits, scored] per part, from results/address-accuracy-lugano.txt (road 36/43,
// neighbourhood 3/3, suburb 5/7, village 22/37, city 29/44, housenumber 19/24), with a point of
// slack where there is room.
const FLOORS = {
  road: [35, 43],
  neighbourhood: [2, 3],
  suburb: [4, 7],
  village: [21, 37],
  city: [28, 44],
  housenumber: [18, 24]
}

test('address accuracy: 45 Lugano points against Nominatim, hit rate and distances per part', async (t) => {
  const bee = await atlasLugano(await tmpStore(t, 'address-accuracy-lugano'))
  const entries = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  t.is(entries.length, 45)
  await scoreRegion(t, bee, entries, FLOORS)
})
