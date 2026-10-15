'use strict'
const fs = require('bare-fs')
const { buildBee } = require('../scripts/bee-build')
const { gazKeys, areaKeys } = require('../scripts/gazetteer-lib')
const { STATE_ARCHIVE, JAIPUR_ARCHIVE, GAZETTEER_JSON: GAZ, AREAS_JSON: AREAS } = require('./helpers')


function cities (file = GAZ) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
}

// tiles and the city+town gazetteer in one bee, as the signed planet bee would hold them
async function fillAtlas (bee, archives = [STATE_ARCHIVE, JAIPUR_ARCHIVE], gazetteer = GAZ, areas = AREAS) {
  await buildBee(bee, archives, () => {})
  const w = bee.write()
  for (const { key, value } of gazKeys(cities(gazetteer))) w.tryPut(key, value)
  if (areas) for (const { key, value } of areaKeys(JSON.parse(fs.readFileSync(areas, 'utf8')))) w.tryPut(key, value)
  await w.flush()
}

module.exports = { cities, fillAtlas }
