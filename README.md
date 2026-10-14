# maps-bee

**A signed, peer-to-peer map tile store for Keet location previews.**

A Keet location message carries only latitude and longitude. This prototype turns that into a pinned map thumbnail on the viewer's device by fetching a few hundred kilobytes from peers: no map server, no trust in the peer that serves the bytes, nothing fetched on a second open.

| | |
| --- | --- |
| Setup and commands | [SETUP.md](SETUP.md) |
| Measurements | [`results/`](results/) |
| Test app | [`app/`](app/), run with `npm start` |
| Runtime | bare 1.34, hypercore 11, hyperbee2 2.18 |

## How it fits together

```
Protomaps planet build (OpenStreetMap, ODbL)
        │  pmtiles extract: zoom 10 complete, zoom 14 without filler
        ▼
scripts/planet-build.js  ──▶  one hyperbee: <zoom>/<quadkey> → gzip MVT tile
scripts/gazetteer-put.js ──▶  g/10/<quadkey>/<n> → nearest city or town
        │  2-of-3 multisig, committed in signed chunks
        ▼
scripts/seed.js on any peer  ◀──── public DHT ────▶  the viewer
                                                       │  readPreview(lat, lon): 2x2 tiles + label,
                                                       │  sparse reads, timeout, deadline, cancel
                                                       ▼
                                              640 × 360 thumbnail with a pin
```

## Problem

Keet has no server. Whatever the viewer of a shared location sees must come from the message, the viewer's own device, or other peers. Today the viewer gets a deep link to an external map. The target is a static map preview with a pin: a small fetch on first open, free on every later open, from data the viewer can verify.

## Design

- **One hyperbee holds the tiles.** Keys are `<zoom>/<quadkey>`, values are the gzipped Mapbox Vector Tile bytes exactly as Protomaps publishes them. The planet bee holds zoom 10 complete plus zoom 14 without the repeated ocean and empty tiles: 32,888,213 tiles, 36.4 GB on the core.
- **Signed by a 2-of-3 multisig.** The publisher fills a draft session and commits it in signed chunks of 20,000 blocks, because hypercore loads every block of a commit into memory. A republish on the same key keeps warm clients' blocks valid. Clients receive the key and the signed length the way they receive other shared indexes.
- **Read sparsely, never downloaded.** For one point the client fetches the 2x2 of zoom 14 tiles the pin leans into, chosen from the pin's fractional position inside its tile, so a 640 by 360 crop centred on the pin is always covered. If all four are absent it falls back to the zoom 10 2x2. Every block read has a timeout, the whole call a deadline, and a failed call cancels its own requests.
- **A gazetteer in the same bee** gives the nearest city or town: 111,548 localities from the zoom 10 places layer. It is a label, not an address.
- **An optional one-time prefetch** of the top two tree levels, 194 blocks and 1.85 MB, after which every point costs at most 18 blocks.
- **Layout decides the cost.** hyperbee2 inflates a tree node by fetching the origin block of every key the node references, inlines values of 1 KB or less into key blocks, and cuts blocks far above its 4 KiB target. Writing tiles in key order in large batches and turning off value inlining are the two publisher flags that make a cold read cheap.

What the serving peer learns is the zoom 12 cell the viewer asked about, about 9 km across.

## Measured

Cold first open from a fresh client over the public DHT, 2x2 plus label, as blocks / bytes. Repeat opens cost 0 blocks on every layout.

| Point | Baseline layout | Key order, no inlining | After the level-2 prefetch |
| --- | ---: | ---: | ---: |
| Jaipur | 266 / 10.16 MB | 60 / 0.69 MB | 13 / 0.18 MB |
| London | 132 / 4.40 MB | 29 / 0.54 MB | 18 / 0.44 MB |
| New York | 19 / 0.44 MB | 16 / 0.41 MB | 16 / 0.41 MB |
| Open ocean, zoom 10 | 264 / 9.41 MB | 26 / 0.16 MB | 13 / 0.07 MB |

| Measurement | File |
| --- | --- |
| Baseline layout, 2x2 unit | `results/planet-probe-2x2.txt` |
| Key order only, no inlining only | `results/planet-c1-sorted.txt`, `results/planet-c2-noinline.txt` |
| Both flags, the publisher path | `results/planet-c12-sorted-noinline.txt` |
| Test app on the seeding host | `results/pear-smoke.txt` |
| Fetch unit, second publish, what a seeder sees, filler tiles | `results/cell-2x2.txt`, `results/second-publish.txt`, `results/seeder-sees.txt`, `results/planet-filler.txt` |

## Layout

| Directory | Holds |
| --- | --- |
| `scripts/` | The prototype: tiles and quadkeys, pmtiles reading, bee building, signing and chunked publish, the planet builder, the gazetteer, `preview.js` (the client read), seed and probe, the SVG thumbnail renderer. |
| `test/` | brittle tests, registered in `test/index.js`, run under bare. |
| `app/` | The Electron test app: a bare worker over pear-runtime calls the real `readPreview`; the window shows the thumbnail and logs probe-format lines. |
| `results/` | Every measurement quoted anywhere, as the scripts printed it. |

## Status

Done and measured: the read path, the signed publish, the planet-scale layout, the test app.

Open: where the street address comes from (the tiles cannot yield one; the sender's geocoder or a second dataset can), the production renderer, who seeds the core, and the republish cadence against Protomaps builds. Integration into Keet is a separate spec.

## Data

Tile data comes from Protomaps basemap builds (build.protomaps.com), distributed as an Open Database License produced work of OpenStreetMap: map data © OpenStreetMap contributors, ODbL. No tile data is in this repository.
