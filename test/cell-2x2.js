'use strict'
const test = require('brittle')
const { lonLatToTile, tileKey } = require('../scripts/tiles')
const { readCell, DETAIL_ZOOM } = require('../scripts/preview')
const { JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const { lon, lat } = JAIPUR_CENTRE

// the pin's tile plus the column and row neighbours on the side the pin leans to
function pick2x2 (lon, lat, z) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const xf = ((lon + 180) / 360) * n
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const x = Math.floor(xf)
  const y = Math.floor(yf)
  const x2 = xf - x < 0.5 ? x - 1 : x + 1
  const y2 = yf - y < 0.5 ? y - 1 : y + 1
  return { tiles: [[x, y], [x2, y], [x, y2], [x2, y2]], frac: { x: xf - x, y: yf - y } }
}

test('2x2 around the pin against the 16-tile cell, both cold', async (t) => {
  const { store, core: seederCore, ref } = await h.openSeeder(t)
  const L = seederCore.length
  const { tiles, frac } = pick2x2(lon, lat, DETAIL_ZOOM)
  t.alike(tiles[0], [lonLatToTile(lon, lat, DETAIL_ZOOM).x, lonLatToTile(lon, lat, DETAIL_ZOOM).y])
  t.comment(`pin z${DETAIL_ZOOM} tile ${tiles[0]} frac x ${frac.x.toFixed(2)} y ${frac.y.toFixed(2)}; 2x2 ${JSON.stringify(tiles)}`)
  const cell = lonLatToTile(lon, lat, DETAIL_ZOOM - 2)

  for (const delayMs of [0, 50]) {
    const tag = `rtt${2 * delayMs}`
    const a = await h.coldClient(t, store, ref.key, delayMs)
    const four = await h.measure(a.core, a.wire, () => Promise.all(tiles.map(([x, y]) => a.bee.get(tileKey(DETAIL_ZOOM, x, y)))))
    h.assertTiles(t, four.result, 4)
    t.comment(h.fmt(tag + '-2x2', 'read-cold', four, L))

    const b = await h.coldClient(t, store, ref.key, delayMs)
    const sixteen = await h.measure(b.core, b.wire, () => readCell(b.bee, DETAIL_ZOOM, cell.x, cell.y))
    h.assertTiles(t, sixteen.result, 16)
    t.comment(h.fmt(tag + '-cell16', 'read-cold', sixteen, L))

    t.ok(four.blocks < sixteen.blocks, '2x2 fetches fewer blocks')
    t.comment(`${tag}: 2x2 is ${(100 * four.blockBytes / sixteen.blockBytes).toFixed(0)}% of the cell bytes, ${(100 * four.ms / sixteen.ms).toFixed(0)}% of the cell time`)
  }
})
