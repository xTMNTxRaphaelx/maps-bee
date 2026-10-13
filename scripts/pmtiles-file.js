'use strict'
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const { PMTiles } = require('pmtiles')

// pmtiles reads through a Source with getKey() and getBytes(offset, length)
class FileSource {
  constructor (path) {
    this.path = path
    this.fh = null
  }

  getKey () {
    return this.path
  }

  async getBytes (offset, length) {
    if (!this.fh) this.fh = await fs.promises.open(this.path, 'r')
    const buf = Buffer.alloc(length)
    const { bytesRead } = await this.fh.read(buf, 0, length, offset)
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) }
  }

  async close () {
    if (this.fh) await this.fh.close()
    this.fh = null
  }
}

function openArchive (path) {
  const source = new FileSource(path)
  const archive = new PMTiles(source)
  archive.close = () => source.close()
  return archive
}

// getZxy returns the tile already gunzipped (fflate on bare); the bee stores it re-gzipped
async function readTile (archive, z, x, y) {
  const res = await archive.getZxy(z, x, y)
  if (!res) return null
  const raw = Buffer.from(res.data)
  const gz = zlib.gzipSync(raw, { level: 9 })
  return { raw, gz }
}

module.exports = { FileSource, openArchive, readTile }
