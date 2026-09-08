'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  isPlaceholderHandle,
  parseProductUrlHandle,
  resolveNonPlaceholderHandle,
  patchPlaceholderTranslationHandles,
} = require('./product-url-handle')

describe('product-url-handle', () => {
  it('treats untitled/unbenannt as placeholder handles', () => {
    assert.equal(isPlaceholderHandle('untitled'), true)
    assert.equal(isPlaceholderHandle('Untitled'), true)
    assert.equal(isPlaceholderHandle('aaa-Mt-Test'), false)
  })

  it('parses shop suffix URLs to base handle + id short code', () => {
    assert.deepEqual(parseProductUrlHandle('untitled-a-262da543'), {
      full: 'untitled-a-262da543',
      base: 'untitled',
      shortCode: '262da543',
    })
    assert.deepEqual(parseProductUrlHandle('aaa-Mt-Test-a-262da543').shortCode, '262da543')
    assert.equal(parseProductUrlHandle('aaa-Mt-Test-a-262da543').base, 'aaa-Mt-Test')
    assert.equal(parseProductUrlHandle('legacy-handle-262da543').base, 'legacy-handle')
    assert.equal(parseProductUrlHandle('plain-slug').shortCode, '')
  })

  it('replaces placeholder handles from a real title slug', () => {
    assert.equal(resolveNonPlaceholderHandle('untitled', 'aaa-mt-test'), 'aaa-mt-test')
    assert.equal(resolveNonPlaceholderHandle('keep-me', 'other'), 'keep-me')
  })

  it('rewrites placeholder translation handles', () => {
    const meta = {
      translations: {
        de: { title: 'aaa Mt Test', handle: 'untitled' },
        en: { title: 'MtSHop Product', handle: 'mtshop-Product' },
      },
    }
    patchPlaceholderTranslationHandles(meta, 'aaa-mt-test', (t) => String(t || '').toLowerCase().replace(/\s+/g, '-'))
    assert.equal(meta.translations.de.handle, 'aaa-mt-test')
    assert.equal(meta.translations.en.handle, 'mtshop-Product')
  })
})
