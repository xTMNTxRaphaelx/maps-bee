'use strict'
const { readPreview } = require('../scripts/preview')

const PARTS = ['road', 'neighbourhood', 'suburb', 'village', 'city', 'housenumber']
const OPTS = { timeout: 5000 }

const norm = (s) => String(s).toLowerCase().trim()
const metresOf = (p) => (p ? `${p.name} (${Math.round(p.metres)}m)` : '-')
const mark = (scored, hit) => (scored ? (hit ? 'HIT' : 'miss') : 'n/a')

// One row per fixture point, then a hit rate per part over the points where Nominatim has that part,
// and the distances of the chosen parts. A neighbourhood or suburb hits when it equals any of Nominatim's
// neighbourhood, suburb or quarter (their order comes from polygons, ours from label distance); the city
// hits on Nominatim's city, town or village, or when Nominatim's city starts with ours, or when our
// village is that locality: a municipality tagged as a village is the right place in a different slot.
async function scoreRegion (t, bee, entries) {
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

  let rateLines = 0
  for (const part of PARTS) {
    t.comment(`rate ${part} ${hits[part]}/${n[part]}`)
    rateLines++
  }
  for (const part of PARTS) {
    t.comment(`dist ${part}: ${dist[part].map(Math.round).sort((x, y) => x - y).join(' ')}`)
  }
  t.is(rateLines, PARTS.length, 'rates printed')
}

module.exports = { scoreRegion }
