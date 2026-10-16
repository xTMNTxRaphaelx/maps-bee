'use strict'
// Candidate points for an address accuracy fixture, sampled from an extract so they land where the
// data is. Three strata in equal share, because a uniform sample of a city bbox is mostly points
// Nominatim gives no road or house number for, and those score nothing:
//   addr   within SPREAD_M of a z15 buildings kind=address point   -> exercises housenumber
//   road   within SPREAD_M of a named road vertex                  -> exercises road
//   plain  uniform in the bbox                                     -> the sparse case
// The stratum is recorded per point. It biases the denominators, not the comparison: every address
// shape is scored on the same points.
//
// usage: fixture-points.js <z15 archive> <bbox> <n> [seed] > candidates.json
const CheapRuler = require('cheap-ruler').default
const { openArchive, readTile } = require('./pmtiles-file')
const { decode } = require('./mvt')
const { lonLatToTile } = require('./tiles')
const { parseFlags } = require('./flags')

const SPREAD_M = 25
const Z = 15

// mulberry32: a seeded PRNG, so the same seed gives the same fixture
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function project (f, tile, p) {
  const size = f.extent * Math.pow(2, tile.zoom)
  return [
    (p.x + f.extent * tile.x) * 360 / size - 180,
    360 / Math.PI * Math.atan(Math.exp((1 - (p.y + f.extent * tile.y) * 2 / size) * Math.PI)) - 90
  ]
}

async function anchors (file, bbox) {
  const archive = openArchive(file)
  const addr = []
  const road = []
  try {
    const tl = lonLatToTile(bbox[0], bbox[3], Z)
    const br = lonLatToTile(bbox[2], bbox[1], Z)
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) {
        const t = await readTile(archive, Z, x, y)
        if (!t) continue
        const vt = decode(t.raw)
        const tile = { x, y, zoom: Z }
        const bl = vt.layers.buildings
        if (bl) {
          for (let i = 0; i < bl.length; i++) {
            const f = bl.feature(i)
            if (f.properties.kind !== 'address' || f.type !== 1) continue
            const g = f.loadGeometry()
            if (!g.length || !g[0].length) continue
            addr.push(project(f, tile, g[0][0]))
          }
        }
        const rl = vt.layers.roads
        if (rl) {
          for (let i = 0; i < rl.length; i++) {
            const f = rl.feature(i)
            if (!f.properties.name || f.type !== 2) continue
            const g = f.loadGeometry()
            if (!g.length || !g[0].length) continue
            road.push(project(f, tile, g[0][Math.floor(g[0].length / 2)] || g[0][0]))
          }
        }
      }
    }
  } finally {
    await archive.close()
  }
  return { addr, road }
}

function jitter (rand, [lon, lat]) {
  const ruler = new CheapRuler(lat, 'meters')
  const a = rand() * 2 * Math.PI
  const d = rand() * SPREAD_M
  return ruler.offset([lon, lat], Math.cos(a) * d, Math.sin(a) * d)
}

const round = (v) => Number(v.toFixed(6))

async function main () {
  const { args } = parseFlags(Bare.argv.slice(2), [])
  const [file, bboxArg, nArg, seedArg] = args
  if (!file || !bboxArg || !nArg) {
    throw new Error('usage: fixture-points.js <z15 archive> <minLon,minLat,maxLon,maxLat> <n> [seed]')
  }
  const bbox = bboxArg.split(',').map(Number)
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) throw new Error(`bad bbox: ${bboxArg}`)
  const n = Number(nArg)
  if (!Number.isInteger(n) || n < 3) throw new Error(`n must be an integer >= 3, got ${nArg}`)
  const rand = rng(seedArg === undefined ? 1 : Number(seedArg))

  const { addr, road } = await anchors(file, bbox)
  const per = Math.floor(n / 3)
  const out = []
  const take = (list, stratum, count) => {
    for (let i = 0; i < count && list.length > 0; i++) {
      const [lon, lat] = jitter(rand, list[Math.floor(rand() * list.length)])
      out.push({ lat: round(lat), lon: round(lon), stratum })
    }
  }
  take(addr, 'addr', per)
  take(road, 'road', per)
  while (out.length < n) {
    out.push({
      lat: round(bbox[1] + rand() * (bbox[3] - bbox[1])),
      lon: round(bbox[0] + rand() * (bbox[2] - bbox[0])),
      stratum: 'plain'
    })
  }
  console.error(`anchors: ${addr.length} address points, ${road.length} named road vertices`)
  console.log(JSON.stringify(out, null, 1))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
