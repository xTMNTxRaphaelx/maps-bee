# Working notes for maps-bee

The conventions are in [CONTRIBUTING.md](CONTRIBUTING.md) — commands, commit style, comment rules,
the results/ citation convention, design priorities, and how to verify against a clean checkout.
Read it before changing anything; it is the same file a human contributor reads, so it stays the
single copy.

Everything else — architecture, key schemes, thresholds, how to build — is in `README.md`,
`docs/TESTING.md` and `docs/PLANET.md`.

Two things that apply to an agent and not to a person:

- No `Co-Authored-By` trailers on commits.
- `npm test` takes about a minute; run it and `npm run lint` before every commit rather than
  batching them, and report the real counts including failures.
