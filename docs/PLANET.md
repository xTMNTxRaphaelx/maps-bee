# Building the planet bee on a machine with disk

The runbook for the design the client actually reads: zoom 10 complete, zoom 14 without filler, zoom
15 split into quadrants, plus the `g/` and `a/` gazetteers. `docs/SETUP.md`'s planet section records
the 20261012 build, which stopped at zoom 14; this supersedes it.

Nothing here has been run end to end. Every number below is marked **measured** (it comes from a
file in `results/`) or **estimated** (arithmetic from a measured number, with the basis given).
Record what actually happens — a run that disagrees with an estimate here is the estimate's problem.

## Before starting

| | |
| --- | --- |
| disk, peak | **estimated** ~130 GB if you delete each extract after its run, ~230 GB if you keep them all |
| wall clock | **estimated** 12-15 h, nearly all of it `pmtiles extract` |
| tools | `tools/pmtiles` binary, `node_modules/bare-runtime/bin/bare`, keys in `keys/` |

```sh
B=node_modules/bare-runtime/bin/bare
S=https://build.protomaps.com/20261012.pmtiles
$B scripts/keys.js keys     # only if keys/ is empty; test-only keys, never committed
```

Check the source build is still the one these numbers came from — `./tools/pmtiles show $S` should
say `tile entries count: 178204798` (**measured**, `results/planet-filler.txt`). A different number
means Protomaps rotated the build under you, and every count below moves with it.

## The constraint that shapes all of this

`planet-build.js --sorted` packs each tile into one 64-bit slot with 26 bits for the entry index, so
**one archive must hold fewer than `MAX_SORTED_ENTRIES` = 2^26 = 67,108,864 entries.** Zoom 15 over
the planet is **estimated** ~125M entries (178.2M for z0-15, minus 39.5M **measured** at z14, minus
~13M for everything below it), so it cannot go in as one archive. Hence quadrants.

Two things follow, and both are silent failures rather than loud ones:

1. **One `--sorted` invocation per z15 quadrant.** `checkZoomOrder` rejects two archives that share a
   zoom, so all four quadrants in one command throws on the second. Separate runs are fine: the
   draft is a named session that resumes from storage, so each run appends to the same draft.
2. **Feed them in ascending key order: NW, NE, SW, SE.** Quadkey digits are `0` NW, `1` NE, `2` SW,
   `3` SE (`tiles.js` `quadkey`), and `10/ < 14/ < 15/ < a/ < g/` as strings. Puts out of key order
   still produce a correct bee, but they cost the layout that makes a cold read cheap — which is the
   whole point of `--sorted`.

## 1. Zoom 10 and zoom 14

**Cut z14 in the same four quadrants as z15, each in a retry loop. One 32 GB cut does not
complete.** The bboxes are in step 2; `--download-threads=8 --overfetch=0.2` and the `until` loop
are not optional on a home link.

```sh
./tools/pmtiles extract $S data/planet-z10.pmtiles --minzoom=10 --maxzoom=10   # measured 2.2 GB, 2m17s

# then once per quadrant, bboxes from step 2
until ./tools/pmtiles extract $S data/planet-z14-nw.pmtiles \
  --bbox=-180,0.0001,-0.0001,85.0511 --minzoom=14 --maxzoom=14 \
  --download-threads=8 --overfetch=0.2; do echo "reset — retrying in 30s"; sleep 30; done

$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 \
  data/planet-z10.pmtiles 2>&1 | tee results/planet-build-z10.txt
# then one run per z14 quadrant, NW NE SW SE, same store and draft
```

z10 goes in on its own and each quadrant follows in NW, NE, SW, SE order: `checkZoomOrder` rejects
two archives sharing a zoom in one invocation, and the keys still ascend across runs
(`10/` < `14/0…` < `14/1…` < `14/2…` < `14/3…`). Each quadrant is far under the 67.1M entry cap —
the whole zoom is 39,501,064 entries (**measured**, 20261012). Keep the quadrants: step 4 harvests
the areas from them, and `gazetteer.js` takes all four as repeated `<archive> <bbox> <minz> <maxz>`
groups in one command. **Measured** on 20261012 for the whole zoom in one run: `done puts 32888213
bytes 35221625742`, about 7 minutes of build time.

