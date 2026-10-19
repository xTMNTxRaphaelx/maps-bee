'use strict'
const test = require('brittle')
const { timed } = require('../../lib/net/client')

test('timed: block and byte deltas across a call', async (t) => {
  const dl = { blocks: 0, bytes: 0 }
  const r = await timed(dl, () => {
    dl.blocks += 3
    dl.bytes += 100
    return 'v'
  })
  t.is(r.value, 'v')
  t.alike({ blocks: r.blocks, bytes: r.bytes }, { blocks: 3, bytes: 100 })
  t.is(typeof r.ms, 'number')
})
