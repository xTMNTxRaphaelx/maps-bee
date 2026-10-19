'use strict'
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hyperbee = require('hyperbee2')
const { manifestFor } = require('../../lib/build/sign')
const { commitDraft } = require('../../lib/build/publish')
const { lonLatToTile, tileKey } = require('../../lib/tiles')
const { tmpStore, JAIPUR_CENTRE } = require('../helpers/helpers')
const { fillAtlas } = require('../helpers/atlas')

const keyPairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
const manifest = manifestFor(keyPairs.map((k) => k.publicKey))
const CHUNK = 100

test('a draft committed in chunks ends as the same signed tree as one commit', async (t) => {
  const store = await tmpStore(t, 'chunked')
  const m = store.get({ manifest })
  await m.ready()
  const draft = m.session({ name: 'draft' })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  await fillAtlas(bee)
  t.ok(draft.length > 2 * CHUNK, `draft has ${draft.length} blocks`)
  const expected = await draft.treeHash()
  const c = lonLatToTile(JAIPUR_CENTRE.lon, JAIPUR_CENTRE.lat, 14)
  const key = tileKey(14, c.x, c.y)
  const want = await bee.get(key)
  t.ok(want, 'draft holds the centre tile')

  const lengths = []
  const res = await commitDraft(m, draft, keyPairs, { chunk: CHUNK, log: (r) => lengths.push(r.length) })
  t.is(res.length, draft.length)
  t.is(m.length, draft.length)
  t.is(m.signedLength, draft.length)
  t.is(lengths.length, Math.ceil(draft.length / CHUNK), 'one commit per chunk')
  t.alike(lengths.slice(0, 2), [CHUNK, 2 * CHUNK])
  t.is(lengths[lengths.length - 1], draft.length)
  t.is(b4a.toString(await m.treeHash(), 'hex'), b4a.toString(expected, 'hex'), 'tree hash unchanged by chunking')

  const mbee = new Hyperbee(store, { core: m, writable: false })
  await mbee.ready()
  const got = await mbee.get(key)
  t.ok(got && b4a.equals(got.value, want.value), 'the committed core serves the tile')
  await draft.close()
})
