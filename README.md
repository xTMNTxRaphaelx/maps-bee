# maps-bee

**Put OpenStreetMap tiles in a signed hyperbee, and read a location preview back out of it.**

The publisher half turns Protomaps basemap archives into one signed hyperbee — tiles under
`<zoom>/<quadkey>`, place labels alongside them — at anything from a city extract to the whole
planet. The client half is `readPreview(bee, point, opts)`: give it a replicated bee and a lat/lon,
get back the tiles covering a thumbnail, the nearest city, and a derived street address, having
fetched a few hundred kilobytes from peers. No map server, no trust in the peer serving the bytes,
nothing fetched on a second open.

**It runs under bare, by design** — the target is keet-core, so the client path takes `bare-zlib`
and does not try to be portable. Runtime: bare 1.34, hypercore 11, hyperbee2 2.18.

[`app/`](app/) is an example consumer, not part of the library — see [`app/README.md`](app/README.md).

```
Protomaps planet build (OpenStreetMap, ODbL)
        │  pmtiles extract
        ▼
bin/planet-build.js  ──▶  one hyperbee: <zoom>/<quadkey> → gzip MVT tile
bin/gazetteer-put.js ──▶  g/10/<quadkey>/<n> → nearest city or town
                         ──▶  a/14/<quadkey>/<n> → neighbourhood, suburb, village
        │  2-of-3 multisig, committed in signed chunks
        ▼
bin/seed.js on any peer  ◀──── DHT ────▶  readPreview → 640 × 360 thumbnail with a pin
```

## Reading from a bee

`index.js` is the whole client surface — the read path and nothing else. `lib/build/` is
publisher-side, `lib/net/` opens and measures a client of its own, and `bin/` holds the CLIs; all
three are reached by path, not from here.

```js
const { readPreview, prefetchTop, renderThumbnail, pinOffset } = require('maps-bee')
const { decodeGzip } = require('maps-bee/lib/mvt')   // not on the surface yet; see below

const point = { lat: 26.9, lon: 75.8 }
const { zoom, origin, tiles, label, address } =
  await readPreview(bee, point, { timeout: 10000, deadline: 30000 })

const svg = renderThumbnail(tiles.map((gz) => gz && decodeGzip(gz)), pinOffset(point, origin, zoom))
```

**`readPreview(bee, point, opts)`** is one call per shared location. It reads the 2x2, the nearest
city and the area labels in parallel, then derives the address from what they return.

| | |
| --- | --- |
| `point` | `{ lat, lon }`; off the globe rejects with `RangeError` rather than reading a real key for the wrong place |
| `opts.timeout` | **required**, ms per block read; a `TypeError` without it |
| `opts.deadline` | optional, ms for the whole call |
| `zoom` | 15, 14 or 10 — whichever tier answered — or `null` outside the atlas |
| `origin` | `{ x, y }`, the tile coordinate of the 2x2's top-left at that zoom |
| `tiles` | four gzipped MVT buffers, row-major from `origin`; a missing one is `null` and drawn blank, all four missing makes the result `null` |
| `label` | `{ name, kind, km }`, the nearest city or town, or `null` |
| `address` | see below, or `null` outside the atlas |

On either timeout it rejects with hypercore's `REQUEST_TIMEOUT` and destroys the requests it
started, so a failed call leaves nothing in flight. The label is best effort — its failure gives
`label: null` rather than rejecting.

`tiles` comes back gzipped and `renderThumbnail` takes decoded tiles, so rendering currently needs
`decodeGzip` from `lib/mvt.js`, which `index.js` does not export. That is a gap in the surface:
`app/ops.js` reaches past `index.js` for the same reason.

| rest of the surface | |
| --- | --- |
| `prefetchTop(bee, levels, opts)` | inflates the top `levels` tree levels so later reads walk them locally; returns `{ nodes }` per level |
| `deriveAddress({ point, tiles, label, areas })`, `display(address)` | the address derivation alone, for tiles already in hand |
| `renderThumbnail(tiles, offset)`, `pinOffset(point, origin, zoom)` | the 640 by 360 SVG thumbnail |
| `DETAIL_ZOOM`, `FALLBACK_ZOOM`, `LABEL_ZOOM` | 15, 10 and 8 |

### address

