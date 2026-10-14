# maps-bee

Setup and run commands. Everything runs under bare.

```
npm install
mkdir -p tools data/extract results
cp <path to the pmtiles binary> tools/pmtiles
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/rajasthan-z10.pmtiles --bbox=69.5,23.0,78.3,30.2 --maxzoom=10
./tools/pmtiles extract https://build.protomaps.com/20261012.pmtiles data/extract/jaipur-z11-14.pmtiles --bbox=75.65,26.75,75.95,27.05 --minzoom=11 --maxzoom=14
B=node_modules/bare-runtime/bin/bare
$B scripts/keys.js keys
$B scripts/build-bee.js store/single data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles | tee results/build-bee.txt
$B scripts/publish.js store/signed keys data/extract/rajasthan-z10.pmtiles data/extract/jaipur-z11-14.pmtiles | tee results/publish.txt
./tools/pmtiles extract data/planet-z10.pmtiles data/extract/atlantic-z10.pmtiles --bbox=-30,27,-13,30 --minzoom=10 --maxzoom=10
$B scripts/gazetteer.js data/gazetteer.json data/extract/rajasthan-z10.pmtiles 69.5,23.0,78.3,30.2 0 10 data/extract/jaipur-z11-14.pmtiles 75.65,26.75,75.95,27.05 11 14 | tee results/gazetteer.txt
npm test
```

Planet build, z10 complete plus z14 without filler runs, then sign, seed and probe:

```
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

The measured experiments behind that build line (results/planet-c1-sorted.txt, results/planet-c2-noinline.txt, results/planet-c12-sorted-noinline.txt):

```
$B scripts/planet-build.js store/planet keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # directory-walk order, add --resume after an interruption
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 store/planet-c1 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # key-order puts only
$B scripts/planet-build.js --inline-value-size=0 store/planet-c2 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # no inlined values only
```

Running the setup rewrites `results/build-bee.txt`, `results/publish.txt` and `results/gazetteer.txt` for your own keys and store, so expect those three to show as modified. The sparse tests read the published key from `results/publish.txt` and open `store/signed`; the gazetteer and preview tests read `data/gazetteer.json`. `keys/` holds test-only keys and is never committed.

Tile data comes from Protomaps basemap builds (build.protomaps.com), distributed as an Open Database License produced work of OpenStreetMap: map data © OpenStreetMap contributors, ODbL. No tile data is in this repository.

## Pear test app

An Electron window over a bare worker (pear-runtime) that reads previews from the planet bee over the public DHT with `scripts/preview.js`, draws the 2x2 as a 640x360 thumbnail with a pin, and logs the probe lines. The renderer and Electron main only relay; every read runs in the bare worker (`app/worker.js`, `app/ops.js`).

```
npm install
node node_modules/electron/install.js   # only when npm has ignore-scripts=true, which skips the Electron binary download
npm start
```

One client per key stays open while the window is open, and its store under `store/tmp/probe-*` is removed on quit. The log lines match `scripts/probe.js`:

```
connect ms N	update ms N blocks N bytes N	core.length N             # once per key
prefetch levels 2 nodes A/B	ms N	blocks N	bytes N                 # once per key, when the box is ticked
cold|repeat	<lat>,<lon>	ms N	blocks N	bytes N	zoom Z	tiles P/4	label <name> (<kind>, <km> km)|null
```

Test window:

- Seeder, kept running with its terminal open for the agreed window (a stats line every 10 s): `$B scripts/seed.js store/planet-c12 q6psfy7rzwm4hbsc9r81jans53ympcb3r88w83cc4e91dyeyqcoo`. Stop it with Ctrl-C, or `pkill -INT -f scripts/seed.js` from another terminal, since the `node_modules/bare-runtime/bin/bare` launcher does not forward SIGINT; it prints `stopping: ...`.
- Tester: `git clone https://github.com/xTMNTxRaphaelx/maps-bee && cd maps-bee && npm install && npm start`, plus `node node_modules/electron/install.js` before `npm start` when npm has ignore-scripts. In the window keep the default key, tick prefetch or not, click each preset then Run, click Run a second time on Jaipur for the repeat line, try one free lat/lon, then click Copy log.
- Results go in `results/pear-test-window.txt`. First line `# pear test window YYYY-MM-DD, tester <name>, seeder store/planet-c12 on <host>, prefetch on|off, app <git short sha>`, then one `## session N` heading per app launch, each followed by its copied log verbatim.
