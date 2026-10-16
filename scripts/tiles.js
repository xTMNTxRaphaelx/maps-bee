"use strict";
const b4a = require("b4a");

const MAX_LAT = 85.05112877980659;

// NaN masks to tile column 0 and 200 clamps to the last column, both real keys for the wrong place
function lonLatToTileFraction(lon, lat, z) {
  if (
    !(Number.isFinite(lon) && Number.isFinite(lat)) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > MAX_LAT
  ) {
    throw new RangeError(`lon/lat out of range: ${lon}, ${lat}`);
  }
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const f = lonLatToTileFraction(lon, lat, z);
  return {
    x: Math.min(Math.max(Math.floor(f.x), 0), n - 1),
    y: Math.min(Math.max(Math.floor(f.y), 0), n - 1),
  };
}

// The pin's tile plus the neighbours on the side it leans to, so a view centred on the pin never
// runs off the tiles. Row-major from the top-left (origin); x wraps at the antimeridian, and a row
// outside 0..n-1 has no tiles, so its slots are null and origin.y is -1 above row 0.
function pinTiles(lon, lat, z) {
  const n = 2 ** z;
  const f = lonLatToTileFraction(lon, lat, z);
  const { x, y } = lonLatToTile(lon, lat, z);
  const left = f.x - x < 0.5 ? x - 1 : x;
  const top = f.y - y < 0.5 ? y - 1 : y;
  const tiles = [];
  for (const ty of [top, top + 1]) {
    for (const tx of [left, left + 1]) {
      tiles.push(ty < 0 || ty >= n ? null : [(tx + n) % n, ty]);
    }
  }
  return { origin: { x: (left + n) % n, y: top }, tiles };
}

function quadkey(x, y, z) {
  let q = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    q += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return q;
}

// the quadkey as a number: x bits in the even places, y bits in the odd; arithmetic instead of
// bit operators so z up to 26 stays exact in a double
function mortonCode(x, y, z) {
  let m = 0;
  for (let i = z - 1; i >= 0; i--) {
    m = m * 4 + ((x >> i) & 1) + 2 * ((y >> i) & 1);
  }
  return m;
}

function mortonToXY(m, z) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < z; i++) {
    const d = m % 4;
    m = Math.floor(m / 4);
    x |= (d & 1) << i;
    y |= (d >> 1) << i;
  }
  return { x, y };
}

function zz(z) {
  return String(z).padStart(2, "0");
}

function tileKey(z, x, y) {
  return b4a.from(zz(z) + "/" + quadkey(x, y, z));
}

function parseTileKey(key) {
  const [zs, q] = b4a.toString(key).split("/");
  let x = 0;
  let y = 0;
  for (let i = 0; i < q.length; i++) {
    const d = Number(q[i]);
    x = (x << 1) | (d & 1);
    y = (y << 1) | (d >> 1);
  }
  return { z: Number(zs), x, y };
}

// bbox = [minLon, minLat, maxLon, maxLat]. An inverted bbox spans an empty range and selects no
// tiles, which reads as an archive with none; a bbox crossing the antimeridian is inverted in lon
// and is not supported.
function assertBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (minLon > maxLon || minLat > maxLat) {
    throw new RangeError(`bbox is inverted: ${bbox.join(",")}`);
  }
}

function* bboxTiles(bbox, z) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  assertBbox(bbox);
  const tl = lonLatToTile(minLon, maxLat, z);
  const br = lonLatToTile(maxLon, minLat, z);
  for (let y = tl.y; y <= br.y; y++) {
    for (let x = tl.x; x <= br.x; x++) yield { x, y };
  }
}

// quadkey digits are 0-3, so '4' sorts after every descendant of the parent
function subtreeRange(z, parentQuadkey, prefix = "") {
  const p = prefix + zz(z) + "/" + parentQuadkey;
  return { gte: b4a.from(p), lt: b4a.from(p + "4") };
}

function parseBbox(s) {
  return s.split(",").map(Number);
}

module.exports = {
  lonLatToTileFraction,
  lonLatToTile,
  pinTiles,
  quadkey,
  mortonCode,
  mortonToXY,
  zz,
  tileKey,
  parseTileKey,
  assertBbox,
  bboxTiles,
  subtreeRange,
  parseBbox,
};
