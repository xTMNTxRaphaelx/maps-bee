'use strict'
const zlib = require('bare-zlib')
const { VectorTile } = require('@mapbox/vector-tile')
const { PbfReader } = require('pbf')

function decode (raw) {
  return new VectorTile(new PbfReader(raw))
}

function decodeGzip (gz) {
  return decode(zlib.gunzipSync(gz))
}

// the lon/lat of a tile-local point: the arithmetic of VectorTileFeature.toGeoJSON
// (@mapbox/vector-tile/index.js:158-170), inlined because toGeoJSON clones a whole Feature to carry
// two numbers, once per feature, on the preview path
function project (f, tile, p) {
  const size = f.extent * Math.pow(2, tile.zoom)
  const x0 = f.extent * tile.x
  const y0 = f.extent * tile.y
  return [
    (p.x + x0) * 360 / size - 180,
    360 / Math.PI * Math.atan(Math.exp((1 - (p.y + y0) * 2 / size) * Math.PI)) - 90
  ]
}

module.exports = { decode, decodeGzip, project }
