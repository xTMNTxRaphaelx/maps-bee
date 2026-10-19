'use strict'
// usage: gazetteer.js <out.json> [--kinds=a,b] [--areas] (<archive> <bbox> <minz> <maxz>)...
// --areas collects the neighbourhood, suburb and village labels deriveAddress wants instead of
// localities, and writes them for a/ keys; harvest them from z13, where 91% of the neighbourhood
// labels are already present and a z14 pass costs four times as many tile entries.
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const { parseBbox } = require('../lib/tiles')
const { gazKeys, areaKeys } = require('../lib/gazetteer-lib')
const { collect } = require('../lib/build/gazetteer')
const { parseFlags } = require('./flags')

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--kinds', '--areas'])
  const areas = flags.has('--areas')
  const kindsFlag = flags.get('--kinds')
  const kinds = kindsFlag ? new Set(kindsFlag.split(',')) : null
  const [out, ...rest] = args
  // the sources are read four at a time, so a missing or misspelt one shifts every later argument
  // into the wrong slot; unchecked, that once left minz/maxz NaN and reported a successful empty run
  if (!out || rest.length === 0 || rest.length % 4 !== 0) {
    throw new Error('usage: gazetteer.js [--kinds=a,b] [--areas] <out.json> (<archive.pmtiles> <minLon,minLat,maxLon,maxLat> <minz> <maxz>)...')
  }
  const byName = new Map()
  const counts = { entries: [] }
  for (let i = 0; i < rest.length; i += 4) {
    const [path, bbox, minz, maxz] = rest.slice(i, i + 4)
    for (const [label, v] of [['minz', minz], ['maxz', maxz]]) {
      if (!/^\d+$/.test(v)) throw new Error(`${path}: ${label} must be a non-negative integer, got ${JSON.stringify(v)}`)
    }
    const before = counts.entries.length
    await collect(path, parseBbox(bbox), Number(minz), Number(maxz), byName, counts, kinds, areas, (line) => console.log(`${path}\t${line}`))
    console.log(`${path} bbox ${bbox} z${minz}-${maxz}: +${counts.entries.length - before} ${areas ? 'areas' : 'localities'}`)
  }
  const entries = counts.entries
  const perKind = {}
  for (const e of entries) perKind[e.kind_detail] = (perKind[e.kind_detail] || 0) + 1
  console.log(`${areas ? 'areas' : 'localities'} ${entries.length} by kind_detail ${JSON.stringify(perKind)}`)
  const kv = areas ? areaKeys(entries) : gazKeys(entries)
  const rawKV = kv.reduce((n, e) => n + e.key.byteLength + e.value.byteLength, 0)
  const json = Buffer.from(JSON.stringify(entries))
  console.log(`raw key+value bytes ${rawKV}`)
  console.log(`json bytes ${json.byteLength} gzip bytes ${zlib.gzipSync(json, { level: 9 }).byteLength}`)
  for (const k of areas ? ['neighbourhood', 'suburb', 'village'] : ['city', 'town']) {
    const sub = Buffer.from(JSON.stringify(entries.filter((e) => e.kind_detail === k)))
    console.log(`subset ${k}: json ${sub.byteLength} gzip ${zlib.gzipSync(sub, { level: 9 }).byteLength}`)
  }
  fs.writeFileSync(out, JSON.stringify(entries, null, 1) + '\n')
  console.log(`wrote ${out}`)
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
