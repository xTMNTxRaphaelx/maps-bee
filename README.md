# maps-bee

**A signed, peer-to-peer map tile store for Keet location previews.**

A Keet location message carries only latitude and longitude. This prototype turns that into a pinned map thumbnail on the viewer's device by fetching a few hundred kilobytes from peers: no map server, no trust in the peer that serves the bytes, nothing fetched on a second open.

| | |
| --- | --- |
| Setup, commands and test stages | [docs/TESTING.md](docs/TESTING.md) |
| Planet build runbook | [docs/PLANET.md](docs/PLANET.md) |
| Measurements | [`results/`](results/) |
| Test app | [`app/`](app/), run with `npm start` |
| Runtime | bare 1.34, hypercore 11, hyperbee2 2.18 |

## How it fits together

```
Protomaps planet build (OpenStreetMap, ODbL)
        │  pmtiles extract: zoom 10 complete, zoom 14 without filler
        │  (the planet bee predates the z15 tier; the test atlas has it)
        ▼
scripts/planet-build.js  ──▶  one hyperbee: <zoom>/<quadkey> → gzip MVT tile
scripts/gazetteer-put.js ──▶  g/10/<quadkey>/<n> → nearest city or town
                         ──▶  a/14/<quadkey>/<n> → neighbourhood, suburb, village
        │  2-of-3 multisig, committed in signed chunks
        ▼
scripts/seed.js on any peer  ◀──── public DHT ────▶  the viewer
                                                       │  readPreview(lat, lon): one 2x2 at the first of
                                                       │  z15, z14, z10 that has tiles, + city and area
                                                       │  labels → address; sparse reads, timeout,
                                                       │  deadline, cancel
                                                       ▼
                                              640 × 360 thumbnail with a pin
```

## Problem

Keet has no server. Whatever the viewer of a shared location sees must come from the message, the viewer's own device, or other peers. Today the viewer gets a deep link to an external map. The target is a static map preview with a pin: a small fetch on first open, free on every later open, from data the viewer can verify.

## Design

- **One hyperbee holds the tiles.** Keys are `<zoom>/<quadkey>`, values are the gzipped Mapbox Vector Tile bytes exactly as Protomaps publishes them. The planet bee holds zoom 10 complete plus zoom 14 without the repeated ocean and empty tiles: 32,888,213 tiles, 36.4 GB on the core.
- **Signed by a 2-of-3 multisig.** The publisher fills a draft session and commits it in signed chunks of 20,000 blocks, because hypercore loads every block of a commit into memory. A republish on the same key keeps warm clients' blocks valid. Clients receive the key and the signed length the way they receive other shared indexes.
- **Read sparsely, never downloaded.** For one point the client fetches one 2x2 of tiles, the ones the pin leans into, chosen from the pin's fractional position inside its tile so a 640 by 360 crop centred on the pin is always covered. It tries zoom 15 first, then 14, then 10, and stops at the first zoom with any of the four: zoom 15 carries the complete road network and the address points, zoom 14 is the tier between — a zoom 15 run is filler in open country, and without 14 such a pin would fall straight to a 35 km view — and zoom 10 is the floor. The walk costs the client nothing beyond the zoom that answers; the tiers below only cost the publisher storage. Every block read has a timeout, the whole call a deadline, and a failed call cancels its own requests.
- **A gazetteer in the same bee** gives the nearest city or town: 111,548 localities from the zoom 10 places layer, under `g/` keys. A second set under `a/` holds the neighbourhood, suburb and village labels, harvested at zoom 13 and read over a tighter window. Area parts come from that radius query rather than from whatever fell inside the fetched tiles: measured over 225 points in four cities, it is worth 20 hits, nearly all suburb (`results/address-shapes.txt`).
- **An optional one-time prefetch** of the top two tree levels, 194 blocks and 1.85 MB, after which every point costs at most 18 blocks.
- **Layout decides the cost.** hyperbee2 inflates a tree node by fetching the origin block of every key the node references, inlines values of 1 KB or less into key blocks, and cuts blocks far above its 4 KiB target. Writing tiles in key order in large batches and turning off value inlining are the two publisher flags that make a cold read cheap.

What the serving peer learns is the cell two zooms above the tiles it served: with the zoom 14 2x2 of the signed test store, the zoom 12 cell, about 9 km across (`results/seeder-sees.txt`). A zoom 15 2x2 would narrow that to the zoom 13 cell, about 4.9 km; no signed store with zoom 15 has been measured.

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
| `docs/` | Setup and commands. |

