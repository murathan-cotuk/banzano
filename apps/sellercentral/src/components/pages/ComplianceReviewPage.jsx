"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner, Box, TextField, Select, Button } from "@shopify/polaris";
import { useRouter } from "@/i18n/navigation";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Surfaces docs/HUKUKI.md's non-blocking "needs_compliance_review" advisory (Faz 2) grouped by
// category — a flat table of every flagged product across the whole catalog was unreadable once
// there were more than a handful of rows, so this groups by the product's category breadcrumb
// (collapsible, like the category tree elsewhere) with the existing seller/profile filters still
// narrowing what shows inside each group.
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
      "Products the compliance engine flagged as missing required fields for their category, grouped by category so gaps don't get lost in one long list. This never blocks a sale — it's a heads-up.",
      "Uyumluluk motorunun kategorisi için zorunlu alanları eksik olarak işaretlediği ürünler; kaybolmamaları için kategoriye göre gruplandırıldı. Bu hiçbir satışı engellemez — sadece bir uyarıdır.",
      "Produkte, die die Compliance-Engine als fehlend markiert hat (Pflichtfelder für ihre Kategorie), gruppiert nach Kategorie, damit nichts in einer langen Liste untergeht. Das blockiert nie einen Verkauf — es ist nur ein Hinweis.",
    ),
    empty: t("Nothing needs review right now.", "Şu anda incelenmesi gereken bir şey yok.", "Aktuell muss nichts geprüft werden."),
    noMatches: t("No products match these filters.", "Bu filtrelere uyan ürün yok.", "Keine Produkte für diese Filter."),
    loadError: t("Could not load the review list.", "İnceleme listesi yüklenemedi.", "Prüfliste konnte nicht geladen werden."),
    colMissing: t("Missing fields", "Eksik alanlar", "Fehlende Felder"),
    colChecked: t("Last checked", "Son kontrol", "Zuletzt geprüft"),
    editProduct: t("Open product", "Ürünü aç", "Produkt öffnen"),
    sellerLabel: t("Seller", "Satıcı", "Verkäufer"),
    platformProduct: t("Platform (no seller)", "Platform (satıcısız)", "Plattform (kein Verkäufer)"),
    noCategory: t("No category assigned", "Kategori atanmamış", "Keine Kategorie zugewiesen"),
    filterSeller: t("Filter by seller", "Satıcıya göre filtrele", "Nach Verkäufer filtern"),
    filterSellerPlaceholder: t("Seller name or ID…", "Satıcı adı veya ID…", "Verkäufername oder ID…"),
    filterProfile: t("Filter by profile", "Profile göre filtrele", "Nach Profil filtern"),
    allProfiles: t("All profiles", "Tüm profiller", "Alle Profile"),
    filterCategory: t("Filter by category", "Kategoriye göre filtrele", "Nach Kategorie filtern"),
    allCategories: t("All categories", "Tüm kategoriler", "Alle Kategorien"),
    resultCount: (n, total) => t(`${n} of ${total}`, `${total} üründen ${n}`, `${n} von ${total}`),
    groupCount: (n) => t(`${n} product${n === 1 ? "" : "s"}`, `${n} ürün`, `${n} Produkt${n === 1 ? "" : "e"}`),
    expandAll: t("Expand all", "Tümünü aç", "Alle aufklappen"),
    collapseAll: t("Collapse all", "Tümünü kapat", "Alle einklappen"),
  };
};

