'use strict'
const test = require('brittle')
const { timed, connectLine, prefetchLine, previewLine } = require('../scripts/probe')

test('probe helpers: timed deltas and the probe line formats', async (t) => {
  const dl = { blocks: 0, bytes: 0 }
  const r = await timed(dl, () => {
    dl.blocks += 3
    dl.bytes += 100
    return 'v'
  })
  t.is(r.value, 'v')
  t.alike({ blocks: r.blocks, bytes: r.bytes }, { blocks: 3, bytes: 100 })
  t.is(typeof r.ms, 'number')

  t.is(connectLine(3214.5, { ms: 0.8, blocks: 0, bytes: 0 }, { length: 5761082 }),
    'connect ms 3214.5\tupdate ms 0.8 blocks 0 bytes 0\tcore.length 5761082')
  t.is(prefetchLine(2, { ms: 269.8, blocks: 194, bytes: 1850219, value: { nodes: [1, 15] } }),
    'prefetch levels 2 nodes 1/15\tms 269.8\tblocks 194\tbytes 1850219')

  const point = { lat: 26.9, lon: 75.8 }
  const label = { name: 'Jaipur', kind: 'city', km: 2.6 }
  const address = { display: 'Elevated Hawa Sadak (112 m), Kachi Basti, Sudarshanpura, Jaipur' }
  t.is(previewLine('cold', point, { ms: 162.5, blocks: 60, bytes: 693682, value: { zoom: 14, tiles: [1, 1, 1, 1], label, address } }),
    'cold\t26.9,75.8\tms 162.5\tblocks 60\tbytes 693682\tzoom 14\ttiles 4/4\tlabel Jaipur (city, 2.6 km)\taddress Elevated Hawa Sadak (112 m), Kachi Basti, Sudarshanpura, Jaipur')
  const none = previewLine('cold', point, { ms: 1, blocks: 0, bytes: 0, value: { zoom: null, tiles: null, label: null, address: null } })
  t.ok(none.endsWith('\tzoom null\ttiles 0/4\tlabel null\taddress null'), none)
})
