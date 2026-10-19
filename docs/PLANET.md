# Building the planet bee on a machine with disk

The runbook for the design the client actually reads: zoom 10 complete, zoom 14 without filler, zoom
15 split into quadrants, plus the `g/` and `a/` gazetteers. This is the only place these commands
live; `docs/TESTING.md` stage 4 says what running them is testing.

Steps 1, 3 and 4 were run end to end on 2026-10-16, without zoom 15: z10 complete plus z14 in four
quadrants, then both gazetteers, committed to **5,824,622 blocks / 36,715,803,243 bytes**. z10 put
1,048,576 tiles, the four z14 quadrants 31,839,926 between them, `g/` 111,548 cities and towns.
Step 2 and the zoom 15 runs are still only described here. A z14-topped atlas is a working one —
`preview.js` walks `[15, 14, 10]` and stops at the first tier that answers — it just cannot serve
house numbers, which only exist at z15.

Every number below is marked **measured** (it comes from a file in `results/`) or **estimated**
(arithmetic from a measured number, with the basis given). Record what actually happens — a run
that disagrees with an estimate here is the estimate's problem.

## Before starting

| | |
| --- | --- |
| disk, peak | **estimated** ~130 GB if you delete each extract after its run, ~230 GB if you keep them all |
| wall clock | **estimated** 12-15 h, nearly all of it `pmtiles extract` |
| tools | `tools/pmtiles` binary, `node_modules/bare-runtime/bin/bare`, keys in `keys/` |

```sh
B=node_modules/bare-runtime/bin/bare
$B scripts/keys.js keys     # only if keys/ is empty; test-only keys, never committed

# builds are named by date and kept about a week; 20261012, which every count below was measured
# from, was already a 404 on 2026-10-19
for i in $(seq 0 25); do D=$(date -v-${i}d +%Y%m%d 2>/dev/null || date -d "-$i day" +%Y%m%d); \
  C=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -r 0-1 "https://build.protomaps.com/$D.pmtiles"); \
  case $C in 200|206) S=https://build.protomaps.com/$D.pmtiles; echo "using $D"; break;; esac; done
```

`./tools/pmtiles show $S` gives that build's `tile entries count`. It said **178,204,798** on
20261012 (**measured**, `results/planet-filler.txt`), and every count in this document moves with
it. Record what yours says before starting: the conservation checks below are against `4^zoom`,
which does not move, but the entry counts and the cap headroom do.

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
  --bbox=-179.995,0.005,-0.005,85.0511 --minzoom=14 --maxzoom=14 \
  --download-threads=8 --overfetch=0.2; do echo "reset — retrying in 30s"; sleep 30; done

$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 \
  data/planet-z10.pmtiles 2>&1 | tee results/planet-build-z10.txt
# then one run per z14 quadrant, NW NE SW SE, same store and draft
```

z10 goes in on its own and each quadrant follows in NW, NE, SW, SE order: `checkZoomOrder` rejects
two archives sharing a zoom in one invocation, and the keys still ascend across runs
(`10/` < `14/0…` < `14/1…` < `14/2…` < `14/3…`). Each quadrant is far under the 67.1M entry cap —
the whole zoom is 39,501,064 entries (**measured**, 20261012, `results/planet-z14-only-dryrun.txt`).
Keep the quadrants: step 4 harvests
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

Cut inside the meridian and the equator so two quadrants never share a tile column or row —
`pmtiles extract` rounds a bbox out to whole tiles, and an overlap puts the same keys twice and
breaks the ascending order across runs.

**Offset by 0.005°, not 0.0001°.** A z14 tile is 0.02197° wide and a z15 tile 0.010986°, so 0.0001°
sits 0.45% inside the edge tile and `extract` rounds across the boundary anyway. That is **measured,
2026-10-16**: the four z14 quadrants cut at 0.0001° covered 268,451,842 tiles against a grid of
268,435,456 — one whole tile line, 16,384, duplicated, plus 2. 0.005° lands 23% inside a z14 tile
and 45% inside a z15 one, clear of both edges at either zoom.

**The antimeridian is an edge too: offset ±180 as well, to ∓179.995.** A bbox ending at exactly
180 gives `x = floor((180 + 180) / 360 * 32768) = 32768`, one past the last column at z15, so the
region is 16,385 columns wide and the surplus is whatever lies at x = 0 — the other quadrant's.
**Measured 2026-10-19** (`results/planet-z15-quadrant-bboxes.txt`) on the z15 cuts, which used
±180: NE and SE each addressed 268,451,840
tiles, exactly 16385 x 16384, and NW and SW 268,435,457, a single tile over. Re-cutting NE at
179.995 brought the region to 268,435,456 and dropped 5,660 entries; NW at -179.995 dropped 1.
A quadrant is right when `addressed tiles count` is exactly 268,435,456 = 2^28.

```sh
until ./tools/pmtiles extract $S data/planet-z15-nw.pmtiles --bbox=-179.995,0.005,-0.005,85.0511 \
  --minzoom=15 --maxzoom=15 --download-threads=8 --overfetch=0.2; do echo "reset — retrying in 30s"; sleep 30; done
