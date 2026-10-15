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

module.exports = { parseFlags, intFlag }
