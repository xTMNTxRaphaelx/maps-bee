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

  // Reads until the buffer is full or the file ends: one read may return less than asked for. A
  // short result is not an error here — pmtiles probes getBytes(0, 16384) for the header, so any
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

// Every directory depth-first: index 0 is the root's own entries, then each leaf as the root
// lists it, the order pmtiles getZxyAttempt follows.
async function * directories (archive, header) {
  const walk = async function * (offset, length, isRoot) {
    const entries = await archive.cache.getDirectory(archive.source, offset, length, header)
    const tiles = []
    const dirs = []
    for (const e of entries) (e.runLength === 0 ? dirs : tiles).push(e)
    yield { tiles, pending: dirs.length }
    for (const d of dirs) yield * walk(header.leafDirectoryOffset + d.offset, d.length, false)
  }
  yield * walk(header.rootDirectoryOffset, header.rootDirectoryLength, true)
}

// One read for the whole span of a clustered directory, else one read per entry
async function readValues (archive, header, tiles) {
  if (tiles.length === 0) return []
  let lo = Infinity
  let hi = 0
  let sum = 0
  for (const e of tiles) {
    if (e.offset < lo) lo = e.offset
    if (e.offset + e.length > hi) hi = e.offset + e.length
    sum += e.length
  }
  // A short read here is corruption, not a probe: every length comes from a directory entry, and
  // subarray clamps rather than throwing, so unchecked it publishes blank tiles under a signature
  if (header.clustered && hi - lo <= 2 * sum + 65536) {
    const { data } = await archive.source.getBytes(header.tileDataOffset + lo, hi - lo)
    if (data.byteLength !== hi - lo) throw new Error(`short read: wanted ${hi - lo} bytes at ${header.tileDataOffset + lo}, got ${data.byteLength}`)
    const span = Buffer.from(data)
    return tiles.map((e) => Buffer.from(span.subarray(e.offset - lo, e.offset - lo + e.length)))
  }
  const out = []
  for (const e of tiles) {
    const { data } = await archive.source.getBytes(header.tileDataOffset + e.offset, e.length)
    if (data.byteLength !== e.length) throw new Error(`short read: wanted ${e.length} bytes at ${header.tileDataOffset + e.offset}, got ${data.byteLength}`)
    out.push(Buffer.from(data))
  }
  return out
}

// getZxy returns the tile already gunzipped (fflate on bare); the bee stores it re-gzipped. gz is a
// lazy getter because the gazetteer pass reads t.raw for every tile on the planet and never touches
// t.gz, where level 9 on each would be most of that pass's runtime.
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

module.exports = { FileSource, openArchive, directories, readValues, readTile }
