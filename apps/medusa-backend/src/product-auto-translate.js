'use strict'

const { translateTexts: defaultTranslateTexts } = require('./deepl-translate')
const logger = require('./logger')

const LOCALES = ['de', 'en', 'tr', 'fr', 'es', 'it']
const AUTO_KEY = '_auto'
const PLACEHOLDER_RE = /^(untitled|unbenannt)$/i

function normalizeLocale(loc) {
  const l = String(loc || '').toLowerCase().slice(0, 2)
  return LOCALES.includes(l) ? l : ''
}

function isPlaceholderTitle(value) {
  const t = String(value || '').trim()
  return !t || PLACEHOLDER_RE.test(t)
}

function isEmptyHtml(value) {
  const t = String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return !t
}

function coerceBullets(list) {
  if (!Array.isArray(list)) return []
  return list.map((b) => String(b || '').trim()).filter(Boolean)
}

function realTitle(value) {
  const t = String(value || '').trim()
  return isPlaceholderTitle(t) ? '' : t
}

function autoMap(tr) {
  return (tr && tr[AUTO_KEY] && typeof tr[AUTO_KEY] === 'object') ? { ...tr[AUTO_KEY] } : {}
}

function pickSourceLocale(translations, canonicalTitle, hinted) {
  const hint = normalizeLocale(hinted)
  if (hint && (realTitle(translations[hint]?.title) || !isEmptyHtml(translations[hint]?.description) || coerceBullets(translations[hint]?.bullet_points).length)) {
    return hint
  }
  if (realTitle(translations.de?.title) || realTitle(canonicalTitle)) return 'de'
  for (const loc of LOCALES) {
    if (realTitle(translations[loc]?.title) || !isEmptyHtml(translations[loc]?.description) || coerceBullets(translations[loc]?.bullet_points).length) {
      return loc
    }
  }
  return hint || 'de'
}

function sameText(a, b) {
  return String(a || '').trim() === String(b || '').trim()
}

function shouldFill(current, empty, wasAuto, sourceVal, tgt, src) {
  if (!sourceVal) return false
  if (wasAuto) return true
  if (empty) return true
  if (tgt !== src && sameText(current, sourceVal)) return true
  return false
}

/**
 * Fill empty (or previously auto-filled) locale title/description/bullets from the
 * source locale via DeepL. Manual translations are never overwritten.
 */
async function applyProductAutoTranslate(input, opts = {}) {
  const metadata = (input.metadata && typeof input.metadata === 'object') ? { ...input.metadata } : {}
  const translations = { ...(metadata.translations && typeof metadata.translations === 'object' ? metadata.translations : {}) }
  const prev = (opts.previousTranslations && typeof opts.previousTranslations === 'object') ? opts.previousTranslations : {}
  const src = pickSourceLocale(translations, input.title, opts.sourceLocale)
  const srcTr = { ...(translations[src] || {}) }
  const srcTitle = realTitle(srcTr.title) || (src === 'de' ? realTitle(input.title) : '')
  const srcDesc = !isEmptyHtml(srcTr.description)
    ? srcTr.description
    : (src === 'de' && !isEmptyHtml(input.description) ? input.description : '')
  const srcBullets = coerceBullets(srcTr.bullet_points)

  if (!srcTitle && isEmptyHtml(srcDesc) && srcBullets.length === 0) {
    return { metadata, translatedLocales: [], sourceLocale: src }
  }

  const translateTexts = typeof opts.translateTexts === 'function' ? opts.translateTexts : defaultTranslateTexts
  if (translateTexts === defaultTranslateTexts && !String(process.env.DEEPL_AUTH_KEY || '').trim()) {
    return { metadata, translatedLocales: [], sourceLocale: src }
  }
  const translatedLocales = []

  for (const tgt of LOCALES) {
    if (tgt === src) continue
    const cur = { ...(translations[tgt] || {}) }
    const prevAuto = autoMap(prev[tgt] || cur)
    const needTitle = shouldFill(cur.title, isPlaceholderTitle(cur.title), !!prevAuto.title, srcTitle, tgt, src)
    const needDesc = shouldFill(cur.description, isEmptyHtml(cur.description), !!prevAuto.description, isEmptyHtml(srcDesc) ? '' : srcDesc, tgt, src)
    const needBullets = shouldFill(
      coerceBullets(cur.bullet_points).join('\n'),
      coerceBullets(cur.bullet_points).length === 0,
      !!prevAuto.bullet_points,
      srcBullets.join('\n'),
      tgt,
      src,
    )

    const plain = []
    const plainKeys = []
    if (needTitle && srcTitle) {
      plain.push(srcTitle)
      plainKeys.push('title')
    }
    if (needBullets) {
      srcBullets.forEach((b, i) => {
        plain.push(b)
        plainKeys.push(`bullet:${i}`)
      })
    }

    let plainOut = []
    if (plain.length) {
      try {
        plainOut = await translateTexts(plain, src, tgt, { html: false, pgClient: opts.pgClient })
      } catch (e) {
        logger.warn('product-auto-translate plain failed:', e?.message || e)
        plainOut = plain.map(() => null)
      }
    }

    let descOut = null
    if (needDesc && !isEmptyHtml(srcDesc)) {
      try {
        const d = await translateTexts([srcDesc], src, tgt, { html: true, pgClient: opts.pgClient })
        descOut = d && d[0] ? d[0] : null
      } catch (e) {
        logger.warn('product-auto-translate html failed:', e?.message || e)
      }
    }

    let changed = false
    const next = { ...cur }
    const nextAuto = { ...prevAuto }

    if (needTitle && srcTitle) {
      const trTitle = plainOut[plainKeys.indexOf('title')]
      if (trTitle) {
        next.title = trTitle
        nextAuto.title = true
        changed = true
      }
    }
    if (needDesc && descOut) {
      next.description = descOut
      nextAuto.description = true
      changed = true
    }
    if (needBullets && srcBullets.length) {
      const bullets = []
      srcBullets.forEach((_, i) => {
        const tr = plainOut[plainKeys.indexOf(`bullet:${i}`)]
        if (tr) bullets.push(tr)
      })
      if (bullets.length) {
        next.bullet_points = bullets
        nextAuto.bullet_points = true
        changed = true
      }
    }

    if (changed) {
      if (Object.keys(nextAuto).length) next[AUTO_KEY] = nextAuto
      else delete next[AUTO_KEY]
      translations[tgt] = next
      translatedLocales.push(tgt)
    }
  }

  if (translations[src]) {
    const s = { ...translations[src] }
    if (s[AUTO_KEY]) {
      delete s[AUTO_KEY]
      translations[src] = s
    }
  }

  metadata.translations = translations
  const out = { metadata, translatedLocales, sourceLocale: src }
  const deTitle = realTitle(translations.de?.title)
  if (deTitle) out.title = deTitle
  if (!isEmptyHtml(translations.de?.description)) out.description = translations.de.description
  return out
}

module.exports = {
  applyProductAutoTranslate,
  pickSourceLocale,
  isPlaceholderTitle,
  isEmptyHtml,
  LOCALES,
}
