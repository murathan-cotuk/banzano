'use strict'

/**
 * Affiliate platform module facade. PR 1 only wires up what already exists (schema, config,
 * attribution-engine, commission-calculator, codes) — affiliate/link/click CRUD lands in PR 2/3,
 * once there's a tracking middleware and portal actually calling it. Import from here rather than
 * reaching into individual files directly, so call sites don't need to change when PR 2+ adds the
 * DB-backed methods around this pure logic.
 */

const config = require('./config')
const { ensureAffiliateTables } = require('./schema')
const attributionEngine = require('./attribution-engine')
const commissionCalculator = require('./commission-calculator')
const codes = require('./codes')

module.exports = {
  config,
  ensureAffiliateTables,
  attributionEngine,
  commissionCalculator,
  codes,
}
