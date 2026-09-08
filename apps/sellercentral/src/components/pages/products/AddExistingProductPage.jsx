"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

const copy = {
  title: { en: "Add Existing Product", tr: "Mevcut Ürün Ekle", de: "Bestehendes Produkt hinzufügen" },
  subtitle: {
    en: "Search for an existing product in the catalog by EAN, product ID, or shop link. The form will be pre-filled with the product's data — add your own price, SKU, and shipping details.",
    tr: "EAN, ürün kimliği veya shop linki ile mevcut bir ürünü kataloğda ara. Form ürün verileriyle doldurulur — kendi fiyatını, SKU'nu ve kargo bilgilerini ekle.",
    de: "Suche ein bestehendes Produkt im Katalog per EAN, Produkt-ID oder Shop-Link. Das Formular wird mit den Katalogdaten vorausgefüllt — füge deinen eigenen Preis, SKU und Versanddetails hinzu.",
  },
  eanLabel: { en: "EAN / Barcode", tr: "EAN / Barkod", de: "EAN / Barcode" },
  eanPlaceholder: { en: "e.g. 4012345678901", tr: "örn. 4012345678901", de: "z. B. 4012345678901" },
  idLabel: { en: "Product ID", tr: "Ürün Kimliği", de: "Produkt-ID" },
  idPlaceholder: { en: "UUID from sellercentral", tr: "Sellercentral'dan UUID", de: "UUID aus dem Sellercentral" },
  urlLabel: { en: "Shop URL or handle", tr: "Shop URL veya handle", de: "Shop-URL oder Handle" },
  urlPlaceholder: { en: "andertal.com/de/product-name-ab12cd34", tr: "andertal.com/de/urun-adi-ab12cd34", de: "andertal.com/de/produktname-ab12cd34" },
  search: { en: "Search", tr: "Ara", de: "Suchen" },
  found: {
    en: "Product found. Click \"Add to my products\" to create a new listing with pre-filled catalog data.",
    tr: "Ürün bulundu. Katalog verileriyle doldurulmuş yeni listeleme oluşturmak için \"Ürünlerime ekle\"ye tıkla.",
    de: 'Produkt gefunden. Klicke auf „Zu meinen Produkten hinzufügen“, um ein neues Listing mit vorausgefüllten Katalogdaten zu erstellen.',
  },
  notFound: { en: "No product found for this input.", tr: "Bu giriş için ürün bulunamadı.", de: "Für diese Eingabe wurde kein Produkt gefunden." },
  addBtn: { en: "Add to my products", tr: "Ürünlerime ekle", de: "Zu meinen Produkten hinzufügen" },
  back: { en: "Back to inventory", tr: "Envantera dön", de: "Zurück zum Bestand" },
  matchedVariant: { en: "Matched variant", tr: "Eşleşen varyasyon", de: "Übereinstimmende Variante" },
  otherVariants: { en: "Other variants in this product", tr: "Bu ürüne ait diğer varyasyonlar", de: "Weitere Varianten dieses Produkts" },
  showVariants: { en: "Show all variants", tr: "Tüm varyasyonları göster", de: "Alle Varianten anzeigen" },
  hideVariants: { en: "Hide variants", tr: "Varyasyonları gizle", de: "Varianten ausblenden" },
  variantCount: { en: (n) => `${n} variants total`, tr: (n) => `Toplam ${n} varyasyon`, de: (n) => `${n} Varianten insgesamt` },
};

function useT() {
  const locale = useLocale();
  const l = String(locale || "en").toLowerCase();
  return (key) => {
    const entry = copy[key];
    if (!entry) return key;
    if (l === "tr") return entry.tr;
    if (l === "de" || l === "fr" || l === "es" || l === "it") return entry.de;
    return entry.en;
  };
}

function stripHandleSuffix(handle) {
  const lastDash = handle.lastIndexOf("-");
  if (lastDash < 1) return handle;
  const suffix = handle.slice(lastDash + 1);
  if (/^[a-z0-9]{8}$/i.test(suffix)) return handle.slice(0, lastDash);
  return handle;
}

