'use strict'
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hyperbee = require('hyperbee2')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')
const { pinTiles, tileKey } = require('../scripts/tiles')
const { manifestFor, publishDraft } = require('../scripts/sign')
const { readPreview, DETAIL_ZOOM } = require('../scripts/preview')
const { tmpStore, JAIPUR_CENTRE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const h = require('./sparse-harness')

const { lon, lat } = JAIPUR_CENTRE
const POINT = { lat, lon }
const OPTS = { timeout: 5000 }

// the keys of the 2x2 readPreview reads, in its tiles order
function pinKeys () {
  return pinTiles(lon, lat, DETAIL_ZOOM).tiles.map(([x, y]) => tileKey(DETAIL_ZOOM, x, y))
}

// value blocks hold tile bytes; every other block is keys and tree nodes
function classify (blocks) {
  const out = { value: 0, values: 0, valueBytes: 0, keys: 0, keysBytes: 0 }
  for (const { blk, byteLength } of blocks) {
    if (blk.values) {
      out.value++
      out.values += blk.values.length
      out.valueBytes += byteLength
    } else {
      out.keys++
      out.keysBytes += byteLength
    }
  }
  return out
}

test('second 2-of-3 publish on the same core: same key, one signature rejected, warm client fetches only new blocks', async (t) => {
  const keyPairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
  const signers = (...idx) => idx.map((index) => ({ index, keyPair: keyPairs[index] }))
  const store = await tmpStore(t, 'second-publish')
  const m = store.get({ manifest: manifestFor(keyPairs.map((k) => k.publicKey)) })
  await m.ready()
  const key = b4a.from(m.key)

  const draft = m.session({ name: 'draft' })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  await fillAtlas(bee)
  t.ok(await publishDraft(m, draft, signers(0, 1)), 'first publish')
  const L1 = m.length
  t.is(m.signedLength, L1)
  t.comment(`first publish length ${L1}`)

  // a warm client that has already shown the Jaipur preview
  const warm = await h.coldClient(t, store, key, 0)
  t.is(warm.core.length, L1)
  const first = await h.measure(warm.core, warm.wire, () => readPreview(warm.bee, POINT, OPTS))
  t.is(first.result.zoom, DETAIL_ZOOM)
  t.comment(h.fmt('warm', 'read-cold-v1', first, L1))

  // second draft starts at the published length; rewrite 3 of the 4 tiles of the 2x2
  const draft2 = m.session({ name: 'draft2' })
  await draft2.ready()
  t.is(draft2.length, L1, 'new draft resumes at the published length')
  const bee2 = new Hyperbee(store, { core: draft2, writable: true })
  await bee2.ready()
  const keys = pinKeys()
  const changed = keys.slice(0, 3)
  const before = []
  for (const k of changed) {
    const e = await bee2.get(k)
    t.ok(e, '2x2 tile present in draft2')
    before.push(e.value)
  }
  const w = bee2.write()
  for (let i = 0; i < changed.length; i++) w.tryPut(changed[i], b4a.concat([before[i], b4a.from([0])]))
  await w.flush()
  t.ok(draft2.length > L1, 'rewrites append')
  t.comment(`draft2 length ${draft2.length} (${draft2.length - L1} new blocks for ${changed.length} rewritten tiles)`)

  let err = null
  try {
    await publishDraft(m, draft2, signers(0))
  } catch (e) {
    err = e
  }
  t.is(err && err.code, 'INVALID_SIGNATURE', 'one signature rejected on the second commit')
  t.is(m.length, L1)

  t.ok(await publishDraft(m, draft2, signers(1, 2)), 'second publish with signers b and c')
  const L2 = m.length
  t.ok(b4a.equals(m.key, key), 'core key unchanged')
  t.ok(L2 > L1)
  t.is(m.signedLength, L2)
  t.comment(`second publish length ${L2} (+${L2 - L1})`)

  // a cold client reads the changed value under the same key
  const cold = await h.coldClient(t, store, key, 0)
  t.is(cold.core.length, L2)
  const got = await cold.bee.get(changed[0])
  t.is(got.value.byteLength, before[0].byteLength + 1, 'cold client reads the rewritten tile')

  // the warm client updates and re-reads the same 2x2
  const upd = await h.measure(warm.core, warm.wire, () => warm.core.update({ wait: true }))
  t.is(warm.core.length, L2)
  t.comment(h.fmt('warm', 'update-v2', upd, L2))
  const again = await h.measure(warm.core, warm.wire, () => readPreview(warm.bee, POINT, OPTS))
  t.is(again.result.zoom, DETAIL_ZOOM)
  t.is(again.result.tiles[0].byteLength, before[0].byteLength + 1, 'warm client sees the rewritten tile')
  t.ok(again.indices.every((i) => i >= L1), 'nothing below the first publish is fetched again')
  t.comment(h.fmt('warm', 'read-v2', again, L2))

  const blocks = []
  for (const i of again.indices) {
    const buf = await warm.core.get(i)
    blocks.push({ blk: decodeBlock(buf, i), byteLength: buf.byteLength })
  }
  const c = classify(blocks)
  // values under 4 KiB pack together, so value blocks can be fewer than rewritten tiles
  t.is(c.values, changed.length, 'every rewritten tile value is in a new value block')
  t.comment(`warm read-v2: value blocks ${c.value} holding ${c.values} values (${c.valueBytes} B) for ${changed.length} changed tiles, keys+tree blocks ${c.keys} (${c.keysBytes} B), unchanged tiles ${keys.length - changed.length} fetched 0`)

  await draft.close()
  await draft2.close()
})
