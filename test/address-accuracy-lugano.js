'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const Hyperbee = require('hyperbee2')
const { tmpStore, LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const { scoreRegion } = require('./address-score')

const FIXTURE = path.join(__dirname, 'fixtures', 'lugano-nominatim.json')
const GAZETTEER = path.join(__dirname, '..', 'data', 'gazetteer-lugano.json')

async function atlasLugano (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE], GAZETTEER)
  return bee
}

test('address accuracy: 11 Lugano points against Nominatim, hit rate and distances per part', async (t) => {
  const bee = await atlasLugano(await tmpStore(t, 'address-accuracy-lugano'))
  const entries = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  t.is(entries.length, 11)
  await scoreRegion(t, bee, entries)
})
