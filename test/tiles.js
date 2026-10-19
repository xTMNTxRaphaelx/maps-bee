'use strict'
const test = require('brittle')
const b4a = require('b4a')
const { pinTiles, mortonCode, mortonToXY, parseBbox, quadkey, lonLatToTile, tileKey, parseTileKey, bboxTiles, subtreeRange } = require('../scripts/tiles')
const { JAIPUR_CENTRE, JAIPUR_BBOX } = require('./helpers')

const { lon, lat } = JAIPUR_CENTRE

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

// a bbox of NaNs selects no tiles, so an unchecked one reports a successful empty run
test('parseBbox takes four finite numbers and nothing else', async (t) => {
  t.alike(parseBbox('8.9,45.9,9.1,46.1'), [8.9, 45.9, 9.1, 46.1])
  for (const s of ['8.9,45.9,9.1', '8.9,45.9,9.1,46.1,0', 'data/lugano.pmtiles', '8.9,45.9,9.1,x', '']) {
    await t.exception.all(() => parseBbox(s), /bad bbox/, `rejects ${JSON.stringify(s)}`)
  }
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


test('quadkey digits at z1', (t) => {
  t.is(quadkey(0, 0, 1), '0')
  t.is(quadkey(1, 0, 1), '1')
  t.is(quadkey(0, 1, 1), '2')
  t.is(quadkey(1, 1, 1), '3')
})

test('Jaipur centre tile at z14, z12, z10', (t) => {
  t.alike(lonLatToTile(lon, lat, 14), { x: 11641, y: 6920 })
  t.alike(lonLatToTile(lon, lat, 12), { x: 2910, y: 1730 })
  t.alike(lonLatToTile(lon, lat, 10), { x: 727, y: 432 })
})

test('parent quadkey is a prefix of the child', (t) => {
  const child = quadkey(11641, 6920, 14)
  t.is(child, '12312301113001')
  t.is(quadkey(2910, 1730, 12), child.slice(0, 12))
})

test('tileKey round-trips through parseTileKey', (t) => {
  t.alike(parseTileKey(tileKey(14, 11641, 6920)), { z: 14, x: 11641, y: 6920 })
  t.is(b4a.toString(tileKey(14, 11641, 6920)), '14/12312301113001')
})

test('lonLatToTile clamps at the mercator edges', (t) => {
  t.alike(lonLatToTile(180, 85.0511, 3), { x: 7, y: 0 })
  t.alike(lonLatToTile(-180, -85.0511, 3), { x: 0, y: 7 })
})

// the exact value protomaps whole-world headers carry; a guard one ulp inside it rejects every
// planet-wide archive bbox, and 85.0511 is inside, so only the true limit catches that
test('lonLatToTile accepts the true mercator limit a planet header carries', (t) => {
  const LIMIT = 85.05112877980659
  t.alike(lonLatToTile(-180, LIMIT, 0), { x: 0, y: 0 })
  t.alike(lonLatToTile(180, -LIMIT, 0), { x: 0, y: 0 })
  t.alike(lonLatToTile(-180, LIMIT, 10), { x: 0, y: 0 })
})

test('lonLatToTile rejects input that would key the wrong place', (t) => {
  t.exception.all(() => lonLatToTile(NaN, lat, 14), /out of range/)
  t.exception.all(() => lonLatToTile(200, lat, 14), /out of range/)
  t.exception.all(() => lonLatToTile(lon, 90, 14), /out of range/)
  t.alike(lonLatToTile(lon, lat, 14), { x: 11641, y: 6920 }, 'valid input is unchanged')
})

test('a 3x3 of z14 tiles around the centre spans two z12 subtrees', (t) => {
  const c = lonLatToTile(lon, lat, 14)
  const parents = new Set()
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) parents.add(quadkey((c.x + dx) >> 2, (c.y + dy) >> 2, 12))
  }
  t.alike([...parents].sort(), ['123123011112', '123123011130'])
})

test('subtreeRange brackets every key in the subtree', (t) => {
  const r = subtreeRange(14, '123123011130')
  t.is(b4a.toString(r.gte), '14/123123011130')
  t.is(b4a.toString(r.lt), '14/1231230111304')
  const key = tileKey(14, 11641, 6920)
  t.ok(b4a.compare(r.gte, key) <= 0)
  t.ok(b4a.compare(key, r.lt) < 0)
  const outside = tileKey(14, 11641, 6919) // parent 123123011112
  t.ok(b4a.compare(outside, r.gte) < 0)
})

test('bboxTiles yields a full rectangle of unique tiles', (t) => {
  const tl = lonLatToTile(JAIPUR_BBOX[0], JAIPUR_BBOX[3], 14)
  const br = lonLatToTile(JAIPUR_BBOX[2], JAIPUR_BBOX[1], 14)
  const expected = (br.x - tl.x + 1) * (br.y - tl.y + 1)
  const keys = new Set()
  for (const { x, y } of bboxTiles(JAIPUR_BBOX, 14)) keys.add(b4a.toString(tileKey(14, x, y)))
  t.is(keys.size, expected)
})