**Measured** 2026-10-16, cutting z14 over a home connection, each line a separate attempt:

| cut | threads | overfetch | requests | outcome |
| --- | ---: | ---: | ---: | --- |
| z10, 2.2 GB | 4 | 0.05 | 416 | completed, 2m17s |
| z14 whole, 32 GB | 4 | 0.05 | 49,844 | tail diverged, killed at 1h46m |
| z14 whole, 32 GB | 16 | 0.05 | 49,844 | connection reset at 83%, 20m |
| z14 NW, 12 GB | 16 | 0.2 | 12,011 | connection reset at 89%, 7m53s |
| z14 NW, 12 GB | 8 | 0.2 | 12,016 | tail diverged, then **completed on the loop's retry, 22m31s** |

So: 4 threads never gets reset but its tail does not converge on a large cut; 16 gets reset; 8 is
the setting that finished. Overfetch 0.2 moved 915 KB per request against 642 KB at 0.05, and cost
13 GB transferred for an 11 GB archive — worth it at this size, pointless on z10, whose 416
requests already average 5.3 MB.

The retry loop is what actually saved the run, so write it into the command rather than babysitting
one: `pmtiles extract` neither resumes nor retries, so a single reset discards the whole transfer,
and the quadrant split is what makes a retry cost 22 minutes instead of two hours.

Reading a run while it goes: the bulk is large contiguous chunks and the tail is thousands of tiny
scattered ones, so the rate collapses near the end on every healthy run too — z10 fell to 1.2 kB/s
at 99% and then finished. Rate alone tells you nothing. **The signal is the ETA's direction:** it
extrapolates from bytes, the bytes finish long before the work does, and if it starts *growing*
(11 → 23 minutes on the run above) the tail is diverging and will not land. The output file stops
growing at that point too, since the remaining writes land inside an extent already allocated, so
only its mtime moves; a small nonzero rate with a live mtime means crawling, not frozen. Give a
tail 20 minutes, then kill it and let the loop start over.

Not the cause, though both were suspected: the source build's age — the successful run used the
same four-day-old 20261012 as the failures — and server-side throttling, since a fresh z10 cut hit
full speed in the middle of it all.

## 2. Cut each zoom 15 quadrant and check it fits

Cut a hair inside the meridian and the equator so two quadrants never share a tile column or row —
`pmtiles extract` rounds a bbox out to whole tiles, and an overlap would put the same keys twice and
break the ascending order across runs.

```sh
./tools/pmtiles extract $S data/planet-z15-nw.pmtiles --bbox=-180,0.0001,-0.0001,85.0511 \
  --minzoom=15 --maxzoom=15 --download-threads=16 --overfetch=0.2
./tools/pmtiles show data/planet-z15-nw.pmtiles | grep 'tile entries count'
```

The two flags are for the tail, not the bulk — see the extract shape under step 1. Measure them on
NW and carry the better setting to the other three rather than assuming: overfetch buys fewer
requests with ~20% more bytes, which is the right trade for a tail of 3 KB requests and the wrong
one for a bulk already running at full bandwidth.

**`tile entries count` must be under 67,108,864.** The land is not spread evenly — NE is Europe and
Asia and is the one that may not fit. If a quadrant is over, split it in longitude and treat the
halves as two archives in the same position in the order (NE-west before NE-east). `planet-build.js`
throws `sorted build packs up to 67108864 entries, archive has N` rather than building something
wrong, so this check is a convenience, not a safety net you are removing.

The four bboxes:

| quadrant | bbox | order |
| --- | --- | ---: |
| NW | `-180,0.0001,-0.0001,85.0511` | 1 |
| NE | `0.0001,0.0001,180,85.0511` | 2 |
| SW | `-180,-85.0511,-0.0001,-0.0001` | 3 |
| SE | `0.0001,-85.0511,180,-0.0001` | 4 |

