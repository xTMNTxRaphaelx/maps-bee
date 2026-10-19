# Setup and test procedure

Everything runs under bare from `node_modules/bare-runtime/bin/bare`. npm and node are needed only
to install packages and to host the Electron test app.

A staged run with a gate after each stage: stop if a gate fails rather than carrying a broken tree
into the next stage. Stages 1-3 take about ten minutes. Stage 4 is the planet build and runs for
hours, so do not start it until stage 2 is green.

Record each stage's output under `results/` as named. Three of those files are regenerated for your
own keys and must not be committed — see stage 2.

## Requirements

| Tool | Why | Where |
| --- | --- | --- |
| node and npm | install packages, run Electron | any current release |
| pmtiles binary | cut extracts from the Protomaps planet build | https://github.com/protomaps/go-pmtiles/releases, copied to `tools/pmtiles` |
| disk | the test atlas needs under 100 MB of extracts and stores; the planet bee is budgeted in [PLANET.md](PLANET.md) | |

## Stage 0 — prerequisites

```sh
df -h .
ulimit -n                     # see below
node --version                # >= 22.12
sw_vers -productVersion; uname -m
```

**File descriptors.** No action needed. `planet-build.js` opens one archive at a time and closes it
in a `finally` before the next, and the publisher command passes two, so archive fds peak at one
alongside corestore's RocksDB handles. Earlier planet runs completed at the macOS default of 256,
and the changes since then only reduce fd pressure: `FileSource` no longer opens the file twice and
leaks the first handle, and the archive now closes on a throw as well as on success. Raise it with
`ulimit -n 10240` only if a run actually reports `EMFILE` or `too many open files`.

**pmtiles binary.** Take the `darwin_arm64` build (or `darwin_amd64` on Intel) from
https://github.com/protomaps/go-pmtiles/releases, into `tools/pmtiles`, then `chmod +x tools/pmtiles`
and clear the quarantine flag macOS sets on downloads:

```sh
xattr -d com.apple.quarantine tools/pmtiles 2>/dev/null
./tools/pmtiles version
```

**Fresh clone.** Test what the repo actually holds, not a tree with local state in it:

```sh
git clone <this repo> maps-bee-test && cd maps-bee-test
npm install
node node_modules/electron/install.js   # only if npm has ignore-scripts=true
```

## Stage 1 — the suite with no fixtures

Before downloading anything. This checks the fixture preflight, which exists so a clean clone fails
cleanly instead of aborting the runtime mid-suite.

```sh
npm test; echo "EXIT=$?"
```

**Gate.** Exit 0, `# tests = 42/42 pass`, `# asserts = 146/146 pass`, and one
`data fixtures are present # SKIP` line, with the missing paths listed on stderr. Any other outcome
— especially a non-zero exit, a `SIGABRT`, or no summary line at all — means the preflight does not
hold on macOS. Stop and report it.

## Stage 2 — the fixtures and the full suite

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
$B scripts/gazetteer.js data/areas.json --areas data/extract/jaipur-z11-14.pmtiles 75.55,26.65,76.05,27.15 13 13          # a/ keys; bbox widened by 0.1 deg, see below
$B scripts/gazetteer.js data/areas-lugano.json --areas data/extract/lugano-z11-14.pmtiles 8.75,45.85,9.15,46.16 13 13
npm test 2>&1 | tee ../stage2.txt; echo "EXIT=$?"
```

**Gate.** Exit 0, `# tests = 89/89 pass`, `# asserts = 900/900 pass`, zero `not ok` lines.

Also run the linter, which should be silent:

```sh
npm run lint
```

**If a test fails here, stop.** Stage 4 shares all of this code and will only fail more expensively.
The two failures worth telling apart:

- `addressed tiles count` in `test/planet-build.js` — the Atlantic extract did not cut as expected.
  Check with `./tools/pmtiles show data/extract/atlantic-z10.pmtiles`; it must say **550**.
- a `seeder holds the published length` failure — `store/signed` and `keys/` disagree. Rebuild both.

Notes on the fixtures:

