'use strict'
const env = require('bare-env')
const FramedStream = require('framed-stream')
const { parseBootstrap } = require('../bin/flags')
const { createOps, serve } = require('./ops')

// Unset means the public DHT, which is what a real consumer uses. MAPS_BOOTSTRAP points the app
// at a private one instead — bin/testnet.js prints a line to paste here — so the app can be shown
// working on a machine whose DHT reachability is in question, which seed.js and probe.js could
// already do via --bootstrap and this could not.
const bootstrap = env.MAPS_BOOTSTRAP ? parseBootstrap(env.MAPS_BOOTSTRAP, 'MAPS_BOOTSTRAP') : undefined

const pipe = new FramedStream(Bare.IPC)
const ops = createOps({ bootstrap })
serve(pipe, ops)

// A host that quits without the close op (Cmd+Q, a crash) only ends the pipe: the worker's writable side
// stays open so no close event follows, and an open swarm would keep this process alive with its tmp store.
// close() removes the tmp store, so a failure here is the one app/README calls an acceptance
// criterion: report it and exit non-zero rather than leaving an unhandled rejection racing exit()
let closing = null
const shutdown = () => {
  if (closing) return
  closing = ops.close().catch((err) => {
    console.error(err)
    Bare.exitCode = 1
  }).finally(() => Bare.exit())
}
pipe.on('end', shutdown)
pipe.on('close', shutdown)
