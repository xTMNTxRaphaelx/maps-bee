# Setup

Everything runs under bare from `node_modules/bare-runtime/bin/bare`. npm and node are needed only to install packages and to host the Electron test app.

## Requirements

| Tool | Why | Where |
| --- | --- | --- |
| node and npm | install packages, run Electron | any current release |
| pmtiles binary | cut extracts from the Protomaps planet build | https://github.com/protomaps/go-pmtiles/releases, copied to `tools/pmtiles` |
| disk | the test atlas needs under 100 MB of extracts and stores; the planet bee needs 35 GB of extracts plus 35 GB of store | |

## Quick start: test atlas and suite

About two minutes end to end, including seven small downloads totalling about 28 MB.

```sh
npm install
mkdir -p tools data/extract results
cp <path to the pmtiles binary> tools/pmtiles
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/rajasthan-z10.pmtiles --bbox=69.5,23.0,78.3,30.2 --maxzoom=10
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/jaipur-z11-14.pmtiles --bbox=75.65,26.75,75.95,27.05 --minzoom=11 --maxzoom=14
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/jaipur-z15.pmtiles --bbox=75.65,26.75,75.95,27.05 --minzoom=15 --maxzoom=15
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/lugano-z11-14.pmtiles --bbox=8.85,45.95,9.05,46.06 --minzoom=11 --maxzoom=14
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/lugano-z15.pmtiles --bbox=8.85,45.95,9.05,46.06 --minzoom=15 --maxzoom=15
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/lugano-z10.pmtiles --bbox=8.85,45.95,9.05,46.06 --maxzoom=10
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/atlantic-z10.pmtiles --bbox=-30,27,-13,30 --minzoom=10 --maxzoom=10
B=node_modules/bare-runtime/bin/bare
$B scripts/keys.js keys
$B scripts/build-bee.js store/single data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles | tee results/build-bee.txt
$B scripts/publish.js store/signed keys data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles | tee results/publish.txt
$B scripts/gazetteer.js data/gazetteer.json data/extract/rajasthan-z10.pmtiles 69.5,23.0,78.3,30.2 0 10 data/extract/jaipur-z11-14.pmtiles 75.65,26.75,75.95,27.05 11 14 | tee results/gazetteer.txt
$B scripts/gazetteer.js data/gazetteer-lugano.json --kinds=city,town data/extract/lugano-z10.pmtiles 8.85,45.95,9.05,46.06 0 10
npm test
PATH=node_modules/bare-runtime/bin:$PATH npx brittle-bare test/address-accuracy.js > results/address-accuracy-jaipur.txt
PATH=node_modules/bare-runtime/bin:$PATH npx brittle-bare test/address-accuracy-lugano.js > results/address-accuracy-lugano.txt
```

Expected tail of `npm test`:

```
# tests = 77/77 pass
# asserts = 713/713 pass
# ok
```

Notes:

- The Jaipur zoom 15 extract is 2.8 MB and cuts in seconds; only the z15 tests (`test/address.js`, `test/z15.js`, `test/address-accuracy.js`, `test/render-svg.js`) read it.
- The Atlantic extract is cut straight from the remote build, so the quick start needs nothing from the planet section. It is zoom 10 over open ocean, and `test/planet-build.js` asserts its exact `addressed tiles count: 550` — check that with `./tools/pmtiles show` if that test fails.
- `test/index.js` preflights all ten fixture paths and skips the data-dependent suite with one `# SKIP` line if any is absent, so a partial run of this section fails loudly rather than aborting the process.
- The setup rewrites `results/build-bee.txt`, `results/publish.txt` and `results/gazetteer.txt` for your own keys and store, so expect those three to show as modified. They are measurement logs, not test input — restore them with `git checkout -- results/` and nothing breaks.
- The sparse tests derive the published key from `keys/` (the same manifest `scripts/publish.js` publishes under) and open `store/signed`; the gazetteer and preview tests read `data/gazetteer.json`.
- `keys/` holds test-only keys and is never committed.

## Planet bee

zoom 10 complete plus zoom 14 without filler runs, then sign, seed and probe.

| Step | Time | Disk |
| --- | ---: | ---: |
| zoom 10 extract | minutes | 2.2 GB |
| zoom 14 extract | about 2.5 h | 31 GB |
| build, publisher flags | about 7 min | 35 GB store |
| gazetteer pass over zoom 10 | about 2 min | 12 MB |
| signed commit | about 2 min | |

