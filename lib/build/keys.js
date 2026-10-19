'use strict'
// Generates TEST-ONLY ed25519 key pairs for the multisig prototype. Never use for a real publish.
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const NAMES = ['a', 'b', 'c']

function generate (dir) {
  fs.mkdirSync(dir, { recursive: true })
  // every name checked before any is written. Checking inside the write loop instead would write
  // a and b, then throw on an existing c, and the surviving set no longer derives the core key
  // the old set published under — a refusal that has already done the damage it refuses.
  for (const name of NAMES) {
    const file = path.join(dir, name + '.json')
    if (fs.existsSync(file)) throw new Error(`${file} exists; refusing to overwrite`)
  }
  for (const name of NAMES) {
    const file = path.join(dir, name + '.json')
    const kp = crypto.keyPair()
    const json = {
      label: 'TEST KEY, prototype only',
      name,
      publicKey: b4a.toString(kp.publicKey, 'hex'),
      secretKey: b4a.toString(kp.secretKey, 'hex')
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 })
    console.log(`${name} ${json.publicKey}`)
  }
}

function load (dir) {
  return NAMES.map((name) => {
    const json = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'))
    return { publicKey: b4a.from(json.publicKey, 'hex'), secretKey: b4a.from(json.secretKey, 'hex') }
  })
}

module.exports = { generate, load }
