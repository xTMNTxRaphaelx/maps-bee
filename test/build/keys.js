'use strict'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const { generate, load } = require('../../lib/build/keys')

const TMP = path.join(__dirname, '..', '..', 'store', 'tmp')

function tmpDir (t, name) {
  fs.mkdirSync(TMP, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, name + '-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('generate writes three key pairs load round-trips', (t) => {
  const dir = tmpDir(t, 'keys-generate')
  const lines = []
  const log = console.log
  console.log = (l) => lines.push(l)
  try {
    generate(dir)
  } finally {
    console.log = log
  }

  t.alike(fs.readdirSync(dir).sort(), ['a.json', 'b.json', 'c.json'], 'one file per signer')
  t.is(lines.length, 3, 'prints a public key per signer')

  const pairs = load(dir)
  t.is(pairs.length, 3)
  for (const { publicKey, secretKey } of pairs) {
    t.is(publicKey.byteLength, 32)
    t.is(secretKey.byteLength, 64)
  }
  const printed = lines.map((l) => l.split(' ')[1])
  t.alike(printed, pairs.map((p) => b4a.toString(p.publicKey, 'hex')), 'load returns the keys generate printed')
})

// the secret halves of a key set are in these files; a mode that let the rest of the machine read
// them would be a silent downgrade, and nothing else in the suite opens a generated key set
test('generate writes the key files owner-only', (t) => {
  const dir = tmpDir(t, 'keys-mode')
  const log = console.log
  console.log = () => {}
  try {
    generate(dir)
  } finally {
    console.log = log
  }
  for (const name of ['a', 'b', 'c']) {
    t.is(fs.statSync(path.join(dir, name + '.json')).mode & 0o777, 0o600, `${name}.json is 0600`)
  }
})

// regenerating over a populated directory would mint new keys under the old ones' name, and every
// core already signed by the set becomes unpublishable with no error at the point of loss
test('generate refuses to overwrite an existing key set', (t) => {
  const dir = tmpDir(t, 'keys-overwrite')
  const log = console.log
  console.log = () => {}
  try {
    generate(dir)
    const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8')
    t.exception(() => generate(dir), /refusing to overwrite/)
    t.is(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before, 'the first key set is untouched')
  } finally {
    console.log = log
  }
})

// The dangerous case is the half-populated directory, not the full one: a per-file check inside
// the write loop mints a and b, then refuses on c, and the surviving set derives a different core
// key from the one c was already publishing under. The refusal has to come before any write.
test('generate refuses a partially populated directory without writing anything', (t) => {
  const dir = tmpDir(t, 'keys-partial')
  const log = console.log
  console.log = () => {}
  try {
    fs.writeFileSync(path.join(dir, 'c.json'), '{"name":"c"}\n')
    t.exception(() => generate(dir), /refusing to overwrite/)
    t.alike(fs.readdirSync(dir).sort(), ['c.json'], 'a.json and b.json were never written')
    t.is(fs.readFileSync(path.join(dir, 'c.json'), 'utf8'), '{"name":"c"}\n', 'and c is untouched')
  } finally {
    console.log = log
  }
})
