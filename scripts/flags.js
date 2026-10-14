'use strict'

// --name or --name=value; a flag outside names is an error
function parseFlags (argv, names) {
  const flags = new Map()
  for (const a of argv.filter((s) => s.startsWith('--'))) {
    const i = a.indexOf('=')
    const name = i === -1 ? a : a.slice(0, i)
    if (!names.includes(name)) throw new Error(`unknown flag ${name}`)
    flags.set(name, i === -1 ? null : a.slice(i + 1))
  }
  return flags
}

// a bare flag or an empty value is an error, not 0: Number(null) and Number('') are both 0
function intFlag (flags, name, min) {
  if (!flags.has(name)) return undefined
  const v = flags.get(name)
  if (v === null || !/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer >= ${min}`)
  return Number(v)
}

module.exports = { parseFlags, intFlag }