```sh
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/planet-z10.pmtiles --minzoom=10 --maxzoom=10
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/planet-z14.pmtiles --minzoom=14 --maxzoom=14
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 --inline-value-size=0 store/planet keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # publisher path, into an empty store dir: key-order puts, no value inlined with its key, no --resume
$B scripts/gazetteer.js data/planet-gazetteer.json --kinds=city,town data/planet-z10.pmtiles -180,-85.05,180,85.05 10 10 | tee results/planet-gazetteer.txt
$B scripts/gazetteer-put.js --inline-value-size=0 store/planet keys atlas data/planet-gazetteer.json   # g/ keys after the tiles, before the commit; --inline-value-size=N as in planet-build.js
$B scripts/planet-commit.js store/planet keys atlas   # optional 4th arg: blocks per signed commit, default 20000; resumable
$B scripts/seed.js store/planet <key from the maps line>
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12
$B scripts/probe.js --levels=2 <key> 26.9,75.8 51.5,-0.12   # prefetch the top N tree levels first, then read
```

The build logs `done puts 32888213 bytes 35221625742` for build 20261012; the commit ends with a `maps:` line holding the key and the signed length.

### Experiments behind the publisher flags

Recorded in `results/planet-c1-sorted.txt`, `results/planet-c2-noinline.txt` and `results/planet-c12-sorted-noinline.txt`.

```sh
$B scripts/planet-build.js store/planet keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # directory-walk order, add --resume after an interruption
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 store/planet-c1 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # key-order puts only
$B scripts/planet-build.js --inline-value-size=0 store/planet-c2 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # no inlined values only
```

## Test app

An Electron window over a bare worker (pear-runtime) that reads previews from the planet bee over the public DHT with `scripts/preview.js`, draws the 2x2 as a 640 by 360 thumbnail with a pin, and logs the probe lines. The renderer and Electron main only relay; every read runs in the bare worker (`app/worker.js`, `app/ops.js`).

```sh
npm install
node node_modules/electron/install.js   # only when npm has ignore-scripts=true, which skips the Electron binary download
npm start
```

In the window: keep the default key, pick a preset or type a point, tick prefetch or not, click Run. One client per key stays open while the window is open, and its store under `store/tmp/probe-*` is removed on quit.

The log lines match `scripts/probe.js`:

```
connect ms N	update ms N blocks N bytes N	core.length N             # once per key
prefetch levels 2 nodes A/B	ms N	blocks N	bytes N                 # once per key, when the box is ticked
cold|repeat	<lat>,<lon>	ms N	blocks N	bytes N	zoom Z	tiles P/4	label <name> (<kind>, <km> km)|null	address <display>|null
```

## Test window with an outside tester

**Seeder**, kept running with its terminal open for the agreed window; it prints a stats line every 10 s:

```sh
$B scripts/seed.js store/planet-c12 q6psfy7rzwm4hbsc9r81jans53ympcb3r88w83cc4e91dyeyqcoo
```

Stop it with Ctrl-C, or `pkill -INT -f scripts/seed.js` from another terminal, since the `node_modules/bare-runtime/bin/bare` launcher does not forward SIGINT. It prints `stopping: ...` on the way out.

**Tester:**

```sh
git clone https://github.com/xTMNTxRaphaelx/maps-bee && cd maps-bee
npm install
node node_modules/electron/install.js   # when npm has ignore-scripts
npm start
```

In the window keep the default key, tick prefetch or not, click each preset then Run, click Run a second time on Jaipur for the repeat line, try one free lat/lon, then click Copy log.

**Results** go in `results/pear-test-window.txt`:

```
# pear test window YYYY-MM-DD, tester <name>, seeder store/planet-c12 on <host>, prefetch on|off, app <git short sha>

## session 1
<the copied log, verbatim>
```

One `## session N` heading per app launch.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm start` says Electron failed to install | `~/.npmrc` has `ignore-scripts=true` | `node node_modules/electron/install.js` |
| `pmtiles extract data/planet-z10.pmtiles ...` fails in the planet section | the planet zoom 10 file is not there yet | run the first line of that section first |
| `npm test` ends at `# tests = 32/32` with a `data fixtures are present # SKIP` line | one or more of the ten fixtures is missing; the names are printed on stderr | finish the quick start section |
| a seeder keeps running after Ctrl-C in another terminal | the launcher ignores SIGINT; the real bare child must get it | `pkill -INT -f scripts/seed.js` |
| the app's Run never returns | no seeder is online for that key | start the seeder, then Run again |
| three `results/` files show as modified | the setup regenerates them for your keys | expected; do not commit them, `git checkout -- results/` to drop them |
