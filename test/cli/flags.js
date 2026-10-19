'use strict'
const test = require('brittle')
const { parseFlags, intFlag, bootstrapFlag, parseBootstrap, parsePoints } = require('../../bin/flags')

test('parseFlags keeps known flags with their value or null and rejects the rest', (t) => {
  const { flags } = parseFlags(['--a', '--b=12', 'x', 'y'], ['--a', '--b'])
  t.is(flags.get('--a'), null)
  t.is(flags.get('--b'), '12')
  t.is(flags.size, 2)
  t.exception(() => parseFlags(['--c=1'], ['--a']), /unknown flag --c/)
})

test('parseFlags returns the positionals in order, so callers stop re-deriving them', (t) => {
  const { args } = parseFlags(['--a', 'x', '--b=12', 'y', 'z'], ['--a', '--b'])
  t.alike(args, ['x', 'y', 'z'])
  t.alike(parseFlags([], []).args, [])
  // a value that looks like a flag stays with its flag, not in args
  t.alike(parseFlags(['--b=--a', 'x'], ['--a', '--b']).args, ['x'])
})

test('intFlag takes a non-negative integer at or above min and nothing else', (t) => {
  const f = (v) => intFlag(parseFlags(v === undefined ? [] : [v === null ? '--n' : `--n=${v}`], ['--n']).flags, '--n', 1)
  t.is(f(undefined), undefined)
  t.is(f('1'), 1)
  t.is(f('20000'), 20000)
  for (const bad of [null, '', '0', '-1', '1.5', 'abc', '1e3']) {
    t.exception(() => f(bad), /--n must be an integer >= 1/, `rejects ${JSON.stringify(bad)}`)
  }
  t.is(intFlag(parseFlags(['--n=0'], ['--n']).flags, '--n', 0), 0)
})

// The node list is what puts a seeder, a probe and the example app on the same private DHT, so a
// value that parses wrongly does not fail — it silently joins a different network and nothing
// finds anything. An absent flag must stay undefined: an empty list would make hyperdht bootstrap
// off nothing at all, which is not the same as the public DHT.
test('bootstrapFlag parses host:port lists and rejects anything else', (t) => {
  const f = (v) => bootstrapFlag(parseFlags(v === null ? ['--b'] : [`--b=${v}`], ['--b']).flags, '--b')
  t.is(bootstrapFlag(parseFlags([], ['--b']).flags, '--b'), undefined, 'absent is the public DHT')
  t.alike(f('127.0.0.1:49737'), [{ host: '127.0.0.1', port: 49737 }])
  t.alike(f('127.0.0.1:1,10.0.0.2:65535'), [{ host: '127.0.0.1', port: 1 }, { host: '10.0.0.2', port: 65535 }])
  for (const bad of [null, '', 'nope', ':1', '1.2.3.4', '1.2.3.4:0', '1.2.3.4:65536', '1.2.3.4:x']) {
    t.exception(() => f(bad), /--b/, `rejects ${JSON.stringify(bad)}`)
  }
})

// the same parse behind the app's MAPS_BOOTSTRAP, where the error has to name the variable
// rather than a flag the user never typed
test('parseBootstrap names its source in the error', (t) => {
  t.alike(parseBootstrap('127.0.0.1:49737', 'MAPS_BOOTSTRAP'), [{ host: '127.0.0.1', port: 49737 }])
  t.exception(() => parseBootstrap('nope', 'MAPS_BOOTSTRAP'), /MAPS_BOOTSTRAP: bad node nope/)
  t.exception(() => parseBootstrap('', 'MAPS_BOOTSTRAP'), /MAPS_BOOTSTRAP must be host:port/)
})

test('parsePoints takes lat,lon pairs and rejects the rest', (t) => {
  t.alike(parsePoints(['26.9,75.8', '-33.8688,151.2093']), [{ lat: 26.9, lon: 75.8 }, { lat: -33.8688, lon: 151.2093 }])
  t.alike(parsePoints([]), [])
  // '26.9,' and a third component were both accepted silently: Number('') is 0, so the first
  // became lon 0 in the Gulf of Guinea, which the atlas answers at z10
  for (const bad of ['26.9', '26.9,', ',75.8', 'a,b', '', '26.9,75.8,1']) {
    t.exception(() => parsePoints([bad]), /want lat,lon/, `rejects ${JSON.stringify(bad)}`)
  }
})
