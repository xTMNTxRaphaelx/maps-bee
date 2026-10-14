'use strict'
const test = require('brittle')
const { pinTiles } = require('../scripts/tiles')
const { decode } = require('../scripts/mvt')
const { openArchive, readTile } = require('../scripts/pmtiles-file')
const { renderThumbnail, pinOffset, pinTileOffset } = require('../scripts/render-svg')
const { JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE, JAIPUR_CENTRE } = require('./helpers')

function count (s, sub) {
  return s.split(sub).length - 1
}

function drawn (vt) {
  let paths = 0
  let places = 0
  for (const name of Object.keys(vt.layers)) {
    const layer = vt.layers[name]
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (['earth', 'landuse', 'buildings'].includes(name) && f.type === 3) paths++
      else if (name === 'water' && (f.type === 2 || f.type === 3)) paths++
      else if (name === 'roads' && f.type === 2) paths++
      else if (name === 'places' && f.type === 1 && f.properties.name) places++
    }
  }
  return { paths, places }
}

test('renderThumbnail: 640x360, one path per feature, pin at the centre, attribution', async (t) => {
  const { origin, tiles: xy } = pinTiles(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
  const archive = openArchive(JAIPUR_ARCHIVE)
  const tiles = []
  for (const [x, y] of xy) tiles.push(decode((await readTile(archive, 14, x, y)).raw))
  await archive.close()
  const pin = pinOffset(JAIPUR_CENTRE, origin, 14)
  t.ok(Math.abs(pin.x - 0.74) < 0.01 && Math.abs(pin.y - 1.13) < 0.01, `pin ${pin.x} ${pin.y}`)

  const svg = renderThumbnail(tiles, pin)
  t.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">'))
  const counts = tiles.map(drawn)
  const expected = counts.reduce((n, c) => n + c.paths, 0)
  const places = counts.reduce((n, c) => n + c.places, 0)
  t.ok(expected > 0)
  t.is(count(svg, '<path '), expected + 1, 'one path per feature plus the pin')
  t.is(count(svg, '<text '), places + 1)
  t.is(count(svg, '<clipPath '), 4)
  t.ok(svg.includes('<g transform="translate(-155.0 -540.9)">'), 'pin 0.7422,1.1264 tile units at the centre')
  t.ok(svg.includes('<g transform="translate(320 180)">'))
  t.ok(svg.includes('© OpenStreetMap contributors'))

  const half = renderThumbnail([null, null, tiles[2], tiles[3]], pin)
  t.is(count(half, '<clipPath '), 2)
  t.is(count(half, '<path '), counts[2].paths + counts[3].paths + 1, 'one path per feature plus the pin')
  t.ok(half.includes('<g transform="translate(320 180)">'))
  t.ok(half.includes('© OpenStreetMap contributors'))
})

test('renderThumbnail draws the z15 pin tile over its z14 quarter', async (t) => {
  const { origin, tiles: xy } = pinTiles(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
  const archive = openArchive(JAIPUR_ARCHIVE)
  const tiles = []
  for (const [x, y] of xy) tiles.push(decode((await readTile(archive, 14, x, y)).raw))
  await archive.close()
  const archive15 = openArchive(JAIPUR_Z15_ARCHIVE)
  const z15 = decode((await readTile(archive15, 15, 23283, 13840)).raw)
  await archive15.close()
  const pin = pinOffset(JAIPUR_CENTRE, origin, 14)
  const counts = tiles.map(drawn)
  const z14paths = counts.reduce((n, c) => n + c.paths, 0)
  const z14places = counts.reduce((n, c) => n + c.places, 0)

  const at = pinTileOffset({ x: 23283, y: 13840 }, origin)
  t.alike(at, { x: 0.5, y: 1 })
  const svg = renderThumbnail(tiles, pin, { tile: z15, ...at })
  t.is(count(svg, '<clipPath '), 5)
  t.ok(svg.includes('<clipPath id="p"><rect x="320" y="640" width="320" height="320"/>'))
  t.is(count(svg, '<path '), z14paths + drawn(z15).paths + 1)
  t.is(count(svg, '<text '), z14places + drawn(z15).places + 1)
  t.is(count(renderThumbnail(tiles, pin), '<clipPath '), 4)
})

test('pinOffset unwraps the antimeridian and the row above 0', (t) => {
  const east = pinOffset({ lon: -179.999, lat: 0 }, pinTiles(-179.999, 0, 14).origin, 14)
  t.ok(Math.abs(east.x - 1.0455) < 0.01, `x ${east.x}`)
  const north = pinOffset({ lon: 0, lat: 85.051 }, pinTiles(0, 85.051, 14).origin, 14)
  t.ok(north.y > 1 && north.y < 1.5, `y ${north.y}`)
})
