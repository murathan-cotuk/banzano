"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  Button,
  Divider,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { titleToHandle } from "@/lib/slugify";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import { useLocale } from "next-intl";
import { userError } from "@/lib/api-error-messages";
import { seoPlainPreview } from "@/lib/product-change-request-format";
import { getCollectionEditCopy } from "@/lib/collection-edit-i18n";

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "";
  const url = (typeof env === "string" ? env : "").trim();
  return url || (typeof window !== "undefined" ? "http://localhost:9000" : "");
};

function descriptionVisualToHtml(html) {
  const s = (html || "").trim();
  if (!s) return "";
  if (/<(p|div|h[1-6]|ul|ol|li)\b/i.test(s)) return s;
  return "<p>" + s + "</p>";
}

const META_TITLE_MAX = 60;
const META_DESC_MAX = 160;

function slugFromTitle(title) {
  return titleToHandle(title || "");
}

function getProductCollectionIds(product) {
  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  if (Array.isArray(meta.collection_ids)) return meta.collection_ids.filter(Boolean).map(String);
  if (meta.collection_id != null) return [String(meta.collection_id)];
  if (product?.collection_id != null) return [String(product.collection_id)];
  return [];
}

function isProductInCollection(product, collectionId) {
  if (!collectionId) return false;
  const cid = String(collectionId);
  return getProductCollectionIds(product).includes(cid);
}

