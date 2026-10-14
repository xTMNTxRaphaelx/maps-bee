'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const createTestnet = require('hyperdht/testnet')
const { seed } = require('../scripts/seed')
const { createOps, serve } = require('../app/ops')
const { SIGNED_STORE } = require('./helpers')
const h = require('./sparse-harness')

const TMP = path.join(__dirname, '..', 'store', 'tmp')

test('app ops: run opens a cold client once per key, prefetches once, renders, close removes the store', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())
  const ref = h.publishedRef()
  const s = await seed({ storeDir: SIGNED_STORE, key: ref.key, bootstrap: testnet.bootstrap, interval: 0, log: () => {} })
  t.teardown(() => s.close())
  fs.mkdirSync(TMP, { recursive: true })
  const before = fs.readdirSync(TMP).length

  const ops = createOps({ bootstrap: testnet.bootstrap })
  t.teardown(() => ops.close())
  const req = { key: ref.id, lat: 26.9, lon: 75.8, prefetch: true }
  const r = await ops.run(req)
  for (const l of r.lines) t.comment(l)
  t.is(r.lines.length, 3)
  t.ok(r.lines[0].startsWith('connect ms '))
  t.ok(r.lines[1].startsWith('prefetch levels 2 nodes '))
  t.ok(/^cold\t26\.9,75\.8\tms [\d.]+\tblocks \d+\tbytes \d+\tzoom 14\ttiles 4\/4\tlabel null\taddress Kachi Basti, Sudarshanpura$/.test(r.lines[2]), r.lines[2])
  t.ok(r.svg.startsWith('<svg '))
  t.is(r.present, 4)
  t.is(r.zoom, 14)
  t.is(r.label, 'null')
  t.is(r.address.housenumber, null, 'store/signed has no z15')
  t.is(r.address.city, null, 'store/signed has no gazetteer')
  t.is(r.address.display, 'Kachi Basti, Sudarshanpura')
  t.ok(r.blocks > 0)

  const again = await ops.run(req)
  t.is(again.lines.length, 1, 'same key: no reconnect, no second prefetch')
  t.ok(again.lines[0].startsWith('repeat\t'))
  t.is(again.blocks, 0)

  const handlers = {}
  const replies = []
  const pipe = {
    on (ev, fn) { handlers[ev] = fn },
    write (s) { replies.push(JSON.parse(s)) }
  }
  serve(pipe, ops)
  await handlers.data(Buffer.from(JSON.stringify({ id: 7, op: 'run', key: ref.id, lat: 26.9, lon: 75.8, prefetch: false })))
  t.is(replies.length, 1)
  t.is(replies[0].id, 7)
  t.is(replies[0].ok, true)
  t.ok(replies[0].result.lines[0].startsWith('repeat'))
  await handlers.data(Buffer.from(JSON.stringify({ id: 8, op: 'nope' })))
  t.is(replies[1].id, 8)
  t.is(replies[1].ok, false)
  t.is(typeof replies[1].error, 'string')

  await ops.close()
  t.is(fs.readdirSync(TMP).length, before, 'close removes the client store')
})
