'use strict'

const PLACEHOLDER_HANDLE_RE = /^(untitled|unbenannt|product|produkt)$/i

function isPlaceholderHandle(value) {
  const t = String(value || '').trim()
  return !t || PLACEHOLDER_HANDLE_RE.test(t)
}

/** Shop URLs are {handle}-a-{8} or legacy {handle}-{8}. */
function parseProductUrlHandle(urlHandle) {
  const full = String(urlHandle || '').trim()
  if (!full) return { full: '', base: '', shortCode: '' }
  const lastDash = full.lastIndexOf('-')
  if (lastDash < 1) return { full, base: full, shortCode: '' }
  const suffix = full.slice(lastDash + 1)
  if (!/^[a-z0-9]{8}$/i.test(suffix)) return { full, base: full, shortCode: '' }
  const withoutSuffix = full.slice(0, lastDash)
  const base = withoutSuffix.toLowerCase().endsWith('-a')
    ? withoutSuffix.slice(0, -2)
    : withoutSuffix
  return { full, base, shortCode: suffix.toLowerCase() }
}

function resolveNonPlaceholderHandle(existingHandle, fromTitle) {
  if (!isPlaceholderHandle(existingHandle)) return String(existingHandle || '').trim()
  const next = String(fromTitle || '').trim()
  if (next && !isPlaceholderHandle(fromTitle)) return next
  return String(existingHandle || '').trim()
}

function patchPlaceholderTranslationHandles(metadataObj, canonicalHandle, slugify) {
  if (!metadataObj || typeof metadataObj !== 'object') return metadataObj
  const tr = metadataObj.translations
  if (!tr || typeof tr !== 'object') return metadataObj
  const nextTr = { ...tr }
  for (const loc of Object.keys(nextTr)) {
    const row = nextTr[loc]
    if (!row || typeof row !== 'object') continue
    if (!isPlaceholderHandle(row.handle)) continue
    const fromTitle = typeof slugify === 'function' ? slugify(row.title) : ''
    nextTr[loc] = {
      ...row,
      handle: (!isPlaceholderHandle(fromTitle) ? fromTitle : '') || canonicalHandle || '',
    }
  }
  metadataObj.translations = nextTr
  return metadataObj
}

module.exports = {
  isPlaceholderHandle,
  parseProductUrlHandle,
  resolveNonPlaceholderHandle,
  patchPlaceholderTranslationHandles,
}
