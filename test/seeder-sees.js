'use strict'
const test = require('brittle')
const b4a = require('b4a')
const Hyperbee = require('hyperbee2')
const { decodeBlock } = require('hyperbee2/lib/encoding.js')
const { pinTiles, quadkey } = require('../scripts/tiles')
const { readPreview, DETAIL_ZOOM } = require('../scripts/preview')
const { tmpStore, JAIPUR_CENTRE } = require('./helpers')
const { fillAtlas } = require('./atlas')
const h = require('./sparse-harness')

const { lon, lat } = JAIPUR_CENTRE

// value blocks carry no keys; the keys that point at them live in other blocks
async function valueOwners (core) {
  const owners = new Map()
  for (let i = 0; i < core.length; i++) {
    const blk = decodeBlock(await core.get(i), i)
    if (!blk.keys) continue
    for (const k of blk.keys) {
      if (!k.valuePointer) continue
      const s = k.valuePointer.seq
      if (!owners.has(s)) owners.set(s, [])
      owners.get(s).push(b4a.toString(k.key))
    }
  }
  return owners
}

test('what a seeder sees: uploaded blocks name the z12 cells of the pin\'s 2x2', async (t) => {
  const seederStore = await tmpStore(t, 'seeder-sees')
  const seedCore = seederStore.get({ name: 'atlas' })
  const seed = new Hyperbee(seederStore, { core: seedCore, writable: true })
  await seed.ready()
  await fillAtlas(seed)
  const L = seedCore.length

  const uploads = []
  seedCore.on('upload', (index, byteLength) => uploads.push({ index, byteLength }))

  const { core, bee, wire } = await h.coldClient(t, seederStore, seedCore.key, 0)

  const r = await h.measure(core, wire, () => readPreview(bee, { lat, lon }, { timeout: 5000 }))
  t.is(r.result.zoom, DETAIL_ZOOM)
  t.comment(h.fmt('seeder-sees', 'read-cold', r, L))
  uploads.sort((a, b) => a.index - b.index)
  t.alike(uploads.map((u) => u.index), r.indices, 'seeder upload events match the client downloads')

  // the 2x2 can straddle z12 cells; a z14 quadkey's first 12 digits name its z12 cell
  const prefixes = [...new Set(pinTiles(lon, lat, DETAIL_ZOOM).tiles.map(([x, y]) => `${DETAIL_ZOOM}/${quadkey(x >> 2, y >> 2, DETAIL_ZOOM - 2)}`))]
  const owners = await valueOwners(seedCore)
  const counts = { value: 0, values: 0, keys: 0 }
  let foreign = 0
  for (const u of uploads) {
    const blk = decodeBlock(await seedCore.get(u.index), u.index)
    if (blk.values) {
      counts.value++
      counts.values += blk.values.length
      const names = owners.get(u.index) || []
      foreign += names.filter((n) => !prefixes.some((p) => n.startsWith(p))).length
      t.comment(`block ${u.index}\tvalue\t${u.byteLength} B\t${names.join(' ')}`)
    } else {
      counts.keys++
      const names = blk.keys ? blk.keys.map((k) => b4a.toString(k.key)) : []
      const span = names.length ? `${names[0]} .. ${names[names.length - 1]}` : '(none)'
      t.comment(`block ${u.index}\tkeys+tree\t${u.byteLength} B\tkeys ${names.length}\tnodes ${blk.tree ? blk.tree.length : 0}\t${span}`)
    }
  }
  // values under 4 KiB pack together, so value blocks can be fewer than tiles
  t.is(counts.values, 4, 'the 4 tile values of the 2x2 are what was uploaded')
  t.is(foreign, 0, `every uploaded value block belongs to ${prefixes.join(' or ')}`)
  t.comment(`seeder sees ${counts.value} value blocks holding the ${counts.values} tiles under ${prefixes.join(' and ')}, plus ${counts.keys} keys+tree blocks whose key spans are listed above`)
})
