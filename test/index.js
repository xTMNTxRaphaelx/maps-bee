'use strict'
const test = require('brittle')

test.pause()
require('./keys')
require('./archive')
require('./value-size')
require('./multisig')
require('./sparse-read')
require('./sparse-z8-block')
require('./sparse-swarm')
require('./gazetteer')
require('./preview')
test.resume()
