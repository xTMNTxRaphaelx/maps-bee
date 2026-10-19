'use strict'
const FramedStream = require('framed-stream')
const { createOps, serve } = require('./ops')

const pipe = new FramedStream(Bare.IPC)
const ops = createOps()
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
