'use strict'
const test = require('brittle')
const Hyperbee = require('hyperbee2')
const { prefetchTop, readTiles } = require('../scripts/preview')
const { tmpStore, JAIPUR_CENTRE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const h = require('./sparse-harness')
const { SIGNED_ZOOM } = h

const OPTS = { timeout: 5000 }

async function atlas (store) {
  const core = store.get({ name: 'atlas' })
  const bee = new Hyperbee(store, { core, writable: true })
  await bee.ready()
  await fillAtlas(bee)
  return bee
}

// levels from the root down the leftmost path, counted independently of prefetchTop
async function depth (bee) {
  let ptr = await bee.bootstrap(bee.config)
  let d = 0
  while (ptr) {
    const v = await bee.inflate(ptr, bee.config)
    d++
    ptr = v.children.length ? v.children.get(0) : null
  }
  return d
}

test('prefetchTop inflates the tree level by level and stops at the leaves', async (t) => {
  const bee = await atlas(await tmpStore(t, 'top-levels'))
  t.alike(await prefetchTop(bee, 1, OPTS), { nodes: [1] }, 'level 1 is the root')
  const d = await depth(bee)
  const { nodes } = await prefetchTop(bee, 9, OPTS)
  t.comment(`atlas depth ${d}, nodes per level ${nodes.join('/')}`)
  t.ok(d < 9, `the atlas tree has ${d} levels`)
  t.is(nodes.length, d, 'stops when a level has no children')
  t.is(nodes[0], 1)
})

test('after a full prefetch a cold 2x2 read costs only its value blocks', async (t) => {
  const seederStore = await tmpStore(t, 'top-levels-seed')
  const seed = await atlas(seederStore)
  const L = seed.core.length

  const a = await h.coldClient(t, seederStore, seed.core.key, 0)
  const cold = await h.measure(a.core, a.wire, () => readTiles(a.bee, JAIPUR_CENTRE, SIGNED_ZOOM, OPTS))
  t.comment(h.fmt('2x2', 'read-cold', cold, L))

  const b = await h.coldClient(t, seederStore, seed.core.key, 0)
  const pre = await h.measure(b.core, b.wire, () => prefetchTop(b.bee, 9, OPTS))
  t.comment(h.fmt(`prefetch-${pre.result.nodes.join('/')}`, 'read-cold', pre, L))
  const after = await h.measure(b.core, b.wire, () => readTiles(b.bee, JAIPUR_CENTRE, SIGNED_ZOOM, OPTS))
  t.comment(h.fmt('2x2-after-prefetch', 'read-cold', after, L))
  t.is(after.result.tiles.filter(Boolean).length, 4)
  t.ok(after.blocks <= 4, `${after.blocks} blocks: the 4 values at most`)
  t.ok(after.blocks < cold.blocks, `fewer than the ${cold.blocks} blocks of a cold 2x2`)
})