function getVariantLabel(v) {
  if (!v) return "";
  const opts = Array.isArray(v.option_values) ? v.option_values : [];
  if (opts.length > 0) {
    const parts = opts.map((o) => {
      if (!o) return "";
      if (typeof o === "string") return o;
      return String(o.label || o.value || "").trim();
    }).filter(Boolean);
    if (parts.length > 0) return parts.join(" / ");
  }
  return String(v.value || v.option || v.name || v.title || "").trim();
}

function ProductThumb({ product }) {
  const media = product.metadata?.media?.[0];
  const src = typeof media === "string" ? media : (media?.url || product.image_url || "");
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
    />
  );
}

function VariantRow({ v, isMatch }) {
  const label = getVariantLabel(v);
  const ean = v.ean || v.metadata?.ean || "";
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "6px 10px",
      borderRadius: 6,
      background: isMatch ? "var(--p-color-bg-success-subdued, #f0fdf4)" : "var(--p-color-bg-surface-secondary)",
      border: isMatch ? "1px solid #86efac" : "1px solid transparent",
    }}>
      {isMatch && <span style={{ fontSize: 12, color: "#15803d", fontWeight: 600 }}>✓</span>}
      <BlockStack gap="050">
        {label && <Text as="p" variant="bodySm" fontWeight={isMatch ? "semibold" : "regular"}>{label}</Text>}
        {ean && <Text as="p" variant="bodySm" tone="subdued">EAN: {ean}</Text>}
        {v.sku && <Text as="p" variant="bodySm" tone="subdued">SKU: {v.sku}</Text>}
      </BlockStack>
    </div>
  );
}

