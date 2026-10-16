'use strict'
// What the crop trim costs and saves on a real bee. results/address-shapes.txt measures the trim in
// tile payload; that file's own correction says payload is not client cost, because the tree walk
// and block packing dominate. This reads the full 2x2 and the trimmed one from a cold client over a
// delayed link and compares blocks, which is what a client actually pays.
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const { pinTiles, tileKey } = require('../scripts/tiles')
const { pinOffset, cropMask } = require('../scripts/render-svg')
const { readLabel, readAreas, DETAIL_ZOOM } = require('../scripts/preview')
const { tmpStore, STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const h = require('./sparse-harness')

const OPTS = { timeout: 5000 }

function maskFor (point, zoom) {
  const { origin } = pinTiles(point.lon, point.lat, zoom)
  return cropMask(pinOffset(point, origin, zoom))
}

// A grid over the z15 box (75.65,26.75 .. 75.95,27.05), split by whether the crop leaves a row out.
// Picking by hand gives whichever answer the chosen latitudes happened to have; the trim only shows
// up on the points it applies to, and the grid's own rate says how often that is.
function grid () {
  const trimmed = []
  const whole = []
  for (let lat = 26.78; lat < 27.02; lat += 0.0037) {
    for (let lon = 75.67; lon < 75.93; lon += 0.0041) {
      const p = { lon: Math.round(lon * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5 }
      ;(maskFor(p, DETAIL_ZOOM).filter(Boolean).length < 4 ? trimmed : whole).push(p)
    }
  }
  const every = (xs, n) => Array.from({ length: n }, (_, i) => xs[Math.floor((i + 0.5) * xs.length / n)])
  return { points: [...every(trimmed, 5), ...every(whole, 2)], trimmed, whole }
}

// readTiles with a mask: the slots the crop does not cover are never asked for
function readCell (bee, point, zoom, mask) {
  const { tiles } = pinTiles(point.lon, point.lat, zoom)
  return Promise.all(tiles.map((t, i) => (t && (!mask || mask[i]) ? bee.get(tileKey(zoom, t[0], t[1]), OPTS) : null)))
}

async function atlas15 (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee, [STATE_ARCHIVE, JAIPUR_ARCHIVE, JAIPUR_Z15_ARCHIVE])
  return bee
}

// The crop is one tile wide and 360 of 640 tall, so it always spans both columns and drops a row
// only when the pin sits more than half the crop's height from the row boundary: 2 * 0.28125 of the
// pin's possible positions, 43.75%. A mask that kept one column, or no row, would be a crop the
// renderer could not fill.
test('crop mask: both columns always, a row dropped 43.75% of the time', (t) => {
  const g = grid()
  const n = g.trimmed.length + g.whole.length
  const bad = { columns: [], row: [] }
  for (const p of [...g.trimmed, ...g.whole]) {
    const m = maskFor(p, DETAIL_ZOOM)
    if (!((m[0] || m[2]) && (m[1] || m[3]))) bad.columns.push(p)
    if (!((m[0] && m[1]) || (m[2] && m[3]))) bad.row.push(p)
  }
  t.is(bad.columns.length, 0, `every mask keeps both columns (${n} points)`)
  t.is(bad.row.length, 0, 'every mask keeps a whole row')
  const rate = g.trimmed.length / n
  t.ok(rate > 0.42 && rate < 0.46, `${(100 * rate).toFixed(1)}% of ${n} grid points drop a row`)
})

test('trim cost: the full z15 2x2 against the tiles the crop covers, cold', async (t) => {
  const seederStore = await tmpStore(t, 'trim-seed')
  const seed = await atlas15(seederStore)
  const L = seed.core.length
  t.comment('atlas core.length ' + L)
  const g = grid()
  const rate = g.trimmed.length / (g.trimmed.length + g.whole.length)
  t.comment(`grid of ${g.trimmed.length + g.whole.length} points: ${g.trimmed.length} trim a row (${(100 * rate).toFixed(1)}%)`)

  const totals = { full: { blocks: 0, bytes: 0 }, trim: { blocks: 0, bytes: 0 }, n: 0, trimmed: 0 }
  for (const delayMs of [0, 50]) {
    for (const p of g.points) {
      const mask = maskFor(p, DETAIL_ZOOM)
      const kept = mask.filter(Boolean).length
      const tag = `rtt${2 * delayMs}-${p.lat},${p.lon}`

      const a = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const full = await h.measure(a.core, a.wire, () => Promise.all([
        readCell(a.bee, p, DETAIL_ZOOM, null), readLabel(a.bee, p, OPTS), readAreas(a.bee, p, OPTS)
      ]))
      const b = await h.coldClient(t, seederStore, seed.core.key, delayMs)
      const trim = await h.measure(b.core, b.wire, () => Promise.all([
        readCell(b.bee, p, DETAIL_ZOOM, mask), readLabel(b.bee, p, OPTS), readAreas(b.bee, p, OPTS)
      ]))

      t.ok(full.result[0].some(Boolean), 'the full 2x2 found tiles')
      t.is(trim.result[0].filter(Boolean).length <= kept, true, 'the trim asked for no more than the crop covers')
      t.comment(h.fmt(`${tag}-tiles${kept}-full`, 'read-cold', full, L))
      t.comment(h.fmt(`${tag}-tiles${kept}-trim`, 'read-cold', trim, L))
      t.comment(`${tag}\tcrop keeps ${kept}/4\tblocks ${full.blocks} -> ${trim.blocks}\tbytes ${full.blockBytes} -> ${trim.blockBytes}`)

      totals.full.blocks += full.blocks
      totals.full.bytes += full.blockBytes
      totals.trim.blocks += trim.blocks
      totals.trim.bytes += trim.blockBytes
      totals.n++
      if (kept < 4) totals.trimmed++
    }
  }
  t.comment(`over ${totals.n} reads, ${totals.trimmed} of them trimmed: blocks ${totals.full.blocks} -> ${totals.trim.blocks} (${(totals.trim.blocks / totals.full.blocks).toFixed(2)}x), bytes ${totals.full.bytes} -> ${totals.trim.bytes} (${(totals.trim.bytes / totals.full.bytes).toFixed(2)}x)`)
})