Each part is the nearest matching feature within a threshold, across the one 2x2 the walk returned,
plus the `a/` labels, which are read by radius and so reach past the tiles. Thresholds are named
constants at the top of `lib/address.js`, which is the source for their values.

```
address: {
  housenumber:   { value, metres } | null,       // buildings kind=address within HOUSE_M, z15 only
  road:          { name, kind, metres } | null,  // named road within ROAD_M
  neighbourhood: { name, metres } | null,        // within NEIGHBOURHOOD_M
  suburb:        { name, metres } | null,        // places neighbourhood/suburb or macrohood within SUBURB_M
  village:       { name, kind, metres } | null,  // places locality/village within VILLAGE_M
  city:          { name, kind, km } | null,      // the g/ gazetteer label
  region:        null,                           // not in the bee: these sit in tiles below z10
  country:       null,
  near:          { name, kind, metres } | null,  // named poi within NEAR_M
  display:       string                          // at most three parts, small to large
}
```

The Protomaps schema has no postcode anywhere and no named admin polygons, so detail stops at the
road. **Village is the weak part:** Nominatim names the municipality a point lies inside, we take
the nearest village *point*, often a neighbour's, and no distance cut separates the two — a real fix
needs village extent, which the `a/` pass does not keep.

## Design

- **One hyperbee holds the tiles.** Values are the gzipped MVT bytes exactly as Protomaps publishes
  them. The planet bee holds zoom 10 complete, plus higher zooms without the repeated ocean and
  empty tiles.
- **Signed by a 2-of-3 multisig,** committed in chunks because hypercore loads every block of a
  commit into memory. A republish on the same key keeps warm clients' blocks valid.
- **Read sparsely, never downloaded.** One 2x2 per point, chosen from the pin's fractional position
  so a 640 by 360 crop centred on it is always covered. It tries z15, then z14, then z10 and stops
  at the first with any of the four — z15 has the complete road network and the address points, z10
  is the floor. Every block read has a timeout, the whole call a deadline, and a failed call cancels
  its own requests.
- **Layout decides the cost.** hyperbee2 inflates a tree node by fetching the origin block of every
  key it references, inlines small values into key blocks, and cuts blocks far above its 4 KiB
  target. Writing tiles in key order in large batches and disabling value inlining are worth an
  order of magnitude on a cold open; a repeat open costs no blocks on any layout.
- **Prefetch one level, not two.** Level 1 is effectively free — its nodes are the root a first
  preview fetches anyway. Level 2 costs megabytes up front and only pays back after many previews in
  one session, so `app/ops.js` ships `PREFETCH_LEVELS = 1`.

What a serving peer learns is the cell two zooms above the tiles it served: with a z14 2x2, about
9 km across; with z15, about 4.9 km.

## Layout

| | |
| --- | --- |
| `index.js` | the client surface, and the only entry point a consumer needs |
| `lib/` | the read path: `tiles.js` and `mvt.js` (pure — quadkeys, MVT decode, no I/O), then `gazetteer-lib.js`, `address.js`, `render-svg.js` and `preview.js` on top |
| `lib/build/` | publisher-side: pmtiles reading, bee building, signing and chunked publish, the planet builder, the gazetteer collector, test-only keys |
| `lib/net/` | `client.js` opens a cold client and measures it; `report.js` formats what it measured; `published.js` opens a published core off disk read-only; `seed.js` serves one |
| `bin/` | one thin `main()` per CLI over the modules above, plus `flags.js` for argument parsing. Nothing in `lib/` requires `bin/` |
| `scripts/study/` | research tooling, not part of the library |
| `test/` | brittle tests mirroring the source layout (`geo/ read/ build/ net/ cli/ app/`, with shared fixtures in `helpers/`), registered in `test/index.js`, run under bare |
| `app/` | an example consumer — [`app/README.md`](app/README.md) |
| `results/` | benchmark and probe output, as the scripts printed it; regenerated, not maintained |

## Quick start

Two minutes and two small downloads: a signed atlas over one Indian state, read back with no network.

