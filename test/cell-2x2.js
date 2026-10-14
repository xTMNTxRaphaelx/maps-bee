'use strict'
const test = require('brittle')
const { lonLatToTile, lonLatToTileFraction, pinTiles, tileKey } = require('../scripts/tiles')
const { DETAIL_ZOOM } = require('../scripts/preview')
const { JAIPUR_CENTRE } = require('./helpers')
const h = require('./sparse-harness')

const { lon, lat } = JAIPUR_CENTRE

test('2x2 around the pin against the 16-tile cell, both cold', async (t) => {
  const { store, core: seederCore, ref } = await h.openSeeder(t)
  const L = seederCore.length
  const { tiles } = pinTiles(lon, lat, DETAIL_ZOOM)
  const pin = lonLatToTile(lon, lat, DETAIL_ZOOM)
  const f = lonLatToTileFraction(lon, lat, DETAIL_ZOOM)
  t.ok(tiles.some(([x, y]) => x === pin.x && y === pin.y), 'the 2x2 holds the pin tile')
  t.comment(`pin z${DETAIL_ZOOM} tile ${pin.x},${pin.y} frac x ${(f.x - pin.x).toFixed(2)} y ${(f.y - pin.y).toFixed(2)}; 2x2 ${JSON.stringify(tiles)}`)
  const cell = lonLatToTile(lon, lat, DETAIL_ZOOM - 2)

  for (const delayMs of [0, 50]) {
    const tag = `rtt${2 * delayMs}`
    const a = await h.coldClient(t, store, ref.key, delayMs)
    const four = await h.measure(a.core, a.wire, () => Promise.all(tiles.map(([x, y]) => a.bee.get(tileKey(DETAIL_ZOOM, x, y)))))
    h.assertTiles(t, four.result, 4)
    t.comment(h.fmt(tag + '-2x2', 'read-cold', four, L))

    const b = await h.coldClient(t, store, ref.key, delayMs)
    const sixteen = await h.measure(b.core, b.wire, () => h.readCell(b.bee, DETAIL_ZOOM, cell.x, cell.y))
    h.assertTiles(t, sixteen.result, 16)
    t.comment(h.fmt(tag + '-cell16', 'read-cold', sixteen, L))

    t.ok(four.blocks < sixteen.blocks, '2x2 fetches fewer blocks')
    t.comment(`${tag}: 2x2 is ${(100 * four.blockBytes / sixteen.blockBytes).toFixed(0)}% of the cell bytes, ${(100 * four.ms / sixteen.ms).toFixed(0)}% of the cell time`)
  }
})