## Status

Done and measured: the read path, the signed publish, the planet-scale layout, the test app.

Open: where the street address comes from (the tiles give road, neighbourhood, suburb and city with the rates in the Address section, a house number only at zoom 15 within 30 m, no postcode), the production renderer, who seeds the core, and the republish cadence against Protomaps builds. Integration into Keet is a separate spec.

## Data

Tile data comes from Protomaps basemap builds (build.protomaps.com), distributed as an Open Database License produced work of OpenStreetMap: map data © OpenStreetMap contributors, ODbL. No tile data is in this repository.

## Address

`readPreview` derives `address` from the tiles it already reads (`scripts/address.js`); no extra fetch. What the data can and cannot give:

| Address part | Source in the bee | Verified |
| --- | --- | --- |
| house number | z15 buildings layer, `kind=address`, property `addr_housenumber` only; the schema has no street, postcode or unit property | Jaipur z15: 468 points in 928 tiles, 0 to 4 per tile |
| road | roads layer `name` (and `ref`), z15 pin tile has the complete network | pin 26.879464,75.796516: nearest road 11 m is unnamed, nearest named road "Market Road" at 215 m; 11 of 31 roads in the tile are named |
| neighbourhood, suburb, quarter | the `a/` gazetteer, which reaches past the 2x2; failing that, places layer points in the 2x2 itself, kind `neighbourhood` (kind_detail neighbourhood, suburb) and `macrohood` (quarter) | Tonk Phatak 322 m, Barkat Nagar 470 m, Pratap Nagar 479 m, Bapu Nagar 764 m |
| village | places layer kind `locality` with kind_detail village, in the tiles already fetched; hamlets (population 200) were the wrong label at every distance | Amber 586 m from 26.9855,75.8513; Paradiso 154 m and Massagno 263 m in Lugano |
| city or town | gazetteer, already in the bee | Jaipur (city, 4.6 km) |
| state, country | places layer kinds `region` and `country`, which sit in low-zoom tiles the bee does not hold; z10 tiles near Jaipur carry only locality and macrohood points | z10 scan: locality/city, town, village, macrohood/quarter |
| postcode | nowhere in the Protomaps schema | |
| tehsil, municipal corporation, district | boundaries layer has lines by kind with no names; no admin polygons with names | |

Each part is the nearest matching feature within a threshold, across the one 2x2 the walk returned — zoom 15, 14 or 10 — together with the `a/` area labels, which are read by radius and so reach past the tiles; roads by point-to-segment distance, places and pois by distance to their label point. Both are measured with one `cheap-ruler` built at the pin's latitude, so every part is on the same ruler: its scale factors are the exact WGS84 degree lengths there, within 0.5 m of a Vincenty geodesic at 3 km.

```
address: {
  housenumber:   { value, metres } | null,       // buildings kind=address within HOUSE_M (30 m)
  road:          { name, kind, metres } | null,  // named road within ROAD_M (300 m)
  neighbourhood: { name, metres } | null,        // places neighbourhood/neighbourhood within NEIGHBOURHOOD_M (800 m)
  suburb:        { name, metres } | null,        // places neighbourhood/suburb or macrohood within SUBURB_M (3000 m)
  village:       { name, kind, metres } | null,  // places locality/village within VILLAGE_M (700 m); hamlet labels were wrong at every distance
  city:          { name, kind, km } | null,      // the gazetteer label
  region:        null,                           // not in the bee
  country:       null,                           // not in the bee
  near:          { name, kind, metres } | null,  // named poi within NEAR_M (150 m)
  display:       string                          // at most three parts: the house number within HOUSE_M and/or a road within ROAD_ON_M (50 m), else "near <poi>" within NEAR_M; the nearest area label, or the two nearest small-to-large; the city
}
```

`address` is null only outside the atlas, where there is no tile and no label.