- The Jaipur zoom 15 extract is 2.8 MB and cuts in seconds; only the z15 tests (`test/address.js`, `test/z15.js`, `test/address-accuracy.js`, `test/render-svg.js`) read it.
- The Atlantic extract is cut straight from the remote build, so this stage needs nothing from the planet build. It is zoom 10 over open ocean, and `test/planet-build.js` asserts its exact `addressed tiles count: 550`.
- The two `--areas` passes harvest with a **wider bbox than the extract**. An area gazetteer must cover a margin around the region it serves, or a pin near the edge takes the nearest label that happened to survive the clip rather than the true nearest. Clipping Lugano to its own bbox cost 97 labels instead of 129 and two village hits.
- `test/index.js` preflights all twelve fixture paths and skips the data-dependent suite with one `# SKIP` line if any is absent, so a partial run of this section fails loudly rather than aborting the process.
- This stage rewrites `results/build-bee.txt`, `results/publish.txt` and `results/gazetteer.txt` for your own keys and store, so expect those three to show as modified. They are measurement logs, not test input — restore them with `git checkout -- results/` and nothing breaks.
- The sparse tests derive the published key from `keys/` (the same manifest `scripts/publish.js` publishes under) and open `store/signed`; the gazetteer and preview tests read `data/gazetteer.json`.
- `keys/` holds test-only keys and is never committed.

## Stage 3 — address accuracy

```sh
PATH=node_modules/bare-runtime/bin:$PATH npx brittle-bare test/address-accuracy.js > results/address-accuracy-jaipur.txt
PATH=node_modules/bare-runtime/bin:$PATH npx brittle-bare test/address-accuracy-lugano.js > results/address-accuracy-lugano.txt
git diff --stat results/
```

**Gate.** Both exit 0, and the hit rates are unchanged from what is committed:

| Part | Jaipur | Lugano |
|---|---|---|
| road | 5/6 | 7/11 |
| neighbourhood | 7/7 | 4/5 |
| suburb | 12/12 | 5/7 |
| village | 1/2 | 2/6 |
| city | 18/19 | 10/11 |
| housenumber | 0/0 | 3/5 |

Distances may differ in the last metre; rates must not move. A rate change means either the
Protomaps build rotated under you or the address code behaves differently on macOS — the first is
far likelier, so check that `20261012` is still the build you cut from.

## Stage 4 — planet scale

Run [PLANET.md](PLANET.md) end to end — it carries the commands, the quadrant bboxes, the entry
cap and the retry loops. Budget a day; nearly all of it is `pmtiles extract`. Record each step's
output under `results/` as that document names, and the `time` output with it.

What follows is what this stage is for, which is not the same as how to run it.

### What this stage is actually testing

Four things the small fixtures cannot reach. Each has a specific expected outcome:

1. **The production flush path.** `FLUSH_PUTS` (20000) and `FLUSH_BYTES` (64 MB) are the defaults,
   and every test passes `flushPuts: 200` instead — so until this run, the chunking that actually
   ships has never executed. PLANET.md's build command overrides both to the publisher values, so
   run one archive **once more without the two flags** to exercise the defaults themselves.

2. **Short-read detection at scale.** `readValues` now throws `short read: wanted N bytes at M, got
   K` rather than silently writing blank tiles under a signature. On a correctly downloaded archive
   it must **never fire**. If it does, suspect the download, not the code — re-cut the extract.

3. **The gazetteer pass.** Level-9 gzip on every tile in the world used to run and be discarded
   here; `gz` is now a lazy getter. The pass also walks the archive's tile entries now rather than
   the bbox rectangle, so the 1,048,576-tile z10 rectangle costs the 478,575 entries the archive
   holds. The ~2 min budget predates both changes, so **expect it to come in meaningfully under
   2 min**. This is the one performance fix with a measurable prediction — record the `time`
   output either way, and the `walk entries ... fillerRuns ...` line with it.

4. **Handle and store cleanup.** The archive fd and the store now close in `finally` rather than as
   the last statement of the happy path, so an interrupted or failed build releases them too. Kill
   one quadrant's build partway with Ctrl-C and confirm it exits without leaving the store locked.
   A sorted build cannot `--resume`; the recovery is to re-run that quadrant's command unchanged,
   and the puts already flushed must append no block the second time.

### Gate

The conservation check in PLANET.md step 2 — `puts + fillerTiles` summed across the quadrant runs
equals `4^zoom` — is the gate, because it is the one that catches a bad cut. Summing
`tile entries count` instead does not work and has masked a real overlap.

The commit ends with a `maps:` line carrying the key and signed length; keep it, stage 5 needs the
key. For scale, build `20261012` logged `done puts 32888213 bytes 35221625742` for the
z10-plus-z14 build that preceded the quadrant split.

### Experiments behind the publisher flags

Why the build carries `--sorted --flush-puts --flush-bytes --inline-value-size=0`. Recorded in
`results/planet-c1-sorted.txt`, `results/planet-c2-noinline.txt` and
`results/planet-c12-sorted-noinline.txt`.

