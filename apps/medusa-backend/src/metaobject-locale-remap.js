'use strict'

const LANGS = ['en', 'de', 'tr', 'fr', 'it', 'es']

function looksFrench(s) {
  const t = String(s || '')
  return /[éèêëàùçœæîï]/i.test(t)
}

function looksSpanish(s) {
  const t = String(s || '')
  return /[ñáíóúü¿¡]/i.test(t) || /ción\b|idad\b/i.test(t)
}

function looksTurkish(s) {
  return /[ğüşıöçĞÜŞİÖÇ]/.test(String(s || ''))
}

function looksGerman(s) {
  return /[äöüßÄÖÜ]/.test(String(s || ''))
}

function foldLang(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/i̇/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function looksLikelyTurkish(s) {
  if (looksTurkish(s)) return true
  return /\b(hacim|gerilim|lezzet|koku|stil|kesmek|yaka|kapasite|doldurma|tasarim|parca|icerik|malzeme|sona ermek)\b/.test(foldLang(s))
}

const ENGLISH_CATALOG_LABELS = new Set([
  'size', 'shoe size', 'length', 'width', 'height', 'capacity', 'volume', 'voltage', 'wattage',
  'flavor', 'scent', 'pattern', 'style', 'version', 'edition', 'pack size', 'number of pieces',
  'set contents', 'outer material', 'inner material', 'coating', 'sole', 'filling', 'fabric',
  'finish', 'surface', 'design', 'fit', 'collar', 'sleeve length', 'cut', 'print', 'material', 'model',
])

function looksEnglishCatalogLabel(s) {
  return ENGLISH_CATALOG_LABELS.has(foldLang(s))
}

/** True when Excel EN/DE/TR/FR/IT/ES was stored as DE/EN/FR/ES/IT/TR. */
function shouldRemapSwappedImportLocales(def) {
  const i18n = def && def.label_i18n && typeof def.label_i18n === 'object' ? def.label_i18n : null
  if (!i18n) return false
  if (!(i18n.en && i18n.fr && i18n.es && i18n.it && i18n.tr)) return false
  const fr = i18n.fr && i18n.fr.label
  const tr = i18n.tr && i18n.tr.label
  const es = i18n.es && i18n.es.label
  const en = i18n.en && i18n.en.label
  const label = def.label
  if (looksFrench(fr) && !looksTurkish(fr) && !looksLikelyTurkish(fr)) return false
  // Already corrected: English lives in the en slot, catalog label is German (or at least not the English title).
  if (looksEnglishCatalogLabel(en) && !looksEnglishCatalogLabel(label)) return false
  if (looksEnglishCatalogLabel(label) && looksEnglishCatalogLabel(en) && !looksLikelyTurkish(fr)) return false
  return looksEnglishCatalogLabel(label) && (
    looksGerman(en) || looksLikelyTurkish(fr) || looksSpanish(tr) || looksFrench(es) || !looksEnglishCatalogLabel(en)
  )
}

function pickLabel(def, lang) {
  if (lang === 'de') return String(def.label || '').trim()
  const i18n = def.label_i18n && typeof def.label_i18n === 'object' ? def.label_i18n : {}
  return String((i18n[lang] && i18n[lang].label) || '').trim()
}

function pickValue(def, lang, canonical) {
  if (lang === 'de') return String(canonical || '').trim()
  const i18n = def.values_i18n && typeof def.values_i18n === 'object' ? def.values_i18n : {}
  const map = i18n[lang] && typeof i18n[lang] === 'object' ? i18n[lang] : {}
  return String(map[canonical] || map[String(canonical || '').trim()] || '').trim()
}

/**
 * Stored slots (wrong): de=EN, en=DE, fr=TR, es=FR, it=IT, tr=ES
 * Correct:              de=DE, en=EN, tr=TR, fr=FR, it=IT, es=ES
 */
function remapSwappedImportLocales(def) {
  if (!def || typeof def !== 'object') return { def, valueMap: {} }
  const labels = {
    en: pickLabel(def, 'de'),
    de: pickLabel(def, 'en'),
    tr: pickLabel(def, 'fr'),
    fr: pickLabel(def, 'es'),
    it: pickLabel(def, 'it'),
    es: pickLabel(def, 'tr'),
  }
  const label_i18n = {}
  for (const loc of ['en', 'tr', 'fr', 'it', 'es']) {
    if (labels[loc]) label_i18n[loc] = { label: labels[loc] }
  }

  const values = Array.isArray(def.values) ? def.values : []
  const newValues = []
  const newValuesI18n = { en: {}, tr: {}, fr: {}, it: {}, es: {} }
  const valueMap = {}
  for (const oldCanon of values) {
    const translations = {
      en: pickValue(def, 'de', oldCanon),
      de: pickValue(def, 'en', oldCanon),
      tr: pickValue(def, 'fr', oldCanon),
      fr: pickValue(def, 'es', oldCanon),
      it: pickValue(def, 'it', oldCanon),
      es: pickValue(def, 'tr', oldCanon),
    }
    const newCanon = translations.de || String(oldCanon || '').trim()
    if (!newCanon) continue
    valueMap[String(oldCanon)] = newCanon
    if (!newValues.some((v) => String(v).toLowerCase() === newCanon.toLowerCase())) newValues.push(newCanon)
    for (const loc of ['en', 'tr', 'fr', 'it', 'es']) {
      if (translations[loc]) newValuesI18n[loc][newCanon] = translations[loc]
    }
  }
  const cleanedI18n = {}
  for (const loc of Object.keys(newValuesI18n)) {
    if (Object.keys(newValuesI18n[loc]).length) cleanedI18n[loc] = newValuesI18n[loc]
  }
  return {
    def: {
      ...def,
      label: labels.de || def.label,
      label_i18n: Object.keys(label_i18n).length ? label_i18n : null,
      values: newValues,
      values_i18n: Object.keys(cleanedI18n).length ? cleanedI18n : null,
    },
    valueMap,
  }
}

function remapMetafieldList(list, mapsByKey) {
  if (!Array.isArray(list)) return { list, changed: 0 }
  let changed = 0
  const next = list.map((row) => {
    if (!row || typeof row !== 'object') return row
    const key = String(row.key || '').trim()
    const value = row.value
    const map = mapsByKey[key]
    if (!map || value == null) return row
    const raw = String(value)
    const mapped = map[raw]
    if (mapped == null || mapped === raw) return row
    changed += 1
    return { ...row, value: mapped }
  })
  return { list: next, changed }
}

module.exports = {
  LANGS,
  shouldRemapSwappedImportLocales,
  remapSwappedImportLocales,
  remapMetafieldList,
}