```sh
npm install
mkdir -p tools data/extract
cp <path to the pmtiles binary> tools/pmtiles        # github.com/protomaps/go-pmtiles/releases

B=node_modules/bare-runtime/bin/bare

# Protomaps names builds by date and keeps about a week of them, so pick one that still exists
for i in $(seq 0 25); do D=$(date -v-${i}d +%Y%m%d 2>/dev/null || date -d "-$i day" +%Y%m%d); \
  C=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -r 0-1 "https://build.protomaps.com/$D.pmtiles"); \
  case $C in 200|206) S=https://build.protomaps.com/$D.pmtiles; echo "using $D"; break;; esac; done

./tools/pmtiles extract $S data/extract/rajasthan-z10.pmtiles --bbox=69.5,23.0,78.3,30.2 --maxzoom=10
./tools/pmtiles extract $S data/extract/jaipur-z11-14.pmtiles \
  --bbox=75.65,26.75,75.95,27.05 --minzoom=11 --maxzoom=14

$B bin/keys.js keys                              # test-only keys, never committed
$B bin/publish.js store/quickstart keys \
  data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles
$B bin/gazetteer.js data/gazetteer-quickstart.json --kinds=city,town \
  data/extract/rajasthan-z10.pmtiles 69.5,23.0,78.3,30.2 0 10
$B bin/gazetteer-put.js store/quickstart keys draft data/gazetteer-quickstart.json
$B bin/planet-commit.js store/quickstart keys draft    # commits any draft, not just a planet one
```

Every publish and commit ends with a `maps:` line holding the key and the signed length — that is
the only place a usable key comes from. Read a point out of the atlas with it:

```sh
$B bin/local-check.js store/quickstart <key from the maps line> 26.9,75.8
```

```
26.9,75.8	zoom 14	tiles 4/4	label Jaipur (city, 2.6 km)	address Kachi Basti, Sudarshanpura, Jaipur
```

## Testing

```sh
npm test        # the whole suite under bare
npm run lint    # lunte, silent when it passes
```

The suite runs two ways on purpose. With `data/` absent — what a clean clone and CI see —
`test/index.js` preflights the fixture paths and skips the data-dependent modules, ending with one
`data fixtures are present # SKIP` line and the missing paths on stderr. With the fixtures present
the whole suite runs. Either way the gate is a zero exit, zero `not ok`, and a summary line that is
actually printed; a `SIGABRT` or no summary at all means the preflight does not hold.

### Fixtures

The fixtures are seven `pmtiles extract` cuts (~28 MB) plus a publish and four gazetteer passes —
the commands are in `test/helpers/helpers.js`'s path list order, and `$S` is a live build found as
in the quick start:

```sh
./tools/pmtiles extract $S data/extract/rajasthan-z10.pmtiles --bbox=69.5,23.0,78.3,30.2 --maxzoom=10
./tools/pmtiles extract $S data/extract/jaipur-z11-14.pmtiles --bbox=75.65,26.75,75.95,27.05 --minzoom=11 --maxzoom=14
./tools/pmtiles extract $S data/extract/jaipur-z15.pmtiles --bbox=75.65,26.75,75.95,27.05 --minzoom=15 --maxzoom=15
./tools/pmtiles extract $S data/extract/lugano-z11-14.pmtiles --bbox=8.85,45.95,9.05,46.06 --minzoom=11 --maxzoom=14
./tools/pmtiles extract $S data/extract/lugano-z15.pmtiles --bbox=8.85,45.95,9.05,46.06 --minzoom=15 --maxzoom=15
./tools/pmtiles extract $S data/extract/lugano-z10.pmtiles --bbox=8.85,45.95,9.05,46.06 --maxzoom=10
./tools/pmtiles extract $S data/extract/atlantic-z10.pmtiles --bbox=-30,27,-13,30 --minzoom=10 --maxzoom=10

B=node_modules/bare-runtime/bin/bare
$B bin/keys.js keys
$B bin/publish.js store/signed keys data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles
$B bin/gazetteer.js data/gazetteer.json data/extract/rajasthan-z10.pmtiles 69.5,23.0,78.3,30.2 0 10 \
  data/extract/jaipur-z11-14.pmtiles 75.65,26.75,75.95,27.05 11 14
$B bin/gazetteer.js data/gazetteer-lugano.json --kinds=city,town data/extract/lugano-z10.pmtiles 8.85,45.95,9.05,46.06 0 10
$B bin/gazetteer.js data/areas.json --areas data/extract/jaipur-z11-14.pmtiles 75.55,26.65,76.05,27.15 13 13
$B bin/gazetteer.js data/areas-lugano.json --areas data/extract/lugano-z11-14.pmtiles 8.75,45.85,9.15,46.16 13 13
```

