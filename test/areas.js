'use strict'
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const CheapRuler = require('cheap-ruler').default
const { areaClass, areaKeys, putGazetteer, AREA_ZOOM, AREA_QUERY_ZOOM } = require('../scripts/gazetteer-lib')
const { readAreas } = require('../scripts/preview')
const { deriveAddress, SUBURB_M } = require('../scripts/address')
const { tmpStore } = require('./helpers')

const POINT = { lon: 75.8, lat: 26.9 }
const OPTS = { timeout: 5000 }
const CITY = { name: 'Jaipur', kind: 'city', km: 4.6 }

// a label `metres` east of POINT, on the WGS84 ruler the code measures with
function east (metres) {
  return new CheapRuler(POINT.lat, 'meters').offset([POINT.lon, POINT.lat], metres, 0)
}

function area (name, kindDetail, metres) {
  const [lon, lat] = east(metres)
  return { name, kind_detail: kindDetail, lon, lat }
}

async function beeWith (t, name, entries) {
  const store = await tmpStore(t, name)
  const core = store.get({ name })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  if (entries.length > 0) await putGazetteer(bee, entries, { keys: areaKeys })
  t.teardown(() => bee.close())
  return bee
}

test('areaClass maps the places kinds onto the three address classes', (t) => {
  t.is(areaClass({ name: 'a', kind: 'neighbourhood', kind_detail: 'neighbourhood' }), 'neighbourhood')
  t.is(areaClass({ name: 'a', kind: 'neighbourhood', kind_detail: 'suburb' }), 'suburb')
  t.is(areaClass({ name: 'a', kind: 'macrohood' }), 'suburb', 'macrohood is a suburb-scale label')
  t.is(areaClass({ name: 'a', kind: 'locality', kind_detail: 'village' }), 'village')
  t.is(areaClass({ name: 'a', kind: 'locality', kind_detail: 'hamlet' }), null, 'hamlets were wrong at every distance')
  t.is(areaClass({ kind: 'macrohood' }), null, 'an unnamed label is not a label')
})

// The one that matters: areaKeys writes at AREA_ZOOM and readAreas queries a 3x3 of
// AREA_QUERY_ZOOM. Get those two out of step and every read comes back empty, deriveAddress
// quietly falls back to the tiles, and nothing fails — the gazetteer would just never be used.
test('a key written at AREA_ZOOM is found by the AREA_QUERY_ZOOM window', async (t) => {
  t.ok(AREA_QUERY_ZOOM < AREA_ZOOM, `query z${AREA_QUERY_ZOOM} must be shallower than key z${AREA_ZOOM}`)
  const bee = await beeWith(t, 'areas-range', [area('Near Nbhd', 'neighbourhood', 100)])
  const found = await readAreas(bee, POINT, OPTS)
  t.is(found.length, 1, 'the label came back')
  t.is(found[0].name, 'Near Nbhd')
  t.is(found[0].kind_detail, 'neighbourhood', 'the class survives the round trip')
})

test('the query window reaches past SUBURB_M but does not sweep the whole world', async (t) => {
  const bee = await beeWith(t, 'areas-window', [
    area('In Range', 'suburb', SUBURB_M - 100),
    area('Far Away', 'suburb', 400000)
  ])
  const names = (await readAreas(bee, POINT, OPTS)).map((a) => a.name)
  t.ok(names.includes('In Range'), `a label at ${SUBURB_M - 100} m is inside the window`)
  t.absent(names.includes('Far Away'), '400 km away is not read at all')
})

test('deriveAddress takes the nearest label of each class and applies the thresholds', (t) => {
  const areas = [
    area('Far Nbhd', 'neighbourhood', 700),
    area('Near Nbhd', 'neighbourhood', 120),
    area('The Suburb', 'suburb', 2500),
    area('Too Far Village', 'village', 900)
  ]
  const a = deriveAddress({ point: POINT, tiles: [], label: CITY, areas })
  t.is(a.neighbourhood.name, 'Near Nbhd', 'nearest of the class wins')
  t.ok(Math.abs(a.neighbourhood.metres - 120) < 0.001, `measured ${a.neighbourhood.metres}`)
  t.is(a.suburb.name, 'The Suburb', 'a suburb at 2500 m is inside SUBURB_M where a z15 2x2 could not reach it')
  t.is(a.village, null, 'VILLAGE_M is 700 m')
  t.is(a.display, 'Near Nbhd, The Suburb, Jaipur')
})

// the regression the whole change exists to prevent: an empty area list must not read as
// "there is no neighbourhood here", or a bee without a/ keys loses its area parts entirely
test('no area labels falls back to the places layer of the tiles', (t) => {
  const EXTENT = 4096
  const [lon, lat] = east(200)
  const size = EXTENT * Math.pow(2, 14)
  const { x, y } = require('../scripts/tiles').lonLatToTile(POINT.lon, POINT.lat, 14)
  const f = {
    type: 1,
    extent: EXTENT,
    properties: { name: 'Tile Nbhd', kind: 'neighbourhood', kind_detail: 'neighbourhood' },
    loadGeometry: () => [[{
      x: (lon + 180) * size / 360 - EXTENT * x,
      y: size * (1 - Math.log(Math.tan((lat + 90) * Math.PI / 360)) / Math.PI) / 2 - EXTENT * y
    }]]
  }
  const tiles = [{ vt: { layers: { places: { length: 1, feature: () => f } } }, x, y, zoom: 14 }]
  const fromTiles = deriveAddress({ point: POINT, tiles, label: CITY, areas: null })
  t.is(fromTiles.neighbourhood.name, 'Tile Nbhd', 'null areas reads the tiles')
  const fromAreas = deriveAddress({ point: POINT, tiles, label: CITY, areas: [] })
  t.is(fromAreas.neighbourhood, null, 'an explicitly empty list is an answer, not a fallback')
})
