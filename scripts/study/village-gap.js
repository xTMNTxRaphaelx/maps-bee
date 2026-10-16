'use strict'
// Why `village` misses, and what moving VILLAGE_M would cost. For every fixture point Nominatim
// gives a village for, the a/ gazetteer is searched at any distance, which separates a harvest gap
// (the village is not in the data) from a threshold that is too tight (it is, but too far) from
// the wrong village winning (a nearer one is picked first).
//
// Then a sweep: at each candidate threshold, how many scored points come out right, how many come
// out wrong, and how many unscored points gain a village label they did not have — the cost, since
// a village in `display` that Nominatim does not name is noise the hit rate never sees.
//
// usage: village-gap.js
const fs = require('bare-fs')
const path = require('bare-path')
const { origin, VILLAGE_M } = require('../address')

const DATA = path.join(__dirname, '..', '..', 'data')
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures')
const CITIES = [
  { label: 'Jaipur', fixture: 'jaipur-nominatim-wide.json', areas: 'areas.json' },
  { label: 'Lugano', fixture: 'lugano-nominatim-wide.json', areas: 'areas-lugano.json' }
]
const SWEEP = [700, 800, 900, 1000, 1100, 1200, 1400, 1700, 2000, 2500, 3500]

const norm = (s) => String(s).toLowerCase().trim()
const show = (v) => (v ? `${v.name} ${Math.round(v.m)}m` : '-')

// every village of the a/ gazetteer by distance from the point, on the ruler deriveAddress uses
function ranked (point, villages) {
  const o = origin(point)
  return villages
    .map((v) => ({ name: v.name, m: o.ruler.distance(o.p, [v.lon, v.lat]) }))
    .sort((a, b) => a.m - b.m)
}

function load (city) {
  const points = JSON.parse(fs.readFileSync(path.join(FIXTURES, city.fixture), 'utf8'))
  const villages = JSON.parse(fs.readFileSync(path.join(DATA, city.areas), 'utf8'))
    .filter((e) => e.kind_detail === 'village')
  return points.map((p) => ({
    at: `${p.lat},${p.lon}`,
    want: (p.address && p.address.village) || null,
    ranked: ranked({ lon: p.lon, lat: p.lat }, villages)
  }))
}

// which of the four reasons a point misses at the current threshold
function bucketise (rows) {
  const out = { hit: [], absent: [], beyond: [], outranked: [], none: [] }
  for (const r of rows) {
    if (!r.want) continue
    const ours = r.ranked.find((v) => v.m <= VILLAGE_M) || null
    const theirs = r.ranked.find((v) => norm(v.name) === norm(r.want))
    const row = { ...r, ours, theirs }
    if (ours && norm(ours.name) === norm(r.want)) out.hit.push(row)
    else if (!theirs) out.absent.push(row)
    else if (theirs.m > VILLAGE_M) out.beyond.push(row)
    else if (ours) out.outranked.push(row)
    else out.none.push(row)
  }
  return out
}

// at threshold max: right / wrong / blank over scored points, and labels gained on unscored ones
function atThreshold (rows, max) {
  const t = { right: 0, wrong: 0, blank: 0, noise: 0, unscored: 0 }
  for (const r of rows) {
    const ours = r.ranked.find((v) => v.m <= max) || null
    if (!r.want) {
      t.unscored++
      if (ours) t.noise++
      continue
    }
    if (!ours) t.blank++
    else if (norm(ours.name) === norm(r.want)) t.right++
    else t.wrong++
  }
  return t
}

const all = []
for (const city of CITIES) {
  const rows = load(city)
  all.push(...rows)
  const b = bucketise(rows)
  const scored = rows.filter((r) => r.want).length
  console.log(`\n=== ${city.label} — ${rows.length} points, ${scored} with a village, VILLAGE_M=${VILLAGE_M} ===`)
  console.log(`hit ${b.hit.length}/${scored}  absent ${b.absent.length}  beyond ${b.beyond.length}  outranked ${b.outranked.length}  no-candidate ${b.none.length}`)
  for (const k of ['absent', 'beyond', 'outranked', 'none']) {
    if (b[k].length === 0) continue
    console.log(`  ${k}:`)
    for (const r of b[k]) console.log(`    ${r.at}  want "${r.want}"  theirs ${show(r.theirs)}  ours ${show(r.ours)}`)
  }
}

// the distances the current rule gets right against the ones it gets wrong: if they interleave,
// no threshold separates them and the fix is not a number
const right = []
const wrong = []
for (const r of all) {
  if (!r.want) continue
  const ours = r.ranked.find((v) => v.m <= VILLAGE_M)
  if (!ours) continue
  ;(norm(ours.name) === norm(r.want) ? right : wrong).push(Math.round(ours.m))
}
console.log(`\n=== at VILLAGE_M=${VILLAGE_M}, the distance of the village we pick ===`)
console.log(`  right (${right.length}): ${right.sort((a, b) => a - b).join(' ')}`)
console.log(`  wrong (${wrong.length}): ${wrong.sort((a, b) => a - b).join(' ')}`)

const scoredAll = all.filter((r) => r.want).length
console.log(`\n=== threshold sweep, both cities (${all.length} points: ${scoredAll} scored, ${all.length - scoredAll} unscored) ===`)
console.log('  max\tright\twrong\tblank\tlabel on unscored')
for (const max of SWEEP) {
  const t = atThreshold(all, max)
  console.log(`  ${max}\t${t.right}\t${t.wrong}\t${t.blank}\t${t.noise}/${t.unscored}`)
}
