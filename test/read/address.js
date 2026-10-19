'use strict'
const test = require('brittle')
const { decode } = require('../../lib/mvt')
const { openArchive, readTile } = require('../../lib/build/pmtiles-file')
const { lonLatToTile, pinTiles } = require('../../lib/tiles')
const { deriveAddress, HOUSE_M } = require('../../lib/address')
const { JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE, LUGANO_ARCHIVE, LUGANO_Z15_ARCHIVE } = require('../helpers/helpers')

const LABEL = { name: 'Jaipur', kind: 'city', km: 4.6 }

async function z14Cell (archive, point) {
  const out = []
  for (const xy of pinTiles(point.lon, point.lat, 14).tiles) {
    if (!xy) continue
    const t = await readTile(archive, 14, xy[0], xy[1])
    if (t) out.push({ vt: decode(t.raw), x: xy[0], y: xy[1], zoom: 14 })
  }
  return out
}

async function z15Pin (archive, point) {
  const { x, y } = lonLatToTile(point.lon, point.lat, 15)
  const t = await readTile(archive, 15, x, y)
  return t ? [{ vt: decode(t.raw), x, y, zoom: 15 }] : []
}

test('deriveAddress: parts and display from the z14 2x2 plus the z15 pin tile, z14 alone, nothing', async (t) => {
  const a14 = openArchive(JAIPUR_ARCHIVE)
  const a15 = openArchive(JAIPUR_Z15_ARCHIVE)
  const placed = async (point) => [...await z14Cell(a14, point), ...await z15Pin(a15, point)]

  const tonk = { lat: 26.879464, lon: 75.796516 }
  const a = deriveAddress({ point: tonk, tiles: await placed(tonk), label: LABEL })
  t.alike(Object.keys(a), ['housenumber', 'road', 'neighbourhood', 'suburb', 'village', 'city', 'region', 'country', 'near', 'nearby', 'display'])
  t.is(a.housenumber, null)
  t.alike({ name: a.road.name, kind: a.road.kind }, { name: 'Market Road', kind: 'major_road' })
  t.ok(Math.abs(a.road.metres - 215) < 1, `road ${a.road.metres} m`)
  t.is(a.near, null, 'nearest poi is 176 m')
  t.is(a.neighbourhood.name, 'Barkat Nagar')
  t.ok(Math.abs(a.neighbourhood.metres - 470) < 1, `neighbourhood ${a.neighbourhood.metres} m`)
  t.is(a.suburb.name, 'Tonk Phatak')
  t.is(a.village, null, 'no village or hamlet label within VILLAGE_M')
  t.ok(Math.abs(a.suburb.metres - 322) < 1, `suburb ${a.suburb.metres} m`)
  t.is(a.city, LABEL)
  t.is(a.region, null)
  t.is(a.country, null)
  t.is(a.display, 'Barkat Nagar, Tonk Phatak, Jaipur')

  const setu = { lat: 26.9124, lon: 75.7873 }
  const b = deriveAddress({ point: setu, tiles: await placed(setu), label: LABEL })
  t.is(b.display, 'Acharya Shri Tulsi Setu, Hasanpura-C, Jaipur')
  t.ok(b.road.metres < 3, `road ${b.road.metres} m`)
  t.is(b.housenumber, null, 'nearest address point is 231 m')

  const amer = { lat: 26.9855, lon: 75.8513 }
  const z14 = deriveAddress({ point: amer, tiles: await z14Cell(a14, amer), label: LABEL })
  t.is(z14.road.name, 'Amer Road')
  t.ok(Math.abs(z14.road.metres - 265) < 1, `z14 road ${z14.road.metres} m`)
  const both = deriveAddress({ point: amer, tiles: await placed(amer), label: LABEL })
  t.is(both.road.name, 'to Jaigarh Fort', 'the z15 pin tile holds a nearer named road')
  t.ok(Math.abs(both.road.metres - 42) < 1, `z14+z15 road ${both.road.metres} m`)
  t.is(both.village.name, 'Amber')
  t.alike(Object.keys(both.village).sort(), ['metres', 'name'], 'the tile path returns the same shape as the gazetteer path')
  t.ok(Math.abs(both.village.metres - 586) < 1, `village ${both.village.metres} m`)
  t.is(both.display, 'to Jaigarh Fort, kundalaoo Colony, Jaipur', 'the nearest area label, 282 m, over the village at 586 m')

  const plot = { lat: 26.875861, lon: 75.791891 }
  const p = deriveAddress({ point: plot, tiles: await placed(plot), label: LABEL })
  t.is(p.housenumber.value, '917', 'standing on an address point')
  t.ok(p.housenumber.metres < 1, `house number ${p.housenumber.metres} m`)
  t.is(p.road, null, 'no named road within ROAD_M here')
  t.is(p.display, '917, Barkat Nagar, Jaipur', 'the house number leads the display on its own')

  await a14.close()
  await a15.close()

  t.alike(deriveAddress({ point: tonk, tiles: [], label: null }), {
    housenumber: null, road: null, neighbourhood: null, suburb: null, village: null, city: null, region: null, country: null, near: null, nearby: null, display: ''
  })
})

// Lugano: dense Swiss data, a house number and a named road within metres of the pin
test('deriveAddress in Lugano: house number and road lead, the nearest area label follows', async (t) => {
  const a14 = openArchive(LUGANO_ARCHIVE)
  const a15 = openArchive(LUGANO_Z15_ARCHIVE)
  const point = { lat: 46.006005, lon: 8.952766 }
  const tiles = []
  for (const [x, y] of pinTiles(point.lon, point.lat, 14).tiles) {
    const z = await readTile(a14, 14, x, y)
    if (z) tiles.push({ vt: decode(z.raw), x, y, zoom: 14 })
  }
  const { x, y } = lonLatToTile(point.lon, point.lat, 15)
  tiles.push({ vt: decode((await readTile(a15, 15, x, y)).raw), x, y, zoom: 15 })
  const a = deriveAddress({ point, tiles, label: { name: 'Lugano', kind: 'city', km: 0.3 } })
  t.is(a.housenumber.value, '9')
  t.ok(a.housenumber.metres < HOUSE_M, `house number ${a.housenumber.metres} m`)
  t.is(a.road.name, 'Corso Enrico Pestalozzi')
  t.ok(a.road.metres < 10, `road ${a.road.metres} m`)
  t.is(a.neighbourhood.name, 'Quartiere Maghetti')
  t.is(a.village, null, 'the next municipality, Massagno, is 987 m away, past VILLAGE_M')
  t.is(a.display, '9 Corso Enrico Pestalozzi, Quartiere Maghetti, Lugano')
  await a14.close()
  await a15.close()
})
