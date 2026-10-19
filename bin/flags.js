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

// host:port[,host:port] into the node list hyperswarm and hyperdht take as `bootstrap`. Undefined
// means the public DHT; an empty list would instead make hyperdht bootstrap off nothing at all.
function bootstrapFlag (flags, name) {
  if (!flags.has(name)) return undefined
  const v = flags.get(name)
  if (v === null || v === '') throw new Error(`${name} must be host:port[,host:port]`)
  return v.split(',').map((node) => {
    const i = node.lastIndexOf(':')
    const port = Number(node.slice(i + 1))
    if (i < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}: bad node ${node}, want host:port`)
    return { host: node.slice(0, i), port }
  })
}

// "lat,lon" positionals into points. Shared by probe.js and local-check.js, which both take a
// list of them after their flags.
function parsePoints (args) {
  return args.map((s) => {
    const [lat, lon] = s.split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`bad point ${s}, want lat,lon`)
    return { lat, lon }
  })
}

module.exports = { parseFlags, intFlag, bootstrapFlag, parsePoints }