function GroupHeader({ label, count, open, onToggle, countLabel }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 16px",
        background: "#f6f6f7",
        border: "none",
        borderBottom: "1px solid #e1e3e5",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{
          display: "inline-block",
          fontSize: 13,
          color: "#6d7175",
          transform: `rotate(${open ? "90deg" : "0deg"})`,
          transition: "transform 0.15s ease",
        }}
      >
        ›
      </span>
      <span style={{ fontWeight: 700, fontSize: 13, color: "#111827", flex: 1 }}>{label}</span>
      <Badge>{countLabel}</Badge>
    </button>
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
  const [categoryFilter, setCategoryFilter] = useState("");
  const [openGroups, setOpenGroups] = useState(null); // null = default (first group open), else Set of open breadcrumbs

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

  const profileOptions = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const seen = new Map();
    for (const p of products) {
      if (!p.profile_id || seen.has(p.profile_id)) continue;
      seen.set(p.profile_id, localizedLabel(p.profile_label_i18n, locale, p.profile_id));
    }
    return [{ label: c.allProfiles, value: "" }, ...[...seen.entries()].map(([value, label]) => ({ label, value }))];
  }, [products, locale, c.allProfiles]);

  const categoryOptions = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const seen = new Map();
    for (const p of products) {
      const key = p.category_breadcrumb || "";
      if (seen.has(key)) continue;
      seen.set(key, key || c.noCategory);
    }
    return [{ label: c.allCategories, value: "" }, ...[...seen.entries()].map(([value, label]) => ({ label, value }))];
  }, [products, c.allCategories, c.noCategory]);

  const visibleProducts = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const sellerQ = sellerFilter.trim().toLowerCase();
    return products.filter((p) => {
      if (profileFilter && p.profile_id !== profileFilter) return false;
      if (categoryFilter && (p.category_breadcrumb || "") !== categoryFilter) return false;
      if (sellerQ) {
        const hay = `${p.seller_id || ""} ${p.seller_name || ""}`.toLowerCase();
        if (!hay.includes(sellerQ)) return false;
      }
      return true;
    });
  }, [products, sellerFilter, profileFilter, categoryFilter]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of visibleProducts) {
      const key = p.category_breadcrumb || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return [...map.entries()]
      .map(([key, items]) => ({ key, label: key || c.noCategory, items }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [visibleProducts, c.noCategory]);

  const isGroupOpen = (key, idx) => {
    if (openGroups === null) return idx === 0; // default: only the first group expanded
    return openGroups.has(key);
  };
  const toggleGroup = (key, idx) => {
    setOpenGroups((prev) => {
      const base = prev === null
        ? new Set(groups.map((g, i) => (i === 0 ? g.key : null)).filter((k) => k !== null))
        : new Set(prev);
      if (base.has(key)) base.delete(key); else base.add(key);
      return base;
    });
  };

  if (!isSuperuser) return null;

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{c.subtitle}</Text>
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}
        {Array.isArray(products) && products.length > 0 && (
          <Card>
            <InlineStack gap="300" wrap blockAlign="center">
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
              <div style={{ minWidth: 220 }}>
                <Select
                  label={c.filterCategory}
                  labelHidden
                  options={categoryOptions}
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                />
              </div>
              <Text as="span" tone="subdued" variant="bodySm">
                {c.resultCount(visibleProducts.length, products.length)}
              </Text>
              <InlineStack gap="150">
                <Button size="slim" onClick={() => setOpenGroups(new Set(groups.map((g) => g.key)))}>{c.expandAll}</Button>
                <Button size="slim" onClick={() => setOpenGroups(new Set())}>{c.collapseAll}</Button>
              </InlineStack>
            </InlineStack>
          </Card>
        )}

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
          <BlockStack gap="300">
            {groups.map((group, idx) => {
              const open = isGroupOpen(group.key, idx);
              return (
                <Card key={group.key || "__none__"} padding="0">
                  <GroupHeader
                    label={group.label}
                    open={open}
                    onToggle={() => toggleGroup(group.key, idx)}
                    countLabel={c.groupCount(group.items.length)}
                  />
                  {open && (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <tbody>
                        {group.items.map((p) => (
                          <tr key={p.id} style={{ borderTop: "1px solid #f1f1f1", cursor: "pointer" }} onClick={() => router.push(`/products/${p.id}`)}>
                            <td style={{ padding: "12px 16px", width: "28%" }}>
                              <div style={{ fontWeight: 600, color: "#111827" }}>{p.title || "—"}</div>
                              <div style={{ fontSize: 11, color: "#9ca3af" }}>{p.seller_id ? `${c.sellerLabel}: ${p.seller_name || p.seller_id}` : c.platformProduct}</div>
                            </td>
                            <td style={{ padding: "12px 16px", width: "34%" }}>
                              <InlineStack gap="100" wrap>
                                {(p.missing_fields || []).map((f) => (
                                  <Badge key={f.key} tone="critical">{localizedLabel(f.label_i18n, locale, f.key)}</Badge>
                                ))}
                              </InlineStack>
                            </td>
                            <td style={{ padding: "12px 16px", color: "#6d7175", fontSize: 12, width: "18%" }}>{fmtDate(p.checked_at, locale)}</td>
                            <td style={{ padding: "12px 16px", textAlign: "right" }}>
                              <span style={{ color: "#2563eb", fontWeight: 600, fontSize: 12 }}>{c.editProduct} →</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              );
            })}
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
