'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const { scoreRegion } = require('./address-score')

const FIXTURE = path.join(__dirname, 'fixtures', 'jaipur-nominatim.json')

// the store from tmpStore owns the core and closes it; bee.close would close the store a second time
async function atlas15 (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE])
  return bee
}

// [minHits, scored] per part, from results/address-accuracy-jaipur.txt (road 5/6, neighbourhood 7/7,
// suburb 12/12, village 1/2, city 18/19, housenumber 0/0), with a point of slack where there is room
const FLOORS = {
  road: [4, 6],
  neighbourhood: [6, 7],
  suburb: [11, 12],
  village: [1, 2],
  city: [17, 19],
  housenumber: [0, 0]
}

test('address accuracy: 20 Jaipur points against Nominatim, hit rate and distances per part', async (t) => {
  const bee = await atlas15(await tmpStore(t, 'address-accuracy'))
  const entries = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  t.is(entries.length, 20)
  await scoreRegion(t, bee, entries, FLOORS)
})
