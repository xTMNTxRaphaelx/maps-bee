'use strict'

// --name or --name=value; a flag outside names is an error. One walk returns both halves: every
// caller needs the positionals, and each one that re-derived them wrote the inverse of this test.
function parseFlags (argv, names) {
  const flags = new Map()
  const args = []
  for (const a of argv) {
    if (!a.startsWith('--')) {
      args.push(a)
      continue
    }
    const i = a.indexOf('=')
    const name = i === -1 ? a : a.slice(0, i)
    if (!names.includes(name)) throw new Error(`unknown flag ${name}`)
    flags.set(name, i === -1 ? null : a.slice(i + 1))
  }
  return { flags, args }
}

// a bare flag or an empty value is an error, not 0: Number(null) and Number('') are both 0
function intFlag (flags, name, min) {
  if (!flags.has(name)) return undefined
  const v = flags.get(name)
  if (v === null || !/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer >= ${min}`)
  return Number(v)
}

// host:port[,host:port] into the node list hyperswarm and hyperdht take as `bootstrap`. Split out
// of bootstrapFlag because the example app takes the same value from an environment variable
// rather than a flag, and a second copy of this parse would be a second place to get it wrong.
// `label` names the source in the error, so it can read --bootstrap or MAPS_BOOTSTRAP.
function parseBootstrap (value, label) {
  if (value === null || value === '') throw new Error(`${label} must be host:port[,host:port]`)
  return value.split(',').map((node) => {
    const i = node.lastIndexOf(':')
    const port = Number(node.slice(i + 1))
    if (i < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}: bad node ${node}, want host:port`)
    return { host: node.slice(0, i), port }
  })
}

// Undefined means the public DHT; an empty list would instead make hyperdht bootstrap off nothing.
function bootstrapFlag (flags, name) {
  if (!flags.has(name)) return undefined
  return parseBootstrap(flags.get(name), name)
}

// "lat,lon" positionals into points. Shared by probe.js and local-check.js, which both take a
// list of them after their flags.
//
// The part count and the empty check carry their weight: Number('') is 0, the same trap intFlag
// guards above, so "26.9," read as lat 26.9 lon 0 — a point in the Gulf of Guinea, which the
// atlas holds at z10, so a trailing comma returned a plausible ocean preview instead of an error.
// A third component was dropped in silence for the same reason.
function parsePoints (args) {
  return args.map((s) => {
    const parts = s.split(',')
    const [lat, lon] = parts.map(Number)
    if (parts.length !== 2 || parts.some((p) => p.trim() === '') || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`bad point ${s}, want lat,lon`)
    }
    return { lat, lon }
  })
}

module.exports = { parseFlags, intFlag, bootstrapFlag, parseBootstrap, parsePoints }
