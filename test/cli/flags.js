'use strict'
const test = require('brittle')
const { parseFlags, intFlag } = require('../../bin/flags')

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
