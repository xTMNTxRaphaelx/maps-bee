'use strict'
// How often does a preview come back as the city alone, and is there anything in hand that a
// last-resort rule could have used? A pin in a residential pocket of Noida rendered as just
// "Noida" on the planet atlas: no road within ROAD_ON_M, no poi within NEAR_M, no a/ area within
// its thresholds. display() then has nothing but the city. This counts the cases over the
// accuracy fixtures and says what each one still had available, so the question of whether to add
// a fallback is answered by frequency rather than by one anecdote.
//
// Reads z14 to match a z14-topped planet build, not the z15 the accuracy tests use.
//
// usage: bare-display.js
const fs = require('bare-fs')
const path = require('bare-path')
const { openArchive, readTile } = require('../../lib/build/pmtiles-file')
const { decode, project } = require('../../lib/mvt')
const { pinTiles } = require('../../lib/tiles')
const { haversineKm, readGazetteer } = require('../../lib/gazetteer-lib')
const { deriveAddress, origin, nearestLabel, ROAD_ON_M, NEARBY_M } = require('../../lib/address')

// nearest named poi in the fetched cell at any distance, so a city-only point can be asked what a
// wider "near X" would have said. Measured on the same ruler deriveAddress uses.
function nearestPoi (tiles, o) {
  let best = null
  for (const tile of tiles) {
    const l = tile.vt.layers.pois
    if (!l) continue
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i)
      if (f.type !== 1 || !f.properties.name) continue
      const g = f.loadGeometry()
      if (!g.length || !g[0].length) continue
      const m = o.ruler.distance(o.p, project(f, tile, g[0][0]))
      if (!best || m < best.metres) best = { name: f.properties.name, kind: f.properties.kind, metres: m }
    }
  }
  return best
}

// nearest a/ area of any class at any distance
function nearestArea (areas, o) {
  let best = null
  for (const cls of ['neighbourhood', 'suburb', 'village']) {
    const a = nearestLabel(areas, o, cls, Infinity)
    if (a && (!best || a.metres < best.metres)) best = { ...a, cls }
  }
  return best
}

const ROOT = path.join(__dirname, '..', '..')
const CITIES = [
  { label: 'Jaipur', fixture: 'jaipur-nominatim-wide.json', areas: 'areas.json', gaz: 'gazetteer.json', archives: { 14: 'extract/jaipur-z11-14.pmtiles', 15: 'extract/jaipur-z15.pmtiles' } },
  { label: 'Lugano', fixture: 'lugano-nominatim-wide.json', areas: 'areas-lugano.json', gaz: 'gazetteer-lugano.json', archives: { 14: 'extract/lugano-z11-14.pmtiles', 15: 'extract/lugano-z15.pmtiles' } }
]

const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'))
// read() also loads Nominatim fixtures, which are plain arrays by nature; only a harvest goes
// through readGazetteer, which takes the marked shape and a pre-marker bare array alike
const readGaz = (...p) => readGazetteer(read(...p)).entries

// the 2x2 readPreview would fetch at zoom, decoded and placed
async function cell (archive, point, zoom) {
  const out = []
  for (const t of pinTiles(point.lon, point.lat, zoom).tiles) {
    if (!t) continue
    const tile = await readTile(archive, zoom, t[0], t[1])
    if (tile) out.push({ vt: decode(tile.raw), x: t[0], y: t[1], zoom })
  }
  return out
}

function nearestCity (point, cities) {
  let best = null
  for (const c of cities) {
    const km = haversineKm(point, c)
    if (!best || km < best.km) best = { name: c.name, kind: c.kind_detail, km }
  }
  return best
}

