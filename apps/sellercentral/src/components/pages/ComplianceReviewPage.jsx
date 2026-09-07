"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner, Box, TextField, Select } from "@shopify/polaris";
import { useRouter } from "next/navigation";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Surfaces docs/HUKUKI.md's non-blocking "needs_compliance_review" advisory (Faz 2) — until now
// that data only accumulated in metadata.compliance_review with nothing to actually look at it.
function localizedLabel(i18n, locale, fallback) {
  if (i18n && typeof i18n === "object") {
    if (locale && i18n[locale]) return i18n[locale];
    if (i18n.de) return i18n.de;
    if (i18n.en) return i18n.en;
  }
  return fallback;
}

function fmtDate(d, locale) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString(locale === "en" ? "en-GB" : locale === "tr" ? "tr-TR" : "de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

const copy = (locale) => {
  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);
  return {
    title: t("Compliance review", "Uyumluluk incelemesi", "Compliance-Prüfung"),
    subtitle: t(
      "Products the compliance engine flagged as missing required fields for their category. This never blocks a sale — it's a heads-up so gaps don't go unnoticed.",
      "Uyumluluk motorunun, kategorisi için zorunlu alanları eksik olarak işaretlediği ürünler. Bu hiçbir satışı engellemez — sadece boşlukların fark edilmemesini önlemek içindir.",
      "Produkte, die die Compliance-Engine als fehlend markiert hat (Pflichtfelder für ihre Kategorie). Das blockiert nie einen Verkauf — es ist nur ein Hinweis, damit Lücken nicht übersehen werden.",
    ),
    empty: t("Nothing needs review right now.", "Şu anda incelenmesi gereken bir şey yok.", "Aktuell muss nichts geprüft werden."),
    noMatches: t("No products match these filters.", "Bu filtrelere uyan ürün yok.", "Keine Produkte für diese Filter."),
    loadError: t("Could not load the review list.", "İnceleme listesi yüklenemedi.", "Prüfliste konnte nicht geladen werden."),
    colProduct: t("Product", "Ürün", "Produkt"),
    colProfile: t("Compliance profile", "Uyumluluk profili", "Compliance-Profil"),
    colMissing: t("Missing fields", "Eksik alanlar", "Fehlende Felder"),
    colChecked: t("Last checked", "Son kontrol", "Zuletzt geprüft"),
    editProduct: t("Open product", "Ürünü aç", "Produkt öffnen"),
    sellerLabel: t("Seller", "Satıcı", "Verkäufer"),
    platformProduct: t("Platform (no seller)", "Platform (satıcısız)", "Plattform (kein Verkäufer)"),
    filterSeller: t("Filter by seller", "Satıcıya göre filtrele", "Nach Verkäufer filtern"),
    filterSellerPlaceholder: t("Seller name or ID…", "Satıcı adı veya ID…", "Verkäufername oder ID…"),
    filterProfile: t("Filter by profile", "Profile göre filtrele", "Nach Profil filtern"),
    allProfiles: t("All profiles", "Tüm profiller", "Alle Profile"),
    resultCount: (n, total) => t(`${n} of ${total}`, `${total} üründen ${n}`, `${n} von ${total}`),
  };
};

const SORT_FIELDS = {
  product: (p) => (p.title || "").toLowerCase(),
  profile: (p, locale) => localizedLabel(p.profile_label_i18n, locale, p.profile_id || "").toLowerCase(),
  missing: (p) => (p.missing_fields || []).length,
  checked: (p) => (p.checked_at ? new Date(p.checked_at).getTime() : 0),
};

function SortableHeader({ label, field, sort, onSort }) {
  const active = sort.field === field;
  return (
    <th
      role="button"
      tabIndex={0}
      onClick={() => onSort(field)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(field); } }}
      style={{
        padding: "10px 16px",
        fontSize: 11,
        fontWeight: 700,
        color: active ? "#111827" : "#6d7175",
        textTransform: "uppercase",
        borderBottom: "1px solid #e1e3e5",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
    </th>
  );
}

