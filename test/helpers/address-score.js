'use strict'
const { readPreview } = require('../../lib/preview')

const PARTS = ['road', 'neighbourhood', 'suburb', 'village', 'city', 'housenumber']
const OPTS = { timeout: 5000 }

const norm = (s) => String(s).toLowerCase().trim()
const metresOf = (p) => (p ? `${p.name} (${Math.round(p.metres)}m)` : '-')
const mark = (scored, hit) => (scored ? (hit ? 'HIT' : 'miss') : 'n/a')

// A feature that failed its predicate but still won on distance shows up as a nameless part and
// "undefined" in the display. No hit rate sees that — a nameless part just misses, and a floor
// absorbs it — so assert it directly. On real data this reaches the roads and pois predicates; the
// extracts carry no nameless place or number-less address, so those are in test/address-derive.js.
const NAMED_PARTS = ['road', 'neighbourhood', 'suburb', 'village', 'near', 'nearby']

function usableParts (a) {
  const bad = []
  for (const part of NAMED_PARTS) {
    const p = a[part]
    if (p && !(typeof p.name === 'string' && p.name.length > 0)) bad.push(`${part}.name is ${JSON.stringify(p.name)}`)
  }
  if (a.housenumber) {
    const v = a.housenumber.value
    if (!(typeof v === 'string' && v.length > 0)) bad.push(`housenumber.value is ${JSON.stringify(v)}`)
  }
  if (String(a.display).includes('undefined')) bad.push(`display is ${JSON.stringify(a.display)}`)
  return bad
}

// One row per fixture point, then a hit rate per part over the points Nominatim has it for, and the
// chosen distances. A neighbourhood or suburb hits against any of their neighbourhood, suburb or
// quarter (their order comes from polygons, ours from label distance); the city hits on their city,
// town or village, on a prefix match, or when our village is that locality — a municipality tagged
// as a village is the right place in a different slot. floors: { part: [minHits, scored] }, with the
// denominator asserted too, since a part that stops being scored would satisfy any floor vacuously.
async function scoreRegion (t, bee, entries, floors) {
  const hits = {}
  const n = {}
  const dist = {}
  for (const part of PARTS) {
    hits[part] = 0
    n[part] = 0
    dist[part] = []
  }
  const score = (part, scored, hit) => {
    if (!scored) return
    n[part]++
    if (hit) hits[part]++
  }

  for (const { lat, lon, address: A } of entries) {
    const a = (await readPreview(bee, { lat, lon }, OPTS)).address
    t.ok(a && a.city, 'city at ' + lat + ',' + lon)
    t.is(usableParts(a).join(' | '), '', `every part usable at ${lat},${lon}`)

    const roadHit = Boolean(A.road && a.road && norm(a.road.name) === norm(A.road))
    score('road', Boolean(A.road), roadHit)

    const theirsPlaces = [A.neighbourhood, A.suburb, A.quarter].filter(Boolean).map(norm)
    const placeHit = [a.neighbourhood, a.suburb].some((p) => p && theirsPlaces.includes(norm(p.name)))
    score('neighbourhood', Boolean(A.neighbourhood), placeHit)
    score('suburb', Boolean(A.suburb), placeHit)

    const villageHit = Boolean(A.village && a.village && norm(a.village.name) === norm(A.village))
    score('village', Boolean(A.village), villageHit)

    const theirsCity = A.city || A.town || A.village
    const cityHit = Boolean(theirsCity && ((a.city && (norm(a.city.name) === norm(theirsCity) || norm(A.city || '').startsWith(norm(a.city.name)))) || (a.village && norm(a.village.name) === norm(theirsCity))))
    score('city', Boolean(theirsCity), cityHit)

    const hnScored = Boolean(a.housenumber && A.house_number)
    score('housenumber', hnScored, hnScored && norm(a.housenumber.value) === norm(A.house_number))

    if (a.road) dist.road.push(a.road.metres)
    if (a.neighbourhood) dist.neighbourhood.push(a.neighbourhood.metres)
    if (a.suburb) dist.suburb.push(a.suburb.metres)
    if (a.village) dist.village.push(a.village.metres)
    if (a.city) dist.city.push(a.city.km * 1000)
    if (a.housenumber) dist.housenumber.push(a.housenumber.metres)

    const city = a.city ? `${a.city.name} (${a.city.km.toFixed(1)}km)` : '-'
    const hn = a.housenumber ? a.housenumber.value : '-'
    t.comment([
      `${lat},${lon}`,
      `road ${metresOf(a.road)}|${A.road || '-'} ${mark(Boolean(A.road), roadHit)}`,
      `nb ${metresOf(a.neighbourhood)}|${A.neighbourhood || '-'}`,
      `sub ${metresOf(a.suburb)}|${A.suburb || '-'} ${mark(Boolean(A.suburb), placeHit)}`,
      `vil ${metresOf(a.village)}|${A.village || '-'} ${mark(Boolean(A.village), villageHit)}`,
      `city ${city}|${theirsCity || '-'} ${mark(Boolean(theirsCity), cityHit)}`,
      `hn ${hn}|${A.house_number || '-'} ${mark(hnScored, hnScored && norm(a.housenumber.value) === norm(A.house_number))}`,
      `display ${a.display}`
    ].join('\t'))
  }

  for (const part of PARTS) {
    t.comment(`rate ${part} ${hits[part]}/${n[part]}`)
  }
  for (const part of PARTS) {
    t.comment(`dist ${part}: ${dist[part].map(Math.round).sort((x, y) => x - y).join(' ')}`)
  }

  // these rates are the measurement this suite exists to defend, so they are assertions
  for (const part of PARTS) {
    const [minHits, scored] = floors[part]
    t.is(n[part], scored, `${part} scored on ${scored} points`)
    t.ok(hits[part] >= minHits, `${part} hit ${hits[part]}/${n[part]}, floor ${minHits}`)
  }
}

module.exports = { scoreRegion }