```sh
$B scripts/planet-build.js store/planet keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # directory-walk order, add --resume after an interruption
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 store/planet-c1 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # key-order puts only
$B scripts/planet-build.js --inline-value-size=0 store/planet-c2 keys atlas 10 data/planet-z10.pmtiles data/planet-z14.pmtiles   # no inlined values only
```

## Stage 5 — seed, probe and the app

Two terminals. The Electron window has never been driven since the malformed-frame fix, and no run
has ever involved a real remote peer.

**Terminal A, the seeder** (prints a stats line every 10 s):

```sh
$B scripts/seed.js store/planet <key from the maps line>
```

`seed.js` installs a SIGINT handler and prints `stopping: ...` on the way out, but the
`node_modules/bare-runtime/bin/bare` launcher does not forward SIGINT, so Ctrl-C may not reach it.
`pkill -INT -f scripts/seed.js` from terminal B always does.

**Terminal B, the probe:**

```sh
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12 | tee results/planet-probe-mac.txt
$B scripts/probe.js --levels=2 <key> 26.9,75.8 51.5,-0.12 | tee results/planet-probe-mac-l2.txt
```

Compare against `results/planet-probe.txt` and `results/planet-c12-sorted-noinline.txt`: a cold
Jaipur open should be about **60 blocks / 0.69 MB**, dropping to about **13 / 0.18 MB** after the
level-2 prefetch. Repeat opens should cost **0 blocks**.

**The app.** An Electron window over a bare worker (pear-runtime) that reads previews from the
planet bee over the public DHT with `scripts/preview.js`, draws the 2x2 as a 640 by 360 thumbnail
with a pin, and logs the probe lines. The renderer and Electron main only relay; every read runs in
the bare worker (`app/worker.js`, `app/ops.js`). It is a swarm client: it opens an empty store under
`store/tmp/probe-*` and fetches everything from a peer, so a seeder must be online.

```sh
npm install
node node_modules/electron/install.js   # only when npm has ignore-scripts=true, which skips the Electron binary download
npm start
```

Keep the default key, pick a preset or type a point, tick prefetch or not, click Run. Click Run a
second time on Jaipur for the repeat line, try one free lat/lon, then Copy log into
`results/pear-test-window.txt` under a `## session 1` heading. One client per key stays open while
the window is open.

The log lines match `scripts/probe.js`, with `PREFETCH_LEVELS = 1` (`app/ops.js`):

```
connect ms N	update ms N blocks N bytes N	core.length N             # once per key
prefetch levels 1 nodes A/B	ms N	blocks N	bytes N                 # once per key, when the box is ticked
cold|repeat	<lat>,<lon>	ms N	blocks N	bytes N	zoom Z	tiles P/4	label <name> (<kind>, <km> km)|null	address <display>|null
```

What to watch for, since this is the path with the least coverage:

- the Run button must always come back, even on a bad key or with no seeder online — a button that
  never re-enables is the failure the frame-parsing fix was meant to remove
- `store/tmp/probe-*` must be gone after you quit the window

### Reading an atlas without the swarm

`scripts/local-check.js` opens a store read-only and runs the real preview path with no swarm, so a
sound atlas behind a blocked DHT stops looking like a broken build:

```sh
$B scripts/local-check.js store/planet <key> 26.9,75.8 46.0037,8.9511 40.7128,-74.0060 -33.8688,151.2093
```

Run it before the seeder whenever a probe or the app comes back empty.

## Test window with an outside tester

**Seeder**, kept running with its terminal open for the agreed window:

```sh
$B scripts/seed.js store/planet-c12 q6psfy7rzwm4hbsc9r81jans53ympcb3r88w83cc4e91dyeyqcoo
```

**Tester:**

```sh
git clone https://github.com/xTMNTxRaphaelx/maps-bee && cd maps-bee
npm install
node node_modules/electron/install.js   # when npm has ignore-scripts
npm start
```

In the window keep the default key, tick prefetch or not, click each preset then Run, click Run a
second time on Jaipur for the repeat line, try one free lat/lon, then click Copy log.

**Results** go in `results/pear-test-window.txt`:

```
# pear test window YYYY-MM-DD, tester <name>, seeder store/planet-c12 on <host>, prefetch on|off, app <git short sha>

## session 1
<the copied log, verbatim>
```

One `## session N` heading per app launch.

## Widening the address fixture

The scored fixtures are 20 Jaipur and 11 Lugano points, which is thin — a two-point difference
decides whether the bee needs z14. To widen, sample candidates from the extracts, reverse geocode
them, then compare the address shapes:

