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
$B scripts/planet-build.js store/planet keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # add --resume after an interruption
$B scripts/planet-commit.js store/planet keys atlas   # optional 4th arg: blocks per signed commit, default 20000; resumable
$B scripts/seed.js store/planet <key from the maps line>
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12
```

The sparse tests read the published key from `results/publish.txt` and open `store/signed`; the gazetteer and preview tests read `data/gazetteer.json`. `keys/` holds test-only keys and is never committed.