Measured on 60 Jaipur points against Nominatim reverse results (`test/fixtures/jaipur-nominatim-wide.json`, scored by `test/address-accuracy.js`; a neighbourhood or suburb counts as a hit when it equals any of Nominatim's neighbourhood, suburb or quarter; the city when it equals Nominatim's city, town or village, or starts Nominatim's city, or when our village is that locality). Rows, rates and distances: [`results/address-accuracy-jaipur.txt`](results/address-accuracy-jaipur.txt).

| Part | Hits/n | Chosen-part distance range |
| --- | --- | --- |
| road | 28/36 | 0 m to 258 m (41 points) |
| neighbourhood | 21/21 | 80 m to 779 m (25 points) |
| suburb | 32/36 | 84 m to 2.6 km (38 points) |
| village | 2/10 | 572 m to 669 m (2 points) |
| city | 48/56 | 876 m to 18.2 km (60 points) |
| house number | 14/16 | 1 m to 25 m (21 points) |

Hits/n counts only the points where Nominatim gave that part to compare against; the distance range covers every point where we produced one, which is why n and the point count differ.

**Village is the weak part, and not for want of recall.** Nominatim names the municipality a point lies inside; we take the nearest village *point*, which is often a neighbour's. No distance cut separates the two — the villages picked right reach 691 m and the ones picked wrong start at 138 m — so `VILLAGE_M` buys hits and errors together. A real fix needs village extent, which the `a/` pass does not keep. Measured over 105 points in [`results/village-gap.txt`](results/village-gap.txt).

### Lugano, where the data is dense

Swiss OpenStreetMap carries house numbers and street names on most buildings. At 46.006005,8.952766, six metres off Corso Enrico Pestalozzi, the same rules give `9 Corso Enrico Pestalozzi, Quartiere Maghetti, Lugano`: house number 9 at 16 m, the road at 5 m, the neighbourhood label at 121 m. The next municipality, Massagno, has its village label 987 m away and loses to the nearer neighbourhood, which is why the display takes the nearest area label rather than a fixed order (test/address.js, Lugano test on data/extract/lugano-z11-14.pmtiles and lugano-z15.pmtiles). Scored on 45 Lugano points against Nominatim (`test/fixtures/lugano-nominatim-wide.json`, `test/address-accuracy-lugano.js`, [`results/address-accuracy-lugano.txt`](results/address-accuracy-lugano.txt)):

| Part | Hits/n | Chosen-part distance range |
| --- | --- | --- |
| road | 36/43 | 1 m to 213 m (42 points) |
| neighbourhood | 3/3 | 85 m to 551 m (4 points) |
| suburb | 4/7 | 330 m to 1.4 km (7 points) |
| village | 22/37 | 56 m to 692 m (28 points) |
| city | 29/44 | 353 m to 9.3 km (45 points) |
| house number | 19/24 | 2 m to 28 m (26 points) |

Dense addressing moves the parts a sparse region cannot exercise: house numbers go from 14/16 on a handful of Jaipur points to 19/24, and the road rate rises with them. The city rate falls instead, because the Lugano box reaches municipalities OpenStreetMap tags as villages — Paradiso, Massagno, Breganzona — where the city gazetteer, holding cities and towns only, answers Lugano. That is the same village-extent limit as above, seen from the city part.

### Zoom 15 on the Jaipur region

`data/extract/jaipur-z15.pmtiles` (docs/TESTING.md) holds zoom 15 over the Jaipur box: 928 entries, 926 distinct contents, every entry runLength 1. So `scripts/planet-build.js`'s run skipping has nothing to skip inside this all-land box; how much filler a planet z15 build would skip is unmeasured.

Address points: in the `buildings` layer, geometry type point, `kind: 'address'`, with `addr_housenumber` as the only address key (no street or postcode in any layer). A central z15 tile holds 0 to 2 of them, and none lies within HOUSE_M of any scored point (results/address-accuracy-jaipur.txt, `rate housenumber 0/0`).

Zoom 15 is the first zoom of the 2x2 walk, so one cell serves the thumbnail and the near address together. It replaced an earlier shape that read a z14 2x2 plus a separate z15 pin tile, measured over 225 points in four cities in [`results/address-shapes.txt`](results/address-shapes.txt): the two are a wash on accuracy, and the z15 cell costs one fewer tile per preview.

The payload table there shows 8 to 42% fewer bytes, and the dated correction at the end of that file says what a real bee did instead — blocks 0.93 to 1.00x, bytes 0.95 to 1.09x over three Jaipur points at two latencies. **The case for zoom 15 is house numbers and the complete road network, not bandwidth.** [`results/z15-jaipur.txt`](results/z15-jaipur.txt) measures the earlier shape, where the z15 pin tile was an addition to a z14 2x2 and cost +2 blocks and about +50 KB.
