"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "@/i18n/navigation";
import { Link } from "@/i18n/navigation";
import {
  Page, Layout, Card, Text, TextField, BlockStack, InlineStack,
  Box, Banner, Button, Divider, Checkbox, Badge, Thumbnail,
  InlineGrid,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { titleToHandle } from "@/lib/slugify";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import SearchableSelect from "@/components/inputs/SearchableSelect";
import { useLocale } from "next-intl";
import { getCategoryEditCopy } from "@/lib/category-edit-i18n";
import { categoryDisplayName, categoryNameForEditForm, normalizeCategoryLocale } from "@/lib/category-locale";
import { userError } from "@/lib/api-error-messages";
import { productStatusLabel, productStatusBadgeTone } from "@/lib/product-status-labels";
import { seoPlainPreview } from "@/lib/product-change-request-format";

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "";
  return (typeof env === "string" ? env : "").trim() || (typeof window !== "undefined" ? "http://localhost:9000" : "");
};

function resolveImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http")) return url;
  const base = getDefaultBaseUrl().replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

function slugFromName(name) {
  return titleToHandle(name || "");
}

// Products link to categories via product.category_id OR via linked collection
function getProductCollectionIds(product) {
  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  if (Array.isArray(meta.collection_ids)) return meta.collection_ids.filter(Boolean).map(String);
  if (meta.collection_id != null) return [String(meta.collection_id)];
  if (product?.collection_id != null) return [String(product.collection_id)];
  return [];
}

function isProductInCollection(product, collectionId) {
  if (!collectionId) return false;
  return getProductCollectionIds(product).includes(String(collectionId));
}

function isProductInCategory(product, categoryIds, linkedCollectionId) {
  const ids = Array.isArray(categoryIds) ? categoryIds.map(String) : [];
  if (ids.length === 0) return false;
  const wanted = new Set(ids);
  // Direct category_id match (root field)
  if (product?.category_id && wanted.has(String(product.category_id))) return true;
  // category_id stored in metadata (product edit page saves it here)
  const metaCatId = product?.metadata?.category_id;
  if (metaCatId && wanted.has(String(metaCatId))) return true;
  const metaCatIds = Array.isArray(product?.metadata?.category_ids) ? product.metadata.category_ids.map(String) : [];
  if (metaCatIds.some((id) => wanted.has(String(id)))) return true;
  // Via linked collection
  if (linkedCollectionId && isProductInCollection(product, linkedCollectionId)) return true;
  return false;
}

function categoryLineageIdsFromFlatList(flatCategories, categoryId) {
  if (!categoryId || !Array.isArray(flatCategories) || flatCategories.length === 0) return [];
  const byId = new Map(flatCategories.map((c) => [String(c.id), c]));
  const out = [];
  let cur = byId.get(String(categoryId));
  const seen = new Set();
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    out.push(String(cur.id));
    const pid = cur.parent_id != null ? String(cur.parent_id) : "";
    cur = pid && byId.has(pid) ? byId.get(pid) : null;
  }
  return out;
}

function collectDescendantIdsFromFlatList(flatCategories, rootId) {
  if (!rootId || !Array.isArray(flatCategories) || flatCategories.length === 0) return [];
  const childrenByParent = new Map();
  for (const c of flatCategories) {
    const pid = c?.parent_id != null ? String(c.parent_id) : "";
    if (!pid) continue;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid).push(c);
  }
  const out = [];
  const walk = (id) => {
    const kids = childrenByParent.get(String(id)) || [];
    for (const k of kids) {
      out.push(String(k.id));
      walk(String(k.id));
    }
  };
  walk(String(rootId));
  return out;
}

/** Unwrap JSON-array-encoded URL strings: '["https://..."]' → "https://..." */
function safeStoredUrl(val) {
  if (!val || typeof val !== "string") return "";
  const s = val.trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) && arr[0] ? String(arr[0]) : "";
    } catch (_) { return ""; }
  }
  return s;
}

