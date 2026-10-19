'use strict'
const test = require('brittle')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { tmpStore } = require('../helpers/helpers')

// [label, bytes, blocks the put adds]
const SIZES = [
  ['100B', 100, 1],
  ['4KiB', 4 * 1024, 2],
  ['2MiB', 2 * 1024 * 1024, 2],
  ['14MiB', 14 * 1024 * 1024, 2]
]

test('values up to 14 MiB round-trip; over 1 KiB costs a second block; 16 MiB rejects', async (t) => {
  const store = await tmpStore(t, 'value-size')
  const core = store.get({ name: 'value-size' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()

  for (const [label, size, blocks] of SIZES) {
    const before = core.length
    const value = b4a.alloc(size, label.length)
    const w = bee.write()
    w.tryPut(b4a.from(label), value)
    await w.flush()
    const got = await bee.get(b4a.from(label))
    t.ok(got && b4a.equals(got.value, value), label + ' round-trips')
    t.is(core.length - before, blocks, label + ' block count')
  }

  const w = bee.write()
  w.tryPut(b4a.from('16MiB'), b4a.alloc(16 * 1024 * 1024, 1))
  let err = null
  try {
    await w.flush()
  } catch (e) {
    err = e
  }
  t.ok(err, '16 MiB put rejected')
  t.is(err && err.code, 'BAD_ARGUMENT')
  t.ok(/maximum suggested block size/.test(err ? err.message : ''))
  t.is(core.length, 7)
  await bee.close()
})
