'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const { buildBee } = require('../scripts/bee-build')
const { gazKeys } = require('../scripts/gazetteer-lib')
const { STATE_ARCHIVE, JAIPUR_ARCHIVE } = require('./helpers')

const GAZ = path.join(__dirname, '..', 'data', 'gazetteer.json')

function cities () {
  return JSON.parse(fs.readFileSync(GAZ, 'utf8')).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
}

// tiles and the city+town gazetteer in one bee, as the signed planet bee would hold them
async function fillAtlas (bee) {
  await buildBee(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE], () => {})
  const w = bee.write()
  for (const { key, value } of gazKeys(cities())) w.tryPut(key, value)
  await w.flush()
}

module.exports = { cities, fillAtlas }
