'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { FileSource, valueChunks } = require('../../lib/build/pmtiles-file')

const TMP = path.join(__dirname, '..', '..', 'store', 'tmp')

function tmpFile (t, bytes) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, 'file-source-'))
  const file = path.join(dir, 'archive.bin')
  fs.writeFileSync(file, bytes)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

// One read can return less than asked for, and a short buffer is silent corruption downstream:
// planet-build slices by absolute offset and subarray clamps, so an entry past the end yields 0
// bytes and decodes to a valid tile with no layers.
test('getBytes fills the buffer when the bytes are there', async (t) => {
  const file = tmpFile(t, Buffer.alloc(1000, 7))
  const src = new FileSource(file)
  t.teardown(() => src.close())

  const { data } = await src.getBytes(0, 1000)
  t.is(data.byteLength, 1000, 'every requested byte')
  t.is(Buffer.from(data).every((b) => b === 7), true, 'and the right ones')

  const mid = await src.getBytes(400, 200)
  t.is(mid.data.byteLength, 200, 'a read at an offset is complete too')
})

test('a read past the end of the file is short, and says so by its length', async (t) => {
  const file = tmpFile(t, Buffer.alloc(10, 1))
  const src = new FileSource(file)
  t.teardown(() => src.close())

  // pmtiles probes getBytes(0, 16384) for the header, so a short result is not an error in itself;
  // the caller that knows the exact length (planet-build readValues) is the one that must check
  const { data } = await src.getBytes(0, 64)
  t.is(data.byteLength, 10, 'what was actually there, not a 64-byte buffer of mostly zeros')

  const past = await src.getBytes(10, 8)
  t.is(past.data.byteLength, 0, 'entirely past the end reads zero bytes')
})

test('getBytes keeps reading until the buffer is full', async (t) => {
  const file = tmpFile(t, Buffer.alloc(300000, 3))
  const src = new FileSource(file)
  t.teardown(() => src.close())

  let calls = 0
  const fh = await src.open()
  const read = fh.read.bind(fh)
  // force the short reads the old single-read path accepted silently
  fh.read = (buf, off, len, pos) => {
    calls++
    return read(buf, off, Math.min(len, 4096), pos)
  }

  const { data } = await src.getBytes(0, 300000)
  t.is(data.byteLength, 300000, 'looped rather than returning the first chunk')
  t.ok(calls > 1, `took ${calls} reads`)
  t.is(Buffer.from(data).every((b) => b === 3), true, 'assembled in the right order')
})

// pmtiles asks for the header and the root directory at once; a check-then-open around the await
// opens the file twice and leaks the first handle for the process lifetime
test('concurrent getBytes open the file once', async (t) => {
  const file = tmpFile(t, Buffer.alloc(100, 9))
  const src = new FileSource(file)
  t.teardown(() => src.close())

  let opens = 0
  const open = fs.promises.open
  fs.promises.open = (...args) => {
    opens++
    return open(...args)
  }
  t.teardown(() => { fs.promises.open = open })

  const [a, b, c] = await Promise.all([src.getBytes(0, 10), src.getBytes(10, 10), src.getBytes(20, 10)])
  t.is(opens, 1, 'one handle for three concurrent reads')
  t.is(a.data.byteLength + b.data.byteLength + c.data.byteLength, 30)
})

// Four entries whose file order is the reverse of their entry order, each 10 bytes of its own
// index, so a value handed back under the wrong entry is visible.
function fakeArchive (reads) {
  const table = { offsets: Float64Array.from([30, 20, 10, 0]), lengths: Uint32Array.from([10, 10, 10, 10]) }
  const source = {
    getBytes (offset, length) {
      reads.push(offset)
      return { data: Buffer.alloc(length, (30 - offset) / 10).buffer }
    }
  }
  return { archive: { source }, header: { clustered: false, tileDataOffset: 0 }, table }
}

// valueChunks is the read path the planet build and the gazetteer pass share. Both hand it a visit
// order that is not file order, and both lean on the chunk bounds to cap what is held in memory.
test('valueChunks bounds each chunk, reads in file order and returns values in visit order', async (t) => {
  const reads = []
  const { archive, header, table } = fakeArchive(reads)
  const order = [{ entry: 0 }, { entry: 1 }, { entry: 2 }, { entry: 3 }, { entry: 0 }]
  const seen = []
  for await (const c of valueChunks(archive, header, order, table, { maxTiles: 3, maxBytes: Infinity })) {
    seen.push({ tiles: c.tiles.length, read: c.read, values: c.tiles.map((x) => c.value(x)[0]) })
  }
  t.alike(seen, [
    { tiles: 3, read: 3, values: [0, 1, 2] },
    { tiles: 2, read: 5, values: [3, 0] }
  ], 'two chunks of 3 and 2, each value under its own entry')
  t.alike(reads, [10, 20, 30, 0, 30], 'each chunk reads its distinct entries in file order')

  const byBytes = []
  for await (const c of valueChunks(archive, header, order, table, { maxTiles: Infinity, maxBytes: 15 })) {
    byBytes.push(c.tiles.length)
  }
  t.alike(byBytes, [2, 2, 1], 'bytes bound a chunk as well as tiles')

  for await (const c of valueChunks(archive, header, [], table, { maxTiles: 3, maxBytes: 15 })) {
    t.fail(`empty order yielded ${c.tiles.length} tiles`)
  }
})

test('close releases the handle and a later read reopens', async (t) => {
  const file = tmpFile(t, Buffer.alloc(50, 4))
  const src = new FileSource(file)

  await src.getBytes(0, 10)
  await src.close()
  await src.close()
  t.pass('closing twice is not an error')

  const { data } = await src.getBytes(0, 10)
  t.is(data.byteLength, 10, 'reopened on demand')
  await src.close()
})
