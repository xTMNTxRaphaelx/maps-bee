# Working notes for maps-bee

Conventions and standing decisions that the code does not state on its own. Everything else —
architecture, key schemes, thresholds, how to build — is in `README.md`, `docs/TESTING.md` and
`docs/PLANET.md`.

## Commands

- `npm test` — the whole suite under bare (`brittle-bare test/index.js`).
- `npm run lint` — lunte. Must be clean before a commit.

Both must pass before anything is committed. Report the real numbers, including failures.

## Commits

One line, imperative, naming what changed and why it changed — not how many things it touched.
"Read the detail cell at z15, with z14 as the tier below", not "fix 18 audit findings".

No `Co-Authored-By` trailers. Split a change that needs more than one line of explanation into more
than one commit.

## Comments

Comments carry the measurement, the invariant or the reason. They never restate the code beneath
them, and they never reference an external review document — if a finding matters, state the
invariant in its own terms, since the document will not be there later.

Prefer one comment above a block to a comment per line.

## Documentation

Markdown lives in `docs/`, except `README.md` and this file. Measured results go in `results/`, and a
result that later proves wrong gets a dated correction appended rather than a silent edit — see the
correction at the end of `results/address-shapes.txt`.

## Design priorities, in order

1. **Accuracy** of the derived address.
2. **Client cost per fetched lat/lon** — what one preview downloads. Publisher storage is not a
   constrained resource here: a client only ever fetches the cells around its own point, so a zoom
   tier that is never read costs it nothing. This is why `ZOOMS` keeps z14 below z15.
3. **Planet scale with no extra steps.** An approach that needs a special case to survive a planet
   build does not count as working. The live constraint is `MAX_SORTED_ENTRIES` (2^26 = 67.1M) per
   `--sorted` run, against roughly 178M planet tile entries at z15.

## Verifying

Test on a clean checkout's paths, not on this box's. `data/`, `store/`, `keys/` and `tools/` are
gitignored and already populated here, so a script that depends on one of them passes locally and
fails for everyone else — that happened three times in a row in `scripts/study/address-study.sh`. A script
creates the directories it writes to, and checks for the tools it needs before doing work.

Do not suppress output with `-q` in a script that can fail: it hid the cause of two of those three.