**The `--areas` passes harvest with a wider bbox than the extract on purpose:** an area gazetteer
must cover a margin around the region it serves, or a pin near the edge takes the nearest label that
survived the clip rather than the true nearest.

`test/read/address-accuracy.js` and `test/read/address-accuracy-lugano.js` print a rate per address part. Note
the Protomaps build alongside any rate you keep — the fixture is fixed but the tiles come from a
build that rotates weekly, so a rate change across builds says nothing about the code.

`keys/`, `store/`, `data/` and `tools/` are gitignored and populated only locally.

### Seed and probe

```sh
$B bin/seed.js store/planet <key>                      # terminal A
$B bin/probe.js --levels=1 <key> 26.9,75.8 51.5,-0.12  # terminal B
```

`--levels=N` on `probe.js` inflates the top N tree levels before the first read, as an app
shipping them would; `app/README.md` has the measurement behind the level it picks. Both commands
take `--bootstrap=host:port,...` for a private DHT.

`bin/local-check.js` runs the same read path with no swarm at all, so run it first whenever a
probe comes back empty — a sound atlas behind a blocked DHT stops looking like a broken build. Its
`--json` also dumps the whole address object, which is what separates "nothing was found" from
"something was found and `display()` dropped it": a road beyond `ROAD_ON_M` stays in the object and
out of the string, so a pin that is not on a street shows the city alone and looks empty.
`bin/testnet.js` prints a `--bootstrap=` line that puts both commands on a private DHT. If a
seeder survives Ctrl-C, the launcher did not forward SIGINT: `pkill -INT -f bin/seed.js`.

**A probe over the swarm may serve nothing, and it is not known to be this repo's fault.** On a
clean run the seeder has served none of three sequential probes and logged no peer, while the client
reported `connections 1` naming that seeder's own key. A plain hyperswarm server on the same
discovery key does fire its handler, and `test/net/seed-probe.js` — testnet, seeder and client in one
process — passes on every suite run. A client holding a connection the server does not have points
at the transport, and this has only ever run in a sandboxed Linux ARM64 container where UDX
holepunching is the likeliest thing to break. **Next step is real hardware**, not more debugging
here; until then do not read a failing probe as a broken atlas.

## Building the planet bee

Zoom 10 complete, zoom 14 without filler, zoom 15 in quadrants, plus the `g/` and `a/` gazetteers.
Budget a day and a couple of hundred gigabytes, nearly all of it `pmtiles extract`. A z14-topped
atlas works — `preview.js` stops at the first tier that answers — it just cannot serve house numbers.

**The constraint that shapes all of this:** `--sorted` packs each tile into one 64-bit slot with 26
bits for the entry index, so one archive must hold fewer than `MAX_SORTED_ENTRIES` = 2^26 =
67,108,864 entries. Planet z15 is far above that, hence quadrants — and two things follow, both
silent failures rather than loud ones:

1. **One `--sorted` invocation per quadrant.** `checkZoomOrder` rejects two archives sharing a zoom,
   so all four in one command throws on the second. Separate runs append to the same named draft.
2. **Feed them in ascending key order: NW, NE, SW, SE** (quadkey digits `0123`, and
   `10/ < 14/ < 15/ < a/ < g/` as strings). Out-of-order puts still build a correct bee, but cost
   the layout that makes a cold read cheap — the whole point of `--sorted`.

| quadrant | bbox | order |
| --- | --- | ---: |
| NW | `-179.995,0.005,-0.005,85.0511` | 1 |
| NE | `0.005,0.005,179.995,85.0511` | 2 |
| SW | `-179.995,-85.0511,-0.005,-0.005` | 3 |
| SE | `0.005,-85.0511,179.995,-0.005` | 4 |

Cut inside the meridian, equator and antimeridian so two quadrants never share a tile column or row:
`pmtiles extract` rounds a bbox out to whole tiles, and an overlap puts the same keys twice and
breaks the ascending order. **0.005°, not 0.0001°** — 0.0001° sits 0.45% inside the edge tile and
rounds across anyway, which once duplicated a whole tile line. A quadrant is right when
`addressed tiles count` is exactly 268,435,456 = 2^28.

