'use strict'
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const {
  shouldRemapSwappedImportLocales,
  remapSwappedImportLocales,
  remapMetafieldList,
} = require('../src/metaobject-locale-remap')

const envPath = path.join(__dirname, '..', '.env')
const envText = fs.readFileSync(envPath, 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (!m) continue
  process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim()
}

function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return fallback }
}

async function main() {
  const dry = process.argv.includes('--dry-run')
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await c.connect()
  const defs = await c.query('SELECT key, label, values, label_i18n, values_i18n FROM admin_hub_metafield_definitions')
  const mapsByKey = {}
  const remapped = []
  const skipped = []
  for (const row of defs.rows) {
    if (!shouldRemapSwappedImportLocales(row)) {
      if (row.label_i18n) skipped.push({ key: row.key, label: row.label, fr: row.label_i18n?.fr?.label, en: row.label_i18n?.en?.label })
      continue
    }
    const { def, valueMap } = remapSwappedImportLocales(row)
    mapsByKey[row.key] = valueMap
    remapped.push({ key: row.key, from: row.label, to: def.label })
    if (!dry) {
      await c.query(
        `UPDATE admin_hub_metafield_definitions
         SET label = $2, values = $3::jsonb, label_i18n = $4::jsonb, values_i18n = $5::jsonb, updated_at = now()
         WHERE key = $1`,
        [row.key, def.label, JSON.stringify(def.values || []), def.label_i18n ? JSON.stringify(def.label_i18n) : null, def.values_i18n ? JSON.stringify(def.values_i18n) : null],
      )
    }
  }

  const products = await c.query('SELECT id, metadata, variants FROM admin_hub_products')
  let productMf = 0
  let variantMf = 0
  for (const p of products.rows) {
    const meta = parseJson(p.metadata, {}) || {}
    const { meta: nextMeta, changed } = (() => {
      if (!Array.isArray(meta.metafields)) return { meta, changed: 0 }
      const r = remapMetafieldList(meta.metafields, mapsByKey)
      if (!r.changed) return { meta, changed: 0 }
      return { meta: { ...meta, metafields: r.list }, changed: r.changed }
    })()
    let variants = parseJson(p.variants, [])
    let vChanged = 0
    if (Array.isArray(variants)) {
      variants = variants.map((v) => {
        if (!v || typeof v !== 'object') return v
        const vm = v.metadata && typeof v.metadata === 'object' ? v.metadata : null
        if (!vm || !Array.isArray(vm.metafields)) return v
        const r = remapMetafieldList(vm.metafields, mapsByKey)
        if (!r.changed) return v
        vChanged += r.changed
        return { ...v, metadata: { ...vm, metafields: r.list } }
      })
    }
    productMf += changed
    variantMf += vChanged
    if (!dry && (changed || vChanged)) {
      await c.query(
        'UPDATE admin_hub_products SET metadata = $2::jsonb, variants = $3::jsonb, updated_at = now() WHERE id = $1',
        [p.id, JSON.stringify(nextMeta), JSON.stringify(variants)],
      )
    }
  }

  console.log(JSON.stringify({
    dry,
    definitions: remapped.length,
    remapped: remapped,
    skipped,
    productMetafields: productMf,
    variantMetafields: variantMf,
  }, null, 2))
  await c.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
