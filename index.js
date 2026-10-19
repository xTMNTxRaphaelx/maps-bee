'use strict'
// The client surface: what a consumer needs to turn a lat/lon and a replicated bee into a preview.
// Everything else under scripts/ is publisher-side or a CLI, and is required by path.
const { DETAIL_ZOOM, FALLBACK_ZOOM, LABEL_ZOOM, readPreview, prefetchTop } = require('./scripts/preview')
const { deriveAddress, display } = require('./scripts/address')
const { renderThumbnail, pinOffset } = require('./scripts/render-svg')

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