export default function ComplianceReviewPage() {
  const locale = useLocale();
  const router = useRouter();
  const c = copy(locale);
  const [products, setProducts] = useState(null);
  const [error, setError] = useState("");
  const [isSuperuser, setIsSuperuser] = useState(null); // null = not checked yet
  const [sellerFilter, setSellerFilter] = useState("");
  const [profileFilter, setProfileFilter] = useState("");
  const [sort, setSort] = useState({ field: "checked", dir: "desc" });

  useEffect(() => {
    const su = typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true";
    setIsSuperuser(su);
    if (!su) { router.replace("/"); return; }
    let cancelled = false;
    getMedusaAdminClient().getComplianceReviewProducts()
      .then((d) => { if (!cancelled) setProducts(d.products || []); })
      .catch(() => { if (!cancelled) { setProducts([]); setError(c.loadError); } });
    return () => { cancelled = true; };
  }, []);

  const handleSort = (field) => {
    setSort((prev) => (prev.field === field ? { field, dir: prev.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }));
  };

  const profileOptions = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const seen = new Map();
    for (const p of products) {
      if (!p.profile_id || seen.has(p.profile_id)) continue;
      seen.set(p.profile_id, localizedLabel(p.profile_label_i18n, locale, p.profile_id));
    }
    return [{ label: c.allProfiles, value: "" }, ...[...seen.entries()].map(([value, label]) => ({ label, value }))];
  }, [products, locale, c.allProfiles]);

  const visibleProducts = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const sellerQ = sellerFilter.trim().toLowerCase();
    let list = products.filter((p) => {
      if (profileFilter && p.profile_id !== profileFilter) return false;
      if (sellerQ) {
        const hay = `${p.seller_id || ""} ${p.seller_name || ""}`.toLowerCase();
        if (!hay.includes(sellerQ)) return false;
      }
      return true;
    });
    const getter = SORT_FIELDS[sort.field] || SORT_FIELDS.checked;
    list = [...list].sort((a, b) => {
      const va = getter(a, locale);
      const vb = getter(b, locale);
      if (va < vb) return sort.dir === "asc" ? -1 : 1;
      if (va > vb) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [products, sellerFilter, profileFilter, sort, locale]);

  if (!isSuperuser) return null;

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{c.subtitle}</Text>
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}
        {Array.isArray(products) && products.length > 0 && (
          <Card>
            <InlineStack gap="300" wrap>
              <div style={{ minWidth: 220 }}>
                <TextField
                  label={c.filterSeller}
                  labelHidden
                  value={sellerFilter}
                  onChange={setSellerFilter}
                  placeholder={c.filterSellerPlaceholder}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setSellerFilter("")}
                />
              </div>
              <div style={{ minWidth: 220 }}>
                <Select
                  label={c.filterProfile}
                  labelHidden
                  options={profileOptions}
                  value={profileFilter}
                  onChange={setProfileFilter}
                />
              </div>
              <Text as="span" tone="subdued" variant="bodySm">
                {c.resultCount(visibleProducts.length, products.length)}
              </Text>
            </InlineStack>
          </Card>
        )}
        <Card padding="0">
          {products === null ? (
            <Box padding="800">
              <InlineStack align="center"><Spinner size="small" /></InlineStack>
            </Box>
          ) : products.length === 0 ? (
            <Box padding="600">
              <Text as="p" tone="subdued" alignment="center">{c.empty}</Text>
            </Box>
          ) : visibleProducts.length === 0 ? (
            <Box padding="600">
              <Text as="p" tone="subdued" alignment="center">{c.noMatches}</Text>
            </Box>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                  <SortableHeader label={c.colProduct} field="product" sort={sort} onSort={handleSort} />
                  <SortableHeader label={c.colProfile} field="profile" sort={sort} onSort={handleSort} />
                  <SortableHeader label={c.colMissing} field="missing" sort={sort} onSort={handleSort} />
                  <SortableHeader label={c.colChecked} field="checked" sort={sort} onSort={handleSort} />
                  <th style={{ padding: "10px 16px", borderBottom: "1px solid #e1e3e5" }} />
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #f1f1f1", cursor: "pointer" }} onClick={() => router.push(`/products/${p.id}`)}>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{p.title || "—"}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{p.seller_id ? `${c.sellerLabel}: ${p.seller_name || p.seller_id}` : c.platformProduct}</div>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      {p.profile_id ? localizedLabel(p.profile_label_i18n, locale, p.profile_id) : "—"}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <InlineStack gap="100" wrap>
                        {(p.missing_fields || []).map((f) => (
                          <Badge key={f.key} tone="critical">{localizedLabel(f.label_i18n, locale, f.key)}</Badge>
                        ))}
                      </InlineStack>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6d7175", fontSize: 12 }}>{fmtDate(p.checked_at, locale)}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <span style={{ color: "#2563eb", fontWeight: 600, fontSize: 12 }}>{c.editProduct} →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
