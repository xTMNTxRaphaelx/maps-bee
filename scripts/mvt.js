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

module.exports = { decode, decodeGzip }
