'use strict'
const test = require('brittle')
const { pinTiles, mortonCode, mortonToXY, quadkey } = require('../scripts/tiles')

test('pinTiles: the 2x2 the pin leans into, row-major from the top-left', (t) => {
  t.alike(pinTiles(75.8, 26.9, 14), {
    origin: { x: 11641, y: 6919 },
    tiles: [[11641, 6919], [11642, 6919], [11641, 6920], [11642, 6920]]
  }, 'Jaipur matches results/cell-2x2.txt')

  const east = pinTiles(179.999, 0, 14)
  t.alike(east.tiles.map(([x]) => x), [16383, 0, 16383, 0], 'x wraps at the antimeridian')
  t.is(east.origin.x, 16383)

  const north = pinTiles(0, 85.051, 14) // row 0, fraction 0.07: leans up
  t.is(north.origin.y, -1)
  t.is(north.tiles[0], null, 'no row above row 0')
  t.is(north.tiles[1], null, 'no row above row 0')
  t.alike(north.tiles.slice(2).map(([, y]) => y), [0, 0])
})

test('mortonCode is the quadkey in base 4 and mortonToXY inverts it', (t) => {
  let ok = 0
  for (const z of [10, 14]) {
    const n = 2 ** z
    for (let i = 0; i < 500; i++) {
      const x = Math.floor(Math.random() * n)
      const y = Math.floor(Math.random() * n)
      const m = mortonCode(x, y, z)
      const back = mortonToXY(m, z)
      if (m.toString(4).padStart(z, '0') === quadkey(x, y, z) && back.x === x && back.y === y) ok++
    }
  }
  t.is(ok, 1000, '1,000 random tiles at z10 and z14')
})