## 3. Build each quadrant, in that order

```sh
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 \
  data/planet-z15-nw.pmtiles 2>&1 | tee results/planet-build-z15-nw.txt
```

Then `-ne`, `-sw`, `-se`, one command each, same store and same draft name `atlas`. Each run prints
`draft atlas length N` at the start — N must be larger each time, or you are writing to a fresh
draft and the earlier work is not in it.

**A sorted run cannot `--resume`** (`buildPlanet` throws on the combination). If one dies partway,
that quadrant's puts are already in the draft and re-running it would duplicate them: start the
whole store again, or finish on a machine that will not be interrupted. This is the one place where
an interruption costs real time, which is also the argument for four runs rather than one.

Delete each quadrant extract after its run to keep peak disk near one extract plus the store.

## 4. The two gazetteers

```sh
$B scripts/gazetteer.js data/planet-areas.json --areas data/planet-z14.pmtiles \
  -180,-85.05,180,85.05 14 14 2>&1 | tee results/planet-areas.txt
$B scripts/gazetteer-put.js --inline-value-size=0 --areas store/planet keys atlas data/planet-areas.json

$B scripts/gazetteer.js data/planet-gazetteer.json --kinds=city,town data/planet-z10.pmtiles \
  -180,-85.05,180,85.05 10 10 2>&1 | tee results/planet-gazetteer.txt
$B scripts/gazetteer-put.js --inline-value-size=0 store/planet keys atlas data/planet-gazetteer.json
```

**`a/` before `g/`**: `a/` sorts first, and `docs/SETUP.md` had these the other way round.

The area pass harvests from the zoom 14 extract rather than a zoom 13 cut of its own. Zoom 13 is the
cheaper pass — **estimated** ~8M tiles against ~31.8M **measured** at z14, so ~14 min against ~56 min
at the **measured** 9,400 tiles/s of the zoom 10 pass — but a z13 planet extract is another multi-hour
cut and tens of GB that nothing else in this build uses, and zoom 14 carries 100% of the
neighbourhood labels against 91% at z13. Trading 40 minutes of CPU for hours of extract is the
reason. If you already have a z13 extract, use it: change the file and `14 14` to `13 13`, nothing
else. The `a/` **key** zoom is 14 either way (`AREA_ZOOM`).

Watch the walk line this prints: `walk entries ... tiles ... fillerRuns ... fillerTiles ... runBlobs`.
The z14 archive is **measured** at 39,501,064 entries of which 7,661,427 are filler runs covering
236,595,819 tiles — those are skipped after one probe per distinct blob. Expect ~1.25 GB resident.
If `runBlobs` is large, or `fillerRuns` is near zero, something about the archive is not what we
think and the pass is doing far more work than it should.

## 5. Sign, seed, probe

```sh
$B scripts/planet-commit.js store/planet keys atlas 2>&1 | tee results/planet-commit.txt
$B scripts/seed.js store/planet <key from the maps line>
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12
$B scripts/probe.js --levels=2 <key> 26.9,75.8 51.5,-0.12
```

The commit ends with a `maps:` line holding the key and the signed length. **Measured** at z10+z14:
about 2 minutes; **estimated** 5-6 minutes with z15.

## What to check when it is done

- A probe at a dense point should come back at **zoom 15**, not 14. If it says 14, the quadrant
  covering that point did not make it into the draft — check each run's `draft atlas length`.
- `results/planet-probe-2x2.txt` is the z14-era baseline: 60 blocks / 0.69 MB cold for Jaipur with
  the publisher flags, 13 / 0.18 MB after the level-2 prefetch (**measured**). The z15 equivalent is
  unmeasured; `results/address-shapes.txt`'s correction says to expect roughly the same, not less.
- `docs/TESTING.md` stage 4 lists what this run is actually testing — the production flush path,
  short-read detection, the gazetteer pass, handle cleanup. Record the `time` output for each stage
  either way, in `results/`.
