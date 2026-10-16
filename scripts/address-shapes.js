'use strict'
// Scores three address shapes on the same fixture points, to decide which zooms the bee needs:
//   A  z14 2x2 + z15 pin tile, every part from tiles          (today's shape, plus z15)
//   B  z15 2x2, area parts from a gazetteer built at z13      (no z14 in the bee)
//   C  z15 2x2 only, area parts from those tiles              (no z14, no gazetteer areas)
// A and B differing says z14 is load-bearing; B and C differing says the gazetteer areas are.
//
// usage: address-shapes.js <fixture.json> <z11-14 archive> <z15 archive> <bbox> <city gazetteer.json>
const fs = require('bare-fs')
const CheapRuler = require('cheap-ruler').default
const { openArchive, readTile } = require('./pmtiles-file')
const { decode } = require('./mvt')
const { lonLatToTile, pinTiles } = require('./tiles')
const { parseFlags } = require('./flags')
const { deriveAddress, NEIGHBOURHOOD_M, SUBURB_M, VILLAGE_M, ROAD_ON_M } = require('./address')

// the zoom the area labels are read out of, not the zoom they are keyed at — gazetteer-lib's
// AREA_ZOOM is 14 and is the a/ key granularity, a different number for a different thing
const HARVEST_ZOOM = 13
const PARTS = ['road', 'neighbourhood', 'suburb', 'village', 'city', 'housenumber']
const NB = (p) => p.kind === 'neighbourhood' && p.kind_detail === 'neighbourhood'
const SUB = (p) => (p.kind === 'neighbourhood' && p.kind_detail === 'suburb') || p.kind === 'macrohood'
const VIL = (p) => p.kind === 'locality' && p.kind_detail === 'village'
const norm = (s) => String(s).toLowerCase().trim()

function project (f, tile, p) {
  const size = f.extent * Math.pow(2, tile.zoom)
  return [
    (p.x + f.extent * tile.x) * 360 / size - 180,
    360 / Math.PI * Math.atan(Math.exp((1 - (p.y + f.extent * tile.y) * 2 / size) * Math.PI)) - 90
  ]
}

// scripts/address.js display(), which is not exported; kept in step with it by hand
function display (a) {
  const road = a.road && a.road.metres <= ROAD_ON_M ? a.road.name : null
  const specific = a.housenumber
    ? (road ? `${a.housenumber.value} ${road}` : a.housenumber.value)
    : road || (a.near ? `near ${a.near.name}` : null)
  const areas = [[a.neighbourhood, 0], [a.suburb, 1], [a.village, 1]].filter(([p]) => p).sort(([p], [q]) => p.metres - q.metres)
  const chosen = specific ? areas.slice(0, 1) : areas.slice(0, 2).sort(([p, r], [q, s]) => r - s || p.metres - q.metres)
  const parts = [specific, ...chosen.map(([p]) => p.name)]
  if (a.city) parts.push(a.city.name)
  return parts.filter(Boolean).join(', ')
}

// the g/ entries an area gazetteer pass would write: one point per named area
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
          if (!p.name || f.type !== 1) continue
          const cls = NB(p) ? 'nb' : SUB(p) ? 'sub' : VIL(p) ? 'vil' : null
          if (!cls) continue
          const g = f.loadGeometry()
          if (!g.length || !g[0].length) continue
          const [lon, lat] = project(f, { x, y, zoom: HARVEST_ZOOM }, g[0][0])
          byKey.set(cls + '|' + p.name, { cls, name: p.name, lon, lat })
        }
      }
    }
  } finally {
    await archive.close()
  }
  return [...byKey.values()]
}

function nearestArea (index, point, cls, max) {
  const ruler = new CheapRuler(point.lat, 'meters')
  let best = null
  for (const e of index) {
    if (e.cls !== cls) continue
    const m = ruler.distance([point.lon, point.lat], [e.lon, e.lat])
    if (m <= max && (!best || m < best.metres)) best = { name: e.name, metres: m }
  }
  return best
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

async function pinTile (archive, point, count) {
  const { x, y } = lonLatToTile(point.lon, point.lat, 15)
  const t = await readTile(archive, 15, x, y)
  if (!t) return null
  count.tiles++
  count.bytes += t.raw.byteLength
  return { vt: decode(t.raw), x, y, zoom: 15 }
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
  const bbox = bboxArg.split(',').map(Number)
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) throw new Error(`bad bbox: ${bboxArg}`)

  const entries = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  const cities = JSON.parse(fs.readFileSync(gazFile, 'utf8')).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
  const index = await areaIndex(midFile, bbox)
  const mid = openArchive(midFile)
  const z15 = openArchive(z15File)
  const acc = { A: blank(), B: blank(), C: blank() }
  const cost = { A: { tiles: 0, bytes: 0 }, B: { tiles: 0, bytes: 0 } }
  try {
    for (const e of entries) {
      const point = { lon: e.lon, lat: e.lat }
      const ruler = new CheapRuler(point.lat, 'meters')
      let city = null
      for (const c of cities) {
        const km = ruler.distance([point.lon, point.lat], [c.lon, c.lat]) / 1000
        if (!city || km < city.km) city = { name: c.name, kind: c.kind_detail, km }
      }
      const tilesA = await cell(mid, point, 14, cost.A)
      const pin = await pinTile(z15, point, cost.A)
      score(acc.A, deriveAddress({ point, tiles: pin ? [...tilesA, pin] : tilesA, label: city }), e.address)

      const tilesB = await cell(z15, point, 15, cost.B)
      const base = deriveAddress({ point, tiles: tilesB, label: city })
      const withAreas = {
        ...base,
        neighbourhood: nearestArea(index, point, 'nb', NEIGHBOURHOOD_M),
        suburb: nearestArea(index, point, 'sub', SUBURB_M),
        village: nearestArea(index, point, 'vil', VILLAGE_M)
      }
      withAreas.display = display(withAreas)
      score(acc.B, withAreas, e.address)
      score(acc.C, base, e.address)
    }
  } finally {
    await mid.close()
    await z15.close()
  }

  const n = entries.length
  console.log(`${fixture}: ${n} points, ${index.length} area labels from z${HARVEST_ZOOM}`)
  console.log('part            A(z14+z15pin)  B(z15+gazArea)  C(z15 only)')
  for (const p of PARTS) {
    const f = (k) => `${acc[k].hits[p]}/${acc[k].n[p]}`
    console.log(`  ${p.padEnd(13)} ${f('A').padEnd(14)} ${f('B').padEnd(15)} ${f('C')}`)
  }
  console.log(`  ${'tiles/point'.padEnd(13)} ${(cost.A.tiles / n).toFixed(1).padEnd(14)} ${(cost.B.tiles / n).toFixed(1)}`)
  console.log(`  ${'KiB/point'.padEnd(13)} ${(cost.A.bytes / n / 1024).toFixed(1).padEnd(14)} ${(cost.B.bytes / n / 1024).toFixed(1)}`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
