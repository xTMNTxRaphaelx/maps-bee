'use strict'
// Ground truth for an address accuracy fixture: reverse geocode each candidate point with
// Nominatim and write the fixture shape test/address-score.js reads ({ lat, lon, display_name,
// address }). Runs under node, not bare: it needs fetch and this is a one-off authoring tool.
//
// Nominatim's usage policy caps automated use at one request a second and requires a real
// User-Agent naming the application. Both are enforced below; do not lower DELAY_MS.
//
// usage: node scripts/fetch-nominatim.js <candidates.json> <out.json> [contact]
const fs = require('fs')

const DELAY_MS = 1100
const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function reverse (lat, lon, ua) {
  const url = `${ENDPOINT}?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lon}`
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${lat},${lon}`)
  const body = await res.json()
  if (body.error) throw new Error(`${body.error} for ${lat},${lon}`)
  return body
}

async function main () {
  const [candFile, outFile, contact] = process.argv.slice(2)
  if (!candFile || !outFile) {
    throw new Error('usage: node scripts/fetch-nominatim.js <candidates.json> <out.json> [contact]')
  }
  const ua = `maps-bee-fixture/1.0 (${contact || 'https://github.com/xTMNTxRaphaelx/maps-bee'})`
  const candidates = JSON.parse(fs.readFileSync(candFile, 'utf8'))
  const out = []
  let failed = 0
  for (let i = 0; i < candidates.length; i++) {
    const { lat, lon, stratum } = candidates[i]
    try {
      const r = await reverse(lat, lon, ua)
      out.push({ lat, lon, stratum, display_name: r.display_name, address: r.address || {} })
    } catch (err) {
      failed++
      console.error(`  skipped ${lat},${lon}: ${err.message}`)
    }
    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
      console.error(`  ${i + 1}/${candidates.length} (${failed} skipped)`)
    }
    if (i < candidates.length - 1) await sleep(DELAY_MS)
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n')
  const have = {}
  for (const e of out) for (const k of Object.keys(e.address)) have[k] = (have[k] || 0) + 1
  console.error(`wrote ${outFile}: ${out.length} points`)
  console.error(`  road ${have.road || 0}  neighbourhood ${have.neighbourhood || 0}  suburb ${have.suburb || 0}  quarter ${have.quarter || 0}  village ${have.village || 0}  city ${have.city || 0}  house_number ${have.house_number || 0}`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
