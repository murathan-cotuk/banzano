'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  shouldRemapSwappedImportLocales,
  remapSwappedImportLocales,
  remapMetafieldList,
} = require('./metaobject-locale-remap')

describe('metaobject-locale-remap', () => {
  const swapped = {
    key: 'fabric',
    label: 'Fabric',
    values: ['Cotton', 'Denim'],
    label_i18n: {
      en: { label: 'Stoff' },
      es: { label: 'Tissu' },
      fr: { label: 'Kumaş' },
      it: { label: 'Tessuto' },
      tr: { label: 'Tela' },
    },
    values_i18n: {
      en: { Cotton: 'Baumwolle', Denim: 'Denim' },
      es: { Cotton: 'Coton', Denim: 'Denim' },
      fr: { Cotton: 'Pamuk', Denim: 'Kot' },
      it: { Cotton: 'Cotone', Denim: 'Denim' },
      tr: { Cotton: 'Algodón', Denim: 'Dril' },
    },
  }

  it('detects the EN/DE/TR/FR/ES swap pattern', () => {
    assert.equal(shouldRemapSwappedImportLocales(swapped), true)
    const remapped = remapSwappedImportLocales(swapped).def
    assert.equal(shouldRemapSwappedImportLocales(remapped), false)
    assert.equal(shouldRemapSwappedImportLocales({ key: 'farbe', label: 'Farbe', label_i18n: null }), false)
    assert.equal(shouldRemapSwappedImportLocales({
      label: 'Volume',
      label_i18n: {
        en: { label: 'Volumen' },
        es: { label: 'Volume' },
        fr: { label: 'Hacim' },
        it: { label: 'Volume' },
        tr: { label: 'Volumen' },
      },
    }), true)
    assert.equal(shouldRemapSwappedImportLocales({
      label: 'Innenmaterial',
      label_i18n: {
        en: { label: 'Inner material' },
        es: { label: 'Material interior' },
        fr: { label: 'Matériau intérieur' },
        it: { label: 'Materiale interno' },
        tr: { label: 'İç Malzeme' },
      },
    }), false)
  })

  it('moves titles and values into the correct languages', () => {
    const { def, valueMap } = remapSwappedImportLocales(swapped)
    assert.equal(def.label, 'Stoff')
    assert.equal(def.label_i18n.en.label, 'Fabric')
    assert.equal(def.label_i18n.tr.label, 'Kumaş')
    assert.equal(def.label_i18n.fr.label, 'Tissu')
    assert.equal(def.label_i18n.it.label, 'Tessuto')
    assert.equal(def.label_i18n.es.label, 'Tela')
    assert.deepEqual(def.values, ['Baumwolle', 'Denim'])
    assert.equal(def.values_i18n.en.Baumwolle, 'Cotton')
    assert.equal(def.values_i18n.tr.Baumwolle, 'Pamuk')
    assert.equal(def.values_i18n.fr.Baumwolle, 'Coton')
    assert.equal(def.values_i18n.es.Baumwolle, 'Algodón')
    assert.equal(valueMap.Cotton, 'Baumwolle')
  })

  it('rewrites product metafield values via the canonical map', () => {
    const { valueMap } = remapSwappedImportLocales(swapped)
    const { list, changed } = remapMetafieldList(
      [{ key: 'fabric', value: 'Cotton' }, { key: 'farbe', value: 'Blau' }],
      { fabric: valueMap },
    )
    assert.equal(changed, 1)
    assert.equal(list[0].value, 'Baumwolle')
    assert.equal(list[1].value, 'Blau')
  })
})
