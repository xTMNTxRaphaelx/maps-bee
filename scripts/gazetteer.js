'use strict'
// usage: gazetteer.js <out.json> [--kinds=a,b] [--areas] (<archive> <bbox> <minz> <maxz>)...
// --areas collects the neighbourhood, suburb and village labels deriveAddress wants instead of
// localities, and writes them for a/ keys; harvest them from z13, where 91% of the neighbourhood
// labels are already present and a z14 pass costs four times as many tile reads.
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const { openArchive, readTile } = require('./pmtiles-file')
const { bboxTiles, parseBbox } = require('./tiles')
const { parseFlags } = require('./flags')
const { decode } = require('./mvt')
const { haversineKm, gazKeys, areaKeys, areaClass } = require('./gazetteer-lib')

const DUP_KM = 5
// neighbourhoods sit a few hundred metres apart, so the locality dedupe would merge them
const AREA_DUP_KM = 0.3

function inBbox (p, b) {
  return p.lon >= b[0] && p.lat >= b[1] && p.lon <= b[2] && p.lat <= b[3]
}

// kinds: a Set of kind_detail values to keep, or null for every locality
async function collect (path, bbox, minz, maxz, byName, counts, kinds = null, areas = false) {
  const archive = openArchive(path)
  try {
    await collectFrom(archive, bbox, minz, maxz, byName, counts, kinds, areas)
  } finally {
    await archive.close()
  }
}

async function collectFrom (archive, bbox, minz, maxz, byName, counts, kinds, areas = false) {
  // highest zoom first so each place keeps its most precise point
  for (let z = maxz; z >= minz; z--) {
    for (const { x, y } of bboxTiles(bbox, z)) {
      const t = await readTile(archive, z, x, y)
      if (!t) continue
      const layer = decode(t.raw).layers.places
      if (!layer) continue
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i)
        const p = f.properties
        if (p.kind === 'region') counts.regionFeatures++
        let kindDetail
        if (areas) {
          kindDetail = areaClass(p)
          if (!kindDetail) continue
        } else {
          if (p.kind !== 'locality' || !p.name) continue
          if (kinds && !kinds.has(p.kind_detail)) continue
          kindDetail = p.kind_detail || null
        }
        const g = f.toGeoJSON(x, y, z).geometry
        if (g.type !== 'Point') continue
        const pt = { lon: Math.round(g.coordinates[0] * 1e5) / 1e5, lat: Math.round(g.coordinates[1] * 1e5) / 1e5 }
        if (!inBbox(pt, bbox)) continue
        const id = p.name + '|' + (kindDetail || '')
        const list = byName.get(id) || []
        if (list.some((q) => haversineKm(q, pt) < (areas ? AREA_DUP_KM : DUP_KM))) continue
        list.push(pt)
        byName.set(id, list)
        counts.entries.push({ name: p.name, kind_detail: kindDetail, population: p.population || null, lon: pt.lon, lat: pt.lat })
      }
    }
  }
}

async function main () {
  const { flags, args } = parseFlags(Bare.argv.slice(2), ['--kinds', '--areas'])
  const areas = flags.has('--areas')
  const kindsFlag = flags.get('--kinds')
  const kinds = kindsFlag ? new Set(kindsFlag.split(',')) : null
  const [out, ...rest] = args
  // the sources are read four at a time, so a missing or misspelt one used to leave minz/maxz NaN,
  // `for (let z = NaN; z >= NaN; z--)` never ran, and the script reported a successful empty run
  if (!out || rest.length === 0 || rest.length % 4 !== 0) {
    throw new Error('usage: gazetteer.js [--kinds=a,b] <out.json> (<archive.pmtiles> <minLon,minLat,maxLon,maxLat> <minz> <maxz>)...')
  }
  const byName = new Map()
  const counts = { regionFeatures: 0, entries: [] }
  for (let i = 0; i < rest.length; i += 4) {
    const [path, bbox, minz, maxz] = rest.slice(i, i + 4)
    for (const [label, v] of [['minz', minz], ['maxz', maxz]]) {
      if (!/^\d+$/.test(v)) throw new Error(`${path}: ${label} must be a non-negative integer, got ${JSON.stringify(v)}`)
    }
    const before = counts.entries.length
    await collect(path, parseBbox(bbox), Number(minz), Number(maxz), byName, counts, kinds, areas)
    console.log(`${path} bbox ${bbox} z${minz}-${maxz}: +${counts.entries.length - before} ${areas ? 'areas' : 'localities'}`)
  }
  const entries = counts.entries
  const perKind = {}
  for (const e of entries) perKind[e.kind_detail] = (perKind[e.kind_detail] || 0) + 1
  console.log(`region features seen (not deduped, all zooms) ${counts.regionFeatures}`)
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

module.exports = { collect }

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