```sh
./tools/pmtiles extract $S data/planet-z10.pmtiles --minzoom=10 --maxzoom=10

# once per quadrant, at z14 and z15; the retry loop is not optional on a home link. NW is shown;
# the other three bboxes follow from the cutting rule above.
until ./tools/pmtiles extract $S data/planet-z14-nw.pmtiles --bbox=-179.995,0.005,-0.005,85.0511 \
  --minzoom=14 --maxzoom=14 --download-threads=8 --overfetch=0.2; do echo "retrying in 30s"; sleep 30; done
until ./tools/pmtiles extract $S data/planet-z15-nw.pmtiles --bbox=-179.995,0.005,-0.005,85.0511 \
  --minzoom=15 --maxzoom=15 --download-threads=8 --overfetch=0.2; do echo "retrying in 30s"; sleep 30; done

$B bin/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 data/planet-z10.pmtiles
# then one run per quadrant, NW NE SW SE, same store and same draft name

# a/ before g/, because a/ sorts first. One invocation over all four z14 quadrants, not four runs:
# the dedupe is shared across the sources of a single pass, so splitting it would keep a name once
# per quadrant. The bbox stays the whole world on each, the margin the --areas note below explains.
$B bin/gazetteer.js data/planet-areas.json --areas \
  data/planet-z14-nw.pmtiles -180,-85.05,180,85.05 14 14 \
  data/planet-z14-ne.pmtiles -180,-85.05,180,85.05 14 14 \
  data/planet-z14-sw.pmtiles -180,-85.05,180,85.05 14 14 \
  data/planet-z14-se.pmtiles -180,-85.05,180,85.05 14 14
$B bin/gazetteer-put.js --inline-value-size=0 --areas store/planet keys atlas data/planet-areas.json
$B bin/gazetteer.js data/planet-gazetteer.json --kinds=city,town data/planet-z10.pmtiles -180,-85.05,180,85.05 10 10
$B bin/gazetteer-put.js --inline-value-size=0 store/planet keys atlas data/planet-gazetteer.json

$B bin/planet-commit.js store/planet keys atlas 20000   # chunk size: an unchunked planet commit
                                                            # dies at the 4 GB V8 heap
$B bin/local-check.js store/planet <key> 26.9,75.8 46.0037,8.9511 40.7128,-74.006 -33.8688,151.2093
```

`--download-threads=8` is the setting that finished: 4 never gets reset but its tail does not
converge, 16 gets reset. `pmtiles extract` neither resumes nor retries, so one reset discards the
whole transfer. **A diverging tail shows as the ETA growing**, not as the rate collapsing — the rate
collapses near the end of every healthy run. Give a tail 20 minutes, then kill it and let the loop
restart; a sorted run cannot `--resume`, but re-running its command unchanged is safe, since a put
matching what is stored appends no block.

**Check coverage by conservation, not by summing entries.** Every tile of a zoom is either put or
counted as filler, so `puts + fillerTiles` summed across the quadrant runs must equal `4^zoom` —
268,435,456 at z14, 1,073,741,824 at z15. Summing `tile entries count` does *not* work: splitting by
bbox cuts run-length entries in two, so quadrants legitimately report more entries than the whole
zoom, and that surplus masks a real overlap.

Each run prints `draft atlas length N` — N must grow each time, or the earlier work is not in this
draft. A probe at a dense point should come back at zoom 15 once z15 is in; if it says 14, that
quadrant did not make it into the draft.

This build is also the only exercise of the production flush defaults (every test overrides
`FLUSH_PUTS` and `FLUSH_BYTES`, so run one archive without the flags), of short-read detection
(`readValues` throws rather than writing blank tiles under a signature, and must never fire on a
good archive), and of handle cleanup (Ctrl-C partway through should not leave the store locked).

## Status

Done: the read path, the signed publish, the planet-scale layout, the example app. Open: where the
street address comes from, the production renderer, who seeds the core, the republish cadence
against Protomaps builds, and the zoom 15 tier of the planet build. Integration into Keet is a
separate spec.

Tile data comes from Protomaps basemap builds (build.protomaps.com), an Open Database License
produced work of OpenStreetMap: map data © OpenStreetMap contributors, ODbL. No tile data is in this
repository.