function descriptionVisualToHtml(html) {
  const s = (html || "").trim();
  if (!s) return "";
  if (/<(p|div|h[1-6]|ul|ol|li)\b/i.test(s)) return s;
  return "<p>" + s + "</p>";
}

function productEditHref(product) {
  const id = product?.id;
  if (!id) return null;
  return `/products/${id}`;
}

function ProductRowLink({ product, children }) {
  const href = productEditHref(product);
  if (!href) return children;
  return (
    <Link
      href={href}
      style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}

export default function CategoryEditPage({ category: initialCategory, onReload }) {
  const router = useRouter();
  const locale = useLocale();
  const c = getCategoryEditCopy(locale);
  const client = getMedusaAdminClient();
  const [category, setCategory] = useState(initialCategory ?? null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [allCategories, setAllCategories] = useState([]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [mainImgPickerOpen, setMainImgPickerOpen] = useState(false);
  const [bannerImgPickerOpen, setBannerImgPickerOpen] = useState(false);
  const [richtextMode, setRichtextMode] = useState("visual");
  const richtextEditorRef = useRef(null);

  const meta = (initialCategory?.metadata && typeof initialCategory.metadata === "object") ? initialCategory.metadata : {};
  const linkedCollectionId = meta.collection_id || null;

  const [form, setForm] = useState({
    name: categoryNameForEditForm(initialCategory, locale),
    slug: initialCategory?.slug ?? "",
    long_content: initialCategory?.long_content ?? "",
    parent_id: initialCategory?.parent_id ?? "",
    active: initialCategory?.active !== false,
    is_visible: initialCategory?.is_visible !== false,
    meta_title: meta.meta_title ?? "",
    meta_description: meta.meta_description ?? "",
    keywords: meta.keywords ?? "",
    image_url: safeStoredUrl(meta.image_url ?? initialCategory?.image_url ?? ""),
    banner_image_url: safeStoredUrl(meta.banner_image_url ?? initialCategory?.banner_image_url ?? ""),
    banner_video_url: safeStoredUrl(meta.banner_video_url ?? ""),
  });

  const initialFormRef = useRef(JSON.parse(JSON.stringify({
    name: categoryNameForEditForm(initialCategory, locale),
    slug: initialCategory?.slug ?? "",
    long_content: initialCategory?.long_content ?? "",
    parent_id: initialCategory?.parent_id ?? "",
    active: initialCategory?.active !== false,
    is_visible: initialCategory?.is_visible !== false,
    meta_title: meta.meta_title ?? "",
    meta_description: meta.meta_description ?? "",
    keywords: meta.keywords ?? "",
    image_url: safeStoredUrl(meta.image_url ?? initialCategory?.image_url ?? ""),
    banner_image_url: safeStoredUrl(meta.banner_image_url ?? initialCategory?.banner_image_url ?? ""),
    banner_video_url: safeStoredUrl(meta.banner_video_url ?? ""),
  })));

  const [categoryProducts, setCategoryProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [addingProductId, setAddingProductId] = useState(null);
  const [removingProductId, setRemovingProductId] = useState(null);
  const [addProductSearch, setAddProductSearch] = useState("");
  const unsaved = useUnsavedChanges();

  const categoryScopeIds = React.useMemo(() => {
    const rootId = String(initialCategory?.id || "");
    if (!rootId) return [];
    const all = [initialCategory, ...(allCategories || [])].filter(Boolean);
    const descendants = collectDescendantIdsFromFlatList(all, rootId);
    return Array.from(new Set([rootId, ...descendants.map(String)]));
  }, [initialCategory, allCategories]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(initialFormRef.current);

  const saveRef = useRef(null);
  const discardRef = useRef(null);

  useEffect(() => {
    if (!unsaved) return;
    unsaved.setDirty(isDirty);
    unsaved.setHandlers({
      onSave: () => saveRef.current?.(),
      onDiscard: () => discardRef.current?.(),
    });
    return () => { unsaved.clearHandlers?.(); };
  }, [isDirty, unsaved]);

  useEffect(() => {
    if (richtextMode === "visual" && richtextEditorRef.current) {
      richtextEditorRef.current.innerHTML = form.long_content || "";
    }
  }, [richtextMode]);

  useEffect(() => {
    if (!initialCategory) return;
    const nextName = categoryNameForEditForm(initialCategory, locale);
    setForm((prev) => ({ ...prev, name: nextName }));
  }, [locale, initialCategory?.id]);

  // Load categories for parent selector
  useEffect(() => {
    client.getAdminHubCategories({ all: true })
      .then((r) => setAllCategories((r.categories || []).filter((c) => c.id !== initialCategory?.id)))
      .catch(() => setAllCategories([]));
  }, []);

  // Load products
  useEffect(() => {
    if (!initialCategory?.id) return;
    client.getAdminHubProducts({ limit: 500 }).then((r) => {
      const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setAllProducts(list);
      setCategoryProducts(list.filter((p) => isProductInCategory(p, categoryScopeIds, linkedCollectionId)));
    }).catch(() => { setAllProducts([]); setCategoryProducts([]); });
  }, [initialCategory?.id, linkedCollectionId, categoryScopeIds]);

  const refreshProducts = useCallback(async () => {
    const r = await client.getAdminHubProducts({ limit: 500 });
    const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
    setAllProducts(list);
    setCategoryProducts(list.filter((p) => isProductInCategory(p, categoryScopeIds, linkedCollectionId)));
  }, [initialCategory?.id, linkedCollectionId, categoryScopeIds]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const loc = normalizeCategoryLocale(locale);
      const existingMeta = initialCategory.metadata && typeof initialCategory.metadata === "object"
        ? { ...initialCategory.metadata }
        : {};
      const tr = { ...(existingMeta.translations || {}) };
      const trimmedName = (form.name || "").trim();
      tr[loc] = { ...(tr[loc] || {}), name: trimmedName };
      const canonicalName = loc === "en" ? trimmedName : (initialCategory.name || "").trim();
      await client.updateAdminHubCategory(initialCategory.id, {
        name: canonicalName || initialCategory.name,
        slug: form.slug,
        long_content: form.long_content || null,
        parent_id: form.parent_id || null,
        active: form.active,
        is_visible: form.is_visible,
        banner_image_url: form.banner_image_url || null,
        metadata: {
          ...existingMeta,
          translations: tr,
          meta_title: form.meta_title || null,
          meta_description: form.meta_description || null,
          keywords: form.keywords || null,
          image_url: form.image_url || null,
          banner_image_url: form.banner_image_url || null,
          banner_video_url: form.banner_video_url || null,
        },
      });
      initialFormRef.current = JSON.parse(JSON.stringify(form));
      unsaved?.setDirty(false);
      if (onReload) await onReload();
    } catch (e) {
      setError(userError(e, locale, c.saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setForm({ ...initialFormRef.current });
    unsaved?.setDirty(false);
  };

  // Keep refs current on every render so topbar save/discard buttons always call latest version
  saveRef.current = handleSave;
  discardRef.current = handleDiscard;

  const addProductToCategory = async (productId) => {
    if (!productId) return;
    setAddingProductId(productId);
    try {
      const existing = await client.getAdminHubProduct(productId);
      const allCats = [initialCategory, ...(allCategories || [])].filter(Boolean);
      const lineage = categoryLineageIdsFromFlatList(allCats, String(initialCategory.id));
      const enrichedMeta = {
        ...(existing?.metadata || {}),
        category_id: String(initialCategory.id),
        admin_category_id: String(initialCategory.id),
        category_ids: lineage.length > 0 ? lineage : [String(initialCategory.id)],
      };
      if (linkedCollectionId) {
        // Add to linked collection
        const existingIds = getProductCollectionIds(existing);
        const nextIds = Array.from(new Set([...existingIds, String(linkedCollectionId)]));
        await client.updateAdminHubProduct(productId, {
          metadata: { ...enrichedMeta, collection_ids: nextIds },
          collection_id: nextIds[0] || null,
        });
      } else {
        // Direct category link — write to both root field and metadata for consistency
        await client.updateAdminHubProduct(productId, {
          category_id: String(initialCategory.id),
          metadata: enrichedMeta,
        });
      }
      setAddProductSearch("");
      await refreshProducts();
    } catch (e) {
      setError(userError(e, locale, c.addProductError));
    } finally {
      setAddingProductId(null);
    }
  };

  const removeProductFromCategory = async (productId) => {
    if (!productId) return;
    setRemovingProductId(productId);
    try {
      const existing = await client.getAdminHubProduct(productId);
      if (linkedCollectionId) {
        const existingIds = getProductCollectionIds(existing);
        const nextIds = existingIds.filter((id) => String(id) !== String(linkedCollectionId));
        await client.updateAdminHubProduct(productId, {
          metadata: { ...(existing?.metadata || {}), collection_ids: nextIds },
          collection_id: nextIds[0] || null,
        });
      } else {
        const meta = { ...(existing?.metadata || {}) };
        delete meta.category_id;
        delete meta.admin_category_id;
        delete meta.category_ids;
        await client.updateAdminHubProduct(productId, { category_id: null, metadata: meta });
      }
      await refreshProducts();
    } catch (e) {
      setError(userError(e, locale, c.removeProductError));
    } finally {
      setRemovingProductId(null);
    }
  };

  const inCategoryIds = new Set((categoryProducts || []).map((p) => p.id));
  const filteredAddProducts = (allProducts || [])
    .filter((p) => !inCategoryIds.has(p.id))
    .filter((p) => !addProductSearch || (p.title || "").toLowerCase().includes(addProductSearch.toLowerCase()));

  const parentOptions = [
    { label: c.noParent, value: "" },
    ...allCategories.map((cat) => ({
      label: categoryDisplayName(cat, locale),
      value: String(cat.id),
      sublabel: cat.slug ? `/${cat.slug}` : undefined,
    })),
  ];

  const categoryTreeRows = (() => {
    const rootId = String(initialCategory?.id || "");
    const all = [initialCategory, ...(allCategories || [])].filter(Boolean);
    const byId = new Map(all.map((c) => [String(c.id), c]));
    const descendants = collectDescendantIdsFromFlatList(all, rootId);
    const depthOf = (id) => {
      let d = 0;
      let cur = byId.get(String(id));
      const seen = new Set();
      while (cur && String(cur.id) !== rootId && !seen.has(String(cur.id))) {
        seen.add(String(cur.id));
        const pid = cur.parent_id != null ? String(cur.parent_id) : "";
        if (!pid) break;
        cur = byId.get(pid);
        d += 1;
      }
      return d;
    };
    return descendants
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .sort((a, b) => categoryDisplayName(a, locale).localeCompare(categoryDisplayName(b, locale), undefined, { sensitivity: "base" }))
      .map((c) => ({ id: String(c.id), name: categoryDisplayName(c, locale), slug: c.slug || "", depth: depthOf(c.id) }));
  })();

  return (
    <Page
      backAction={{ content: c.backCategories, url: "/content/categories" }}
      title={form.name || categoryDisplayName(initialCategory, locale) || c.category}
      subtitle={`/${form.slug || initialCategory?.slug || ""}`}
      primaryAction={{ content: c.save, onAction: handleSave, loading: saving, disabled: saving || !isDirty }}
      secondaryActions={[{ content: c.discard, onAction: handleDiscard, disabled: !isDirty }]}
    >
      <style>{`
        .category-richtext-editor { color: var(--p-color-text); }
        .category-richtext-editor h1 { font-size: 1.75rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .category-richtext-editor h2 { font-size: 1.5rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .category-richtext-editor h3 { font-size: 1.25rem; font-weight: 600; margin: 0.6em 0 0.3em; line-height: 1.35; }
        .category-richtext-editor h1:first-child, .category-richtext-editor h2:first-child, .category-richtext-editor h3:first-child { margin-top: 0; }
        .category-richtext-editor p { margin: 0 0 0.6em; }
        .category-richtext-editor p:last-child { margin-bottom: 0; }
        .category-richtext-editor ul, .category-richtext-editor ol { margin: 0.4em 0 0.8em 1.5em; padding-left: 1.5em; }
        .category-richtext-editor ul { list-style-type: disc; }
        .category-richtext-editor ol { list-style-type: decimal; }
        .category-richtext-editor li { margin-bottom: 0.25em; }
        .category-richtext-editor strong { font-weight: 600; }
        .category-richtext-editor blockquote { margin: 0.75em 0; padding-left: 1em; border-left: 4px solid var(--p-color-border); color: var(--p-color-text-subdued); }
      `}</style>
      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
        </Box>
      )}

      <Layout>
        {/* Left column — main fields */}
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{c.categoryDetails}</Text>
                <TextField
                  label={c.name}
                  value={form.name}
                  onChange={(v) => setForm((p) => ({ ...p, name: v, slug: slugManuallyEdited ? p.slug : slugFromName(v) }))}
                  autoComplete="off"
                />
                <TextField
                  label={c.slug}
                  value={form.slug}
                  onChange={(v) => { setSlugManuallyEdited(true); setForm((p) => ({ ...p, slug: v })); }}
                  autoComplete="off"
                  prefix="/"
                  helpText={c.slugHelp}
                />
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" fontWeight="medium">{c.description}</Text>
                  <div style={{ border: "1px solid var(--p-color-border)", borderRadius: 12, overflow: "hidden", background: "var(--p-color-bg-surface)" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--p-color-bg-surface-secondary)", borderBottom: "1px solid var(--p-color-border)" }}>
                      {richtextMode === "visual" && (
                        <>
                          <button type="button" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)", fontWeight: 700, fontSize: 14 }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("bold"); }} title={c.bold}>B</button>
                          <button type="button" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)", fontStyle: "italic", fontSize: 14 }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("italic"); }} title={c.italic}>I</button>
                          <button type="button" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)", fontSize: 16 }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }} title={c.list}>•</button>
                        </>
                      )}
                      <button type="button" style={{ marginLeft: 8, width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: richtextMode === "html" ? "var(--p-color-bg-surface-selected)" : "transparent", color: "var(--p-color-text-subdued)", fontSize: 11 }} onClick={() => { if (richtextMode === "visual" && richtextEditorRef.current) setForm((prev) => ({ ...prev, long_content: descriptionVisualToHtml(richtextEditorRef.current.innerHTML || "") })); else if (richtextMode !== "visual" && richtextEditorRef.current) richtextEditorRef.current.innerHTML = form.long_content || ""; setRichtextMode(richtextMode === "html" ? "visual" : "html"); }} title={c.html}>{"</>"}</button>
                    </div>
                    {richtextMode === "html" ? (
                      <textarea style={{ minHeight: 160, width: "100%", padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, border: "none", resize: "vertical", boxSizing: "border-box" }} value={form.long_content || ""} onChange={(e) => setForm((prev) => ({ ...prev, long_content: e.target.value }))} placeholder={c.htmlPlaceholder} />
                    ) : (
                      <div ref={richtextEditorRef} className="category-richtext-editor" contentEditable suppressContentEditableWarning style={{ minHeight: 160, padding: 16, outline: "none", fontSize: 14, lineHeight: 1.6 }} onBlur={() => { if (richtextEditorRef.current) setForm((prev) => ({ ...prev, long_content: descriptionVisualToHtml(richtextEditorRef.current.innerHTML || "") })); }} />
                    )}
                  </div>
                </BlockStack>
                <SearchableSelect
                  label={c.parentCategory}
                  options={parentOptions}
                  value={form.parent_id || ""}
                  onChange={(v) => setForm((p) => ({ ...p, parent_id: v }))}
                  emptyLabel={c.noParent}
                  placeholder={c.parentCategory}
                />
              </BlockStack>
            </Card>

            {/* SEO */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{c.seo}</Text>
                <TextField label={c.metaTitle} value={form.meta_title} onChange={(v) => setForm((p) => ({ ...p, meta_title: v }))} autoComplete="off" helpText={`${form.meta_title.length}/60`} placeholder={form.name || ""} />
                <TextField label={c.metaDescription} value={form.meta_description} onChange={(v) => setForm((p) => ({ ...p, meta_description: v }))} multiline={2} autoComplete="off" helpText={`${form.meta_description.length}/160`} placeholder={seoPlainPreview(form.long_content, 160)} />
                <TextField label={c.keywords} value={form.keywords} onChange={(v) => setForm((p) => ({ ...p, keywords: v }))} autoComplete="off" helpText={c.keywordsHelp} />
              </BlockStack>
            </Card>

            {/* Products */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {c.products} <Text as="span" tone="subdued" variant="bodySm">({categoryProducts.length})</Text>
                  </Text>
                </InlineStack>

                {/* Add product search */}
                <TextField
                  label=""
                  labelHidden
                  placeholder={c.searchProductsPlaceholder}
                  value={addProductSearch}
                  onChange={setAddProductSearch}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setAddProductSearch("")}
                />
                {addProductSearch && filteredAddProducts.length > 0 && (
                  <div style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden", maxHeight: 240, overflowY: "auto" }}>
                    {filteredAddProducts.slice(0, 10).map((p) => (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderBottom: "1px solid #f1f1f1" }}>
                        {p.thumbnail ? (
                          <Thumbnail source={resolveImageUrl(p.thumbnail)} alt={p.title} size="small" />
                        ) : (
                          <div style={{ width: 40, height: 40, background: "#f4f6f8", borderRadius: 4, flexShrink: 0 }} />
                        )}
                        <ProductRowLink product={p}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Text as="p" variant="bodyMd" fontWeight="medium" truncate>
                              <span style={{ color: "var(--p-color-text-link)" }}>{p.title}</span>
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">{p.handle}</Text>
                          </div>
                        </ProductRowLink>
                        <Button
                          size="slim"
                          onClick={() => addProductToCategory(p.id)}
                          loading={addingProductId === p.id}
                          disabled={!!addingProductId}
                        >
                          {c.add}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <Divider />

                {categoryProducts.length === 0 ? (
                  <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                    <Text as="p" tone="subdued" alignment="center">{c.noProducts}</Text>
                  </Box>
                ) : (
                  <BlockStack gap="200">
                    {categoryProducts.map((p) => (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #f1f1f1" }}>
                        {p.thumbnail ? (
                          <Thumbnail source={resolveImageUrl(p.thumbnail)} alt={p.title} size="small" />
                        ) : (
                          <div style={{ width: 40, height: 40, background: "#f4f6f8", borderRadius: 4, flexShrink: 0 }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text as="p" variant="bodyMd" fontWeight="medium" truncate>{p.title}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">{p.handle}</Text>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                          {p.status && (
                            <Badge tone={p.status === "published" ? "success" : "attention"}>
                              {productStatusLabel(locale, p.status)}
                            </Badge>
                          )}
                          <Button
                            size="slim"
                            variant="plain"
                            tone="critical"
                            onClick={() => removeProductFromCategory(p.id)}
                            loading={removingProductId === p.id}
                            disabled={!!removingProductId}
                          >
                            {c.remove}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {c.categoryTree} <Text as="span" tone="subdued" variant="bodySm">({categoryTreeRows.length} {c.childSuffix})</Text>
                  </Text>
                </InlineStack>
                {categoryTreeRows.length === 0 ? (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <Text as="p" tone="subdued">{c.noChildCategory}</Text>
                  </Box>
                ) : (
                  <BlockStack gap="100">
                    {categoryTreeRows.map((row) => (
                      <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #f1f1f1" }}>
                        <span style={{ display: "inline-block", width: `${Math.min(20, row.depth * 12)}px` }} />
                        <Text as="span" variant="bodySm">{row.name}</Text>
                        <Text as="span" tone="subdued" variant="bodySm">/{row.slug}</Text>
                        <div style={{ marginLeft: "auto" }}>
                          <Button size="micro" url={`/content/categories/${row.id}`}>{c.open}</Button>
                        </div>
                      </div>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Right column — status + images */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{c.status}</Text>
                <Checkbox
                  label={c.active}
                  checked={form.active}
                  onChange={(v) => setForm((p) => ({ ...p, active: v }))}
                />
                <Checkbox
                  label={c.visibleInShop}
                  checked={form.is_visible}
                  onChange={(v) => setForm((p) => ({ ...p, is_visible: v }))}
                />
                {initialCategory?.has_collection && (
                  <Badge tone="success">{c.linkedCollection}</Badge>
                )}
              </BlockStack>
            </Card>

            {/* Main image */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{c.categoryImage}</Text>
                {form.image_url ? (
                  <div style={{ position: "relative" }}>
                    <img
                      src={resolveImageUrl(form.image_url)}
                      alt={c.categoryAlt}
                      style={{ width: "100%", borderRadius: 8, objectFit: "cover", maxHeight: 180 }}
                    />
                    <Button
                      size="slim"
                      variant="plain"
                      tone="critical"
                      onClick={() => setForm((p) => ({ ...p, image_url: "" }))}
                    >
                      {c.remove}
                    </Button>
                  </div>
                ) : null}
                <Button onClick={() => setMainImgPickerOpen(true)}>
                  {form.image_url ? c.changeImage : c.addImage}
                </Button>
              </BlockStack>
            </Card>

            {/* Banner image / video */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">{c.banner}</Text>
                {form.banner_image_url ? (
                  <div>
                    <img
                      src={resolveImageUrl(form.banner_image_url)}
                      alt={c.banner}
                      style={{ width: "100%", borderRadius: 8, objectFit: "cover", maxHeight: 120 }}
                    />
                    <Button
                      size="slim"
                      variant="plain"
                      tone="critical"
                      onClick={() => setForm((p) => ({ ...p, banner_image_url: "" }))}
                    >
                      {c.remove}
                    </Button>
                  </div>
                ) : null}
                <Button onClick={() => setBannerImgPickerOpen(true)}>
                  {form.banner_image_url ? c.changeBannerImage : c.addBannerImage}
                </Button>
                <TextField
                  label={c.bannerVideoUrl}
                  value={form.banner_video_url || ""}
                  onChange={(v) => setForm((p) => ({ ...p, banner_video_url: v }))}
                  autoComplete="off"
                  placeholder={c.bannerVideoPlaceholder}
                  helpText={c.bannerVideoHelp}
                />
                {form.banner_video_url ? (
                  <div>
                    <video
                      src={resolveImageUrl(form.banner_video_url)}
                      style={{ width: "100%", borderRadius: 8, objectFit: "cover", maxHeight: 120 }}
                      muted
                      playsInline
                    />
                    <Button
                      size="slim"
                      variant="plain"
                      tone="critical"
                      onClick={() => setForm((p) => ({ ...p, banner_video_url: "" }))}
                    >
                      {c.removeVideo}
                    </Button>
                  </div>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <MediaPickerModal
        open={mainImgPickerOpen}
        onClose={() => setMainImgPickerOpen(false)}
        multiple={false}
        onSelect={(urls) => {
          const url = Array.isArray(urls) ? urls[0] : urls;
          if (url) setForm((p) => ({ ...p, image_url: url }));
          setMainImgPickerOpen(false);
        }}
      />
      <MediaPickerModal
        open={bannerImgPickerOpen}
        onClose={() => setBannerImgPickerOpen(false)}
        multiple={false}
        onSelect={(urls) => {
          const url = Array.isArray(urls) ? urls[0] : urls;
          if (url) setForm((p) => ({ ...p, banner_image_url: url }));
          setBannerImgPickerOpen(false);
        }}
      />
    </Page>
  );
}
