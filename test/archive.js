'use strict'
const test = require('brittle')
const zlib = require('bare-zlib')
const { openArchive, readTile } = require('../scripts/pmtiles-file')
const { decode, decodeGzip } = require('../scripts/mvt')
const { lonLatToTile } = require('../scripts/tiles')
const { JAIPUR_ARCHIVE, STATE_ARCHIVE, JAIPUR_CENTRE } = require('./helpers')

test('Jaipur extract header covers z11-14 and the bbox', async (t) => {
  const archive = openArchive(JAIPUR_ARCHIVE)
  const h = await archive.getHeader()
  t.is(h.minZoom, 11)
  t.is(h.maxZoom, 14)
  t.ok(h.minLon <= JAIPUR_CENTRE.lon && JAIPUR_CENTRE.lon <= h.maxLon)
  t.ok(h.minLat <= JAIPUR_CENTRE.lat && JAIPUR_CENTRE.lat <= h.maxLat)
  await archive.close()
})

test('state extract header covers z0-10', async (t) => {
  const archive = openArchive(STATE_ARCHIVE)
  const h = await archive.getHeader()
  t.is(h.minZoom, 0)
  t.is(h.maxZoom, 10)
  await archive.close()
})

test('centre z14 tile decodes to MVT with roads and places', async (t) => {
  const archive = openArchive(JAIPUR_ARCHIVE)
  const { x, y } = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
  const tile = await readTile(archive, 14, x, y)
  t.ok(tile, 'tile present')
  t.is(tile.raw.byteLength, 26036)
  // compressed size depends on the zlib build, so only the round trip is asserted
  t.ok(tile.gz.byteLength < tile.raw.byteLength)
  t.alike(zlib.gunzipSync(tile.gz), tile.raw)
  const layers = Object.keys(decode(tile.raw).layers)
  t.ok(layers.includes('roads'))
  t.ok(layers.includes('places'))
  t.alike(Object.keys(decodeGzip(tile.gz).layers), layers)
  await archive.close()
})

test('a tile outside the extract is absent', async (t) => {
  const archive = openArchive(JAIPUR_ARCHIVE)
  t.is(await readTile(archive, 14, 0, 0), null)
  await archive.close()
})
