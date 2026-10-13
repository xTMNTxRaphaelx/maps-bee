"use strict";
const b4a = require("b4a");

const MAX_LAT = 85.0511;

// NaN masks to tile column 0 and 200 clamps to the last column, both real keys for the wrong place
function lonLatToTile(lon, lat, z) {
  if (
    !(Number.isFinite(lon) && Number.isFinite(lat)) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > MAX_LAT
  ) {
    throw new RangeError(`lon/lat out of range: ${lon}, ${lat}`);
  }
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.min(Math.max(x, 0), n - 1),
    y: Math.min(Math.max(y, 0), n - 1),
  };
}

function quadkey(x, y, z) {
  let q = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    q += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return q;
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

// bbox = [minLon, minLat, maxLon, maxLat]
function* bboxTiles(bbox, z) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
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
  lonLatToTile,
  quadkey,
  zz,
  tileKey,
  parseTileKey,
  bboxTiles,
  subtreeRange,
  parseBbox,
};
