'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  applyProductAutoTranslate,
  pickSourceLocale,
  isPlaceholderTitle,
  isEmptyHtml,
} = require('./product-auto-translate')

describe('product-auto-translate', () => {
  it('treats Untitled as empty title', () => {
    assert.equal(isPlaceholderTitle('Untitled'), true)
    assert.equal(isPlaceholderTitle('aaa Mt Test'), false)
    assert.equal(isEmptyHtml('<p></p>'), true)
    assert.equal(isEmptyHtml('<p>Hello</p>'), false)
  })

  it('prefers the hinted locale when it has real content', () => {
    const tr = {
      de: { title: 'Untitled' },
      tr: { title: 'Kırmızı pamuklu tişört' },
    }
    assert.equal(pickSourceLocale(tr, 'Untitled', 'tr'), 'tr')
  })

  it('fills empty locales from the source language and marks them auto', async () => {
    const dict = {
      'de:en:Kırmızı pamuklu tişört': 'Red cotton t-shirt',
      'de:fr:Kırmızı pamuklu tişört': 'T-shirt en coton rouge',
      'de:es:Kırmızı pamuklu tişört': 'Camiseta de algodón rojo',
      'de:it:Kırmızı pamuklu tişört': 'T-shirt di cotone rosso',
      'de:en:<p>Yumuşak kumaş</p>': '<p>Soft fabric</p>',
      'de:fr:<p>Yumuşak kumaş</p>': '<p>Tissu doux</p>',
      'de:es:<p>Yumuşak kumaş</p>': '<p>Tela suave</p>',
      'de:it:<p>Yumuşak kumaş</p>': '<p>Tessuto morbido</p>',
    }
    const translateTexts = async (texts, src, tgt) => texts.map((t) => dict[`${src}:${tgt}:${t}`] || `TR(${tgt}) ${t}`)

    const applied = await applyProductAutoTranslate(
      {
        title: 'Untitled',
        description: '',
        metadata: {
          translations: {
            tr: { title: 'Kırmızı pamuklu tişört', description: '<p>Yumuşak kumaş</p>', bullet_points: ['Nefes alır'] },
            de: { title: 'Untitled' },
          },
        },
      },
      { sourceLocale: 'tr', translateTexts, pgClient: false },
    )

    assert.equal(applied.sourceLocale, 'tr')
    assert.ok(applied.translatedLocales.includes('de'))
    assert.ok(applied.translatedLocales.includes('en'))
    assert.equal(applied.metadata.translations.de.title, 'TR(de) Kırmızı pamuklu tişört')
    assert.equal(applied.metadata.translations.de._auto.title, true)
    assert.equal(applied.metadata.translations.en.title, 'TR(en) Kırmızı pamuklu tişört')
    assert.equal(applied.metadata.translations.en.bullet_points[0], 'TR(en) Nefes alır')
    assert.equal(applied.title, applied.metadata.translations.de.title)
    assert.equal(applied.metadata.translations.tr._auto, undefined)
  })

  it('does not overwrite a manual translation', async () => {
    const translateTexts = async (texts, _src, tgt) => texts.map((t) => `${tgt}:${t}`)
    const applied = await applyProductAutoTranslate(
      {
        title: 'Cotton shirt',
        metadata: {
          translations: {
            de: { title: 'Cotton shirt', description: '<p>Soft</p>' },
            en: { title: 'Hand-edited English title' },
          },
        },
      },
      { sourceLocale: 'de', translateTexts, pgClient: false },
    )
    assert.equal(applied.metadata.translations.en.title, 'Hand-edited English title')
    assert.ok(!applied.translatedLocales.includes('en') || !applied.metadata.translations.en._auto?.title)
  })

  it('re-translates a field still marked auto when the source changes', async () => {
    const translateTexts = async (texts, _src, tgt) => texts.map((t) => `${tgt}:${t}`)
    const applied = await applyProductAutoTranslate(
      {
        title: 'New German name',
        metadata: {
          translations: {
            de: { title: 'New German name' },
            en: { title: 'Old English', _auto: { title: true } },
          },
        },
      },
      {
        sourceLocale: 'de',
        translateTexts,
        pgClient: false,
        previousTranslations: {
          de: { title: 'Old German name' },
          en: { title: 'Old English', _auto: { title: true } },
        },
      },
    )
    assert.equal(applied.metadata.translations.en.title, 'en:New German name')
    assert.equal(applied.metadata.translations.en._auto.title, true)
  })
})
