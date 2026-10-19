# maps-bee example app

An Electron window that calls the library's `readPreview` over the public DHT and draws what comes
back. It is an example consumer, not part of maps-bee — nothing in `lib/`, `bin/` or `index.js` requires
it, and the library is usable without Electron, pear-runtime, or anything else in this directory.

What it is here for: `readPreview` is otherwise only ever driven by tests and by `bin/probe.js`,
both of which run in one process against a store on the same machine. This is the only place the
real read path runs in a real application, in a real process boundary, against a real remote peer.
That makes it the least covered path in the repo and the one worth exercising by hand before
trusting a change to the client read.

## Running it

A seeder must be online for the key you use — the app is a cold swarm client with nothing on disk,
so with no peer it has nowhere to get bytes from. Start one from the repo root first
(README, "Seed and probe"), then:

```sh
npm start
node node_modules/electron/install.js   # first, only if npm has ignore-scripts=true
```

Keep the default key or paste your own, pick a preset or type a lat/lon, tick prefetch or not, and
click Run. Clicking Run again on the same point gives the repeat line, which is the one that should
cost 0 blocks. One client per key stays open while the window is open, so the first point of a
session pays the connect and the rest do not.

Copy log puts the session on the clipboard in `bin/probe.js` format:

```
connect ms N	update ms N blocks N bytes N	core.length N             # once per key
prefetch levels 1 nodes A/B	ms N	blocks N	bytes N                 # once per key, when ticked
cold|repeat	<lat>,<lon>	ms N	blocks N	bytes N	zoom Z	tiles P/4	label <name> (<kind>, <km> km)|null	address <display>|null
```

Those lines are worth keeping when you are measuring. Paste them into `results/` under a
`## session N` heading, one heading per launch, with the date, the Protomaps build, the seeder host
and the app's git short sha on the line above — without the build and the sha the numbers cannot be
compared to anything later.

Two things to watch while it runs, both of them failures this app has actually had:

- **The Run button must always come back**, including on a bad key and with no seeder online. A
  button that never re-enables is the malformed-frame bug the framing fix was meant to remove.
- **`store/tmp/probe-*` must be gone after the window quits**, including on Cmd+Q and on a crash.

## How it is put together

```
app/main.js       Electron main: spawns the worker, relays IPC
   │  pear-runtime, framed-stream: JSON frames { id, op, ... } → { id, ok, result | error }
   ▼
app/worker.js     a bare process — the only place library code runs
   └── app/ops.js   openClient → prefetchTop → readPreview → renderThumbnail
```

The split is the point. `readPreview` needs bare, Electron's main process is node, so the read runs
in a bare worker over pear-runtime and everything else only relays: `main.js` and `renderer.js`
carry no map logic at all, and `ops.js` is plain JavaScript with no Electron in it, which is why
`test/app-ops.js` can test it directly.

Every reply is matched by `id`, and both ends treat a malformed or unmatched frame as a non-event
rather than throwing — an uncaught throw in main's frame handler takes the whole Electron process
down, and a reply without an `id` is one the caller's pending promise can never match, which is what
left the Run button stuck. The worker also shuts down on `end` as well as `close`, because a host
that quits without sending the close op leaves the pipe half-open and an open swarm would keep the
process alive with its tmp store.

| | |
| --- | --- |
| `main.js` | Electron main, the worker, the frame pump |
| `preload.js`, `renderer.js`, `index.html` | the window; no map logic |
| `worker.js` | the bare process the library runs in |
| `ops.js` | the one file that calls maps-bee |

## Settings, and why

In `ops.js`:

| | | |
| --- | ---: | --- |
| `PREFETCH_LEVELS` | 1 | Level 1 is effectively free — its nodes are the root the first preview fetches anyway — and shaves a fraction of a second off that read. Level 2 costs megabytes up front to save a little per preview after the first, so it does not break even until many previews in one session. Re-measure with `probe.js --levels=` before changing it. |
| `TIMEOUT` | 10000 | `opts.timeout`, per block read |
| `DEADLINE` | 30000 | `opts.deadline`, the whole call, and the connect timeout |

One note for anyone reading this as a model: `ops.js` requires `../lib/preview`,
`../lib/net/client` and `../lib/net/report` by path rather than going through `index.js`. It wants
`report.js`'s line formatters so its log matches the probe's byte for byte, and those are
deliberately not part of the client surface. A consumer that does not need to print probe lines
should require the package.