export default function AddExistingProductPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const client = getMedusaAdminClient();

  const [ean, setEan] = useState("");
  const [productId, setProductId] = useState("");
  const [shopUrl, setShopUrl] = useState("");
  const [searchedEan, setSearchedEan] = useState("");

  const [state, setState] = useState(null); // null | "loading" | "found" | "not_found"
  const [foundProduct, setFoundProduct] = useState(null);
  const [siblingsOpen, setSiblingsOpen] = useState(false);

  const search = useCallback(async () => {
    const eanTrim = ean.trim();
    const idTrim = productId.trim();
    const urlTrim = shopUrl.trim();

    if (!eanTrim && !idTrim && !urlTrim) return;

    setState("loading");
    setFoundProduct(null);
    setSiblingsOpen(false);
    setSearchedEan(eanTrim);

    try {
      let found = null;

      if (!found && eanTrim) {
        const eanResult = await client.lookupProductByEan(eanTrim).catch(() => null);
        found = eanResult?.product || null;
      }

      if (!found && idTrim) {
        try {
          const { product } = await client.getAdminHubProductFull(idTrim);
          if (product?.id) found = product;
        } catch (_) {}
      }

      if (!found && urlTrim) {
        let segment = urlTrim;
        try {
          const parsed = new URL(urlTrim.startsWith("http") ? urlTrim : `https://${urlTrim}`);
          const parts = parsed.pathname.split("/").filter(Boolean);
          if (parts.length > 0) segment = parts[parts.length - 1];
        } catch (_) {}
        const baseHandle = stripHandleSuffix(segment);
        for (const h of [...new Set([baseHandle, segment])]) {
          if (!h) continue;
          try {
            const { product } = await client.getAdminHubProductFull(h);
            if (product?.id) { found = product; break; }
          } catch (_) {}
        }
      }

      if (found?.id) {
        setFoundProduct(found);
        setState("found");
      } else {
        setState("not_found");
      }
    } catch (_) {
      setState("not_found");
    }
  }, [ean, productId, shopUrl, client]);

  // Deep-linked from the "See other variations" button on the product edit page.
  useEffect(() => {
    const pid = searchParams?.get("product_id");
    if (!pid) return;
    setProductId(pid);
  }, [searchParams]);

  useEffect(() => {
    if (productId && searchParams?.get("product_id") === productId) {
      search();
    }
  }, [productId]);

  const handleAdd = () => {
    if (!foundProduct?.id) return;
    const variantEan = matchedVariant ? String(matchedVariant.ean || matchedVariant.metadata?.ean || "").trim() : "";
    const suffix = variantEan ? `&variant_ean=${encodeURIComponent(variantEan)}` : "";
    router.push(`/products/new?existing_id=${encodeURIComponent(foundProduct.id)}${suffix}`);
  };

  const variants = Array.isArray(foundProduct?.variants) ? foundProduct.variants : [];
  const matchedVariant = searchedEan
    ? variants.find((v) => String(v?.ean || v?.metadata?.ean || "").trim() === searchedEan)
    : null;
  const siblingVariants = matchedVariant
    ? variants.filter((v) => v !== matchedVariant)
    : [];

  return (
    <Page
      title={t("title")}
      backAction={{ content: t("back"), url: "/products/inventory" }}
    >
      <Card>
        <BlockStack gap="400">
          <Text as="p" variant="bodySm" tone="subdued">{t("subtitle")}</Text>

          <Divider />

          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label={t("eanLabel")}
                  value={ean}
                  onChange={(v) => { setEan(v); setState(null); setFoundProduct(null); setSearchedEan(""); }}
                  placeholder={t("eanPlaceholder")}
                  autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                />
              </div>
            </InlineStack>

            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label={t("idLabel")}
                  value={productId}
                  onChange={(v) => { setProductId(v); setState(null); setFoundProduct(null); setSearchedEan(""); }}
                  placeholder={t("idPlaceholder")}
                  autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                />
              </div>
            </InlineStack>

            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField
                  label={t("urlLabel")}
                  value={shopUrl}
                  onChange={(v) => { setShopUrl(v); setState(null); setFoundProduct(null); setSearchedEan(""); }}
                  placeholder={t("urlPlaceholder")}
                  autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter") search(); }}
                />
              </div>
            </InlineStack>

            <Box>
              <Button
                variant="primary"
                onClick={search}
                loading={state === "loading"}
                disabled={!ean.trim() && !productId.trim() && !shopUrl.trim()}
              >
                {t("search")}
              </Button>
            </Box>
          </BlockStack>

          {state === "found" && foundProduct && (
            <BlockStack gap="300">
              <Banner tone="success">
                <Text as="p">{t("found")}</Text>
              </Banner>

              {/* Product header */}
              <div style={{ padding: "12px 16px", background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, display: "flex", alignItems: "center", gap: 16 }}>
                <ProductThumb product={foundProduct} />
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {foundProduct.title || foundProduct.handle || foundProduct.id}
                  </Text>
                  {variants.length > 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {typeof t("variantCount") === "function" ? t("variantCount")(variants.length) : `${variants.length} variants`}
                    </Text>
                  )}
                  {(foundProduct.metadata?.ean || foundProduct.ean) && variants.length === 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">EAN: {foundProduct.metadata?.ean || foundProduct.ean}</Text>
                  )}
                </BlockStack>
              </div>

              {/* Matched variant highlight */}
              {matchedVariant && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="success">{t("matchedVariant")}</Text>
                  <VariantRow v={matchedVariant} isMatch />
                </BlockStack>
              )}

              {/* Sibling variants */}
              {siblingVariants.length > 0 && (
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued">{t("otherVariants")} ({siblingVariants.length})</Text>
                    <Button
                      variant="plain"
                      onClick={() => setSiblingsOpen((o) => !o)}
                    >
                      {siblingsOpen ? t("hideVariants") : t("showVariants")}
                    </Button>
                  </InlineStack>
                  {siblingsOpen && (
                    <BlockStack gap="150">
                      {siblingVariants.map((v, i) => (
                        <VariantRow key={v.id || i} v={v} isMatch={false} />
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              )}

              {/* No variant match but has variants — show all */}
              {!matchedVariant && variants.length > 0 && (
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" tone="subdued">{t("otherVariants")} ({variants.length})</Text>
                    <Button
                      variant="plain"
                      onClick={() => setSiblingsOpen((o) => !o)}
                    >
                      {siblingsOpen ? t("hideVariants") : t("showVariants")}
                    </Button>
                  </InlineStack>
                  {siblingsOpen && (
                    <BlockStack gap="150">
                      {variants.map((v, i) => (
                        <VariantRow key={v.id || i} v={v} isMatch={false} />
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              )}

              <Button variant="primary" onClick={handleAdd}>{t("addBtn")}</Button>
            </BlockStack>
          )}

          {state === "not_found" && (
            <Banner tone="warning">{t("notFound")}</Banner>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