export default function CollectionEditPage({ collection: initialCollection, isNew, onReload }) {
  const router = useRouter();
  const locale = useLocale();
  const c = getCollectionEditCopy(locale);
  const client = getMedusaAdminClient();
  const baseUrl = (client.baseURL || getDefaultBaseUrl()).replace(/\/$/, "");
  const [collection, setCollection] = useState(initialCollection ?? null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [categories, setCategories] = useState([]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [mainImgPickerOpen, setMainImgPickerOpen] = useState(false);
  const [bannerImgPickerOpen, setBannerImgPickerOpen] = useState(false);
  const [richtextMode, setRichtextMode] = useState("visual");
  const richtextEditorRef = useRef(null);

  const [form, setForm] = useState({
    title: "",
    handle: "",
    category_id: "",
    display_title: "",
    meta_title: "",
    meta_description: "",
    keywords: "",
    richtext: "",
    image_url: "",
    banner_image_url: "",
    banner_video_url: "",
    recommended_product_ids: [],
  });
  const [collectionProducts, setCollectionProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [addingProductId, setAddingProductId] = useState(null);
  const [removingProductId, setRemovingProductId] = useState(null);
  const [addProductSearch, setAddProductSearch] = useState("");
  const [addProductPopoverOpen, setAddProductPopoverOpen] = useState(false);
  const [searchRect, setSearchRect] = useState(null);
  const searchContainerRef = useRef(null);
  const initialFormRef = useRef(null);
  const unsaved = useUnsavedChanges();

  useEffect(() => {
    if (initialCollection) {
      setCollection(initialCollection);
      const nextForm = {
        title: initialCollection.title ?? "",
        handle: initialCollection.handle ?? "",
        category_id:
          initialCollection.category_id != null && String(initialCollection.category_id).trim() !== ""
            ? String(initialCollection.category_id)
            : "",
        display_title: initialCollection.display_title ?? initialCollection.title ?? "",
        meta_title: initialCollection.meta_title ?? "",
        meta_description: initialCollection.meta_description ?? "",
        keywords: initialCollection.keywords ?? "",
        richtext: initialCollection.richtext ?? initialCollection.description_html ?? "",
        image_url: initialCollection.image_url ?? "",
        banner_image_url: initialCollection.banner_image_url ?? "",
        banner_video_url: initialCollection.banner_video_url ?? (initialCollection.metadata?.banner_video_url ?? ""),
        recommended_product_ids: Array.isArray(initialCollection.recommended_product_ids) ? initialCollection.recommended_product_ids : [],
      };
      setForm((prev) => ({ ...prev, ...nextForm }));
      initialFormRef.current = nextForm;
    } else if (isNew) {
      const empty = { title: "", handle: "", category_id: "", display_title: "", meta_title: "", meta_description: "", keywords: "", richtext: "", image_url: "", banner_image_url: "", banner_video_url: "", recommended_product_ids: [] };
      initialFormRef.current = empty;
    }
  }, [initialCollection, isNew]);

  const isDirty = initialFormRef.current != null && JSON.stringify(form) !== JSON.stringify(initialFormRef.current);

  const handleDiscard = useCallback(() => {
    if (initialFormRef.current) setForm({ ...initialFormRef.current });
    setCollection(initialCollection ?? null);
    setError(null);
    unsaved?.setDirty(false);
  }, [initialCollection, unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    unsaved.setDirty(isDirty);
  }, [isDirty, unsaved]);

  useEffect(() => {
    if (richtextMode === "visual" && richtextEditorRef.current) richtextEditorRef.current.innerHTML = form.richtext || "";
  }, [richtextMode, form.richtext]);


  useEffect(() => {
    client.getAdminHubCategories().then((r) => setCategories(r.categories || [])).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!collection?.id) {
      setCollectionProducts([]);
      return;
    }
    client.getAdminHubProducts({ limit: 500 }).then((r) => {
      const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setCollectionProducts(list.filter((p) => isProductInCollection(p, collection.id)));
    }).catch(() => setCollectionProducts([]));
  }, [collection?.id, client]);

  useEffect(() => {
    if (!collection?.id) return;
    client.getAdminHubProducts({ limit: 200 }).then((r) => {
      const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setAllProducts(list);
    }).catch(() => setAllProducts([]));
  }, [collection?.id, client]);

  useEffect(() => {
    if (!addProductPopoverOpen) return;
    const update = () => {
      if (searchContainerRef.current) {
        setSearchRect(searchContainerRef.current.getBoundingClientRect());
      }
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [addProductPopoverOpen]);

  // Popover is `position: fixed` to escape the white card, but the scrollable page wrapper's
  // `overflow` still clips it — flip the wrapper to visible while the popover is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (addProductPopoverOpen) document.body.classList.add("andertal-dropdown-open");
    else document.body.classList.remove("andertal-dropdown-open");
    return () => document.body.classList.remove("andertal-dropdown-open");
  }, [addProductPopoverOpen]);

  const addProductToCollection = async (productId) => {
    if (!collection?.id || !productId) return;
    setAddingProductId(productId);
    try {
      const existing = await client.getAdminHubProduct(productId);
      const existingIds = getProductCollectionIds(existing);
      const nextIds = Array.from(new Set([...existingIds, String(collection.id)]));
      await client.updateAdminHubProduct(productId, {
        metadata: { ...(existing?.metadata || {}), collection_ids: nextIds },
        collection_id: nextIds[0] || null,
      });
      const r = await client.getAdminHubProducts({ limit: 500 });
      const nonDraft = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setCollectionProducts(nonDraft.filter((p) => isProductInCollection(p, collection.id)));
      const all = await client.getAdminHubProducts({ limit: 200 });
      setAllProducts((all.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft"));
      setAddProductSearch("");
    } catch (e) {
      setError(userError(e, locale, "Failed to add product to collection"));
    } finally {
      setAddingProductId(null);
    }
  };

  const removeProductFromCollection = async (productId) => {
    if (!productId) return;
    setRemovingProductId(productId);
    try {
      const existing = await client.getAdminHubProduct(productId);
      const existingIds = getProductCollectionIds(existing);
      const nextIds = existingIds.filter((id) => String(id) !== String(collection?.id));
      await client.updateAdminHubProduct(productId, {
        metadata: { ...(existing?.metadata || {}), collection_ids: nextIds },
        collection_id: nextIds[0] || null,
      });
      const r = await client.getAdminHubProducts({ limit: 500 });
      const nonDraft = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setCollectionProducts(nonDraft.filter((p) => isProductInCollection(p, collection?.id)));
      const all = await client.getAdminHubProducts({ limit: 200 });
      setAllProducts((all.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft"));
    } catch (e) {
      setError(userError(e, locale, "Failed to remove product from collection"));
    } finally {
      setRemovingProductId(null);
    }
  };

  const inCollectionIds = new Set((collectionProducts || []).map((p) => p.id));
  const productsNotInCollection = (allProducts || []).filter((p) => !inCollectionIds.has(p.id));

  const handleTitleChange = (value) => {
    setForm((prev) => ({
      ...prev,
      title: value,
      handle: slugManuallyEdited ? prev.handle : slugFromTitle(value),
      display_title: prev.display_title === (prev.title || "") ? value : prev.display_title,
    }));
  };

  const handleSave = async () => {
    const title = (form.title || "").trim();
    const handle = (form.handle || "").trim() || slugFromTitle(title);
    if (!title) {
      setError(c.titleRequired);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      if (isNew) {
        const created = await client.createCollection({
          title,
          handle: handle || slugFromTitle(title),
          standalone: true,
          ...(form.category_id && { category_id: form.category_id }),
        });
        if (created?.id) {
          await client.updateCollection(created.id, {
            title,
            handle: handle || slugFromTitle(title),
            display_title: form.display_title,
            meta_title: form.meta_title,
            meta_description: form.meta_description,
            keywords: form.keywords,
            richtext: form.richtext,
            image_url: form.image_url,
            banner_image_url: form.banner_image_url,
            banner_video_url: form.banner_video_url || null,
            recommended_product_ids: form.recommended_product_ids || [],
          });
          router.replace(`/products/collections/${created.id}`);
        } else {
          await (onReload?.() ?? Promise.resolve());
        }
      } else if (collection?.id) {
        await client.updateCollection(collection.id, {
          title,
          handle: handle || slugFromTitle(title),
          category_id: form.category_id ? form.category_id : null,
          display_title: form.display_title,
          meta_title: form.meta_title,
          meta_description: form.meta_description,
          keywords: form.keywords,
          richtext: form.richtext,
          image_url: form.image_url,
          banner_image_url: form.banner_image_url,
          banner_video_url: form.banner_video_url || null,
          recommended_product_ids: form.recommended_product_ids,
        });
        const updated = await client.getCollection(collection.id);
        if (updated) {
          setCollection(updated);
          const nextForm = {
            title: form.title,
            handle: form.handle,
            category_id: form.category_id,
            display_title: updated.display_title ?? form.display_title,
            meta_title: updated.meta_title ?? form.meta_title,
            meta_description: updated.meta_description ?? form.meta_description,
            keywords: updated.keywords ?? form.keywords,
            richtext: updated.richtext ?? updated.description_html ?? form.richtext,
            image_url: updated.image_url ?? form.image_url,
            banner_image_url: updated.banner_image_url ?? form.banner_image_url,
            banner_video_url: updated.banner_video_url ?? updated.metadata?.banner_video_url ?? form.banner_video_url,
            recommended_product_ids: Array.isArray(updated.recommended_product_ids) ? updated.recommended_product_ids : form.recommended_product_ids,
          };
          setForm((prev) => ({ ...prev, ...nextForm }));
          initialFormRef.current = nextForm;
        }
        onReload?.();
        unsaved?.setDirty(false);
      }
    } catch (err) {
      setError(userError(err, locale, isNew ? "Failed to create collection" : "Failed to update collection"));
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(handleSave);
  const discardRef = useRef(handleDiscard);
  saveRef.current = handleSave;
  discardRef.current = handleDiscard;
  useEffect(() => {
    if (!unsaved) return;
    unsaved.setHandlers({
      onSave: () => saveRef.current?.(),
      onDiscard: () => discardRef.current?.(),
    });
    return () => {
      unsaved.clearHandlers();
      unsaved.setDirty(false);
    };
  }, [unsaved]);

  return (
    <Page
      title={isNew ? c.newCollection : (collection?.title || c.editCollection)}
      backAction={{ content: c.collections, onAction: () => router.push("/products/collections") }}
      primaryAction={{
        content: saving ? c.saving : mediaUploading ? c.uploading : c.save,
        onAction: handleSave,
        loading: saving,
        disabled: mediaUploading,
      }}
    >
      <style>{`
        .collection-richtext-editor { color: var(--p-color-text); }
        .collection-richtext-editor h1 { font-size: 1.75rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .collection-richtext-editor h2 { font-size: 1.5rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .collection-richtext-editor h3 { font-size: 1.25rem; font-weight: 600; margin: 0.6em 0 0.3em; line-height: 1.35; }
        .collection-richtext-editor h4, .collection-richtext-editor h5, .collection-richtext-editor h6 { font-size: 1.1rem; font-weight: 600; margin: 0.5em 0 0.25em; line-height: 1.4; }
        .collection-richtext-editor h1:first-child, .collection-richtext-editor h2:first-child, .collection-richtext-editor h3:first-child { margin-top: 0; }
        .collection-richtext-editor p { margin: 0 0 0.6em; }
        .collection-richtext-editor p:last-child { margin-bottom: 0; }
        .collection-richtext-editor ul, .collection-richtext-editor ol { margin: 0.4em 0 0.8em 1.5em; padding-left: 1.5em; }
        .collection-richtext-editor ul { list-style-type: disc; }
        .collection-richtext-editor ol { list-style-type: decimal; }
        .collection-richtext-editor li { margin-bottom: 0.25em; }
        .collection-richtext-editor strong { font-weight: 600; }
        .collection-richtext-editor blockquote { margin: 0.75em 0; padding-left: 1em; border-left: 4px solid var(--p-color-border); color: var(--p-color-text-subdued); }
      `}</style>
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingSm">
                {c.basic}
              </Text>
              <TextField
                label={c.collectionName}
                value={form.title}
                onChange={handleTitleChange}
                placeholder={c.namePlaceholder}
                autoComplete="off"
                helpText={c.nameHelp}
              />
              <TextField
                label={c.handleLabel}
                value={form.handle}
                onChange={(value) => {
                  setSlugManuallyEdited(true);
                  setForm((prev) => ({ ...prev, handle: value }));
                }}
                placeholder={c.handlePlaceholder}
                autoComplete="off"
                helpText={c.handleHelp}
              />
              <CategoryDrilldownSelect
                label={c.linkCategory}
                categories={categories || []}
                value={form.category_id}
                onChange={(value) => setForm((prev) => ({ ...prev, category_id: value }))}
                placeholder={c.selectCategory}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
        {!isNew && collection?.id && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingSm">{c.productsInCollection}</Text>
                <p style={{ margin: 0, fontSize: 14, color: "var(--p-color-text-subdued)" }}>
                  {c.productsHint}
                </p>
                {collectionProducts.length === 0 ? (
                  <Text as="p" tone="subdued">{c.noProducts}</Text>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--p-color-border)", textAlign: "left" }}>
                          <th style={{ padding: "8px 12px", fontWeight: 600 }}>{c.colImage}</th>
                          <th style={{ padding: "8px 12px", fontWeight: 600 }}>{c.colSku}</th>
                          <th style={{ padding: "8px 12px", fontWeight: 600 }}>{c.colTitle}</th>
                          <th style={{ padding: "8px 12px", fontWeight: 600 }}>{c.colPrice}</th>
                          <th style={{ padding: "8px 12px", fontWeight: 600 }}>{c.colQty}</th>
                          <th style={{ padding: "8px 12px", fontWeight: 600, width: 100 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {collectionProducts.map((p) => {
                          const media = (p.metadata && p.metadata.media) ? (Array.isArray(p.metadata.media) ? p.metadata.media[0] : p.metadata.media) : null;
                          const imgUrl = typeof media === "string" ? media : (media && media.url) ? media.url : null;
                          const price = p.price != null ? p.price : (p.price_cents != null ? p.price_cents / 100 : 0);
                          const qty = p.inventory != null ? p.inventory : 0;
                          return (
                            <tr key={p.id} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                              <td style={{ padding: "8px 12px", verticalAlign: "middle" }}>
                                {imgUrl ? (
                                  <Link href={`/products/${p.id}`} style={{ display: "inline-block" }}>
                                    <img src={imgUrl.startsWith("http") || imgUrl.startsWith("data:") ? imgUrl : `${baseUrl}${imgUrl}`} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }} />
                                  </Link>
                                ) : (
                                  <div style={{ width: 48, height: 48, background: "var(--p-color-bg-fill-secondary)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--p-color-text-subdued)", fontSize: 12 }}>—</div>
                                )}
                              </td>
                              <td style={{ padding: "8px 12px" }}>{p.sku || "—"}</td>
                              <td style={{ padding: "8px 12px" }}>
                                <Link href={`/products/${p.id}`} style={{ fontWeight: 500, color: "inherit" }}>{p.title || p.handle || p.id}</Link>
                              </td>
                              <td style={{ padding: "8px 12px" }}>{typeof price === "number" ? (price % 1 === 0 ? price : price.toFixed(2)) : price} €</td>
                              <td style={{ padding: "8px 12px" }}>{qty}</td>
                              <td style={{ padding: "8px 12px" }}>
                                <Button size="slim" tone="critical" variant="plain" onClick={() => removeProductFromCollection(p.id)} loading={removingProductId === p.id}>{c.remove}</Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ marginTop: 16 }}>
                  <div ref={searchContainerRef} style={{ position: "relative" }}>
                    <TextField
                      label={c.addProduct}
                      value={addProductSearch}
                      onChange={setAddProductSearch}
                      onFocus={() => setAddProductPopoverOpen(true)}
                      placeholder={c.searchProducts}
                      autoComplete="off"
                    />
                    {addProductPopoverOpen && searchRect && (
                      <div
                        style={{
                          position: "fixed",
                          top: searchRect.bottom + 4,
                          left: searchRect.left,
                          width: searchRect.width,
                          maxHeight: 320,
                          overflowY: "auto",
                          background: "var(--p-color-bg-surface)",
                          border: "1px solid var(--p-color-border)",
                          borderRadius: 8,
                          zIndex: 10002,
                          boxShadow: "var(--p-shadow-400)",
                        }}
                      >
                        {(() => {
                          const term = addProductSearch.trim().toLowerCase();
                          const filtered = productsNotInCollection
                            .filter((p) => !term || (p.title || p.handle || p.sku || "").toLowerCase().includes(term))
                            .slice(0, 100);
                          if (filtered.length === 0) {
                            return <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--p-color-text-subdued)" }}>{c.noProducts}</div>;
                          }
                          return filtered.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              style={{
                                display: "block",
                                width: "100%",
                                padding: "8px 12px",
                                textAlign: "left",
                                border: "none",
                                borderBottom: "1px solid var(--p-color-border-subdued)",
                                background: addingProductId === p.id ? "var(--p-color-bg-fill-secondary)" : "transparent",
                                cursor: addingProductId ? "wait" : "pointer",
                                fontSize: 13,
                              }}
                              onClick={() => { addProductToCollection(p.id); setAddProductPopoverOpen(false); }}
                              disabled={!!addingProductId}
                            >
                              {addingProductId === p.id ? `${c.adding} ` : ""}{p.title || p.handle || p.sku || p.id}
                            </button>
                          ));
                        })()}
                      </div>
                    )}
                    {addProductPopoverOpen && (
                      <div
                        style={{ position: "fixed", inset: 0, zIndex: 10001 }}
                        onClick={() => setAddProductPopoverOpen(false)}
                        aria-hidden
                      />
                    )}
                  </div>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingSm">{c.shopPage}</Text>
              <TextField
                label={c.displayTitle}
                value={form.display_title}
                onChange={(value) => setForm((prev) => ({ ...prev, display_title: value }))}
                placeholder={c.displayTitlePlaceholder}
                autoComplete="off"
              />
              <Text as="p" variant="bodySm" fontWeight="medium">{c.mainImage}</Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
                {form.image_url ? (
                  <div style={{ width: 100, aspectRatio: 1, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-fill-secondary)", position: "relative" }}>
                    <img src={form.image_url.startsWith("http") || form.image_url.startsWith("data:") ? form.image_url : `${baseUrl}${form.image_url}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <button type="button" onClick={() => setForm((prev) => ({ ...prev, image_url: "" }))} style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", fontSize: 14 }} aria-label={c.remove}>×</button>
                  </div>
                ) : null}
                <div
                  onClick={() => setMainImgPickerOpen(true)}
                  style={{ width: 100, aspectRatio: 1, borderRadius: 8, border: "2px dashed var(--p-color-border)", background: "var(--p-color-bg-fill-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <span style={{ fontSize: 24, color: "var(--p-color-icon)" }}>+</span>
                </div>
              </div>
              <Text as="p" variant="bodySm" fontWeight="medium">{c.bannerImage}</Text>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
                {form.banner_image_url ? (
                  <div style={{ maxWidth: 320, height: 50, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-fill-secondary)", position: "relative" }}>
                    <img src={form.banner_image_url.startsWith("http") || form.banner_image_url.startsWith("data:") ? form.banner_image_url : `${baseUrl}${form.banner_image_url}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    <button type="button" onClick={() => setForm((prev) => ({ ...prev, banner_image_url: "" }))} style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", fontSize: 14 }} aria-label="Remove">×</button>
                  </div>
                ) : null}
                <div
                  onClick={() => setBannerImgPickerOpen(true)}
                  style={{ width: 200, height: 50, borderRadius: 8, border: "2px dashed var(--p-color-border)", background: "var(--p-color-bg-fill-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                  <span style={{ fontSize: 18, color: "var(--p-color-icon)" }}>+ Banner</span>
                </div>
              </div>
              <Text as="p" variant="bodySm" fontWeight="medium">Banner-Video (optional, ersetzt Bild)</Text>
              {form.banner_video_url ? (
                <div style={{ maxWidth: 320, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-fill-secondary)", position: "relative" }}>
                  <video src={form.banner_video_url.startsWith("http") ? form.banner_video_url : `${baseUrl}${form.banner_video_url}`} style={{ width: "100%", maxHeight: 80, objectFit: "cover", display: "block" }} muted playsInline />
                  <button type="button" onClick={() => setForm((prev) => ({ ...prev, banner_video_url: "" }))} style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.5)", color: "#fff", cursor: "pointer", fontSize: 14 }} aria-label="Remove">×</button>
                </div>
              ) : null}
              <TextField
                label=""
                labelHidden
                value={form.banner_video_url || ""}
                onChange={(v) => setForm((prev) => ({ ...prev, banner_video_url: v }))}
                autoComplete="off"
                placeholder="https://…/banner.mp4 (MP4/WebM)"
              />
              <MediaPickerModal
                open={mainImgPickerOpen}
                onClose={() => setMainImgPickerOpen(false)}
                title="Ana görsel seç"
                multiple={false}
                onUploadingChange={setMediaUploading}
                onSelect={(urls) => { if (urls[0]) setForm((prev) => ({ ...prev, image_url: urls[0] })); }}
              />
              <MediaPickerModal
                open={bannerImgPickerOpen}
                onClose={() => setBannerImgPickerOpen(false)}
                title="Banner görseli seç"
                multiple={false}
                onUploadingChange={setMediaUploading}
                onSelect={(urls) => { if (urls[0]) setForm((prev) => ({ ...prev, banner_image_url: urls[0] })); }}
              />
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" fontWeight="medium">Richtext (below products on collection page)</Text>
                <div className="collection-description-box" style={{ border: "1px solid var(--p-color-border)", borderRadius: 12, overflow: "hidden", background: "var(--p-color-bg-surface)" }}>
                  <div className="collection-description-toolbar" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--p-color-bg-surface-secondary)", borderBottom: "1px solid var(--p-color-border)" }}>
                    {richtextMode === "visual" && (
                      <>
                        <button type="button" className="collection-desc-btn" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)" }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("bold"); }} title="Bold">B</button>
                        <button type="button" className="collection-desc-btn" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)" }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("italic"); }} title="Italic">I</button>
                        <button type="button" className="collection-desc-btn" style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: "transparent", color: "var(--p-color-text-subdued)" }} onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }} title="List">•</button>
                      </>
                    )}
                    <button type="button" style={{ marginLeft: 8, width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, cursor: "pointer", background: richtextMode === "html" ? "var(--p-color-bg-surface-selected)" : "transparent", color: "var(--p-color-text-subdued)" }} onClick={() => { if (richtextMode === "visual" && richtextEditorRef.current) setForm((prev) => ({ ...prev, richtext: descriptionVisualToHtml(richtextEditorRef.current.innerHTML || "") })); else if (richtextMode !== "visual" && richtextEditorRef.current) richtextEditorRef.current.innerHTML = form.richtext || ""; setRichtextMode(richtextMode === "html" ? "visual" : "html"); }} title="HTML">{"</>"}</button>
                  </div>
                  {richtextMode === "html" ? (
                    <textarea style={{ minHeight: 160, width: "100%", padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, border: "none", resize: "vertical", boxSizing: "border-box" }} value={form.richtext || ""} onChange={(e) => setForm((prev) => ({ ...prev, richtext: e.target.value }))} placeholder="<h2>Heading</h2><p>…</p>" />
                  ) : (
                    <div ref={richtextEditorRef} className="collection-richtext-editor" contentEditable suppressContentEditableWarning style={{ minHeight: 160, padding: 16, outline: "none", fontSize: 14, lineHeight: 1.6 }} onBlur={() => { if (richtextEditorRef.current) setForm((prev) => ({ ...prev, richtext: descriptionVisualToHtml(richtextEditorRef.current.innerHTML || "") })); }} />
                  )}
                </div>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingSm">{c.seo}</Text>
              <Box position="relative">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <Text as="span" variant="bodySm" tone="subdued">{c.metaTitle}</Text>
                  <Text as="span" variant="bodySm" tone="subdued">{(form.meta_title || "").length} / {META_TITLE_MAX}</Text>
                </div>
                <TextField label="" labelHidden value={form.meta_title} onChange={(v) => setForm((prev) => ({ ...prev, meta_title: v.slice(0, META_TITLE_MAX) }))} placeholder={form.display_title || form.title || c.metaTitle} autoComplete="off" />
              </Box>
              <Box position="relative">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <Text as="span" variant="bodySm" tone="subdued">{c.metaDescription}</Text>
                  <Text as="span" variant="bodySm" tone="subdued">{(form.meta_description || "").length} / {META_DESC_MAX}</Text>
                </div>
                <TextField label="" labelHidden value={form.meta_description} onChange={(v) => setForm((prev) => ({ ...prev, meta_description: v.slice(0, META_DESC_MAX) }))} placeholder={seoPlainPreview(form.richtext, 160) || c.metaDescription} multiline={2} autoComplete="off" />
              </Box>
              <TextField label={c.keywords} value={form.keywords} onChange={(value) => setForm((prev) => ({ ...prev, keywords: value }))} placeholder={c.keywordsPlaceholder} autoComplete="off" />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
