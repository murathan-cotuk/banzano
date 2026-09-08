const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  unwrapCategoryImageValue,
  pickCategoryImageRaw,
  productCoverFromMetadata,
  collectRefsFromProductMetadata,
  annotateCategoryTreeHasProducts,
  pruneEmptyCategoryTree,
  applyProductImageFallback,
  slimStoreCategoryNode,
} = require('./store-category-tree')

describe('store-category-tree', () => {
  it('unwraps JSON-array and object image values', () => {
    assert.equal(
      unwrapCategoryImageValue('["https://cdn.example/a.jpg"]'),
      'https://cdn.example/a.jpg',
    )
    assert.equal(
      unwrapCategoryImageValue({ url: 'https://cdn.example/b.jpg' }),
      'https://cdn.example/b.jpg',
    )
    assert.equal(unwrapCategoryImageValue(['https://cdn.example/c.jpg']), 'https://cdn.example/c.jpg')
    assert.equal(unwrapCategoryImageValue(''), '')
  })

  it('picks category list image from metadata then banner', () => {
    assert.equal(
      pickCategoryImageRaw({ metadata: { image_url: '/uploads/cat.webp' }, banner_image_url: '/uploads/banner.png' }),
      '/uploads/cat.webp',
    )
    assert.equal(
      pickCategoryImageRaw({ banner_image_url: '/uploads/banner.png' }),
      '/uploads/banner.png',
    )
  })

  it('marks a root has_products when a descendant leaf matches by id or slug', () => {
    const leaf = { id: 'leaf-1', slug: 'phones-bumpers', children: [] }
    const mid = { id: 'mid-1', slug: 'phones', children: [leaf] }
    const root = { id: 'root-1', slug: 'electronics', parent_id: null, children: [mid] }
    const empty = { id: 'root-2', slug: 'books', parent_id: null, children: [] }
    annotateCategoryTreeHasProducts([root, empty], {
      ids: new Set(['leaf-1']),
      slugs: new Set(),
    })
    assert.equal(leaf.has_products, true)
    assert.equal(mid.has_products, true)
    assert.equal(root.has_products, true)
    assert.equal(empty.has_products, false)

    const bySlug = { id: 'r', slug: 'arts', children: [{ id: 'c', slug: 'art-portfolios', children: [] }] }
    annotateCategoryTreeHasProducts([bySlug], { ids: new Set(), slugs: new Set(['art-portfolios']) })
    assert.equal(bySlug.has_products, true)
    assert.equal(bySlug.children[0].has_products, true)
  })

  it('prunes categories that have no shop-visible products', () => {
    const tree = [
      { id: 'keep', has_products: true, children: [{ id: 'leaf', has_products: true, children: [] }] },
      { id: 'drop', has_products: false, children: [{ id: 'empty-leaf', has_products: false, children: [] }] },
    ]
    const pruned = pruneEmptyCategoryTree(tree)
    assert.equal(pruned.length, 1)
    assert.equal(pruned[0].id, 'keep')
    assert.equal(pruned[0].children.length, 1)
  })

  it('bubbles a product cover up to a root that has no category image', () => {
    const leaf = { id: 'leaf-1', slug: 'bumpers', children: [] }
    const root = { id: 'root-1', slug: 'phones', children: [leaf] }
    applyProductImageFallback([root], new Map([['leaf-1', '/uploads/phone.jpg']]))
    assert.equal(leaf.image_url, '/uploads/phone.jpg')
    assert.equal(root.image_url, '/uploads/phone.jpg')
  })

  it('slims nodes: drops long_content, keeps image + translations + has_products', () => {
    const node = {
      id: 'a',
      name: 'Appliances',
      slug: 'appliances',
      parent_id: null,
      active: true,
      is_visible: true,
      sort_order: 1,
      has_products: true,
      long_content: '<p>huge html</p>',
      seo_title: 'seo',
      banner_image_url: '/uploads/banner.jpg',
      metadata: {
        image_url: '/uploads/cat.jpg',
        translations: { de: { name: 'Haushaltsgeräte' } },
        collection_id: 'ignore-me',
      },
      children: [],
    }
    const slim = slimStoreCategoryNode(node, (u) => (u ? `https://api.example${u}` : null))
    assert.equal(slim.long_content, undefined)
    assert.equal(slim.seo_title, undefined)
    assert.equal(slim.has_products, true)
    assert.equal(slim.image_url, 'https://api.example/uploads/cat.jpg')
    assert.equal(slim.metadata.translations.de.name, 'Haushaltsgeräte')
    assert.equal(slim.metadata.collection_id, undefined)
  })

  it('collects category ids/slugs from product metadata without leaking thumbs across products', () => {
    const ids = new Set()
    const slugs = new Set()
    const thumbs = new Map()
    collectRefsFromProductMetadata(
      { admin_category_id: 'AAA', category_slug: 'phones', thumbnail: '/uploads/a.jpg' },
      ids, slugs, thumbs,
    )
    collectRefsFromProductMetadata(
      { admin_category_id: 'BBB', category_slug: 'cars' },
      ids, slugs, thumbs,
    )
    assert.equal(ids.has('aaa'), true)
    assert.equal(ids.has('bbb'), true)
    assert.equal(slugs.has('phones'), true)
    assert.equal(thumbs.get('aaa'), '/uploads/a.jpg')
    assert.equal(thumbs.has('bbb'), false)
  })

  it('reads product cover from media array', () => {
    assert.equal(
      productCoverFromMetadata({ media: [{ url: '/uploads/m.jpg' }] }),
      '/uploads/m.jpg',
    )
  })
})
