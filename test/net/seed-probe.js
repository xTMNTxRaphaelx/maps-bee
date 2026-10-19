'use strict'
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { seed } = require('../../lib/net/seed')
const { probe } = require('../../lib/net/client')
const { SIGNED_STORE, JAIPUR_CENTRE } = require('../helpers/helpers')
const h = require('../helpers/sparse-harness')

test('seed.js serves the signed atlas and probe.js reads a preview over a testnet', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy())
  const ref = h.publishedRef()
  const lines = []
  const s = await seed({ storeDir: SIGNED_STORE, key: ref.key, bootstrap: testnet.bootstrap, interval: 0, log: (l) => lines.push(l) })
  t.teardown(() => s.close())
  t.is(s.core.length, ref.length, 'seeder holds the published length')

  const p = await probe({ key: ref.key, points: [JAIPUR_CENTRE], bootstrap: testnet.bootstrap, log: (l) => t.comment(l) })
  t.is(p.coreLength, ref.length, 'client updated to the published length')
  t.is(p.results.length, 2, 'cold and repeat')
  const [cold, repeat] = p.results
  t.is(cold.zoom, 14)
  t.is(cold.present, 4, 'all 4 z14 tiles of the 2x2')
  t.ok(cold.blocks > 0)
  t.is(repeat.blocks, 0, 'repeat read fetches nothing')
  t.is(s.stats.uploads, p.update.blocks + cold.blocks, 'seeder uploads equal client downloads')
  t.ok(lines.some((l) => l.startsWith('seeding ')), 'seeder printed its key line')
})
