'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { tmpStore, LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE, GAZETTEER_LUGANO_JSON: GAZETTEER } = require('./helpers')
const { fillAtlas } = require('./atlas')
const { scoreRegion } = require('./address-score')

const FIXTURE = path.join(__dirname, 'fixtures', 'lugano-nominatim.json')

async function atlasLugano (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE], GAZETTEER)
  return bee
}

// [minHits, scored] per part, from results/address-accuracy-lugano.txt (road 7/11, neighbourhood 4/5,
// suburb 5/7, village 2/6, city 10/11, housenumber 3/5), with a point of slack where there is room
const FLOORS = {
  road: [6, 11],
  neighbourhood: [3, 5],
  suburb: [4, 7],
  village: [1, 6],
  city: [9, 11],
  housenumber: [2, 5]
}

test('address accuracy: 11 Lugano points against Nominatim, hit rate and distances per part', async (t) => {
  const bee = await atlasLugano(await tmpStore(t, 'address-accuracy-lugano'))
  const entries = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  t.is(entries.length, 11)
  await scoreRegion(t, bee, entries, FLOORS)
})