./tools/pmtiles show data/planet-z15-nw.pmtiles | grep -E 'addressed tiles count|tile entries count'
```

**After building the quadrants, check coverage by conservation, not by summing entries.** Every
tile of a zoom is either put or counted as filler, so across the four runs:

```sh
grep -h '^done puts' results/planet-build-z15-*.txt \
  | awk '{p+=$3; ft+=$11} END {print "total", p+ft}'
```

must equal `4^zoom` — 268,435,456 at z14, 1,073,741,824 at z15. Summing `tile entries count` does
*not* work: splitting by bbox cuts run-length entries in two, so the quadrants legitimately report
more entries than the whole zoom (39,506,736 against 39,501,064 at z14, all of it split filler
runs), and that surplus masks a real overlap. The conservation check is what caught the 0.0001°
defect after the entry sum said it was fine.

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
| NW | `-179.995,0.005,-0.005,85.0511` | 1 |
| NE | `0.005,0.005,179.995,85.0511` | 2 |
| SW | `-179.995,-85.0511,-0.005,-0.005` | 3 |
| SE | `0.005,-85.0511,179.995,-0.005` | 4 |

## 3. Build each quadrant, in that order

```sh
$B scripts/planet-build.js --sorted --flush-puts=200000 --flush-bytes=536870912 \
  --inline-value-size=0 store/planet keys atlas 10 \
  data/planet-z15-nw.pmtiles 2>&1 | tee results/planet-build-z15-nw.txt
```

Then `-ne`, `-sw`, `-se`, one command each, same store and same draft name `atlas`. Each run prints
`draft atlas length N` at the start — N must be larger each time, or you are writing to a fresh
draft and the earlier work is not in it.

**A sorted run cannot `--resume`** (`buildPlanet` throws on the combination), but a dead one is
re-run by repeating its command unchanged. A hyperbee put whose stored bytes equal the ones being
written is not applied (hyperbee2 lib/write.js:152-158 and :170-179 compare the inflated value,
not just the key), and a batch with nothing applied appends no block (:427). The build copies the
archive's gzip bytes raw, so the second pass writes the same bytes and the already-flushed prefix
costs a tree descent and one value read per key, not a block. The draft ends with one key per tile
either way.

The one consequence is in the numbers, not the data: the re-run counts every key it tried, so its
`done puts` includes the retried ones. Take that archive's `tiles` and `fillerTiles` from its
`collect entries …` line instead when summing step 2's coverage check.

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

**`a/` before `g/`**: `a/` sorts first. The 20261012 run had these the other way round.

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
$B scripts/planet-commit.js store/planet keys atlas 20000 2>&1 | tee results/planet-commit.txt

# check the atlas before blaming the network for anything
$B scripts/local-check.js store/planet <key from the maps line> \
  26.9,75.8 46.0037,8.9511 40.7128,-74.0060 -33.8688,151.2093

$B scripts/seed.js store/planet <key>
$B scripts/probe.js <key> 26.9,75.8 51.5,-0.12
$B scripts/probe.js --levels=2 <key> 26.9,75.8 51.5,-0.12
```

The commit ends with a `maps:` line holding the key and the signed length. Pass the chunk size:
hypercore reads every block of a commit into memory at once, so an unchunked commit of a planet
draft dies at the 4 GB V8 heap. **Measured** at z10+z14: about 2 minutes; **estimated** 5-6 minutes
with z15.

**Run `local-check.js` before the seeder.** It opens the store read-only and runs the real preview
path with no swarm, so a sound atlas behind a blocked DHT stops looking like a broken build — which
is exactly how it looked on 2026-10-16, when the seeder reported `length 5824622` and no client ever
connected. One point per quadrant exercises all four z14 archives and both gazetteer prefixes.
**Measured** on that build (`results/planet-local-check.txt`), every point `tiles 4/4` at zoom 14:

```
26.9,75.8          Kachi Basti, Sudarshanpura, Jaipur
46.0037,8.9511     piazza Rizziero Rezzonico, Quartiere Maghetti, Lugano
40.7128,-74.006    IRT City Hall Loop, Lower Manhattan, New York
-33.8688,151.2093  King Street Cycleway, Wynyard, Sydney
```

## What to check when it is done

- A probe at a dense point should come back at **zoom 15**, not 14. If it says 14, the quadrant
  covering that point did not make it into the draft — check each run's `draft atlas length`.
- `results/planet-probe-quadrants.txt` is the current baseline, **measured** 2026-10-16 on the
  z14-topped quadrant build: a cold first preview is 198 blocks / 1.56 MB, and each one after it
  33-64 blocks / 0.43-0.61 MB, with a repeat at 0/0. That is 6.5x fewer bytes than the
  2026-10-13 build in `results/planet-probe-2x2.txt`, which cost 10.16 MB for the same point and
  returned no area labels — the gain is `--flush-puts=200000 --flush-bytes=536870912`, which
  leaves smaller blocks so a preview stops hauling a ~40 KB block to read one tile.
- **Do not prefetch past one level.** Level 1 is free to the byte (its 17 blocks are the root the
  first preview would fetch anyway) and only moves ~200 ms off the first preview. Level 2 breaks
  even near 18 previews in a session, level 3 near 125. `app/ops.js` ships `PREFETCH_LEVELS = 1`
  on these numbers.
- `docs/TESTING.md` stage 4 lists what this run is actually testing — the production flush path,
  short-read detection, the gazetteer pass, handle cleanup. Record the `time` output for each stage
  either way, in `results/`.
