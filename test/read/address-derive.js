'use strict'
const test = require('brittle')
const { lonLatToTile } = require('../../lib/tiles')
const { deriveAddress } = require('../../lib/address')

// Synthetic tiles, so deriveAddress runs without the data/ extracts: type, properties, extent and
// loadGeometry are the whole surface it touches.
const EXTENT = 4096
const POINT = { lon: 75.8, lat: 26.9 }
const TILE = { ...lonLatToTile(POINT.lon, POINT.lat, 14), zoom: 14 }

// the inverse of address.js project(), so a feature can be placed at a given lon/lat
function local (lon, lat, tile) {
  const size = EXTENT * Math.pow(2, tile.zoom)
  const x = (lon + 180) * size / 360 - EXTENT * tile.x
  const y = size * (1 - Math.log(Math.tan((lat + 90) * Math.PI / 360)) / Math.PI) / 2 - EXTENT * tile.y
  return { x, y }
}

// metres north of POINT, as a lon/lat, using the WGS84 meridional degree length written out rather
// than imported: sharing a constant with the code under test makes its error cancel, so the
// assertions read clean while being wrong. That happened — the road case measured a suspiciously
// exact 12.000000002 m when address.js and this helper both used 110574.
const A = 6378137
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)

function metresPerDegreeLat (lat) {
  const s = Math.sin(lat * Math.PI / 180)
  const d = 1 - E2 * s * s
  return (Math.PI / 180) * A * (1 - E2) / (d * Math.sqrt(d))
}

function north (metres) {
  return { lon: POINT.lon, lat: POINT.lat + metres / metresPerDegreeLat(POINT.lat) }
}

function point (properties, metres, tile = TILE) {
  const { lon, lat } = north(metres)
  return { type: 1, extent: EXTENT, properties, loadGeometry: () => [[local(lon, lat, tile)]] }
}

function road (properties, metres, tile = TILE) {
  const { lat } = north(metres)
  return {
    type: 2,
    extent: EXTENT,
    properties,
    loadGeometry: () => [[local(POINT.lon - 0.01, lat, tile), local(POINT.lon + 0.01, lat, tile)]]
  }
}

function tiles (layers, tile = TILE) {
  const vt = { layers: {} }
  for (const [name, features] of Object.entries(layers)) {
    vt.layers[name] = { length: features.length, feature: (i) => features[i] }
  }
  return [{ vt, x: tile.x, y: tile.y, zoom: tile.zoom }]
}

const CITY = { name: 'Jaipur', kind: 'city', km: 4.6 }

test('the synthetic harness places a feature where it says it does', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ places: [point({ name: 'Nbhd', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 100)] }),
    label: CITY
  })
  // 1 mm, not 1 m: the placement is exact and cheap-ruler is good to well under a millimetre here,
  // so a loose bound would hide a real change in the metric
  t.ok(Math.abs(a.neighbourhood.metres - 100) < 0.001, `placed at 100 m, measured ${a.neighbourhood.metres}`)
})

test('an address feature with no house number never reaches the display', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({
      buildings: [point({ kind: 'address' }, 15)],
      roads: [road({ name: 'Market Road', kind: 'minor_road' }, 10)]
    }),
    label: CITY
  })
  t.is(a.housenumber, null, 'no housenumber part')
  t.absent(a.display.includes('undefined'), `display is ${JSON.stringify(a.display)}`)
  t.is(a.display, 'Market Road, Jaipur')
})

test('a nearer address feature with a house number still wins', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({
      buildings: [point({ kind: 'address' }, 5), point({ kind: 'address', addr_housenumber: '12' }, 15)],
      roads: [road({ name: 'Market Road', kind: 'minor_road' }, 10)]
    }),
    label: CITY
  })
  t.is(a.housenumber.value, '12')
  t.is(a.display, '12 Market Road, Jaipur')
})

test('an unnamed place does not consume the slot and delete the area', (t) => {
  const layers = (nbhd) => ({
    roads: [road({ name: 'Market Road', kind: 'minor_road' }, 10)],
    places: [
      point({ ...nbhd, kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 30),
      point({ name: 'Real Suburb', kind: 'neighbourhood', kind_detail: 'suburb' }, 745)
    ]
  })
  const unnamed = deriveAddress({ point: POINT, tiles: tiles(layers({})), label: CITY })
  const named = deriveAddress({ point: POINT, tiles: tiles(layers({ name: 'Real Nbhd' })), label: CITY })

  t.is(unnamed.neighbourhood, null, 'an unnamed neighbourhood is not a neighbourhood')
  t.is(unnamed.display, 'Market Road, Real Suburb, Jaipur', 'the suburb survives')
  t.is(named.display, 'Market Road, Real Nbhd, Jaipur')
})

// The same shape on the two predicates where the extracts do carry nameless features, in bulk:
// these are what the per-point invariant in test/address-score.js reaches on real data.
test('a nameless road does not take the road slot from a named one further away', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ roads: [road({ kind: 'minor_road' }, 8), road({ name: 'Market Road', kind: 'minor_road' }, 25)] }),
    label: CITY
  })
  t.is(a.road.name, 'Market Road', 'the nearer nameless road is not a road')
  t.absent(a.display.includes('undefined'), `display is ${JSON.stringify(a.display)}`)
  t.is(a.display, 'Market Road, Jaipur')
})

