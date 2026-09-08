'use strict'
const logger = require('./logger')

const ALLOWED = new Set(['en', 'de', 'tr', 'fr', 'es', 'it'])
const CHUNK_SIZE = 50

function normalizeLocale(loc) {
  const l = String(loc || '').toLowerCase().slice(0, 2)
  return ALLOWED.has(l) ? l : ''
}

function deepLang(loc) {
  const u = String(loc || 'en').toUpperCase()
  const m = { EN: 'EN', DE: 'DE', TR: 'TR', FR: 'FR', IT: 'IT', ES: 'ES' }
  return m[u.slice(0, 2)] || 'EN'
}

async function ensureCacheTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS i18n_translation_cache (
      source_lang VARCHAR(8) NOT NULL,
      target_lang VARCHAR(8) NOT NULL,
      source_text TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_lang, target_lang, source_text)
    )
  `)
}

async function loadFromCache(client, texts, sourceLang, targetLang) {
  const map = new Map()
  const unique = [...new Set((texts || []).map((t) => String(t || '').trim()).filter(Boolean))]
  if (!unique.length) return map
  for (let i = 0; i < unique.length; i += 400) {
    const chunk = unique.slice(i, i + 400)
    const r = await client.query(
      `SELECT source_text, translated_text FROM i18n_translation_cache
       WHERE source_lang = $1 AND target_lang = $2 AND source_text = ANY($3::text[])`,
      [sourceLang, targetLang, chunk],
    )
    for (const row of r.rows || []) {
      if (row.source_text && row.translated_text) map.set(row.source_text, row.translated_text)
    }
  }
  return map
}

async function savePairsToCache(client, sourceLang, targetLang, pairs) {
  for (const [src, tr] of pairs) {
    const source_text = String(src || '').trim()
    const translated_text = String(tr || '').trim()
    if (!source_text || !translated_text) continue
    await client.query(
      `INSERT INTO i18n_translation_cache (source_lang, target_lang, source_text, translated_text, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (source_lang, target_lang, source_text)
       DO UPDATE SET translated_text = EXCLUDED.translated_text, updated_at = NOW()`,
      [sourceLang, targetLang, source_text, translated_text],
    )
  }
}

async function deeplTranslateBatch(texts, sourceLocale, targetLocale, opts = {}) {
  const key = String(process.env.DEEPL_AUTH_KEY || '').trim()
  if (!key || !texts.length) return texts.map(() => null)
  const baseUrl =
    String(process.env.DEEPL_API_URL || '').trim() ||
    (key.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate')
  const params = new URLSearchParams()
  params.set('auth_key', key)
  params.set('target_lang', deepLang(targetLocale))
  if (sourceLocale) params.set('source_lang', deepLang(sourceLocale))
  if (opts.html) params.set('tag_handling', 'html')
  for (const t of texts) params.append('text', t)
  const r = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.message || `DeepL HTTP ${r.status}`)
  const out = (j.translations || []).map((x) => String(x?.text || '').trim())
  while (out.length < texts.length) out.push(null)
  return out
}

/**
 * Translate texts sourceLang → targetLang. Hits DeepL only for cache misses.
 * Returns an array aligned with `texts` (null when a row could not be translated).
 */
async function translateTexts(texts, sourceLang, targetLang, opts = {}) {
  const src = normalizeLocale(sourceLang)
  const tgt = normalizeLocale(targetLang)
  const list = (texts || []).map((t) => String(t || ''))
  if (!src || !tgt || src === tgt) return list.map((t) => t || null)
  const unique = [...new Set(list.map((t) => t.trim()).filter(Boolean))]
  if (!unique.length) return list.map(() => null)

  let client = opts.pgClient || null
  let ownsClient = false
  if (!client && opts.pgClient !== false) {
    try {
      const { getPooledClient } = require('./db-pool')
      client = getPooledClient()
      if (client) {
        ownsClient = true
        await client.connect()
      }
    } catch (_) {
      client = null
    }
  }

  let cached = new Map()
  try {
    if (client) {
      await ensureCacheTable(client)
      cached = await loadFromCache(client, unique, src, tgt)
    }
    const missing = unique.filter((t) => !cached.has(t))
    const batchFn = typeof opts.translateBatch === 'function' ? opts.translateBatch : deeplTranslateBatch
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE)
      try {
        const translated = await batchFn(chunk, src, tgt, { html: !!opts.html })
        const pairs = []
        for (let j = 0; j < chunk.length; j++) {
          const tr = translated[j]
          if (tr) {
            cached.set(chunk[j], tr)
            pairs.push([chunk[j], tr])
          }
        }
        if (client && pairs.length) await savePairsToCache(client, src, tgt, pairs)
      } catch (e) {
        logger.warn('deepl-translate chunk failed:', e?.message || e)
      }
    }
  } finally {
    if (ownsClient && client) await client.end().catch(() => {})
  }

  return list.map((t) => {
    const k = String(t || '').trim()
    return k ? (cached.get(k) || null) : null
  })
}

module.exports = {
  translateTexts,
  deeplTranslateBatch,
  normalizeLocale,
  ALLOWED_LOCALES: [...ALLOWED],
}
