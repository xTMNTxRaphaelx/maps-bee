# maps-bee

**A signed, peer-to-peer map tile store for Keet location previews.**

A Keet location message carries only latitude and longitude. This prototype turns that into a pinned map thumbnail on the viewer's device by fetching a few hundred kilobytes from peers: no map server, no trust in the peer that serves the bytes, nothing fetched on a second open.

| | |
| --- | --- |
| Setup and commands | [docs/SETUP.md](docs/SETUP.md) |
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
                                                       │  readPreview(lat, lon): 2x2 tiles + z15 pin tile + label → address,
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
| neighbourhood, suburb, quarter | places layer points, kind `neighbourhood` (kind_detail neighbourhood, suburb) and `macrohood` (quarter), present in the z14 2x2 already fetched | Tonk Phatak 322 m, Barkat Nagar 470 m, Pratap Nagar 479 m, Bapu Nagar 764 m |
| village | places layer kind `locality` with kind_detail village, in the tiles already fetched; hamlets (population 200) were the wrong label at every distance | Amber 586 m from 26.9855,75.8513; Paradiso 154 m and Massagno 263 m in Lugano |
| city or town | gazetteer, already in the bee | Jaipur (city, 4.6 km) |
| state, country | places layer kinds `region` and `country`, which sit in low-zoom tiles the bee does not hold; z10 tiles near Jaipur carry only locality and macrohood points | z10 scan: locality/city, town, village, macrohood/quarter |
| postcode | nowhere in the Protomaps schema | |
| tehsil, municipal corporation, district | boundaries layer has lines by kind with no names; no admin polygons with names | |

Each part is the nearest matching feature across the z14 (or z10) 2x2 and the z15 pin tile together, within a threshold; roads by point-to-segment distance, places and pois by distance to their label point. Both are measured with one `cheap-ruler` built at the pin's latitude, so every part is on the same ruler: its scale factors are the exact WGS84 degree lengths there, within 0.5 m of a Vincenty geodesic at 3 km.

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

Measured on 20 Jaipur points against Nominatim reverse results (`test/fixtures/jaipur-nominatim.json`, scored by `test/address-accuracy.js`; a neighbourhood or suburb counts as a hit when it equals any of Nominatim's neighbourhood, suburb or quarter; the city when it equals Nominatim's city, town or village, or starts Nominatim's city, or when our village is that locality). Rows, rates and distances: [`results/address-accuracy-jaipur.txt`](results/address-accuracy-jaipur.txt).

| Part | Hits/n | Chosen-part distance range |
| --- | --- | --- |
| road | 5/6 | 2 to 223 m (17 points) |
| neighbourhood | 7/7 | 61 to 716 m (8 points) |
| suburb | 12/12 | 145 to 2495 m (13 points) |
| village | 1/2 | 586 m (1 point) |
| city | 18/19 | 1209 to 15105 m (20 points) |
| house number | 0/0 | none within 30 m |

The road miss: at 26.9196,75.788 the nearest named road is Ram Mandir Road at 123 m and Nominatim gives Station Road, 146 m away; Nominatim picks by polygon, so nearest-line cannot match it. The city and village misses are the same point: at 26.92,75.93 Nominatim gives the village Dyodha Chor; the gazetteer, which holds cities and towns only, gives Jaipur at 11.0 km, and the nearest village or hamlet label in the tiles is Malpura at 1.3 km with Dyodha Chor itself at 2.3 km, so VILLAGE_M leaves the part null rather than wrong.

### Lugano, where the data is dense

Swiss OpenStreetMap carries house numbers and street names on most buildings. At 46.006005,8.952766, six metres off Corso Enrico Pestalozzi, the same rules give `9 Corso Enrico Pestalozzi, Quartiere Maghetti, Lugano`: house number 9 at 16 m, the road at 5 m, the neighbourhood label at 121 m. The next municipality, Massagno, has its village label 987 m away and loses to the nearer neighbourhood, which is why the display takes the nearest area label rather than a fixed order (test/address.js, Lugano test on data/extract/lugano-z11-14.pmtiles and lugano-z15.pmtiles). Scored on 11 Lugano points against Nominatim (`test/fixtures/lugano-nominatim.json`, `test/address-accuracy-lugano.js`, results/address-accuracy-lugano.txt):

| Part | Hits/n | Chosen-part distance range |
| --- | --- | --- |
| road | 7/11 | 1 to 122 m (11 points) |
| neighbourhood | 4/5 | 121 to 737 m (7 points) |
| suburb | 5/7 | 198 to 2557 m (10 points) |
| village | 2/6 | 154 to 606 m (3 points) |
| city | 10/11 | 26 m to 3.2 km (11 points) |
| house number | 3/5 | 9 to 24 m (6 points) |

The road misses are squares and the airport, where Nominatim names a different adjoining way (Piazza della Riforma against piazza Rizziero Rezzonico 10 m away, Piazzale della Stazione against Lugano Stazione). The two house-number misses are the neighbouring building: 10B against 1, 14 against 16, for pins placed between buildings. Paradiso and Massagno are municipalities of their own that OpenStreetMap tags as villages; the city gazetteer keeps cities and towns, so the city part says Lugano there while the village part names them at 154 and 263 m, and the scorer credits the city part when the village is Nominatim's locality. The remaining city miss is Cimo, whose label is 1.1 km from the point. The village misses are Cimo and three central points where Nominatim gives Breganzona as the village and the nearest village label in the tiles is Massagno at 815 to 1,138 m, past VILLAGE_M.

### Zoom 15 on the Jaipur region

`data/extract/jaipur-z15.pmtiles` (docs/SETUP.md) holds zoom 15 over the Jaipur box: 928 entries, 926 distinct contents, every entry runLength 1. So `scripts/planet-build.js`'s run skipping has nothing to skip inside this all-land box; how much filler a planet z15 build would skip is unmeasured.

Address points: in the `buildings` layer, geometry type point, `kind: 'address'`, with `addr_housenumber` as the only address key (no street or postcode in any layer). A central z15 tile holds 0 to 2 of them, and none lies within HOUSE_M of any scored point (results/address-accuracy-jaipur.txt, `rate housenumber 0/0`).

`readPreview` reads the pin's z15 tile in parallel with the 2x2 and the label and returns it as `pinTile` (`{ zoom: 15, x, y, tile }` or null). Cold cost on the test atlas: +2 blocks and about +50 KB (the tile's leaf node and its value block); on a bee without z15 the miss costs +1 block, 13 KB. The thumbnail draws the z15 tile over its z14 quarter. Numbers: [`results/z15-jaipur.txt`](results/z15-jaipur.txt).
