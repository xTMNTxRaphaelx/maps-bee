'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { FileSource } = require('../scripts/pmtiles-file')

const TMP = path.join(__dirname, '..', 'store', 'tmp')

function tmpFile (t, bytes) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, 'file-source-'))
  const file = path.join(dir, 'archive.bin')
  fs.writeFileSync(file, bytes)
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

// One read can return less than asked for. A short buffer here is silent corruption downstream:
// planet-build slices tiles out of the span by absolute offset, and subarray clamps rather than
// throwing, so an entry past the end yields 0 bytes and decodes to a valid tile with no layers.
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

  // pmtiles probes getBytes(0, 16384) for the header, so a short result here is not an error in
  // itself — it is the caller that knows the exact length (planet-build readValues) that must check
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
