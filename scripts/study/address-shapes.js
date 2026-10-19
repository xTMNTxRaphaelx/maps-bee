'use strict'
// Scores two address shapes on the same fixture points, to decide what the bee must hold:
//   B  z15 2x2, area parts from a gazetteer harvested at z13   (what preview.js reads)
//   C  z15 2x2 only, area parts from those tiles               (no gazetteer areas)
// B and C differing says the area gazetteer earns its place. A third shape, a z14 2x2 plus a
// separate z15 pin tile, was scored here until the z15 detail cell replaced it; its numbers are in
// results/address-shapes.txt and the question it answered is closed.
//
// usage: address-shapes.js <fixture.json> <z11-14 archive> <z15 archive> <bbox> <city gazetteer.json>
// the z11-14 archive is still needed: the area labels are harvested from its z13 tiles
const fs = require('bare-fs')
const { openArchive, readTile } = require('../../lib/build/pmtiles-file')
const { decode, project } = require('../../lib/mvt')
const { lonLatToTile, parseBbox, pinTiles } = require('../../lib/tiles')
const { parseFlags } = require('../../bin/flags')
const { areaClass } = require('../../lib/gazetteer-lib')
const { DETAIL_ZOOM } = require('../../lib/preview')
const { deriveAddress, origin, nearestLabel, display, NEIGHBOURHOOD_M, SUBURB_M, VILLAGE_M } = require('../../lib/address')

// the zoom the area labels are read out of, not the zoom they are keyed at — gazetteer-lib's
// AREA_ZOOM is 14 and is the a/ key granularity, a different number for a different thing
const HARVEST_ZOOM = 13
const PARTS = ['road', 'neighbourhood', 'suburb', 'village', 'city', 'housenumber']
const norm = (s) => String(s).toLowerCase().trim()

// the a/ entries an area gazetteer pass would write: one point per named area
async function areaIndex (file, bbox) {
  const archive = openArchive(file)
  const byKey = new Map()
  try {
    const tl = lonLatToTile(bbox[0], bbox[3], HARVEST_ZOOM)
    const br = lonLatToTile(bbox[2], bbox[1], HARVEST_ZOOM)
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        const t = await readTile(archive, HARVEST_ZOOM, x, y)
        if (!t) continue
        const l = decode(t.raw).layers.places
        if (!l) continue
        for (let i = 0; i < l.length; i++) {
          const f = l.feature(i)
          const p = f.properties
          if (f.type !== 1) continue
          // areaClass, so the study classifies exactly as the real pass does
          const kindDetail = areaClass(p)
          if (!kindDetail) continue
          const g = f.loadGeometry()
          if (!g.length || !g[0].length) continue
          const [lon, lat] = project(f, { x, y, zoom: HARVEST_ZOOM }, g[0][0])
          byKey.set(kindDetail + '|' + p.name, { name: p.name, kind_detail: kindDetail, lon, lat })
        }
      }
    }
  } finally {
    await archive.close()
  }
  return [...byKey.values()]
}

async function cell (archive, point, zoom, count) {
  const out = []
  for (const t of pinTiles(point.lon, point.lat, zoom).tiles) {
    if (!t) continue
    const tile = await readTile(archive, zoom, t[0], t[1])
    if (!tile) continue
    count.tiles++
    count.bytes += tile.raw.byteLength
    out.push({ vt: decode(tile.raw), x: t[0], y: t[1], zoom })
  }
  return out
}

function blank () {
  const o = { hits: {}, n: {} }
  for (const p of PARTS) {
    o.hits[p] = 0
    o.n[p] = 0
  }
  return o
}

// the rules in test/address-score.js, so these numbers are comparable with results/address-accuracy-*
function score (acc, a, A) {
  const add = (part, scored, hit) => {
    if (!scored) return
    acc.n[part]++
    if (hit) acc.hits[part]++
  }
  add('road', Boolean(A.road), Boolean(A.road && a.road && norm(a.road.name) === norm(A.road)))
  const theirs = [A.neighbourhood, A.suburb, A.quarter].filter(Boolean).map(norm)
  const placeHit = [a.neighbourhood, a.suburb].some((p) => p && theirs.includes(norm(p.name)))
  add('neighbourhood', Boolean(A.neighbourhood), placeHit)
  add('suburb', Boolean(A.suburb), placeHit)
  add('village', Boolean(A.village), Boolean(A.village && a.village && norm(a.village.name) === norm(A.village)))
  const theirsCity = A.city || A.town || A.village
  const cityHit = Boolean(theirsCity && ((a.city && (norm(a.city.name) === norm(theirsCity) || norm(A.city || '').startsWith(norm(a.city.name)))) || (a.village && norm(a.village.name) === norm(theirsCity))))
  add('city', Boolean(theirsCity), cityHit)
  const hnScored = Boolean(a.housenumber && A.house_number)
  add('housenumber', hnScored, hnScored && norm(a.housenumber.value) === norm(A.house_number))
}

async function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [fixture, midFile, z15File, bboxArg, gazFile] = args
  if (!fixture || !midFile || !z15File || !bboxArg || !gazFile) {
    throw new Error('usage: address-shapes.js <fixture.json> <z11-14 archive> <z15 archive> <bbox> <gazetteer.json>')
  }
  const bbox = parseBbox(bboxArg)

  const entries = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  const cities = JSON.parse(fs.readFileSync(gazFile, 'utf8')).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
  const index = await areaIndex(midFile, bbox)
  const z15 = openArchive(z15File)
  const acc = { B: blank(), C: blank() }
  const cost = { B: { tiles: 0, bytes: 0 } }
  try {
    for (const e of entries) {
      const point = { lon: e.lon, lat: e.lat }
      // the same ruler deriveAddress measures on, so every distance here is on one metric
      const o = origin(point)
      let city = null
      for (const c of cities) {
        const km = o.ruler.distance(o.p, [c.lon, c.lat]) / 1000
        if (!city || km < city.km) city = { name: c.name, kind: c.kind_detail, km }
      }
      const tilesB = await cell(z15, point, DETAIL_ZOOM, cost.B)
      const base = deriveAddress({ point, tiles: tilesB, label: city })
      const withAreas = {
        ...base,
        neighbourhood: nearestLabel(index, o, 'neighbourhood', NEIGHBOURHOOD_M),
        suburb: nearestLabel(index, o, 'suburb', SUBURB_M),
        village: nearestLabel(index, o, 'village', VILLAGE_M)
      }
      withAreas.display = display(withAreas)
      score(acc.B, withAreas, e.address)
      score(acc.C, base, e.address)
    }
  } finally {
    await z15.close()
  }

  const n = entries.length
  console.log(`${fixture}: ${n} points, ${index.length} area labels from z${HARVEST_ZOOM}`)
  console.log('part            B(z15+gazArea)  C(z15 only)')
  for (const p of PARTS) {
    const f = (k) => `${acc[k].hits[p]}/${acc[k].n[p]}`
    console.log(`  ${p.padEnd(13)} ${f('B').padEnd(15)} ${f('C')}`)
  }
  console.log(`  ${'tiles/point'.padEnd(13)} ${(cost.B.tiles / n).toFixed(1)}`)
  console.log(`  ${'KiB/point'.padEnd(13)} ${(cost.B.bytes / n / 1024).toFixed(1)}`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