Four cities, chosen to span the regimes address derivation has to cope with:

| City | bbox | z15 address points | Why |
| --- | --- | ---: | --- |
| Jaipur | `75.65,26.75,75.95,27.05` | 468 | dense streets, almost no house numbers |
| Lugano | `8.85,45.95,9.05,46.06` | 34 372 | small, complete Swiss addressing |
| Berlin | `13.30,52.45,13.55,52.56` | 120 954 | rich hierarchy, house numbers everywhere |
| Nairobi | `36.70,-1.36,36.95,-1.22` | 1 205 | sparse coverage, the hardest regime |

```sh
B=node_modules/bare-runtime/bin/bare
S=https://build.protomaps.com/20261012.pmtiles

# 0. Berlin and Nairobi extracts and city gazetteers (Jaipur and Lugano come from stage 2)
for C in "berlin 13.30,52.45,13.55,52.56" "nairobi 36.70,-1.36,36.95,-1.22"; do
  set -- $C
  ./tools/pmtiles extract $S data/extract/$1-z11-14.pmtiles --bbox=$2 --minzoom=11 --maxzoom=14
  ./tools/pmtiles extract $S data/extract/$1-z15.pmtiles    --bbox=$2 --minzoom=15 --maxzoom=15
  ./tools/pmtiles extract $S data/extract/$1-z10.pmtiles    --bbox=$2 --maxzoom=10
  $B scripts/gazetteer.js data/gazetteer-$1.json --kinds=city,town data/extract/$1-z10.pmtiles $2 0 10
done

# 1. candidates are committed; regenerate only to change n or the seed
#    $B scripts/study/fixture-points.js data/extract/<city>-z15.pmtiles <bbox> 60 1 > test/fixtures/<city>-candidates.json

# 2. ground truth: node, not bare; one request a second, as Nominatim's policy requires
for C in jaipur lugano berlin nairobi; do
  node scripts/study/fetch-nominatim.js test/fixtures/$C-candidates.json test/fixtures/$C-nominatim-wide.json
done

# 3. compare the three shapes
$B scripts/study/address-shapes.js test/fixtures/jaipur-nominatim-wide.json  data/extract/jaipur-z11-14.pmtiles  data/extract/jaipur-z15.pmtiles  75.65,26.75,75.95,27.05 data/gazetteer.json
$B scripts/study/address-shapes.js test/fixtures/lugano-nominatim-wide.json  data/extract/lugano-z11-14.pmtiles  data/extract/lugano-z15.pmtiles  8.85,45.95,9.05,46.06   data/gazetteer-lugano.json
$B scripts/study/address-shapes.js test/fixtures/berlin-nominatim-wide.json  data/extract/berlin-z11-14.pmtiles  data/extract/berlin-z15.pmtiles  13.30,52.45,13.55,52.56 data/gazetteer-berlin.json
$B scripts/study/address-shapes.js test/fixtures/nairobi-nominatim-wide.json data/extract/nairobi-z11-14.pmtiles data/extract/nairobi-z15.pmtiles 36.70,-1.36,36.95,-1.22 data/gazetteer-nairobi.json
```

Step 2 is 225 points at one a second, so about four minutes, and needs
`nominatim.openstreetmap.org` reachable.

What the comparison answers: **A vs B** is whether z14 earns its place in the bee once z15 is there;
**B vs C** is whether the area gazetteer earns its place. On the narrow fixture A and B are identical
on all twelve rates while C loses two Jaipur suburbs, so z14 looks droppable and the gazetteer areas
look load-bearing — on two points. That is what the wider set is for.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm start` says Electron failed to install | `~/.npmrc` has `ignore-scripts=true` | `node node_modules/electron/install.js` |
| `npm test` ends at `# tests = 42/42` with a `data fixtures are present # SKIP` line | one or more of the twelve fixtures is missing; the names are printed on stderr | finish stage 2 |
| a seeder keeps running after Ctrl-C in another terminal | the launcher ignores SIGINT; the real bare child must get it | `pkill -INT -f scripts/seed.js` |
| the app's Run never returns | no seeder is online for that key | start the seeder, then Run again |
| three `results/` files show as modified | stage 2 regenerates them for your keys | expected; do not commit them, `git checkout -- results/` to drop them |

## Reporting back

Send me, in this order:

1. the stage 1, 2 and 3 gate results (pass/fail plus the counts)
2. the planet build's `done puts` lines and the conservation total
3. the `time` outputs for the build and the gazetteer pass
4. anything that threw, verbatim, with the stage it threw in

If a stage fails, send that stage's output and stop there rather than working around it.
