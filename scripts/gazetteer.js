'use strict'
// usage: gazetteer.js <out.json> (<archive> <bbox> <minz> <maxz>)...
const fs = require('bare-fs')
const zlib = require('bare-zlib')
const { openArchive, readTile } = require('./pmtiles-file')
const { bboxTiles, parseBbox } = require('./tiles')
const { decode } = require('./mvt')
const { haversineKm, gazKeys } = require('./gazetteer-lib')

const DUP_KM = 5

function inBbox (p, b) {
  return p.lon >= b[0] && p.lat >= b[1] && p.lon <= b[2] && p.lat <= b[3]
}

async function collect (path, bbox, minz, maxz, byName, counts) {
  const archive = openArchive(path)
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
        if (p.kind !== 'locality' || !p.name) continue
        const g = f.toGeoJSON(x, y, z).geometry
        if (g.type !== 'Point') continue
        const pt = { lon: Math.round(g.coordinates[0] * 1e5) / 1e5, lat: Math.round(g.coordinates[1] * 1e5) / 1e5 }
        if (!inBbox(pt, bbox)) continue
        const id = p.name + '|' + (p.kind_detail || '')
        const list = byName.get(id) || []
        if (list.some((q) => haversineKm(q, pt) < DUP_KM)) continue
        list.push(pt)
        byName.set(id, list)
        counts.entries.push({ name: p.name, kind_detail: p.kind_detail || null, population: p.population || null, lon: pt.lon, lat: pt.lat })
      }
    }
  }
  await archive.close()
}

async function main () {
  const [out, ...rest] = Bare.argv.slice(2)
  const byName = new Map()
  const counts = { regionFeatures: 0, entries: [] }
  for (let i = 0; i < rest.length; i += 4) {
    const [path, bbox, minz, maxz] = rest.slice(i, i + 4)
    const before = counts.entries.length
    await collect(path, parseBbox(bbox), Number(minz), Number(maxz), byName, counts)
    console.log(`${path} bbox ${bbox} z${minz}-${maxz}: +${counts.entries.length - before} localities`)
  }
  const entries = counts.entries
  const perKind = {}
  for (const e of entries) perKind[e.kind_detail] = (perKind[e.kind_detail] || 0) + 1
  console.log(`region features seen (not deduped, all zooms) ${counts.regionFeatures}`)
  console.log(`localities ${entries.length} by kind_detail ${JSON.stringify(perKind)}`)
  const kv = gazKeys(entries)
  const rawKV = kv.reduce((n, e) => n + e.key.byteLength + e.value.byteLength, 0)
  const json = Buffer.from(JSON.stringify(entries))
  console.log(`raw key+value bytes ${rawKV}`)
  console.log(`json bytes ${json.byteLength} gzip bytes ${zlib.gzipSync(json, { level: 9 }).byteLength}`)
  for (const k of ['city', 'town']) {
    const sub = Buffer.from(JSON.stringify(entries.filter((e) => e.kind_detail === k)))
    console.log(`subset ${k}: json ${sub.byteLength} gzip ${zlib.gzipSync(sub, { level: 9 }).byteLength}`)
  }
  const jaipur = entries.filter((e) => e.name === 'Jaipur')
  console.log(`Jaipur entries ${JSON.stringify(jaipur)}`)
  fs.writeFileSync(out, JSON.stringify(entries, null, 1) + '\n')
  console.log(`wrote ${out}`)
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