async function run (city, zoom) {
  const points = read('test', 'fixtures', city.fixture)
  const areas = readGaz('data', city.areas)
  const cities = readGaz('data', city.gaz).filter((e) => e.kind_detail === 'city' || e.kind_detail === 'town')
  const archive = openArchive(path.join(ROOT, 'data', city.archives[zoom]))
  const tally = { points: 0, noTiles: 0, specific: 0, areaOnly: 0, cityOnly: 0, rescuable: 0, nothing: 0, poiInReach: 0, areaInReach: 0 }
  const detail = []
  try {
    for (const p of points) {
      const point = { lat: p.lat, lon: p.lon }
      tally.points++
      const tiles = await cell(archive, point, zoom)
      if (tiles.length === 0) {
        tally.noTiles++
        continue
      }
      const a = deriveAddress({ point, tiles, label: nearestCity(point, cities), areas })
      const hasSpecific = Boolean(a.housenumber) || Boolean(a.road && a.road.metres <= ROAD_ON_M) || Boolean(a.near)
      const hasArea = Boolean(a.neighbourhood || a.suburb || a.village)
      if (hasSpecific) tally.specific++
      else if (hasArea) tally.areaOnly++
      else {
        tally.cityOnly++
        if (a.road) tally.rescuable++
        else tally.nothing++
        // what a wider rule could have reached: the road the display dropped, the nearest named
        // poi in the cell at any distance, the nearest a/ area at any distance
        const o = origin(point)
        const poi = nearestPoi(tiles, o)
        const area = nearestArea(areas, o)
        if (poi && poi.metres <= NEARBY_M) tally.poiInReach++
        if (area && area.metres <= NEARBY_M) tally.areaInReach++
        detail.push([
          `${p.lat},${p.lon}`.padEnd(22),
          `road ${a.road ? `${a.road.name} ${Math.round(a.road.metres)}m` : '-'}`.padEnd(38),
          `poi ${poi ? `${poi.name} ${Math.round(poi.metres)}m` : '-'}`.padEnd(38),
          `area ${area ? `${area.name} ${Math.round(area.metres)}m` : '-'}`
        ].join(''))
      }
    }
  } finally {
    await archive.close()
  }
  const pct = (n) => `${((n / tally.points) * 100).toFixed(1)}%`
  console.log(`\n--- ${city.label}, z${zoom}, ${tally.points} fixture points`)
  console.log(`  specific part (housenumber, road <= ${ROAD_ON_M}m, or poi)  ${tally.specific} ${pct(tally.specific)}`)
  console.log(`  area but no specific                                 ${tally.areaOnly} ${pct(tally.areaOnly)}`)
  console.log(`  city only                                            ${tally.cityOnly} ${pct(tally.cityOnly)}`)
  console.log(`    a road was found but dropped as too far            ${tally.rescuable}`)
  console.log(`    a named poi within ${NEARBY_M}m was in the cell        ${tally.poiInReach}`)
  console.log(`    an a/ area within ${NEARBY_M}m existed               ${tally.areaInReach}`)
  console.log(`    genuinely nothing within any threshold             ${tally.nothing}`)
  if (tally.noTiles > 0) console.log(`  no tiles at z${zoom}                                      ${tally.noTiles}`)
  for (const line of detail) console.log(`      ${line}`)
  return tally
}

async function main () {
  const summary = []
  for (const zoom of [14, 15]) {
    const totals = { points: 0, cityOnly: 0, rescuable: 0, nothing: 0, noTiles: 0, poiInReach: 0, areaInReach: 0 }
    console.log(`\n=== detail cell at z${zoom} ===`)
    for (const city of CITIES) {
      const t = await run(city, zoom)
      for (const k of Object.keys(totals)) totals[k] += t[k]
    }
    summary.push({ zoom, ...totals })
  }
  console.log('\n=== both cities, by detail zoom ===')
  console.log(`  zoom\tpoints\tcity only\troad >50m\tpoi <${NEARBY_M}m\tarea <${NEARBY_M}m`)
  for (const s of summary) {
    console.log(`  ${s.zoom}\t${s.points}\t${s.cityOnly} (${((s.cityOnly / s.points) * 100).toFixed(1)}%)\t${s.rescuable}\t\t${s.poiInReach}\t\t${s.areaInReach}`)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  })
}
