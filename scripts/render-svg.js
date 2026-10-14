'use strict'
const { lonLatToTileFraction } = require('./tiles')

const TILE = 640
const W = 640
const H = 360

const LANDUSE = { park: '#cfe3b4', forest: '#c3dca8', wood: '#c3dca8', grass: '#d6e8c0', cemetery: '#d6e1c6', residential: '#ece8e1', industrial: '#e3dfdb', hospital: '#f3e0e0', school: '#f0e8d8', university: '#f0e8d8', commercial: '#efe4e0', farmland: '#ebe8d0' }
const ROADS = {
  highway: { w: 5, c: '#f2b65c' },
  major_road: { w: 3.2, c: '#ffffff' },
  minor_road: { w: 1.6, c: '#ffffff' },
  path: { w: 1, c: '#b8a78a', dash: '3,2' },
  rail: { w: 1.2, c: '#8f8f8f', dash: '4,3' },
  other: { w: 1, c: '#e6e0d8' }
}
const LAYERS = ['earth', 'landuse', 'water', 'buildings', 'roads', 'places']

// The pin in tile units from the 2x2 origin. origin.x has wrapped at the antimeridian
// (scripts/tiles.js pinTiles), so a negative x is the pin one world width to the right.
function pinOffset (point, origin, zoom) {
  const f = lonLatToTileFraction(point.lon, point.lat, zoom)
  let x = f.x - origin.x
  if (x < 0) x += 2 ** zoom
  return { x, y: f.y - origin.y }
}

function pathFor (rings, ox, oy, s, close) {
  let d = ''
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      d += (i === 0 ? 'M' : 'L') + (ox + p.x * s).toFixed(1) + ' ' + (oy + p.y * s).toFixed(1)
    }
    if (close) d += 'Z'
  }
  return d
}

function esc (t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function feature (name, f, ox, oy, s) {
  const p = f.properties
  if (name === 'earth' && f.type === 3) return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, true)}" fill="#f4f1ea" fill-rule="evenodd"/>`
  if (name === 'landuse' && f.type === 3) return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, true)}" fill="${LANDUSE[p.kind] || '#e9e5de'}" fill-rule="evenodd"/>`
  if (name === 'water' && f.type === 3) return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, true)}" fill="#a9cce6" fill-rule="evenodd"/>`
  if (name === 'water' && f.type === 2) return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, false)}" fill="none" stroke="#a9cce6" stroke-width="1.5"/>`
  if (name === 'buildings' && f.type === 3) return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, true)}" fill="#dcd3cb" fill-rule="evenodd"/>`
  if (name === 'roads' && f.type === 2) {
    const st = ROADS[p.kind] || ROADS.other
    return `<path d="${pathFor(f.loadGeometry(), ox, oy, s, false)}" fill="none" stroke="${st.c}" stroke-width="${st.w}" stroke-linecap="round" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`
  }
  if (name === 'places' && f.type === 1 && p.name) {
    const pt = f.loadGeometry()[0][0]
    const big = p.kind === 'locality'
    return `<text x="${(ox + pt.x * s).toFixed(1)}" y="${(oy + pt.y * s).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="${big ? 15 : 11}" font-weight="${big ? 'bold' : 'normal'}" fill="#3b3b3b" stroke="#ffffff" stroke-width="3" paint-order="stroke" text-anchor="middle">${esc(p.name)}</text>`
  }
  return ''
}

// tiles: the 4 decoded tiles of a pinTiles 2x2, row-major, null where missing; pin: pinOffset.
// The pin sits in [0.5, 1.5] tile units on both axes (pinTiles), so the 640x360 window centred on it
// stays inside the 2x2 at 640 px per tile.
function renderThumbnail (tiles, pin) {
  let clips = ''
  let body = ''
  for (let i = 0; i < tiles.length; i++) {
    const vt = tiles[i]
    if (!vt) continue
    const ox = (i % 2) * TILE
    const oy = (i >> 1) * TILE
    clips += `<clipPath id="t${i}"><rect x="${ox}" y="${oy}" width="${TILE}" height="${TILE}"/></clipPath>`
    body += `<g clip-path="url(#t${i})">`
    for (const name of LAYERS) {
      const layer = vt.layers[name]
      if (!layer) continue
      const s = TILE / layer.extent
      for (let j = 0; j < layer.length; j++) body += feature(name, layer.feature(j), ox, oy, s)
    }
    body += '</g>'
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#eef0ee"/>` +
    `<defs>${clips}</defs>` +
    `<g transform="translate(${(W / 2 - pin.x * TILE).toFixed(1)} ${(H / 2 - pin.y * TILE).toFixed(1)})">${body}</g>` +
    `<g transform="translate(${W / 2} ${H / 2})">` +
    '<path d="M0 0 L-9 -16 A12 12 0 1 1 9 -16 Z" fill="#e53935" stroke="#ffffff" stroke-width="2"/>' +
    '<circle cx="0" cy="-22" r="4.5" fill="#ffffff"/></g>' +
    `<text x="8" y="${H - 8}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#555" stroke="#fff" stroke-width="3" paint-order="stroke">© OpenStreetMap contributors</text>` +
    '</svg>'
}

module.exports = { TILE, W, H, pinOffset, renderThumbnail }
