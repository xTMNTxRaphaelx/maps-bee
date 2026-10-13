'use strict'
const b4a = require('b4a')
const { lonLatToTile, quadkey, tileKey, subtreeRange } = require('./tiles')
const { GAZ_ZOOM, haversineKm } = require('./gazetteer-lib')

const DETAIL_ZOOM = 14
const FALLBACK_ZOOM = 10
const LABEL_ZOOM = 8

// the 16 z tiles under the z-2 cell (px, py), row-major (y outer, x inner), as parallel gets
function readCell (bee, z, px, py, opts) {
  const gets = []
  for (let y = py << 2; y < (py << 2) + 4; y++) {
    for (let x = px << 2; x < (px << 2) + 4; x++) gets.push(bee.get(tileKey(z, x, y), opts))
  }
  return Promise.all(gets)
}

// null when no tile of the cell is published: outside the atlas, or a filler cell
async function readTiles (bee, lon, lat, z, opts) {
  const cell = lonLatToTile(lon, lat, z - 2)
  const entries = await readCell(bee, z, cell.x, cell.y, opts)
  if (!entries.some(Boolean)) return null
  return { zoom: z, cell, tiles: entries.map((e) => (e ? e.value : null)) }
}

// nearest city or town in the z8 cell of the point and its 8 neighbours;
// one cell alone misses a nearer place across its edge (test/gazetteer.js)
async function readLabel (bee, lon, lat, opts) {
  const c = lonLatToTile(lon, lat, LABEL_ZOOM)
  const n = 2 ** LABEL_ZOOM
  const ranges = []
  for (let dy = -1; dy <= 1; dy++) {
    const y = c.y + dy
    if (y < 0 || y >= n) continue
    for (let dx = -1; dx <= 1; dx++) {
      ranges.push(subtreeRange(GAZ_ZOOM, quadkey((c.x + dx + n) % n, y, LABEL_ZOOM), 'g/'))
    }
  }
  const point = { lon, lat }
  let best = null
  await Promise.all(ranges.map(async (range) => {
    for await (const e of bee.createReadStream({ ...range, ...opts })) {
      const p = JSON.parse(b4a.toString(e.value))
      const km = haversineKm(point, p)
      if (!best || km < best.km) best = { name: p.name, kind: p.kind_detail, km }
    }
  }))
  return best
}

// One call per shared location: the z14 cell, else the z10 cell, plus the nearest place.
// opts.timeout is per block read; on timeout this rejects and the caller shows text instead.
async function readPreview (bee, lat, lon, opts = {}) {
  const [tiles, label] = await Promise.all([
    readTiles(bee, lon, lat, DETAIL_ZOOM, opts).then((r) => r || readTiles(bee, lon, lat, FALLBACK_ZOOM, opts)),
    readLabel(bee, lon, lat, opts)
  ])
  return { ...(tiles || { zoom: null, cell: null, tiles: null }), label }
}

module.exports = { DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM, readCell, readTiles, readLabel, readPreview }
