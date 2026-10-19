'use strict'
// How a probe run reads on a terminal. Pure formatting over the shapes readPreview and timed
// return — no store, no swarm, no clock — so the line formats are asserted directly in
// test/net/report.js rather than inferred from a live run.

function tilesPresent (value) {
  return value.tiles ? value.tiles.filter(Boolean).length : 0
}

function labelText (label) {
  return label ? `${label.name} (${label.kind}, ${label.km.toFixed(1)} km)` : 'null'
}

function connectLine (connectMs, upd, core) {
  return `connect ms ${Math.round(connectMs * 10) / 10}\tupdate ms ${upd.ms} blocks ${upd.blocks} bytes ${upd.bytes}\tcore.length ${core.length}`
}

function prefetchLine (levels, prefetch) {
  return `prefetch levels ${levels} nodes ${prefetch.value.nodes.join('/')}\tms ${prefetch.ms}\tblocks ${prefetch.blocks}\tbytes ${prefetch.bytes}`
}

function previewLine (phase, point, r) {
  return `${phase}\t${point.lat},${point.lon}\tms ${r.ms}\tblocks ${r.blocks}\tbytes ${r.bytes}\tzoom ${r.value.zoom}\ttiles ${tilesPresent(r.value)}/4\tlabel ${labelText(r.value.label)}\taddress ${r.value.address ? r.value.address.display : 'null'}`
}

module.exports = { tilesPresent, labelText, connectLine, prefetchLine, previewLine }
