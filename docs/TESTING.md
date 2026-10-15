# Test run procedure

A staged run with a gate after each stage: stop if a gate fails rather than carrying a broken tree
into the next stage. Stages 1-3 take about ten minutes. Stage 4 is the planet build and runs for
hours, so do not start it until stage 2 is green.

Record each stage's output under `results/` as named. Three of those files are regenerated for your
own keys and must not be committed (SETUP.md).

## Stage 0 — prerequisites

```sh
df -h .                       # stage 4 needs 70 GB free: 33 GB extracts + 35 GB store
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

**Gate.** Exit 0, `# tests = 32/32`, and one `data fixtures are present # SKIP` line, with the
missing paths listed on stderr. Any other outcome — especially a non-zero exit, a `SIGABRT`, or no
summary line at all — means the preflight does not hold on macOS. Stop and report it.

## Stage 2 — quick start and the full suite

Follow `docs/SETUP.md` "Quick start" verbatim: seven extracts, keys, build, publish, both
gazetteers, then

```sh
npm test 2>&1 | tee ../stage2.txt; echo "EXIT=$?"
```

**Gate.** Exit 0, `# tests = 77/77 pass`, `# asserts = 713/713 pass`, zero `not ok` lines.

Also run the linter, which should be silent:

```sh
npm run lint
```

**If a test fails here, stop.** Stage 4 shares all of this code and will only fail more expensively.
The two failures worth telling apart:

- `addressed tiles count` in `test/planet-build.js` — the Atlantic extract did not cut as expected.
  Check with `./tools/pmtiles show data/extract/atlantic-z10.pmtiles`; it must say **550**.
- a `seeder holds the published length` failure — `store/signed` and `keys/` disagree. Rebuild both.

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

The part no machine has run since the fixes. Budget ~3 h wall clock, mostly the zoom 14 extract.
Nothing special is needed beyond disk space.

```sh
B=node_modules/bare-runtime/bin/bare
S=https://build.protomaps.com/20261012.pmtiles

./tools/pmtiles extract $S data/planet-z10.pmtiles --minzoom=10 --maxzoom=10   # ~2.2 GB, minutes
./tools/pmtiles extract $S data/planet-z14.pmtiles --minzoom=14 --maxzoom=14   # ~31 GB, ~2.5 h

time $B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 \
  data/planet-z10.pmtiles data/planet-z14.pmtiles 2>&1 | tee results/planet-build-mac.txt

time $B scripts/gazetteer.js data/planet-gazetteer.json --kinds=city,town \
  data/planet-z10.pmtiles -180,-85.05,180,85.05 10 10 2>&1 | tee results/planet-gazetteer-mac.txt

$B scripts/gazetteer-put.js --inline-value-size=0 store/planet keys atlas data/planet-gazetteer.json
time $B scripts/planet-commit.js store/planet keys atlas 2>&1 | tee results/planet-commit-mac.txt
```

### What this stage is actually testing

Four things the small fixtures cannot reach. Each has a specific expected outcome:

1. **The production flush path.** `FLUSH_PUTS` (20000) and `FLUSH_BYTES` (64 MB) are the defaults,
   and every test passes `flushPuts: 200` instead — so until this run, the chunking that actually
   ships has never executed. The command above overrides both to the publisher values, so run it
   **once more without the two flags** if you want the defaults themselves exercised.

2. **Short-read detection at scale.** `readValues` now throws `short read: wanted N bytes at M, got
   K` rather than silently writing blank tiles under a signature. On a correctly downloaded archive
   it must **never fire**. If it does, suspect the download, not the code — re-cut the extract.

3. **The gazetteer pass.** Level-9 gzip on every tile in the world used to run and be discarded
   here; `gz` is now a lazy getter. SETUP budgets ~2 min for this pass from before that change, so
   **expect it to come in meaningfully under 2 min**. This is the one performance fix with a
   measurable prediction — record the `time` output either way.

4. **Handle and store cleanup.** The archive fd and the store now close in `finally` rather than as
   the last statement of the happy path, so an interrupted or failed build releases them too. Kill
   the build partway with Ctrl-C once and confirm it exits without leaving the store locked — the
   next run should open `store/planet` with `--resume` instead of refusing it.

### Gate

```
done puts 32888213 bytes 35221625742
```

That is the exact line build `20261012` produced. A different build date gives different numbers —
legitimate, but then it is not a regression check, so note which build you used. The commit ends
with a `maps:` line carrying the key and signed length; keep it, stage 5 needs the key.

Also confirm `store/planet` is ~35 GB and the process exited 0.

## Stage 5 — seed, probe and the app

Two terminals. The Electron window has never been driven since the malformed-frame fix, and no run
has ever involved a real remote peer.

**Terminal A, the seeder** (prints a stats line every 10 s):

```sh
$B scripts/seed.js store/planet <key from the maps line>
```

It does not stop on Ctrl-C — the bare launcher does not forward SIGINT. Stop it with
`pkill -INT -f scripts/seed.js` from terminal B.

**Terminal B, the probe:**

```sh
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12 | tee results/planet-probe-mac.txt
$B scripts/probe.js --levels=2 <key> 26.9,75.8 51.5,-0.12 | tee results/planet-probe-mac-l2.txt
```

Compare against `results/planet-probe.txt` and `results/planet-c12-sorted-noinline.txt`: a cold
Jaipur open should be about **60 blocks / 0.69 MB**, dropping to about **13 / 0.18 MB** after the
level-2 prefetch. Repeat opens should cost **0 blocks**.

**The app:**

```sh
npm start
```

Keep the default key, click each preset then Run, click Run a second time on Jaipur for the repeat
line, try one free lat/lon, then Copy log into `results/pear-test-window.txt` under a
`## session 1` heading.

What to watch for, since this is the path with the least coverage:

- the Run button must always come back, even on a bad key or with no seeder online — a button that
  never re-enables is the failure the frame-parsing fix was meant to remove
- `store/tmp/probe-*` must be gone after you quit the window

## Reporting back

Send me, in this order:

1. the stage 1, 2 and 3 gate results (pass/fail plus the counts)
2. `results/planet-build-mac.txt` tail — the `done puts` line
3. the two `time` outputs for the build and the gazetteer pass
4. anything that threw, verbatim, with the stage it threw in

If a stage fails, send that stage's output and stop there rather than working around it.
