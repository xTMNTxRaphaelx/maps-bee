'use strict'
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hyperbee = require('hyperbee2')
const { openArchive, readTile } = require('../../lib/build/pmtiles-file')
const { bboxTiles, tileKey } = require('../../lib/tiles')
const { manifestFor, publishDraft } = require('../../lib/build/sign')
const { tmpStore, JAIPUR_ARCHIVE } = require('../helpers/helpers')

const keyPairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
const manifest = manifestFor(keyPairs.map((k) => k.publicKey))

async function jaipurTiles (n) {
  const archive = openArchive(JAIPUR_ARCHIVE)
  const h = await archive.getHeader()
  const out = []
  for (const { x, y } of bboxTiles([h.minLon, h.minLat, h.maxLon, h.maxLat], 14)) {
    const tile = await readTile(archive, 14, x, y)
    if (tile) out.push({ key: tileKey(14, x, y), value: tile.gz })
    if (out.length === n) break
  }
  await archive.close()
  return out
}

async function draftWithTiles (store, tiles) {
  const m = store.get({ manifest })
  await m.ready()
  const draft = m.session({ name: 'draft' })
  await draft.ready()
  const bee = new Hyperbee(store, { core: draft, writable: true })
  await bee.ready()
  const w = bee.write()
  for (const tile of tiles) w.tryPut(tile.key, tile.value)
  await w.flush()
  return { m, draft }
}

test('2-of-3 multisig publish from a named draft session', async (t) => {
  const tiles = await jaipurTiles(50)
  t.is(tiles.length, 50)

  const store = await tmpStore(t, 'multisig')
  const { m, draft } = await draftWithTiles(store, tiles)
  t.is(m.writable, false)
  t.is(draft.writable, true)
  t.ok(draft.length > 0)
  t.is(m.length, 0)

  const res = await publishDraft(m, draft, [{ index: 0, keyPair: keyPairs[0] }, { index: 2, keyPair: keyPairs[2] }])
  t.ok(res)
  t.is(m.length, draft.length)
  t.is(m.signedLength, m.length)

  const client = await tmpStore(t, 'multisig-client')
  const s1 = store.replicate(true)
  const s2 = client.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.teardown(() => {
    s1.destroy()
    s2.destroy()
  })
  const rc = client.get({ key: m.key, writable: false })
  await rc.ready()
  await rc.update({ wait: true })
  t.is(rc.signedLength, m.signedLength)
  const rbee = new Hyperbee(client, { core: rc, writable: false })
  await rbee.ready()
  const probe = tiles[17]
  const got = await rbee.get(probe.key)
  t.ok(got && b4a.equals(got.value, probe.value))
  await draft.close()
})

test('commit with one of two required signatures throws INVALID_SIGNATURE', async (t) => {
  const tiles = await jaipurTiles(5)
  const store = await tmpStore(t, 'multisig-neg')
  const { m, draft } = await draftWithTiles(store, tiles)
  let err = null
  try {
    await publishDraft(m, draft, [{ index: 0, keyPair: keyPairs[0] }])
  } catch (e) {
    err = e
  }
  t.ok(err, 'single-signer commit rejected')
  t.is(err && err.code, 'INVALID_SIGNATURE')
  t.is(m.length, 0)
  await draft.close()
})