test('a nameless poi does not become the "near" part', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ pois: [point({ kind: 'cafe' }, 10), point({ name: 'Real Cafe', kind: 'cafe' }, 60)] }),
    label: CITY
  })
  t.is(a.near.name, 'Real Cafe')
  t.is(a.display, 'near Real Cafe, Jaipur')
})

// The last resort in display(): a line that would be the city alone reaches past ROAD_ON_M and
// NEAR_M rather than naming nothing. It must not fire anywhere else, or a road 200 m away starts
// displacing the area label that actually describes the pin.
test('a city-only display reaches past ROAD_ON_M and NEAR_M, and only then', (t) => {
  const poi = deriveAddress({
    point: POINT,
    tiles: tiles({ pois: [point({ name: 'Alpe Grande', kind: 'peak' }, 400)] }),
    label: CITY
  })
  t.is(poi.near, null, 'past NEAR_M, so not the specific part')
  t.is(poi.nearby.name, 'Alpe Grande')
  t.is(poi.display, 'near Alpe Grande, Jaipur')

  const far = deriveAddress({
    point: POINT,
    tiles: tiles({ roads: [road({ name: 'SP13', kind: 'major_road' }, 213)] }),
    label: CITY
  })
  t.is(far.display, 'near SP13, Jaipur', 'a road past ROAD_ON_M is named rather than dropped')

  const both = deriveAddress({
    point: POINT,
    tiles: tiles({ roads: [road({ name: 'SP13', kind: 'major_road' }, 213)], pois: [point({ name: 'Alpe Grande', kind: 'peak' }, 400)] }),
    label: CITY
  })
  t.is(both.display, 'near SP13, Jaipur', 'the nearer of the two wins')

  const withArea = deriveAddress({
    point: POINT,
    tiles: tiles({
      roads: [road({ name: 'SP13', kind: 'major_road' }, 213)],
      places: [point({ name: 'Nbhd', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 300)]
    }),
    label: CITY
  })
  t.is(withArea.display, 'Nbhd, Jaipur', 'an area suppresses the last resort')

  const beyond = deriveAddress({
    point: POINT,
    tiles: tiles({ pois: [point({ name: 'Too Far', kind: 'peak' }, 600)] }),
    label: CITY
  })
  t.is(beyond.nearby, null, 'past NEARBY_M is not reached for')
  t.is(beyond.display, 'Jaipur', 'and the city alone is still the honest answer')
})

test('one places pass still resolves neighbourhood, suburb and village independently', (t) => {
  let reads = 0
  const features = [
    point({ name: 'Nbhd', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 200),
    point({ name: 'Suburb', kind: 'neighbourhood', kind_detail: 'suburb' }, 2000),
    point({ name: 'Village', kind: 'locality', kind_detail: 'village' }, 600),
    point({ name: 'Hamlet', kind: 'locality', kind_detail: 'hamlet' }, 100),
    point({ name: 'Too Far', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 900)
  ]
  const vt = { layers: { places: { length: features.length, feature: (i) => { reads++; return features[i] } } } }
  const a = deriveAddress({ point: POINT, tiles: [{ vt, x: TILE.x, y: TILE.y, zoom: TILE.zoom }], label: CITY })

  t.is(a.neighbourhood.name, 'Nbhd')
  t.is(a.suburb.name, 'Suburb')
  t.is(a.village.name, 'Village')
  t.is(reads, features.length, 'the layer is walked once, not once per part')
})

test('a place beyond its threshold is dropped, not clamped to the threshold', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ places: [point({ name: 'Far Village', kind: 'locality', kind_detail: 'village' }, 900)] }),
    label: CITY
  })
  t.is(a.village, null, 'VILLAGE_M is 700 m')
})

test('a feature carrying no geometry is out of range rather than an error', (t) => {
  const empty = { type: 1, extent: EXTENT, properties: { name: 'Ghost', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, loadGeometry: () => [] }
  const emptyRing = { type: 1, extent: EXTENT, properties: { name: 'Ghost2', kind: 'locality', kind_detail: 'village' }, loadGeometry: () => [[]] }
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ places: [empty, emptyRing, point({ name: 'Real', kind: 'neighbourhood', kind_detail: 'neighbourhood' }, 50)] }),
    label: CITY
  })
  t.is(a.neighbourhood.name, 'Real', 'the geometryless feature did not win on a NaN distance')
  t.is(a.village, null)
  t.is(a.display, 'Real, Jaipur')
})

test('an empty road geometry does not throw either', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({ roads: [{ type: 2, extent: EXTENT, properties: { name: 'Ghost Road' }, loadGeometry: () => [[]] }] }),
    label: CITY
  })
  t.is(a.road, null)
  t.is(a.display, 'Jaipur')
})

test('the nearest road wins across a multi-segment geometry', (t) => {
  const a = deriveAddress({
    point: POINT,
    tiles: tiles({
      roads: [road({ name: 'Far Road', kind: 'minor_road' }, 120), road({ name: 'Near Road', kind: 'minor_road' }, 12)]
    }),
    label: CITY
  })
  t.is(a.road.name, 'Near Road')
  t.ok(Math.abs(a.road.metres - 12) < 0.001, `measured ${a.road.metres}`)
})
