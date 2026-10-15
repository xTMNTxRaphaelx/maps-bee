'use strict'
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const { PMTiles, ResolvedValueCache } = require('pmtiles')

// pmtiles reads through a Source with getKey() and getBytes(offset, length)
class FileSource {
  constructor (path) {
    this.path = path
    this.opening = null
  }

  getKey () {
    return this.path
  }

  // memoise the promise, not the handle: pmtiles asks for the header and the root directory at
  // once, and a check-then-open around an await opens the file twice and leaks the first handle
  open () {
    if (!this.opening) this.opening = fs.promises.open(this.path, 'r')
    return this.opening
  }

  // Reads until the buffer is full or the file ends: one read may return less than asked for.
  // A short result is not an error here — pmtiles probes getBytes(0, 16384) for the header, so any
  // archive under 16 KiB reads short by design. Callers needing an exact length check it themselves.
  async getBytes (offset, length) {
    const fh = await this.open()
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + read) }
  }

  async close () {
    if (!this.opening) return
    const fh = await this.opening
    this.opening = null
    await fh.close()
  }
}

// ResolvedValueCache, because the default SharedPromiseCache builds an AbortController per leaf
// directory read and bare has none; small extracts never reach a leaf, the planet files do
function openArchive (path) {
  const source = new FileSource(path)
  const archive = new PMTiles(source, new ResolvedValueCache())
  archive.close = () => source.close()
  return archive
}

// getZxy returns the tile already gunzipped (fflate on bare); the bee stores it re-gzipped.
// gz is a lazy getter, not a field: the gazetteer pass reads t.raw for every tile on the planet and
// never touches t.gz, and level 9 synchronously on each of those is most of that pass's runtime
async function readTile (archive, z, x, y) {
  const res = await archive.getZxy(z, x, y)
  if (!res) return null
  const raw = Buffer.from(res.data)
  let gz = null
  return {
    raw,
    get gz () {
      if (gz === null) gz = zlib.gzipSync(raw, { level: 9 })
      return gz
    }
  }
}

module.exports = { FileSource, openArchive, readTile }
