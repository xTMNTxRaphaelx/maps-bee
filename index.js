'use strict'
// The client surface: what a consumer needs to turn a lat/lon and a replicated bee into a preview.
// It is the read path only. lib/build/ is publisher-side, lib/net/ opens and measures a client of
// its own, and bin/ is the CLIs; all three are reached by path, not from here.
const { DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM, readPreview, prefetchTop } = require('./lib/preview')
const { deriveAddress, display } = require('./lib/address')
const { renderThumbnail, pinOffset } = require('./lib/render-svg')

module.exports = {
  DETAIL_ZOOM,
  FALLBACK_ZOOM,
  LABEL_ZOOM,
  readPreview,
  prefetchTop,
  deriveAddress,
  display,
  renderThumbnail,
  pinOffset
}
