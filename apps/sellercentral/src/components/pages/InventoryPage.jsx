"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  SkeletonBodyText,
  SkeletonDisplayText,
  Divider,
  Modal,
  Checkbox,
  TextField,
  Select,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { userError } from "@/lib/api-error-messages";
import { getUI } from "@/lib/ui-strings";
import { lt, fmtMoney, fmtDateShort } from "@/lib/locale-text";
import { formatDecimal } from "@/lib/format";
import { resolveImageUrl } from "@/lib/image-url";
import { Link as I18nLink } from "@/i18n/navigation";
import {
  formatChangeRequestValueForDisplay,
  fieldNameDisplayLabel,
} from "@/lib/product-change-request-format";
import CustomCheckbox from "@/components/ui/CustomCheckbox";

const INVENTORY_ROW_GRID = "40px 56px 110px 72px minmax(320px, 2fr) minmax(140px, 0.9fr) minmax(150px, 1fr) minmax(200px, 1.2fr) 148px";
const EXCEL_BORDER = "1px solid #e5e7eb";

const DEFAULT_DUPLICATE_OPTIONS = {
  title: true,
  description: true,
  price: true,
  inventory: false,
  categories: true,
  media: true,
  variants: true,
};

function stripSkuEanFromVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants.map((v) => {
    const { sku, ean, ...rest } = typeof v === "object" && v ? v : {};
    const out = { ...rest };
    out.sku = "";
    out.ean = undefined;
    if (Array.isArray(out.options)) {
      out.options = out.options.map((o) => {
        const opt = typeof o === "object" && o ? { ...o } : {};
        opt.sku = "";
        opt.ean = undefined;
        return opt;
      });
    }
    return out;
  });
}

function isPlaceholderProductTitle(value) {
  const t = String(value || "").trim();
  return !t || /^(untitled|unbenannt)$/i.test(t);
}

function coerceProductMediaUrl(entry) {
  if (entry == null || entry === "") return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object") return String(entry.url || entry.src || entry.path || "").trim();
  return "";
}

function coerceProductMediaList(list) {
  if (!Array.isArray(list)) {
    const one = coerceProductMediaUrl(list);
    return one ? [one] : [];
  }
  return list.map(coerceProductMediaUrl).filter(Boolean);
}

function getLocalizedTitle(product, locale) {
  const tr = product.metadata?.translations && typeof product.metadata.translations === "object"
    ? product.metadata.translations
    : {};
  const loc = String(locale || "de").toLowerCase();
  const order = [loc, "de", "en", "tr", "fr", "es", "it"];
  for (const l of order) {
    const t = tr[l]?.title;
    if (!isPlaceholderProductTitle(t)) return t;
  }
  for (const l of Object.keys(tr)) {
    const t = tr[l]?.title;
    if (!isPlaceholderProductTitle(t)) return t;
  }
  if (!isPlaceholderProductTitle(product.title)) return product.title;
  return product.title || "Untitled";
}

function firstProductMediaUrl(product, locale) {
  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  const tr = meta.translations && typeof meta.translations === "object" ? meta.translations : {};
  const loc = String(locale || "de").toLowerCase();
  const fromLoc = coerceProductMediaList(tr[loc]?.media);
  if (fromLoc[0]) return fromLoc[0];
  const fromDe = coerceProductMediaList(tr.de?.media);
  if (fromDe[0]) return fromDe[0];
  const fromRoot = coerceProductMediaList(meta.media);
  if (fromRoot[0]) return fromRoot[0];
  for (const l of ["en", "tr", "fr", "es", "it"]) {
    if (l === loc) continue;
    const list = coerceProductMediaList(tr[l]?.media);
    if (list[0]) return list[0];
  }
  return coerceProductMediaUrl(meta.thumbnail) || "";
}

function isOwnInventoryProduct(product, mySellerId) {
  const s = String(product?.seller_id || "").trim();
  if (!s) return true;
  return s === String(mySellerId || "").trim();
}

// A product a seller listed (but didn't originally create ? e.g. an already-existing
// catalog product) has `created_at` from the ORIGINAL owner, not from when this seller
// added it. `seller_listing_created_at` (populated server-side only for this viewing
// seller) reflects when THEY actually added it, so "recently added" sorts correctly
// even for products they didn't create first.
function effectiveAddedAt(product) {
  return product?.seller_listing_created_at || product?.created_at || 0;
}

function sortProductsList(list, locale, sortKey) {
  const arr = [...(list || [])];
  if (sortKey === "title_desc") {
    arr.sort((a, b) => getLocalizedTitle(b, locale).localeCompare(getLocalizedTitle(a, locale), undefined, { sensitivity: "base" }));
  } else if (sortKey === "inventory_desc") {
    arr.sort((a, b) => Number(b?.inventory ?? 0) - Number(a?.inventory ?? 0));
  } else if (sortKey === "inventory_asc") {
    arr.sort((a, b) => Number(a?.inventory ?? 0) - Number(b?.inventory ?? 0));
  } else if (sortKey === "price_desc") {
    arr.sort((a, b) => Number(b?.price ?? 0) - Number(a?.price ?? 0));
  } else if (sortKey === "price_asc") {
    arr.sort((a, b) => Number(a?.price ?? 0) - Number(b?.price ?? 0));
  } else if (sortKey === "created_desc") {
    arr.sort((a, b) => new Date(effectiveAddedAt(b)) - new Date(effectiveAddedAt(a)));
  } else if (sortKey === "created_asc") {
    arr.sort((a, b) => new Date(effectiveAddedAt(a)) - new Date(effectiveAddedAt(b)));
  } else {
    arr.sort((a, b) => getLocalizedTitle(a, locale).localeCompare(getLocalizedTitle(b, locale), undefined, { sensitivity: "base" }));
  }
  return arr;
}

function EditPencilIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M13.96 3.22a2.4 2.4 0 1 1 3.4 3.4l-9.1 9.11-3.7.3.3-3.7 9.1-9.11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m12.33 4.85 3.4 3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getVariantLabel(v, locale) {
  if (!v) return "";
  // option_values array: each is { value, labels, ... }
  const opts = Array.isArray(v.option_values) ? v.option_values : [];
  if (opts.length === 0) {
    const raw = (v.value ?? v.option ?? "").toString().trim();
    return raw;
  }
  return opts
    .map((o) => {
      if (o == null) return "";
      if (typeof o === "string" || typeof o === "number") return String(o).trim();
      const label =
        (o.labels && (o.labels[locale] || o.labels["de"] || o.labels["en"])) ||
        o.label ||
        o.value ||
        "";
      return String(label).trim();
    })
    .filter(Boolean)
    .join("/");
}

function getVariantName(v, locale, fallbackName = "?") {
  if (!v) return "";
  const l = String(locale || "de").toLowerCase();
  const normalizeSig = (s) =>
    String(s || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "")
      .replace(/[_\-|]+/g, "/")
      .replace(/\/+/g, "/")
      .replace(/[^a-z0-9/]/g, "");
  const optionSignature = normalizeSig(getVariantLabel(v, l));
  const isOptionDerived = (text) => {
    const t = normalizeSig(text);
    if (!t) return false;
    return optionSignature && t === optionSignature;
  };
  const tr = v.metadata && typeof v.metadata === "object" && v.metadata.translations && typeof v.metadata.translations === "object"
    ? v.metadata.translations
    : {};
  const trTitle = String(tr[l]?.title || tr.de?.title || tr.en?.title || "").trim();
  if (trTitle && !isOptionDerived(trTitle)) return trTitle;
  const byName = String(v.name || "").trim();
  if (byName && !isOptionDerived(byName)) return byName;
  const byTitle = String(v.title || "").trim();
  if (byTitle && !isOptionDerived(byTitle)) return byTitle;
  const skuFallback = String(v?.sku || "").trim();
  if (skuFallback) return skuFallback;
  return String(fallbackName || "?");
}

function getDefaultShopUrl() {
  const env = process.env.NEXT_PUBLIC_SHOP_URL || "";
  const url = (typeof env === "string" ? env : "").trim();
  if (url) return url.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    if (window.location.hostname === "localhost") return "http://localhost:3000";
    return window.location.origin;
  }
  return "";
}

function defaultShopMarketForLocale(loc) {
  const l = String(loc || "de").toLowerCase();
  if (l === "en") return "gb";
  if (l === "tr") return "tr";
  if (l === "fr") return "fr";
  if (l === "it") return "it";
  if (l === "es") return "es";
  return "de";
}

function shopPreviewPrefix(loc) {
  const l = String(loc || "de").toLowerCase();
  return `/${defaultShopMarketForLocale(l)}/${l}/eur`;
}

function shopProductHandleForLocale(product, loc) {
  const tr = product?.metadata?.translations?.[loc];
  const h = (tr?.handle || "").trim();
  if (h) return h;
  return (product?.handle || "").trim();
}

function statusLabel(statusRaw) {
  const s = String(statusRaw || "").toLowerCase();
  if (s === "published" || s === "active") return "active";
  if (s === "draft" || !s) return "draft";
  if (s === "inactive" || s === "archived") return "inactive";
  return s;
}

function statusColors(statusRaw) {
  const s = String(statusRaw || "").toLowerCase();
  if (s === "published" || s === "active") return { bg: "#dcfce7", fg: "#166534", br: "#86efac" };
  if (s === "draft" || !s) return { bg: "#fef3c7", fg: "#92400e", br: "#fde68a" };
  return { bg: "#fee2e2", fg: "#991b1b", br: "#fecaca" };
}

function isMasterCatalogProduct(product) {
  return !String(product?.seller_id || "").trim();
}

/** Product row toggle: master catalog listings use active/inactive; own products use published/archived (ProductEditPage). */
function productToggleStatusValues(product) {
  if (isMasterCatalogProduct(product)) {
    return { on: "active", off: "inactive" };
  }
  return { on: "published", off: "archived" };
}

function isProductToggleOn(statusRaw) {
  return statusLabel(statusRaw) === "active";
}

function ProductStatusToggle({ on, onChange, disabled, title }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!on);
      }}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-checked={on}
      role="switch"
      style={{
        width: 46,
        height: 26,
        borderRadius: 13,
        padding: 0,
        background: on ? "#10b981" : "#d1d5db",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 23 : 3,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

function InlineVariantEditor({ product, locale, medusaClient, setProducts }) {
  const matrixVariants = (product.variants || []).filter((v) => Array.isArray(v.option_values) && v.option_values.length > 0);
  const [drafts, setDrafts] = useState(() =>
    matrixVariants.map((v) => ({
      option_values: v.option_values,
      sku: v.sku || "",
      inventory: v.inventory != null ? String(v.inventory) : "0",
      price: v.price_cents != null ? String((v.price_cents / 100).toFixed(2)) : "",
    }))
  );
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const setField = (idx, field, val) => {
    setDrafts((prev) => prev.map((d, i) => i === idx ? { ...d, [field]: val } : d));
    setSavedMsg("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const updatedVariants = product.variants.map((v) => {
        if (!Array.isArray(v.option_values) || v.option_values.length === 0) return v;
        const draft = drafts.find((d) =>
          JSON.stringify(d.option_values) === JSON.stringify(v.option_values)
        );
        if (!draft) return v;
        return {
          ...v,
          sku: draft.sku,
          inventory: parseInt(draft.inventory, 10) || 0,
          price_cents: draft.price !== "" ? Math.round(parseFloat(draft.price) * 100) : v.price_cents,
        };
      });
      const updated = await medusaClient.updateAdminHubProduct(product.id, { variants: updatedVariants });
      if (updated) setProducts((prev) => prev.map((p) => p.id === product.id ? { ...p, variants: updatedVariants } : p));
      setSavedMsg((locale === "en" ? "Saved" : locale === "tr" ? "Kaydedildi" : locale === "fr" ? "Enregistré" : locale === "es" ? "Guardado" : locale === "it" ? "Salvato" : "Gespeichert") + " ✓");
    } catch (e) {
      setSavedMsg((locale === "en" ? "Error: " : locale === "tr" ? "Hata: " : locale === "fr" ? "Erreur : " : locale === "es" ? "Error: " : locale === "it" ? "Errore: " : "Fehler: ") + (e?.message || ""));
    } finally {
      setSaving(false);
    }
  };

  const shopBaseUrl = getDefaultShopUrl();
  const l = String(locale || "en").toLowerCase();
  const i18n = {
    select: l === "tr" ? "Seç" : l === "de" ? "Ausw." : l === "fr" ? "Sél." : l === "es" ? "Sel." : l === "it" ? "Sel." : "Select",
    status: l === "tr" ? "Durum" : l === "de" ? "Status" : l === "fr" ? "Statut" : l === "es" ? "Estado" : l === "it" ? "Stato" : "Status",
    details: l === "tr" ? "Ürün detayları" : l === "de" ? "Produktdetails" : l === "fr" ? "Détails produit" : l === "es" ? "Detalles producto" : l === "it" ? "Dettagli prodotto" : "Product details",
    inventory: l === "tr" ? "Envanter" : l === "de" ? "Bestand" : l === "fr" ? "Stock" : l === "es" ? "Inventario" : l === "it" ? "Inventario" : "Inventory",
    price: l === "tr" ? "Fiyat" : l === "de" ? "Preis" : l === "fr" ? "Prix" : l === "es" ? "Precio" : l === "it" ? "Prezzo" : "Price",
    variations: l === "tr" ? "Varyasyonlar" : l === "de" ? "Variationen" : l === "fr" ? "Variantes" : l === "es" ? "Variantes" : l === "it" ? "Varianti" : "Variations",
    sku: "SKU",
    ean: "EAN",
    save: l === "tr" ? "Kaydet" : l === "de" ? "Speichern" : l === "fr" ? "Enregistrer" : l === "es" ? "Guardar" : l === "it" ? "Salva" : "Save",
    saving: l === "tr" ? "Kaydediliyor?" : l === "de" ? "Speichern?" : l === "fr" ? "Enregistrement?" : l === "es" ? "Guardando?" : l === "it" ? "Salvataggio?" : "Saving?",
    noVariations: l === "tr" ? "Varyasyon yok" : l === "de" ? "Keine Variationen" : l === "fr" ? "Pas de variantes" : l === "es" ? "Sin variantes" : l === "it" ? "Nessuna variante" : "No variations",
  };
  const localizeStatus = (k) => {
    if (k === "active") return l === "tr" ? "Aktif" : l === "de" ? "Aktiv" : l === "fr" ? "Actif" : l === "es" ? "Activo" : l === "it" ? "Attivo" : "Active";
    if (k === "inactive") return l === "tr" ? "Pasif" : l === "de" ? "Inaktiv" : l === "fr" ? "Inactif" : l === "es" ? "Inactivo" : l === "it" ? "Inattivo" : "Inactive";
    return l === "tr" ? "Taslak" : l === "de" ? "Entwurf" : l === "fr" ? "Brouillon" : l === "es" ? "Borrador" : l === "it" ? "Bozza" : "Draft";
  };
  if (matrixVariants.length === 0) {
    return <div style={{ padding: "8px 12px", fontSize: 13, color: "#6b7280" }}>{i18n.noVariations}</div>;
  }

  return (
    <div style={{ marginTop: 0, borderTop: EXCEL_BORDER, background: "#fff" }}>
      <div style={{ display: "grid", gridTemplateColumns: "40px 56px 110px 56px 2fr 140px 150px 1.2fr", gap: 0, marginBottom: 0, background: "#f8fafc", borderBottom: EXCEL_BORDER, alignItems: "center" }}>
        <div />
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", padding: "8px 6px", borderRight: EXCEL_BORDER, textAlign: "center" }}>{i18n.select}</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", padding: "8px 6px", borderRight: EXCEL_BORDER, textAlign: "center" }}>{i18n.status}</div>
        <div style={{ borderRight: EXCEL_BORDER, padding: "8px 6px" }} />
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", padding: "8px 8px", borderRight: EXCEL_BORDER, textAlign: "center" }}>{i18n.details}</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", textAlign: "center", padding: "8px 8px", borderRight: EXCEL_BORDER }}>{i18n.inventory}</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", textAlign: "center", padding: "8px 8px", borderRight: EXCEL_BORDER }}>{i18n.price}</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", padding: "8px 8px", textAlign: "center" }}>{i18n.variations}</div>
      </div>
      {drafts.map((d, idx) => {
        const vRow = matrixVariants[idx] || {};
        const vMedia = vRow.metadata?.media;
        const vRawThumb =
          (Array.isArray(vMedia) && vMedia[0] ? (typeof vMedia[0] === "string" ? vMedia[0] : vMedia[0]?.url || null) : null) ||
          vRow.image_urls?.[locale] ||
          vRow.image_url ||
          null;
        const vThumbUrl = vRawThumb ? resolveImageUrl(vRawThumb) : null;
        return (
        <div key={idx} style={{ display: "grid", gridTemplateColumns: "40px 56px 110px 56px 2fr 140px 150px 1.2fr", gap: 0, alignItems: "center", borderBottom: idx === drafts.length - 1 ? "none" : EXCEL_BORDER, background: idx % 2 === 0 ? "#fff" : "#fcfdff" }}>
          <div style={{ textAlign: "center", color: "#9ca3af", padding: "8px 4px", borderRight: EXCEL_BORDER }}>?</div>
          <div style={{ padding: "8px 6px", borderRight: EXCEL_BORDER }}><CustomCheckbox checked={false} onChange={() => {}} size={18} /></div>
          <div style={{ padding: "8px 6px", borderRight: EXCEL_BORDER }}>
            {(() => {
              const c = statusColors(matrixVariants[idx]?.status || product.status);
              return (
                <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, border: `1px solid ${c.br}` }}>
                  {localizeStatus(statusLabel(matrixVariants[idx]?.status || product.status))}
                </span>
              );
            })()}
          </div>
          <div style={{ padding: "8px 6px", borderRight: EXCEL_BORDER, display: "flex", justifyContent: "center" }}>
            <div
              style={{
                width: 40, height: 40, flexShrink: 0, borderRadius: 6, overflow: "hidden",
                background: "#f4f4f5", border: "1px solid #e5e7eb",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {vThumbUrl ? (
                <img
                  src={vThumbUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c1c1c6" strokeWidth="1.6" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="9" cy="9" r="1.6" fill="#c1c1c6" stroke="none" />
                  <path d="M21 15l-5-5-9 9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          </div>
          <div style={{ minWidth: 0, padding: "8px 8px", borderRight: EXCEL_BORDER }}>
            <a
              href={`${shopBaseUrl}${shopPreviewPrefix(locale)}/produkt/${encodeURIComponent(shopProductHandleForLocale(product, locale))}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, fontWeight: 600, color: "#111827", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              title={getVariantName(matrixVariants[idx], locale, `Variant ${idx + 1}`)}
            >
              {getVariantName(matrixVariants[idx], locale, `Variant ${idx + 1}`)}
            </a>
            <button
              type="button"
              onClick={() => router.push(`/products/${product.id}`)}
              style={{ marginTop: 1, padding: 0, background: "none", border: "none", cursor: "pointer", color: "#4b5563", fontSize: 12, textDecoration: "underline" }}
              title={lt(locale, "Open product edit page via SKU", "SKU ile ürün düzenleme sayfasına git", "Ouvrir la page produit via SKU", "Abrir edición de producto vía SKU", "Apri modifica prodotto tramite SKU", "SKU üzerinden ürün düzenleme sayfasına git")}
            >
              {i18n.sku}: {matrixVariants[idx]?.sku || "?"}
            </button>
            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.2 }}>
              {i18n.ean}: {matrixVariants[idx]?.ean || "?"}
            </div>
          </div>
          <div style={{ padding: "8px 8px", borderRight: EXCEL_BORDER }}>
          <input
            type="number"
            min="0"
            value={d.inventory}
            onChange={(e) => setField(idx, "inventory", e.target.value)}
            style={{ fontSize: 13, padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: 6, width: "100%", boxSizing: "border-box", outline: "none", height: 30 }}
          />
          </div>
          <div style={{ padding: "8px 8px", borderRight: EXCEL_BORDER }}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={d.price}
            onChange={(e) => setField(idx, "price", e.target.value)}
            placeholder="0.00"
            style={{ fontSize: 13, padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: 6, width: "100%", boxSizing: "border-box", outline: "none", height: 30 }}
          />
          </div>
          <div style={{ fontSize: 12, color: "#4b5563", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "8px 8px", textAlign: "center" }}>
            {getVariantLabel(matrixVariants[idx], locale) || "?"}
          </div>
        </div>
        );
      })}
      <div style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 12, padding: "8px 6px", borderTop: "1px solid #e5e7eb", background: "#fff" }}>
        <Button type="button" onClick={save} loading={saving} variant="primary">
          {saving ? i18n.saving : i18n.save}
        </Button>
        {savedMsg && <span style={{ fontSize: 12, color: (savedMsg.startsWith("Fehler") || savedMsg.startsWith("Error") || savedMsg.startsWith("Erreur") || savedMsg.startsWith("Errore")) ? "#dc2626" : "#16a34a" }}>{savedMsg}</span>}
      </div>
    </div>
  );
}

function InventoryProductRow({
  product,
  locale,
  selectedIds,
  setSelectedIds,
  menuOpenId,
  setMenuOpenId,
  medusaClient,
  openDuplicateModal,
  setProducts,
  pendingChangeRequests,
  onOpenChangeRequests,
  ui,
}) {
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const menuBtnRef = useRef(null);
  const menuPanelRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  const shopBaseUrl = getDefaultShopUrl();
  const l = String(locale || "en").toLowerCase();
  const menuOpen = menuOpenId === product.id;

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const el = menuBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuW = 180;
      const menuH = 160;
      const gap = 6;
      let top = r.bottom + gap;
      let left = r.right - menuW;
      if (left < 8) left = 8;
      if (left + menuW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - menuW - 8);
      if (top + menuH > window.innerHeight - 8 && r.top > menuH + gap) {
        top = r.top - menuH - gap;
      }
      setMenuPos({ top, left, width: menuW });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e) => {
      const t = e.target;
      if (!(t instanceof Node)) {
        setMenuOpenId(null);
        return;
      }
      if (menuBtnRef.current?.contains(t) || menuPanelRef.current?.contains(t)) return;
      setMenuOpenId(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setMenuOpenId(null);
    };
    // Capture phase so Polaris / row handlers that stopPropagation still close the menu.
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("touchstart", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("touchstart", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, setMenuOpenId]);

  const statusOn = isProductToggleOn(product.status);
  const statusValues = productToggleStatusValues(product);
  const i18n = {
    sku: "SKU",
    ean: "EAN",
    status: l === "tr" ? "Durum" : l === "de" ? "Status" : l === "fr" ? "Statut" : l === "es" ? "Estado" : l === "it" ? "Stato" : "Status",
    active: l === "tr" ? "Aktif" : l === "de" ? "Aktiv" : l === "fr" ? "Actif" : l === "es" ? "Activo" : l === "it" ? "Attivo" : "Active",
    draft: l === "tr" ? "Taslak" : l === "de" ? "Entwurf" : l === "fr" ? "Brouillon" : l === "es" ? "Borrador" : l === "it" ? "Bozza" : "Draft",
    inactive: l === "tr" ? "Pasif" : l === "de" ? "Inaktiv" : l === "fr" ? "Inactif" : l === "es" ? "Inactivo" : l === "it" ? "Inattivo" : "Inactive",
    openVariants: l === "tr" ? "Varyasyonları aç" : l === "de" ? "Variationen öffnen" : l === "fr" ? "Ouvrir les variantes" : l === "es" ? "Abrir variantes" : l === "it" ? "Apri varianti" : "Open variations",
    closeVariants: l === "tr" ? "Varyasyonları kapat" : l === "de" ? "Variationen schließen" : l === "fr" ? "Fermer les variantes" : l === "es" ? "Cerrar variantes" : l === "it" ? "Chiudi varianti" : "Close variations",
    noVariants: l === "tr" ? "Varyasyon yok" : l === "de" ? "Keine Variationen" : l === "fr" ? "Pas de variantes" : l === "es" ? "Sin variantes" : l === "it" ? "Nessuna variante" : "No variations",
    changeProposed: l === "tr" ? "Değişiklik önerildi" : l === "de" ? "Änderung vorgeschlagen" : l === "fr" ? "Modification proposée" : l === "es" ? "Cambio propuesto" : l === "it" ? "Modifica proposta" : "Change proposed",
    activateProduct: l === "tr" ? "Ürün aktifleştir" : l === "de" ? "Produkt aktivieren" : l === "fr" ? "Activer le produit" : l === "it" ? "Attiva prodotto" : l === "es" ? "Activar producto" : "Activate product",
    deactivateProduct: l === "tr" ? "Ürün pasifleştir" : l === "de" ? "Produkt deaktivieren" : l === "fr" ? "Désactiver le produit" : l === "it" ? "Disattiva prodotto" : l === "es" ? "Desactivar producto" : "Deactivate product",
  };
  const handleStatusToggle = async (nextOn) => {
    const nextStatus = nextOn ? statusValues.on : statusValues.off;
    setStatusSaving(true);
    try {
      const res = await medusaClient.updateAdminHubProduct(product.id, { status: nextStatus });
      if (res?.suggestion_submitted) {
        window.alert(
          l === "tr"
            ? "Değişiklik onaya gönderildi."
            : l === "de"
              ? "Änderung zur Freigabe eingereicht."
              : l === "fr"
              ? "Modification soumise pour approbation."
              : l === "es"
              ? "Cambio enviado para aprobación."
              : l === "it"
              ? "Modifica inviata per approvazione."
              : "Change submitted for approval.",
        );
        return;
      }
      const updated = res?.product ?? res;
      const newStatus = updated?.status ?? nextStatus;
      setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, status: newStatus } : p)));
    } catch (err) {
      console.error("Failed to update product status", err);
      window.alert(
        l === "tr"
          ? "Durum güncellenemedi."
          : l === "de"
            ? "Status konnte nicht aktualisiert werden."
            : l === "fr"
            ? "Impossible de mettre à jour le statut."
            : l === "es"
            ? "No se pudo actualizar el estado."
            : l === "it"
            ? "Impossibile aggiornare lo stato."
            : "Could not update status.",
      );
    } finally {
      setStatusSaving(false);
    }
  };
  const localizeStatus = (k) => {
    if (k === "active") return i18n.active;
    if (k === "inactive") return i18n.inactive;
    return i18n.draft;
  };
  const meta = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
  const media = meta.media;
  const rawThumb =
    product.thumbnail ||
    firstProductMediaUrl(product, locale) ||
    (Array.isArray(media) && media[0]
      ? typeof media[0] === "string"
        ? media[0]
        : media[0]?.url || null
      : null) ||
    (typeof media === "string" && media ? media : null);
  const thumbUrl = rawThumb ? resolveImageUrl(rawThumb) : null;
  const price =
    product.price != null
      ? Number(product.price)
      : product.variants?.[0]?.prices?.[0]?.amount
        ? Number(product.variants[0].prices[0].amount) / 100
        : 0;
  const inv = product.inventory != null ? Number(product.inventory) : 0;
  const sku = product.sku || "?";
  const ean = meta?.ean || "?";
  const variationSummary = Array.isArray(meta?.variation_groups)
    ? meta.variation_groups.map((g) => g?.name).filter(Boolean).join(" / ")
    : "?";
  const hasVariants = Array.isArray(product.variants) && product.variants.filter((v) => Array.isArray(v.option_values) && v.option_values.length > 0).length > 0;
  const pendingCount = Array.isArray(pendingChangeRequests) ? pendingChangeRequests.length : 0;
  return (
    <div
      style={{ background: "#fff", borderBottom: EXCEL_BORDER, transition: "background-color .1s" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "#fafafa"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
    >
      <div style={{ display: "grid", gridTemplateColumns: INVENTORY_ROW_GRID, gap: 0, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => hasVariants && setVariantsOpen((v) => !v)}
          disabled={!hasVariants}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: hasVariants ? "#fff" : "#f3f4f6",
            color: hasVariants ? "#374151" : "#9ca3af",
            cursor: hasVariants ? "pointer" : "not-allowed",
            fontSize: 14,
            lineHeight: 1,
          }}
          title={hasVariants ? (variantsOpen ? i18n.closeVariants : i18n.openVariants) : i18n.noVariants}
        >
          {hasVariants ? (variantsOpen ? "▲" : "▼") : "—"}
        </button>
          <div style={{ padding: "8px 6px", borderRight: EXCEL_BORDER, display: "flex", justifyContent: "center" }}>
          <CustomCheckbox
            checked={selectedIds.includes(product.id)}
            onChange={(e) => {
              e.stopPropagation();
              setSelectedIds((prev) =>
                e.target.checked ? [...prev, product.id] : prev.filter((id) => id !== product.id)
              );
            }}
            size={18}
            style={{ margin: 0 }}
          />
          </div>
          <div style={{ minWidth: 0, padding: "8px 6px", borderRight: EXCEL_BORDER, textAlign: "center" }}>
            {(() => {
              const c = statusColors(product.status);
              return (
                <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, border: `1px solid ${c.br}` }}>
                  {localizeStatus(statusLabel(product.status))}
                </span>
              );
            })()}
          </div>
          <div style={{ padding: "8px 6px", borderRight: EXCEL_BORDER, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 56, height: 56, flexShrink: 0, borderRadius: 8, overflow: "hidden",
              background: "#f4f4f5", border: "1px solid #e5e7eb",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt={getLocalizedTitle(product, locale)}
                referrerPolicy="no-referrer"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextSibling.style.display = "flex"; }}
              />
            ) : null}
            <div
              style={{
                display: thumbUrl ? "none" : "flex",
                width: "100%", height: "100%", alignItems: "center", justifyContent: "center",
                color: "#c1c1c6",
              }}
              aria-hidden
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="9" cy="9" r="1.6" fill="currentColor" stroke="none" />
                <path d="M21 15l-5-5-9 9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
          </div>
          <div style={{ minWidth: 0, padding: "8px 8px", borderRight: EXCEL_BORDER }}>
            <a
              href={`${shopBaseUrl}${shopPreviewPrefix(locale)}/produkt/${encodeURIComponent(shopProductHandleForLocale(product, locale))}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 14, fontWeight: 600, color: "#111827", textDecoration: "none", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", overflow: "hidden" }}
              title={`${getLocalizedTitle(product, locale)} · ${lt(locale, "opens in shop, new tab", "mağazada açılır, yeni sekme", "s'ouvre dans la boutique, nouvel onglet", "se abre en la tienda, pestaña nueva", "si apre nel negozio, nuova scheda", "öffnet im Shop, neuer Tab")}`}
              onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
              onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{getLocalizedTitle(product, locale)}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.2" style={{ flexShrink: 0 }} aria-hidden>
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 3h6v6M10 14 21 3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
            <I18nLink
              href={`/products/${product.id}`}
              style={{ marginTop: 2, padding: 0, color: "#4b5563", fontSize: 12, textDecoration: "underline", display: "inline-block" }}
              title={lt(locale, "Open product edit page via SKU", "SKU ile ürün düzenleme sayfasına git", "Ouvrir la page produit via SKU", "Abrir edición de producto vía SKU", "Apri modifica prodotto tramite SKU", "SKU üzerinden ürün düzenleme sayfasına git")}
            >
              {i18n.sku}: {sku}
            </I18nLink>
            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.2 }}>{i18n.ean}: {ean}</div>
          </div>
          <div style={{ fontSize: 13, color: "#111827", textAlign: "center", fontVariantNumeric: "tabular-nums", padding: "8px 8px", borderRight: EXCEL_BORDER }}>{inv}</div>
          <div style={{ fontSize: 13, color: "#111827", textAlign: "center", fontVariantNumeric: "tabular-nums", padding: "8px 8px", borderRight: EXCEL_BORDER }}>?{formatDecimal(price)}</div>
          <div style={{ fontSize: 12, color: "#4b5563", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "8px 8px", borderRight: EXCEL_BORDER, textAlign: "center" }}>
            {variationSummary || "?"}
          </div>
          <InlineStack gap="100" blockAlign="center" style={{ padding: "8px 6px", justifyContent: "flex-end" }}>
          <I18nLink
            href={`/products/${product.id}`}
            aria-label="Edit product"
            title="Edit product"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: 8,
              color: "#374151",
              textDecoration: "none",
            }}
          >
            <EditPencilIcon />
          </I18nLink>
          <Box position="relative">
            {pendingCount > 0 && (
              <span
                title={`${pendingCount} change proposal(s) pending`}
                style={{
                  position: "absolute",
                  top: 1,
                  right: 1,
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "#dc2626",
                  boxShadow: "0 0 0 2px #fff",
                  zIndex: 2,
                }}
              />
            )}
            <div ref={menuBtnRef} style={{ display: "inline-flex" }}>
              <Button
                variant="tertiary"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenId((prev) => (prev === product.id ? null : product.id));
                }}
              >
                ?
              </Button>
            </div>
            {menuOpen && menuPos && typeof document !== "undefined" && createPortal(
              <div
                ref={menuPanelRef}
                style={{
                  position: "fixed",
                  top: menuPos.top,
                  left: menuPos.left,
                  zIndex: 10050,
                  minWidth: menuPos.width,
                  background: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  boxShadow: "0 10px 24px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {pendingCount > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenChangeRequests(product.id);
                      setMenuOpenId(null);
                    }}
                    style={{
                      width: "100%",
                      height: 36,
                      border: "none",
                      background: "#fff",
                      cursor: "pointer",
                      textAlign: "left",
                      padding: "0 12px",
                      fontSize: 13,
                      color: "#dc2626",
                    }}
                    title="View proposed changes"
                  >
                    {i18n.changeProposed} ({pendingCount})
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDuplicateModal(product);
                    setMenuOpenId(null);
                  }}
                  style={{
                    width: "100%",
                    height: 36,
                    border: "none",
                    background: "#fff",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "0 12px",
                    fontSize: 13,
                    color: "#111827",
                  }}
                >
                  {ui.duplicate}
                </button>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await medusaClient.deleteAdminHubProduct(product.id);
                      setProducts((prev) => prev.filter((p) => p.id !== product.id));
                      setSelectedIds((prev) => prev.filter((id) => id !== product.id));
                    } catch (err) {
                      console.error("Failed to delete product", err);
                    } finally {
                      setMenuOpenId(null);
                    }
                  }}
                  style={{
                    width: "100%",
                    height: 36,
                    border: "none",
                    borderTop: "1px solid #f1f5f9",
                    background: "#fff",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: "0 12px",
                    fontSize: 13,
                    color: "#b91c1c",
                  }}
                >
                  {ui.delete}
                </button>
              </div>,
              document.body
            )}
          </Box>
          <ProductStatusToggle
            on={statusOn}
            disabled={statusSaving}
            title={statusOn ? i18n.deactivateProduct : i18n.activateProduct}
            onChange={handleStatusToggle}
          />
        </InlineStack>
      </div>
      {variantsOpen && hasVariants && (
        <InlineVariantEditor
          product={product}
          locale={locale}
          medusaClient={medusaClient}
          setProducts={setProducts}
        />
      )}
    </div>
  );
}

export default function InventoryPage() {
  const router = useRouter();
  const locale = useLocale();
  const [products, setProducts] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [duplicateSourceId, setDuplicateSourceId] = useState(null);
  const [duplicateFullProduct, setDuplicateFullProduct] = useState(null);
  const [duplicateOptions, setDuplicateOptions] = useState(DEFAULT_DUPLICATE_OPTIONS);
  const [duplicateSaving, setDuplicateSaving] = useState(false);
  const [combineModalOpen, setCombineModalOpen] = useState(false);
  const [combineParentId, setCombineParentId] = useState("");
  const [combineOptionName, setCombineOptionName] = useState("Variante");
  const [combineLabels, setCombineLabels] = useState({});
  const [combineSaving, setCombineSaving] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [eanDuplicateGroups, setEanDuplicateGroups] = useState([]);
  const [eanDuplicatesModalOpen, setEanDuplicatesModalOpen] = useState(false);
  const [eanDuplicateMergingId, setEanDuplicateMergingId] = useState(null);
  const [mySellerId, setMySellerId] = useState("");
  const [sellerLabelById, setSellerLabelById] = useState({});
  const [productListingsMap, setProductListingsMap] = useState({});
  const [sellerSearchFilter, setSellerSearchFilter] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailsFilter, setDetailsFilter] = useState("");
  const [variationFilter, setVariationFilter] = useState("");
  const [inventoryMin, setInventoryMin] = useState("");
  const [inventoryMax, setInventoryMax] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [inventorySort, setInventorySort] = useState("created_desc");
  const [sellerSectionsOpen, setSellerSectionsOpen] = useState({});
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState("xlsx");
  const [exporting, setExporting] = useState(false);
  const medusaClient = getMedusaAdminClient();
  const ui = getUI(locale);
  const l = String(locale || "en").toLowerCase();

  const [pendingChangeRequestsByProductId, setPendingChangeRequestsByProductId] = useState({});
  const [changeRequestsModalOpen, setChangeRequestsModalOpen] = useState(false);
  const [changeRequestsModalProductId, setChangeRequestsModalProductId] = useState(null);
  const [changeRequestsModalItems, setChangeRequestsModalItems] = useState([]);
  const rowHead = {
    select: l === "tr" ? "Seç" : l === "de" ? "Ausw." : l === "fr" ? "Sél." : l === "es" ? "Sel." : l === "it" ? "Sel." : "Select",
    status: l === "tr" ? "Durum" : l === "de" ? "Status" : l === "fr" ? "Statut" : l === "es" ? "Estado" : l === "it" ? "Stato" : "Status",
    details: l === "tr" ? "Ürün detayları" : l === "de" ? "Produktdetails" : l === "fr" ? "Détails produit" : l === "es" ? "Detalles producto" : l === "it" ? "Dettagli prodotto" : "Product details",
    inventory: l === "tr" ? "Envanter" : l === "de" ? "Bestand" : l === "fr" ? "Stock" : l === "es" ? "Inventario" : l === "it" ? "Inventario" : "Inventory",
    price: l === "tr" ? "Fiyat" : l === "de" ? "Preis" : l === "fr" ? "Prix" : l === "es" ? "Precio" : l === "it" ? "Prezzo" : "Price",
    variations: l === "tr" ? "Varyasyonlar" : l === "de" ? "Variationen" : l === "fr" ? "Variantes" : l === "es" ? "Variantes" : l === "it" ? "Varianti" : "Variations",
  };
  const renderInventoryHeader = () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: INVENTORY_ROW_GRID,
        gap: 0,
        borderBottom: EXCEL_BORDER,
        alignItems: "center",
        background: "#f8fafc",
        position: "sticky",
        top: 0,
        zIndex: 2,
      }}
    >
      <div style={{ borderRight: EXCEL_BORDER, padding: "8px 6px" }} />
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", borderRight: EXCEL_BORDER, padding: "8px 6px", textAlign: "center" }}>{rowHead.select}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", borderRight: EXCEL_BORDER, padding: "8px 6px", textAlign: "center" }}>{rowHead.status}</div>
      <div style={{ borderRight: EXCEL_BORDER, padding: "8px 6px" }} />
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", borderRight: EXCEL_BORDER, padding: "8px 8px", textAlign: "center" }}>{rowHead.details}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", textAlign: "center", borderRight: EXCEL_BORDER, padding: "8px 8px", cursor: "pointer" }} onClick={() => setInventorySort((s) => (s === "inventory_desc" ? "inventory_asc" : "inventory_desc"))}>{rowHead.inventory}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", textAlign: "center", borderRight: EXCEL_BORDER, padding: "8px 8px", cursor: "pointer" }} onClick={() => setInventorySort((s) => (s === "price_desc" ? "price_asc" : "price_desc"))}>{rowHead.price}</div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", borderRight: EXCEL_BORDER, padding: "8px 8px", textAlign: "center" }}>{rowHead.variations}</div>
      <div style={{ padding: "8px 6px" }} />
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px" }} />
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px" }} />
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px" }} />
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px" }} />
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px 8px" }}>
        <input value={detailsFilter} onChange={(e) => setDetailsFilter(e.target.value)} placeholder={l === "tr" ? "isim / sku / ean" : "name / sku / ean"} style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 8px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
      </div>
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px 8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <input value={inventoryMin} onChange={(e) => setInventoryMin(e.target.value)} placeholder="min" style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 6px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
        <input value={inventoryMax} onChange={(e) => setInventoryMax(e.target.value)} placeholder="max" style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 6px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
      </div>
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px 8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <input value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="min" style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 6px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
        <input value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="max" style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 6px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
      </div>
      <div style={{ borderRight: EXCEL_BORDER, padding: "6px 8px" }}>
        <input value={variationFilter} onChange={(e) => setVariationFilter(e.target.value)} placeholder={l === "tr" ? "varyasyon" : l === "fr" ? "variante" : l === "es" ? "variante" : l === "it" ? "variante" : "variation"} style={{ width: "100%", height: 28, border: "1px solid #d1d5db", borderRadius: 4, padding: "0 8px", fontSize: 12, boxSizing: "border-box", textAlign: "center" }} />
      </div>
      <div style={{ padding: "6px" }} />
    </div>
  );

  const TableShell = ({ children }) => (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        background: "#fff",
        maxHeight: "68vh",
        overflowX: "auto",
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );

  const runQuickExport = async () => {
    try {
      setExporting(true);
      const sellerToken = typeof window !== "undefined" ? (localStorage.getItem("sellerToken") || "") : "";
      const response = await fetch("/api/import-export/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerToken,
          datasets: ["products"],
          format: exportFormat,
          filters: {
            search: productSearch || detailsFilter || variationFilter || "",
            status: statusFilter === "all" ? "" : statusFilter,
          },
        }),
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `inventory-export.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      setExportModalOpen(false);
    } catch (e) {
      setError(userError(e, locale, "Export failed"));
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
    setMySellerId(localStorage.getItem("sellerId") || "");
  }, []);

  useEffect(() => {
    if (!isSuperuser) return;
    medusaClient
      .getSellers()
      .then((d) => {
        const m = {};
        for (const s of d.sellers || []) {
          if (s.seller_id) m[s.seller_id] = s.store_name || s.company_name || s.email || s.seller_id;
        }
        setSellerLabelById(m);
      })
      .catch(() => {});
    medusaClient
      .getProductListingsMap()
      .then((map) => setProductListingsMap(map || {}))
      .catch(() => {});
  }, [isSuperuser, medusaClient]);

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        setLoading(true);
        const data = await medusaClient.getAdminHubProducts();
        setProducts(data.products || []);
        if (localStorage.getItem("sellerIsSuperuser") === "true") {
          medusaClient.getProductListingsMap().then((map) => setProductListingsMap(map || {})).catch(() => {});
        }
      } catch (err) {
        setError(userError(err, locale, "Failed to load products"));
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
  }, []);

  const refetchPendingChangeRequests = async () => {
    // Pending-change-request review ("Proposal" marker/count) is a superuser moderation tool ?
    // a seller must never see that their own edit to an existing/shared product is queued for
    // approval, so this is skipped entirely for non-superusers.
    if (!isSuperuser) {
      setPendingChangeRequestsByProductId({});
      return {};
    }
    try {
      const data = await medusaClient.request('/admin-hub/v1/product-change-requests?status=pending');
      const map = {};
      for (const cr of (data?.change_requests || [])) {
        const pid = String(cr?.product_id || '');
        if (!pid) continue;
        if (!map[pid]) map[pid] = [];
        map[pid].push(cr);
      }
      setPendingChangeRequestsByProductId(map);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("andertal-notifications-refresh"));
      }
      return map;
    } catch (e) {
      // Non-critical: inventory should still work if proposal backend fails.
      console.warn('Failed to load pending change requests:', e?.message || e);
      return {};
    }
  };

  useEffect(() => {
    refetchPendingChangeRequests();
  }, [isSuperuser]);

  const refetchEanDuplicates = async () => {
    // Same visibility rule as change requests: only a superuser may see that two
    // catalog rows for the same real-world EAN exist and need reconciling.
    if (!isSuperuser) {
      setEanDuplicateGroups([]);
      return [];
    }
    try {
      const data = await medusaClient.request('/admin-hub/v1/products/duplicate-eans');
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      setEanDuplicateGroups(groups);
      return groups;
    } catch (e) {
      console.warn('Failed to load duplicate EAN groups:', e?.message || e);
      return [];
    }
  };

  useEffect(() => {
    refetchEanDuplicates();
  }, [isSuperuser]);

  const mergeEanDuplicate = async (masterId, duplicateProductId) => {
    setEanDuplicateMergingId(duplicateProductId);
    try {
      await medusaClient.request(`/admin-hub/v1/products/duplicate-eans/${encodeURIComponent(masterId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ duplicateProductId }),
      });
      await refetchEanDuplicates();
      const data = await medusaClient.getAdminHubProducts();
      setProducts(data.products || []);
    } catch (e) {
      setError(userError(e, locale, 'Failed to merge duplicate product'));
    } finally {
      setEanDuplicateMergingId(null);
    }
  };

  const openChangeRequestsModal = async (productId) => {
    const pid = String(productId || '');
    const product = products.find((p) => String(p?.id || '') === pid) || null;
    setChangeRequestsModalProductId(pid || null);
    setChangeRequestsModalItems(pendingChangeRequestsByProductId[pid] || []);
    setChangeRequestsModalOpen(true);
  };

  const approveChangeRequest = async (id) => {
    try {
      await medusaClient.request(`/admin-hub/v1/product-change-requests/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reviewer_note: 'Approved via inventory' }),
      });
      const data = await medusaClient.getAdminHubProducts();
      setProducts(data.products || []);
      const map = await refetchPendingChangeRequests();
      if (changeRequestsModalProductId) {
        setChangeRequestsModalItems(map[String(changeRequestsModalProductId)] || []);
      }
    } catch (e) {
      setError(e?.message || 'Approval failed');
    }
  };

  const rejectChangeRequest = async (id) => {
    try {
      await medusaClient.request(`/admin-hub/v1/product-change-requests/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reviewer_note: 'Rejected via inventory' }),
      });
      const map = await refetchPendingChangeRequests();
      if (changeRequestsModalProductId) {
        setChangeRequestsModalItems(map[String(changeRequestsModalProductId)] || []);
      }
    } catch (e) {
      setError(e?.message || 'Rejection failed');
    }
  };

  useEffect(() => {
    if (!duplicateModalOpen || !duplicateSourceId) {
      setDuplicateFullProduct(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const p = await medusaClient.getAdminHubProduct(duplicateSourceId);
        if (!cancelled) setDuplicateFullProduct(p || null);
      } catch (e) {
        if (!cancelled) setDuplicateFullProduct(null);
      }
    })();
    return () => { cancelled = true; };
  }, [duplicateModalOpen, duplicateSourceId]);

  const productMatchesFilters = useCallback((product) => {
    const st = String(product?.status || "draft").toLowerCase();
    // Soft-archived combine/EAN-merge rows stay out of the default inventory list.
    const statusOk =
      statusFilter === "all"
        ? st !== "merged"
        : st === statusFilter;
    if (!statusOk) return false;
    const q = String(productSearch || "").trim().toLowerCase();
    const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
    const hay = [
      getLocalizedTitle(product, locale),
      product?.title || "",
      product?.sku || "",
      meta?.ean || "",
      ...(Array.isArray(product?.variants)
        ? product.variants.map((v) =>
            [v?.sku || "", v?.ean || "", getVariantLabel(v, locale) || "", getVariantName(v, locale, "") || ""].join(" ")
          )
        : []),
    ]
      .join(" ")
      .toLowerCase();
    if (q && !hay.includes(q)) return false;
    const detailsQ = String(detailsFilter || "").trim().toLowerCase();
    if (detailsQ && !hay.includes(detailsQ)) return false;
    const varQ = String(variationFilter || "").trim().toLowerCase();
    if (varQ) {
      const variationHay = (Array.isArray(product?.variants)
        ? product.variants.map((v) => getVariantLabel(v, locale)).join(" ")
        : "").toLowerCase();
      if (!variationHay.includes(varQ)) return false;
    }
    const inv = Number(product?.inventory ?? 0);
    if (inventoryMin !== "" && Number.isFinite(Number(inventoryMin)) && inv < Number(inventoryMin)) return false;
    if (inventoryMax !== "" && Number.isFinite(Number(inventoryMax)) && inv > Number(inventoryMax)) return false;
    const pr = Number(product?.price ?? 0);
    if (priceMin !== "" && Number.isFinite(Number(priceMin)) && pr < Number(priceMin)) return false;
    if (priceMax !== "" && Number.isFinite(Number(priceMax)) && pr > Number(priceMax)) return false;
    return true;
  }, [statusFilter, productSearch, detailsFilter, variationFilter, inventoryMin, inventoryMax, priceMin, priceMax, locale]);

  const { ownProducts, sellerGroups } = useMemo(() => {
    const own = [];
    const g = new Map();
    for (const p of products) {
      if (!productMatchesFilters(p)) continue;
      if (isOwnInventoryProduct(p, mySellerId)) {
        // A superuser-owned master product (null seller_id) is never exclusively
        // "claimed" by whichever seller listed it ? it stays in the superuser's own
        // section AND shows under every seller who has a listing for it.
        own.push(p);
        const listingSellers = isSuperuser ? (productListingsMap[p.id] || []) : [];
        if (isSuperuser && listingSellers.length > 0) {
          for (const sid of listingSellers) {
            if (!g.has(sid)) g.set(sid, []);
            g.get(sid).push({ ...p, _listingSellerIds: listingSellers });
          }
        }
      } else {
        const sid = String(p.seller_id || "unknown");
        if (!g.has(sid)) g.set(sid, []);
        g.get(sid).push(p);
      }
    }
    const keys = [...g.keys()].sort((a, b) =>
      (sellerLabelById[a] || a).localeCompare(sellerLabelById[b] || b, undefined, { sensitivity: "base" })
    );
    return { ownProducts: own, sellerGroups: keys.map((k) => ({ sellerId: k, items: g.get(k) })) };
  }, [products, mySellerId, sellerLabelById, productMatchesFilters, isSuperuser, productListingsMap]);

  const filteredSellerGroups = useMemo(() => {
    const q = sellerSearchFilter.trim().toLowerCase();
    if (!q) return sellerGroups;
    return sellerGroups.filter(({ sellerId }) => {
      const label = (sellerLabelById[sellerId] || sellerId || "").toLowerCase();
      return label.includes(q) || sellerId.toLowerCase().includes(q);
    });
  }, [sellerGroups, sellerSearchFilter, sellerLabelById]);

  // Group own products that share the same master_product_id under a parent header.
  const sortedOwnRows = useMemo(() => {
    const sorted = sortProductsList(ownProducts, locale, inventorySort);
    const groupMap = new Map(); // masterId ? index in result
    const result = [];
    for (const p of sorted) {
      const masterId = String(p.metadata?.master_product_id || "").trim();
      if (!masterId) {
        result.push({ type: "standalone", product: p });
      } else if (groupMap.has(masterId)) {
        result[groupMap.get(masterId)].items.push(p);
      } else {
        groupMap.set(masterId, result.length);
        result.push({ type: "group", masterId, items: [p] });
      }
    }
    // Groups with only 1 item ? treat as standalone
    return result.map((entry) =>
      entry.type === "group" && entry.items.length === 1
        ? { type: "standalone", product: entry.items[0] }
        : entry
    );
  }, [ownProducts, locale, inventorySort]);

  const openDuplicateModal = (product) => {
    setMenuOpenId(null);
    setDuplicateSourceId(product.id);
    setDuplicateOptions({ ...DEFAULT_DUPLICATE_OPTIONS });
    setDuplicateModalOpen(true);
  };

  const renderRow = (product) => (
    <InventoryProductRow
      key={product.id}
      product={product}
      locale={locale}
      selectedIds={selectedIds}
      setSelectedIds={setSelectedIds}
      menuOpenId={menuOpenId}
      setMenuOpenId={setMenuOpenId}
      medusaClient={medusaClient}
      openDuplicateModal={openDuplicateModal}
      setProducts={setProducts}
      pendingChangeRequests={pendingChangeRequestsByProductId[product.id] || []}
      onOpenChangeRequests={(pid) => {
        setMenuOpenId(null);
        openChangeRequestsModal(pid);
      }}
      ui={ui}
    />
  );

  const renderParentGroup = (masterId, items) => {
    const groupTitle = getLocalizedTitle(items[0], locale);
    return (
      <React.Fragment key={masterId}>
        <div style={{
          display: "grid",
          gridTemplateColumns: INVENTORY_ROW_GRID,
          background: "#f3f4f6",
          borderBottom: EXCEL_BORDER,
        }}>
          <div style={{ gridColumn: "1 / -1", padding: "7px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <Text as="span" variant="bodySm" fontWeight="semibold">{groupTitle}</Text>
            <Text as="span" variant="bodySm" tone="subdued">
              ? {items.length} {locale === "tr" ? "varyasyon" : locale === "de" ? "Varianten" : "variants"}
            </Text>
          </div>
        </div>
        {items.map((product) => renderRow(product))}
      </React.Fragment>
    );
  };

  const renderOwnRows = () =>
    sortedOwnRows.map((entry) =>
      entry.type === "group"
        ? renderParentGroup(entry.masterId, entry.items)
        : renderRow(entry.product)
    );

  const closeDuplicateModal = () => {
    setDuplicateModalOpen(false);
    setDuplicateSourceId(null);
    setDuplicateFullProduct(null);
  };

  const openCombineModal = () => {
    if (selectedIds.length < 2) return;
    const first = selectedIds[0];
    setCombineParentId(first);
    setCombineOptionName(
      locale === "en"
        ? "Variant"
        : locale === "tr"
          ? "Varyant"
          : locale === "fr"
            ? "Variante"
            : locale === "es"
              ? "Variante"
              : locale === "it"
                ? "Variante"
                : "Variante"
    );
    const labels = {};
    for (const id of selectedIds) {
      const prod = products.find((p) => p.id === id);
      labels[id] = getLocalizedTitle(prod, locale) || id;
    }
    setCombineLabels(labels);
    setCombineModalOpen(true);
  };

  const closeCombineModal = () => {
    setCombineModalOpen(false);
    setCombineSaving(false);
  };

  const runCombineAsVariants = async () => {
    if (!combineParentId || selectedIds.length < 2) return;
    setCombineSaving(true);
    setError(null);
    try {
      const res = await medusaClient.combineProductsAsVariants({
        parentId: combineParentId,
        productIds: selectedIds,
        optionName: combineOptionName,
        optionValues: combineLabels,
      });
      closeCombineModal();
      setSelectedIds([]);
      const data = await medusaClient.getAdminHubProducts();
      setProducts(data.products || []);
      const parent = res?.parent_id || combineParentId;
      router.push(`/products/${parent}`);
    } catch (e) {
      setError(userError(e, locale, "Failed to combine products"));
      setCombineSaving(false);
    }
  };

  const runDuplicate = async () => {
    const p = duplicateFullProduct;
    if (!p) return;
    setDuplicateSaving(true);
    try {
      const opt = duplicateOptions;
      const meta = (p.metadata && typeof p.metadata === "object") ? { ...p.metadata } : {};
      delete meta.ean;
      if (!opt.media) meta.media = undefined;
      if (!opt.categories) {
        meta.collection_ids = undefined;
        meta.collection_id = undefined;
      }
      const variants = opt.variants ? stripSkuEanFromVariants(p.variants) : [];
      const origTitle = (p.title || "").trim();
      const payload = {
        title: opt.title ? origTitle : "Untitled",
        handle: (origTitle || p.handle || "produkt").toString().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 50) + "-" + Date.now().toString(36),
        sku: "",
        description: opt.description ? (p.description || "") : "",
        status: "draft",
        price: opt.price && (p.price != null) ? Number(p.price) : 0,
        inventory: opt.inventory && (p.inventory != null) ? Number(p.inventory) : 0,
        metadata: meta,
        variants,
        ...(opt.categories && (p.collection_id != null) ? { collection_id: p.collection_id } : {}),
      };
      if (opt.categories && meta.collection_ids && Array.isArray(meta.collection_ids)) {
        payload.metadata = { ...payload.metadata, collection_ids: meta.collection_ids };
      }
      const created = await medusaClient.createAdminHubProduct(payload);
      closeDuplicateModal();
      if (created?.id) router.push(`/products/${created.id}`);
    } catch (err) {
      setError(err?.message || "Duplicate failed");
    } finally {
      setDuplicateSaving(false);
    }
  };

  if (loading) {
    return (
      <Page title="Inventory">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={3} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title={locale === "en" ? "Inventory" : locale === "tr" ? "Envanter" : locale === "fr" ? "Inventaire" : locale === "es" ? "Inventario" : locale === "it" ? "Inventario" : "Bestand"}
      primaryAction={{
        content: locale === "en" ? "Add product" : locale === "tr" ? "Ürün ekle" : locale === "fr" ? "Ajouter un produit" : locale === "es" ? "Agregar producto" : locale === "it" ? "Aggiungi prodotto" : "Produkt hinzufügen",
        onAction: () => router.push("/products/new"),
      }}
      secondaryActions={[
        { content: locale === "en" ? "Add existing product" : locale === "tr" ? "Mevcut ürün ekle" : locale === "fr" ? "Ajouter produit existant" : locale === "es" ? "Agregar producto existente" : locale === "it" ? "Aggiungi prodotto esistente" : "Bestehendes Produkt hinzufügen", onAction: () => router.push("/products/add-existing") },
        { content: locale === "en" ? "Bulk upload" : locale === "tr" ? "Toplu yükleme" : locale === "fr" ? "Import en masse" : locale === "es" ? "Carga masiva" : locale === "it" ? "Caricamento in blocco" : "Massenimport", url: "/import-export" },
        { content: locale === "en" ? "Export" : locale === "tr" ? "Disa aktar" : locale === "fr" ? "Exporter" : locale === "es" ? "Exportar" : locale === "it" ? "Esporta" : "Exportieren", onAction: () => setExportModalOpen(true) },
      ]}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          {isSuperuser && (
            <Box paddingBlockEnd="400">
              <InlineStack gap="400" blockAlign="center" wrap>
                <Box minWidth="260px">
                  <TextField
                    label="Search products"
                    labelHidden
                    autoComplete="off"
                    placeholder={l === "tr" ? "Ürün ara (isim, sku, ean, varyasyon)..." : l === "de" ? "Produkte suchen (Name, SKU, EAN, Variation)..." : l === "fr" ? "Rechercher produits (nom, SKU, EAN, variation)..." : l === "es" ? "Buscar productos (nombre, SKU, EAN, variación)..." : l === "it" ? "Cerca prodotti (nome, SKU, EAN, variazione)..." : "Search products (name, SKU, EAN, variation)..."}
                    value={productSearch}
                    onChange={setProductSearch}
                  />
                </Box>
                <Box minWidth="180px">
                  <Select
                    label={l === "tr" ? "Durum filtresi" : l === "de" ? "Statusfilter" : l === "fr" ? "Filtre statut" : l === "es" ? "Filtro estado" : l === "it" ? "Filtro stato" : "Status filter"}
                    labelHidden
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { label: l === "tr" ? "Tüm statüler" : l === "de" ? "Alle Status" : l === "fr" ? "Tous les statuts" : l === "es" ? "Todos los estados" : l === "it" ? "Tutti gli stati" : "All statuses", value: "all" },
                      { label: l === "tr" ? "Aktif" : l === "de" ? "Aktiv" : l === "fr" ? "Actif" : l === "es" ? "Activo" : l === "it" ? "Attivo" : "Active", value: "published" },
                      { label: l === "tr" ? "Taslak" : l === "de" ? "Entwurf" : l === "fr" ? "Brouillon" : l === "es" ? "Borrador" : l === "it" ? "Bozza" : "Draft", value: "draft" },
                      { label: l === "tr" ? "Pasif" : l === "de" ? "Inaktiv" : l === "fr" ? "Inactif" : l === "es" ? "Inactivo" : l === "it" ? "Inattivo" : "Inactive", value: "inactive" },
                      { label: l === "tr" ? "Arşiv" : l === "de" ? "Archiviert" : l === "fr" ? "Archivé" : l === "es" ? "Archivado" : l === "it" ? "Archiviato" : "Archived", value: "archived" },
                    ]}
                  />
                </Box>
                <Box minWidth="200px">
                  <Select
                    label={l === "tr" ? "Siralama" : l === "de" ? "Sortierung" : l === "fr" ? "Tri" : l === "es" ? "Ordenar" : l === "it" ? "Ordina" : "Sort"}
                    labelHidden
                    options={[
                      { label: "Name A?Z", value: "title_asc" },
                      { label: "Name Z?A", value: "title_desc" },
                      { label: l === "tr" ? "Stok (yüksek→düşük)" : l === "de" ? "Bestand (hoch→niedrig)" : l === "fr" ? "Stock (haut→bas)" : l === "es" ? "Stock (alto→bajo)" : l === "it" ? "Stock (alto→basso)" : "Inventory (high→low)", value: "inventory_desc" },
                      { label: l === "tr" ? "Stok (düşük→yüksek)" : l === "de" ? "Bestand (niedrig→hoch)" : l === "fr" ? "Stock (bas→haut)" : l === "es" ? "Stock (bajo→alto)" : l === "it" ? "Stock (basso→alto)" : "Inventory (low→high)", value: "inventory_asc" },
                      { label: l === "tr" ? "Fiyat (yüksek→düşük)" : l === "de" ? "Preis (hoch→niedrig)" : l === "fr" ? "Prix (haut→bas)" : l === "es" ? "Precio (alto→bajo)" : l === "it" ? "Prezzo (alto→basso)" : "Price (high→low)", value: "price_desc" },
                      { label: l === "tr" ? "Fiyat (düşük→yüksek)" : l === "de" ? "Preis (niedrig→hoch)" : l === "fr" ? "Prix (bas→haut)" : l === "es" ? "Precio (bajo→alto)" : l === "it" ? "Prezzo (basso→alto)" : "Price (low→high)", value: "price_asc" },
                      { label: l === "tr" ? "Önce yeni" : l === "de" ? "Neu zuerst" : l === "fr" ? "Plus récent" : l === "es" ? "Más reciente" : l === "it" ? "Più recente" : "Newest first", value: "created_desc" },
                      { label: l === "tr" ? "Önce eski" : l === "de" ? "Älteste zuerst" : l === "fr" ? "Plus ancien" : l === "es" ? "Más antiguo" : l === "it" ? "Più vecchio" : "Oldest first", value: "created_asc" },
                    ]}
                    value={inventorySort}
                    onChange={setInventorySort}
                  />
                </Box>
              </InlineStack>
            </Box>
          )}

          {!isSuperuser && (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingSm">{locale === "en" ? "All products" : locale === "tr" ? "Tüm ürünler" : locale === "fr" ? "Tous les produits" : locale === "es" ? "Todos los productos" : locale === "it" ? "Tutti i prodotti" : "Alle Produkte"}</Text>
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Box minWidth="260px">
                      <TextField
                        label="Search products"
                        labelHidden
                        autoComplete="off"
                        placeholder={l === "tr" ? "Ürün ara (isim, sku, ean, varyasyon)..." : l === "de" ? "Produkte suchen (Name, SKU, EAN, Variation)..." : l === "fr" ? "Rechercher produits (nom, SKU, EAN, variation)..." : l === "es" ? "Buscar productos (nombre, SKU, EAN, variación)..." : l === "it" ? "Cerca prodotti (nome, SKU, EAN, variazione)..." : "Search products (name, SKU, EAN, variation)..."}
                        value={productSearch}
                        onChange={setProductSearch}
                      />
                    </Box>
                    <Box minWidth="180px">
                      <Select
                        label="Status filter"
                        labelHidden
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                          { label: l === "tr" ? "Tüm statüler" : l === "de" ? "Alle Status" : l === "fr" ? "Tous les statuts" : l === "es" ? "Todos los estados" : l === "it" ? "Tutti gli stati" : "All statuses", value: "all" },
                          { label: l === "tr" ? "Aktif" : l === "de" ? "Aktiv" : l === "fr" ? "Actif" : l === "es" ? "Activo" : l === "it" ? "Attivo" : "Active", value: "published" },
                          { label: l === "tr" ? "Taslak" : l === "de" ? "Entwurf" : l === "fr" ? "Brouillon" : l === "es" ? "Borrador" : l === "it" ? "Bozza" : "Draft", value: "draft" },
                          { label: l === "tr" ? "Pasif" : l === "de" ? "Inaktiv" : l === "fr" ? "Inactif" : l === "es" ? "Inactivo" : l === "it" ? "Inattivo" : "Inactive", value: "inactive" },
                          { label: l === "tr" ? "Arşiv" : l === "de" ? "Archiviert" : l === "fr" ? "Archivé" : l === "es" ? "Archivado" : l === "it" ? "Archiviato" : "Archived", value: "archived" },
                        ]}
                      />
                    </Box>
                    <Box minWidth="200px">
                      <Select
                        label={l === "tr" ? "Siralama" : l === "de" ? "Sortierung" : l === "fr" ? "Tri" : l === "es" ? "Ordenar" : l === "it" ? "Ordina" : "Sort"}
                        labelHidden
                        options={[
                          { label: "Name A?Z", value: "title_asc" },
                          { label: "Name Z?A", value: "title_desc" },
                          { label: l === "tr" ? "Stok (yüksek→düşük)" : l === "de" ? "Bestand (hoch→niedrig)" : l === "fr" ? "Stock (haut→bas)" : l === "es" ? "Stock (alto→bajo)" : l === "it" ? "Stock (alto→basso)" : "Inventory (high→low)", value: "inventory_desc" },
                          { label: l === "tr" ? "Stok (düşük→yüksek)" : l === "de" ? "Bestand (niedrig→hoch)" : l === "fr" ? "Stock (bas→haut)" : l === "es" ? "Stock (bajo→alto)" : l === "it" ? "Stock (basso→alto)" : "Inventory (low→high)", value: "inventory_asc" },
                          { label: l === "tr" ? "Fiyat (yüksek→düşük)" : l === "de" ? "Preis (hoch→niedrig)" : l === "fr" ? "Prix (haut→bas)" : l === "es" ? "Precio (alto→bajo)" : l === "it" ? "Prezzo (alto→basso)" : "Price (high→low)", value: "price_desc" },
                          { label: l === "tr" ? "Fiyat (düşük→yüksek)" : l === "de" ? "Preis (niedrig→hoch)" : l === "fr" ? "Prix (bas→haut)" : l === "es" ? "Precio (bajo→alto)" : l === "it" ? "Prezzo (basso→alto)" : "Price (low→high)", value: "price_asc" },
                          { label: l === "tr" ? "Önce yeni" : l === "de" ? "Neu zuerst" : l === "fr" ? "Plus récent" : l === "es" ? "Más reciente" : l === "it" ? "Più recente" : "Newest first", value: "created_desc" },
                          { label: l === "tr" ? "Önce eski" : l === "de" ? "Älteste zuerst" : l === "fr" ? "Plus ancien" : l === "es" ? "Más antiguo" : l === "it" ? "Più vecchio" : "Oldest first", value: "created_asc" },
                        ]}
                        value={inventorySort}
                        onChange={setInventorySort}
                      />
                    </Box>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {ownProducts.length} {locale === "en" ? (ownProducts.length === 1 ? "product" : "products") : locale === "tr" ? "ürün" : locale === "fr" ? "produit(s)" : locale === "es" ? "producto(s)" : locale === "it" ? "prodotto/i" : (ownProducts.length === 1 ? "Produkt" : "Produkte")}
                    </Text>
                    {selectedIds.length > 0 && (
                      <InlineStack gap="200">
                        {selectedIds.length >= 2 && (
                          <Button onClick={openCombineModal}>
                            {locale === "en"
                              ? `Combine as variants (${selectedIds.length})`
                              : locale === "tr"
                                ? `Varyant olarak birlestir (${selectedIds.length})`
                                : locale === "fr"
                                  ? `Fusionner en variantes (${selectedIds.length})`
                                  : locale === "es"
                                    ? `Combinar como variantes (${selectedIds.length})`
                                    : locale === "it"
                                      ? `Unisci come varianti (${selectedIds.length})`
                                      : `Als Varianten zusammenführen (${selectedIds.length})`}
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          onClick={() => {
                            const firstId = selectedIds[0];
                            if (firstId) {
                              const prod = products.find((p) => p.id === firstId);
                              router.push(`/products/${prod?.id || firstId}`);
                            }
                          }}
                        >
                          {locale === "en" ? `Bulk edit (${selectedIds.length})` : locale === "tr" ? `Toplu düzenle (${selectedIds.length})` : locale === "fr" ? `Modifier en masse (${selectedIds.length})` : locale === "es" ? `Edición masiva (${selectedIds.length})` : locale === "it" ? `Modifica in blocco (${selectedIds.length})` : `Massenbearbeitung (${selectedIds.length})`}
                        </Button>
                      </InlineStack>
                    )}
                  </InlineStack>
                </InlineStack>
                <Divider />
                {ownProducts.length === 0 ? (
                  <Box paddingBlock="400">
                    <BlockStack gap="300">
                      <Text as="p" tone="subdued">{locale === "en" ? "No products yet. Add your first product to get started." : locale === "tr" ? "Henüz ürün yok. Başlamak için ilk ürününüzü ekleyin." : locale === "fr" ? "Aucun produit pour l'instant. Ajoutez votre premier produit." : locale === "es" ? "Aún no hay productos. Agrega tu primer producto." : locale === "it" ? "Ancora nessun prodotto. Aggiungi il tuo primo prodotto." : "Noch keine Produkte. Fügen Sie Ihr erstes Produkt hinzu."}</Text>
                      <InlineStack gap="200">
                        <Button variant="primary" url="/products/new">{locale === "en" ? "Add product" : locale === "tr" ? "Ürün ekle" : locale === "fr" ? "Ajouter un produit" : locale === "es" ? "Agregar producto" : locale === "it" ? "Aggiungi prodotto" : "Produkt hinzufügen"}</Button>
                        <Button url="/import-export">{locale === "en" ? "Bulk upload" : locale === "tr" ? "Toplu yükleme" : locale === "fr" ? "Import en masse" : locale === "es" ? "Carga masiva" : locale === "it" ? "Caricamento in blocco" : "Massenimport"}</Button>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                ) : (
                  <TableShell>
                    {renderInventoryHeader()}
                    {renderOwnRows()}
                  </TableShell>
                )}
              </BlockStack>
            </Card>
          )}

          {isSuperuser && eanDuplicateGroups.length > 0 && (
            <Banner
              tone="warning"
              title={lt(locale, `${eanDuplicateGroups.length} duplicate product(s) found`, `${eanDuplicateGroups.length} yinelenen ürün bulundu`, `${eanDuplicateGroups.length} produit(s) en double trouvé(s)`, `${eanDuplicateGroups.length} producto(s) duplicado(s) encontrado(s)`, `${eanDuplicateGroups.length} prodotto/i duplicato/i trovato/i`, `${eanDuplicateGroups.length} doppelte Produkt(e) gefunden`)}
              action={{
                content: lt(locale, "Review & merge", "İncele ve birleştir", "Vérifier et fusionner", "Revisar y fusionar", "Rivedi e unisci", "Prüfen & zusammenführen"),
                onAction: () => setEanDuplicatesModalOpen(true),
              }}
            >
              <p>
                {lt(
                  locale,
                  "Multiple sellers listed the same EAN and it created separate catalog entries instead of one shared listing. Merge each group back into the original entry so ownership stays with whoever added it first.",
                  "Birden fazla satıcı aynı EAN'i listeledi ve bu, ortak bir listing yerine ayrı katalog kayıtları oluşturdu. Sahipliğin ilk ekleyen satıcıda kalması için her grubu orijinal kayda geri birleştirin.",
                  "Plusieurs vendeurs ont référencé le même EAN, créant des fiches catalogue distinctes au lieu d'une seule offre partagée. Fusionnez chaque groupe dans la fiche d'origine pour que la propriété reste au premier vendeur.",
                  "Varios vendedores listaron el mismo EAN y se crearon fichas de catálogo separadas en lugar de una sola oferta compartida. Fusiona cada grupo con la ficha original para que la propiedad se mantenga con quien la añadió primero.",
                  "Più venditori hanno inserito lo stesso EAN creando voci di catalogo separate invece di un'unica offerta condivisa. Unisci ogni gruppo alla voce originale così la proprietà resta al primo venditore.",
                  "Mehrere Verkäufer haben dieselbe EAN gelistet, wodurch getrennte Katalogeinträge statt eines gemeinsamen Angebots entstanden sind. Führe jede Gruppe wieder mit dem ursprünglichen Eintrag zusammen, damit die Inhaberschaft beim Erstverkäufer bleibt."
                )}
              </p>
            </Banner>
          )}

          {isSuperuser && (
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingSm">{locale === "en" ? "Your superuser area" : locale === "tr" ? "Süper kullanıcı alanınız" : locale === "fr" ? "Votre espace super-utilisateur" : locale === "es" ? "Tu área de superusuario" : locale === "it" ? "La tua area superutente" : "Ihr Superuser-Bereich"}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {locale === "en" ? `Own account products and entries without seller assignment (${ownProducts.length})` : locale === "tr" ? `Kendi hesap ürünleri ve satıcı ataması olmayan girişler (${ownProducts.length})` : locale === "fr" ? `Produits du compte propre et entrées sans vendeur assigné (${ownProducts.length})` : locale === "es" ? `Productos de cuenta propia y entradas sin vendedor asignado (${ownProducts.length})` : locale === "it" ? `Prodotti dell'account proprio e voci senza venditore assegnato (${ownProducts.length})` : `Eigene Konto-Produkte und Einträge ohne Verkäufer-Zuordnung (${ownProducts.length})`}
                      </Text>
                    </BlockStack>
                    {selectedIds.length > 0 && (
                      <InlineStack gap="200">
                        {selectedIds.length >= 2 && (
                          <Button onClick={openCombineModal}>
                            {locale === "en"
                              ? `Combine as variants (${selectedIds.length})`
                              : locale === "tr"
                                ? `Varyant olarak birlestir (${selectedIds.length})`
                                : locale === "fr"
                                  ? `Fusionner en variantes (${selectedIds.length})`
                                  : locale === "es"
                                    ? `Combinar como variantes (${selectedIds.length})`
                                    : locale === "it"
                                      ? `Unisci come varianti (${selectedIds.length})`
                                      : `Als Varianten zusammenführen (${selectedIds.length})`}
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          onClick={() => {
                            const firstId = selectedIds[0];
                            if (firstId) router.push(`/products/${products.find((p) => p.id === firstId)?.id || firstId}`);
                          }}
                        >
                          {locale === "en" ? `Bulk edit (${selectedIds.length})` : locale === "tr" ? `Toplu düzenle (${selectedIds.length})` : locale === "fr" ? `Modifier en masse (${selectedIds.length})` : locale === "es" ? `Edición masiva (${selectedIds.length})` : locale === "it" ? `Modifica in blocco (${selectedIds.length})` : `Massenbearbeitung (${selectedIds.length})`}
                        </Button>
                      </InlineStack>
                    )}
                  </InlineStack>
                  <Divider />
                  {ownProducts.length === 0 ? (
                    <Text as="p" tone="subdued">{locale === "en" ? "No products in this section." : locale === "tr" ? "Bu bölümde ürün yok." : locale === "fr" ? "Aucun produit dans cette section." : locale === "es" ? "Sin productos en esta sección." : locale === "it" ? "Nessun prodotto in questa sezione." : "Keine Produkte in diesem Bereich."}</Text>
                  ) : (
                    <TableShell>
                      {renderInventoryHeader()}
                      {renderOwnRows()}
                    </TableShell>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingSm">{locale === "en" ? "Seller products" : locale === "tr" ? "Satıcı ürünleri" : locale === "fr" ? "Produits des vendeurs" : locale === "es" ? "Productos de vendedores" : locale === "it" ? "Prodotti dei venditori" : "Verkäufer-Produkte"}</Text>
                  <TextField
                    label="Seller filter"
                    labelHidden
                    placeholder={locale === "en" ? "Search seller (store name)…" : locale === "tr" ? "Satıcı ara (Mağaza adı)…" : locale === "fr" ? "Chercher vendeur (nom de boutique)…" : locale === "es" ? "Buscar vendedor (nombre de tienda)…" : locale === "it" ? "Cerca venditore (nome negozio)…" : "Verkäufer suchen (Store-Name)…"}
                    value={sellerSearchFilter}
                    onChange={setSellerSearchFilter}
                    autoComplete="off"
                  />
                  <Divider />
                  {filteredSellerGroups.length === 0 ? (
                    <Text as="p" tone="subdued">{locale === "en" ? `No more seller products${sellerSearchFilter.trim() ? " (filter)" : ""}.` : locale === "tr" ? `Başka satıcı ürünü yok${sellerSearchFilter.trim() ? " (Filtre)" : ""}.` : locale === "fr" ? `Aucun autre produit de vendeur${sellerSearchFilter.trim() ? " (filtre)" : ""}.` : locale === "es" ? `No hay más productos de vendedores${sellerSearchFilter.trim() ? " (filtro)" : ""}.` : locale === "it" ? `Nessun altro prodotto di venditori${sellerSearchFilter.trim() ? " (filtro)" : ""}.` : `Keine weiteren Verkäufer-Produkte${sellerSearchFilter.trim() ? " (Filter)" : ""}.`}</Text>
                  ) : (
                    <BlockStack gap="300">
                      {filteredSellerGroups.map(({ sellerId, items }) => {
                        const label = sellerLabelById[sellerId] || sellerId;
                        const open = sellerSectionsOpen[sellerId] !== false;
                        const sortedItems = sortProductsList(items, locale, inventorySort);
                        return (
                          <Box key={sellerId} padding="300" background="bg-surface-secondary" borderRadius="200">
                            <button
                              type="button"
                              onClick={() => setSellerSectionsOpen((prev) => ({ ...prev, [sellerId]: !open }))}
                              style={{
                                width: "100%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                padding: "4px 0",
                                font: "inherit",
                                textAlign: "left",
                              }}
                            >
                              <Text as="span" variant="bodyMd" fontWeight="semibold">{label}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">{open ? "▲" : "▼"} {sortedItems.length} {locale === "en" ? "products" : locale === "tr" ? "ürün" : locale === "fr" ? "produits" : locale === "es" ? "productos" : locale === "it" ? "prodotti" : "Produkte"}</Text>
                            </button>
                            {open && (
                              <Box paddingBlockStart="300">
                                <TableShell>
                                  {renderInventoryHeader()}
                                  {sortedItems.map((product) => renderRow(product))}
                                </TableShell>
                              </Box>
                            )}
                          </Box>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={combineModalOpen}
        onClose={closeCombineModal}
        title={
          locale === "en"
            ? "Combine as variants"
            : locale === "tr"
              ? "Varyant olarak birlestir"
              : locale === "fr"
                ? "Fusionner en variantes"
                : locale === "es"
                  ? "Combinar como variantes"
                  : locale === "it"
                    ? "Unisci come varianti"
                    : "Als Varianten zusammenführen"
        }
        primaryAction={{
          content:
            locale === "en"
              ? "Combine"
              : locale === "tr"
                ? "Birlestir"
                : locale === "fr"
                  ? "Fusionner"
                  : locale === "es"
                    ? "Combinar"
                    : locale === "it"
                      ? "Unisci"
                      : "Zusammenführen",
          onAction: runCombineAsVariants,
          loading: combineSaving,
          disabled: !combineParentId || selectedIds.length < 2,
        }}
        secondaryActions={[{ content: ui.cancel, onAction: closeCombineModal }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              {locale === "en"
                ? "Selected products become variants under one parent. Absorbed products are archived (not deleted). Orders keep their history."
                : locale === "tr"
                  ? "Seçilen ürünler tek bir parent altında varyant olur. Diğer ürünler arşivlenir (silinmez). Sipariş geçmişi korunur."
                  : locale === "de"
                    ? "Ausgewählte Produkte werden Varianten unter einem Parent. Übernommene Produkte werden archiviert (nicht gelöscht). Bestellhistorie bleibt erhalten."
                    : "Selected products become variants under one parent. Absorbed products are archived."}
            </Text>
            <Select
              label={
                locale === "en"
                  ? "Parent product"
                  : locale === "tr"
                    ? "Ana ürün"
                    : locale === "de"
                      ? "Elternprodukt"
                      : "Parent product"
              }
              options={selectedIds.map((id) => {
                const prod = products.find((p) => p.id === id);
                return { label: getLocalizedTitle(prod, locale) || id, value: id };
              })}
              value={combineParentId}
              onChange={setCombineParentId}
            />
            <TextField
              label={
                locale === "en"
                  ? "Option name"
                  : locale === "tr"
                    ? "Seçenek adı"
                    : locale === "de"
                      ? "Optionsname"
                      : "Option name"
              }
              value={combineOptionName}
              onChange={setCombineOptionName}
              autoComplete="off"
              helpText={
                locale === "en"
                  ? 'e.g. Color, Size'
                  : locale === "tr"
                    ? "örn. Renk, Beden"
                    : locale === "de"
                      ? "z. B. Farbe, Größe"
                      : "e.g. Color, Size"
              }
            />
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                {locale === "en"
                  ? "Variant labels"
                  : locale === "tr"
                    ? "Varyant etiketleri"
                    : locale === "de"
                      ? "Variantenbezeichnungen"
                      : "Variant labels"}
              </Text>
              {selectedIds.map((id) => {
                const prod = products.find((p) => p.id === id);
                return (
                  <TextField
                    key={id}
                    label={getLocalizedTitle(prod, locale) || id}
                    value={combineLabels[id] || ""}
                    onChange={(v) => setCombineLabels((prev) => ({ ...prev, [id]: v }))}
                    autoComplete="off"
                  />
                );
              })}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={duplicateModalOpen}
        onClose={closeDuplicateModal}
        title={locale === "en" ? "Duplicate product" : locale === "tr" ? "Ürünü kopyala" : locale === "fr" ? "Dupliquer le produit" : locale === "es" ? "Duplicar producto" : locale === "it" ? "Duplica prodotto" : "Produkt duplizieren"}
        primaryAction={{
          content: locale === "en" ? "Create duplicate" : locale === "tr" ? "Kopyayı oluştur" : locale === "fr" ? "Créer le doublon" : locale === "es" ? "Crear duplicado" : locale === "it" ? "Crea duplicato" : "Duplikat erstellen",
          onAction: runDuplicate,
          loading: duplicateSaving,
        }}
        secondaryActions={[{ content: ui.cancel, onAction: closeDuplicateModal }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              {locale === "en" ? <><span>Choose what to copy into the new product. </span><strong>SKU and EAN are never copied</strong><span> and must be set for the new product.</span></> : locale === "tr" ? <><span>Yeni ürüne kopyalanacakları seçin. </span><strong>SKU ve EAN hiçbir zaman kopyalanmaz</strong><span> ve yeni ürün için ayarlanmalıdır.</span></> : locale === "fr" ? <><span>Choisissez ce qui doit être copié dans le nouveau produit. </span><strong>SKU et EAN ne sont jamais copiés</strong><span> et doivent être définis pour le nouveau produit.</span></> : locale === "es" ? <><span>Elige qué copiar en el nuevo producto. </span><strong>SKU y EAN nunca se copian</strong><span> y deben definirse para el nuevo producto.</span></> : locale === "it" ? <><span>Scegli cosa copiare nel nuovo prodotto. </span><strong>SKU e EAN non vengono mai copiati</strong><span> e devono essere impostati per il nuovo prodotto.</span></> : <><span>Auswählen, was in das neue Produkt kopiert werden soll. </span><strong>SKU und EAN werden nie kopiert</strong><span> und müssen für das neue Produkt gesetzt werden.</span></>}
            </Text>
            {!duplicateFullProduct ? (
              <InlineStack gap="200" blockAlign="center">
                <SkeletonBodyText lines={1} />
                <Text as="span" tone="subdued">{locale === "en" ? "Loading product…" : locale === "tr" ? "Ürün yükleniyor…" : locale === "fr" ? "Chargement du produit…" : locale === "es" ? "Cargando producto…" : locale === "it" ? "Caricamento prodotto…" : "Produkt wird geladen…"}</Text>
              </InlineStack>
            ) : (
              <BlockStack gap="300">
                <Checkbox
                  label={locale === "en" ? "Copy title" : locale === "tr" ? "Başlığı kopyala" : locale === "fr" ? "Copier le titre" : locale === "es" ? "Copiar título" : locale === "it" ? "Copia titolo" : "Titel kopieren"}
                  checked={duplicateOptions.title}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, title: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Description" : locale === "tr" ? "Açıklama" : locale === "fr" ? "Description" : locale === "es" ? "Descripción" : locale === "it" ? "Descrizione" : "Beschreibung"}
                  checked={duplicateOptions.description}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, description: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Price" : locale === "tr" ? "Fiyat" : locale === "fr" ? "Prix" : locale === "es" ? "Precio" : locale === "it" ? "Prezzo" : "Preis"}
                  checked={duplicateOptions.price}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, price: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Inventory quantity" : locale === "tr" ? "Envanter miktarı" : locale === "fr" ? "Quantité en stock" : locale === "es" ? "Cantidad en inventario" : locale === "it" ? "Quantità inventario" : "Bestandsmenge"}
                  checked={duplicateOptions.inventory}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, inventory: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Categories / collection" : locale === "tr" ? "Kategoriler / koleksiyon" : locale === "fr" ? "Catégories / collection" : locale === "es" ? "Categorías / colección" : locale === "it" ? "Categorie / collezione" : "Kategorien / Kollektion"}
                  checked={duplicateOptions.categories}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, categories: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Images / media" : locale === "tr" ? "Görseller / medya" : locale === "fr" ? "Images / médias" : locale === "es" ? "Imágenes / medios" : locale === "it" ? "Immagini / media" : "Bilder / Medien"}
                  checked={duplicateOptions.media}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, media: v }))}
                />
                <Checkbox
                  label={locale === "en" ? "Variants (option names and values; SKU/EAN never copied)" : locale === "tr" ? "Varyantlar (seçenek adları ve değerleri; SKU/EAN hiçbir zaman kopyalanmaz)" : locale === "fr" ? "Variantes (noms et valeurs d'options ; SKU/EAN jamais copiés)" : locale === "es" ? "Variantes (nombres y valores de opciones; SKU/EAN nunca se copian)" : locale === "it" ? "Varianti (nomi e valori delle opzioni; SKU/EAN mai copiati)" : "Varianten (Optionsnamen und -werte; SKU/EAN werden nie kopiert)"}
                  checked={duplicateOptions.variants}
                  onChange={(v) => setDuplicateOptions((o) => ({ ...o, variants: v }))}
                />
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={changeRequestsModalOpen}
        onClose={() => setChangeRequestsModalOpen(false)}
        title={(() => {
          const label = locale === "en" ? "Proposed changes" : locale === "tr" ? "Önerilen değişiklikler" : locale === "fr" ? "Modifications proposées" : locale === "es" ? "Cambios propuestos" : locale === "it" ? "Modifiche proposte" : "Vorgeschlagene Änderungen";
          if (changeRequestsModalProductId) {
            const productTitle = products.find((p) => String(p?.id || '') === String(changeRequestsModalProductId))?.title || (locale === "en" ? "Product" : locale === "tr" ? "Ürün" : locale === "fr" ? "Produit" : locale === "es" ? "Producto" : locale === "it" ? "Prodotto" : "Produkt");
            return `${label} (${productTitle})`;
          }
          return label;
        })()}
        primaryAction={{ content: ui.close, onAction: () => setChangeRequestsModalOpen(false) }}
        secondaryActions={[]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {changeRequestsModalProductId ? (
              <Box paddingBlockEnd="200">
                <I18nLink
                  href={`/products/${changeRequestsModalProductId}`}
                  style={{ fontSize: 13, fontWeight: 600, color: "#0284c7", textDecoration: "none" }}
                >
                  {locale === "en" ? "Open product edit page →" : locale === "tr" ? "Ürün düzenleme sayfasına git →" : locale === "fr" ? "Ouvrir la page de modification du produit →" : locale === "es" ? "Abrir página de edición del producto →" : locale === "it" ? "Apri pagina di modifica prodotto →" : "Zur Produktbearbeitung →"}
                </I18nLink>
              </Box>
            ) : null}
            {changeRequestsModalItems.length === 0 ? (
              <Text as="p" tone="subdued">
                {locale === "en" ? "No pending change proposals." : locale === "tr" ? "Bekleyen değişiklik önerisi yok." : locale === "fr" ? "Aucune proposition de modification en attente." : locale === "es" ? "No hay propuestas de cambio pendientes." : locale === "it" ? "Nessuna proposta di modifica in sospeso." : "Keine ausstehenden Änderungsvorschläge."}
              </Text>
            ) : (
              changeRequestsModalItems
                .map((cr) => {
                const field = String(cr.field_name || '');
                const curLabel = l === "tr" ? "Mevcut deger" : l === "de" ? "Aktueller Wert" : l === "fr" ? "Valeur actuelle" : l === "es" ? "Valor actual" : l === "it" ? "Valore attuale" : "Current value";
                const propLabel = l === "tr" ? "Önerilen değer" : l === "de" ? "Vorgeschlagener Wert" : l === "fr" ? "Valeur proposée" : l === "es" ? "Valor propuesto" : l === "it" ? "Valore proposto" : "Proposed value";
                return (
                  <Card key={cr.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200">
                      <Text as="h3" variant="bodyMd" fontWeight="semibold">
                        {fieldNameDisplayLabel(field, l)}
                      </Text>
                      <Divider />
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <div>
                          <Text as="p" variant="bodySm" tone="subdued">{curLabel}</Text>
                          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 4 }}>
                            {formatChangeRequestValueForDisplay(cr.old_value)}
                          </div>
                        </div>
                        <div>
                          <Text as="p" variant="bodySm" tone="subdued">{propLabel}</Text>
                          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontWeight: 600, marginTop: 4 }}>
                            {formatChangeRequestValueForDisplay(cr.new_value)}
                          </div>
                        </div>
                      </div>
                      {isSuperuser && (
                        <InlineStack gap="200">
                          <Button
                            variant="primary"
                            tone="success"
                            size="slim"
                            onClick={() => approveChangeRequest(cr.id)}
                          >
                            {locale === "en" ? "Approve" : locale === "tr" ? "Onayla" : locale === "fr" ? "Approuver" : locale === "es" ? "Aprobar" : locale === "it" ? "Approva" : "Genehmigen"}
                          </Button>
                          <Button
                            variant="secondary"
                            tone="critical"
                            size="slim"
                            onClick={() => rejectChangeRequest(cr.id)}
                          >
                            {locale === "en" ? "Reject" : locale === "tr" ? "Reddet" : locale === "fr" ? "Refuser" : locale === "es" ? "Rechazar" : locale === "it" ? "Rifiuta" : "Ablehnen"}
                          </Button>
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Card>
                );
              })
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title={l === "tr" ? "Envanteri disa aktar" : l === "de" ? "Inventar exportieren" : l === "fr" ? "Exporter l'inventaire" : l === "es" ? "Exportar inventario" : l === "it" ? "Esporta inventario" : "Export inventory"}
        primaryAction={{
          content: l === "tr" ? "Disa aktar" : l === "de" ? "Exportieren" : l === "fr" ? "Exporter" : l === "es" ? "Exportar" : l === "it" ? "Esporta" : "Export",
          onAction: runQuickExport,
          loading: exporting,
        }}
        secondaryActions={[
          { content: l === "tr" ? "Iptal" : l === "de" ? "Abbrechen" : l === "fr" ? "Annuler" : l === "es" ? "Cancelar" : l === "it" ? "Annulla" : "Cancel", onAction: () => setExportModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {l === "tr"
                ? "Filtrelenmiş ürünler dışa aktarılır: her ürün için bir parent satırı, her varyant için bir child satırı (ilk sütun: product_type)."
                : l === "de"
                ? "Gefilterte Produkte werden exportiert: pro Artikel eine Parent-Zeile, pro Variante eine Child-Zeile (erste Spalte: product_type)."
                : l === "fr"
                ? "Les produits filtrés sont exportés : une ligne parent par produit, une ligne enfant par variante (première colonne : product_type)."
                : l === "es"
                ? "Los productos filtrados se exportan: una fila padre por producto, una fila hijo por variante (primera columna: product_type)."
                : l === "it"
                ? "I prodotti filtrati vengono esportati: una riga padre per prodotto, una riga figlio per variante (prima colonna: product_type)."
                : "Filtered products are exported: one parent row per product, one child row per variant (first column: product_type)."}
            </Text>
            <Select
              label={l === "tr" ? "Format" : "Format"}
              value={exportFormat}
              onChange={setExportFormat}
              options={[
                { label: "XLSX", value: "xlsx" },
                { label: "CSV", value: "csv" },
                { label: "TXT", value: "txt" },
              ]}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {isSuperuser && (
        <Modal
          open={eanDuplicatesModalOpen}
          onClose={() => setEanDuplicatesModalOpen(false)}
          title={lt(locale, "Duplicate products", "Yinelenen ürünler", "Produits en double", "Productos duplicados", "Prodotti duplicati", "Doppelte Produkte")}
          secondaryActions={[{ content: ui.cancel, onAction: () => setEanDuplicatesModalOpen(false) }]}
        >
          <Modal.Section>
            {eanDuplicateGroups.length === 0 ? (
              <Text as="p" tone="subdued">
                {lt(locale, "No duplicates found.", "Yinelenen ürün bulunamadı.", "Aucun doublon trouvé.", "No se encontraron duplicados.", "Nessun duplicato trovato.", "Keine Duplikate gefunden.")}
              </Text>
            ) : (
              <BlockStack gap="400">
                {eanDuplicateGroups.map((group) => (
                  <Card key={group.ean}>
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingSm">EAN {group.ean}</Text>
                      <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" tone="subdued">
                            {lt(locale, "Original (keeps ownership)", "Orijinal (sahiplik burada kalır)", "Original (conserve la propriété)", "Original (mantiene la propiedad)", "Originale (mantiene la proprietà)", "Original (behält die Inhaberschaft)")}
                          </Text>
                          <Text as="p">
                            {group.master.title || group.master.id} · {sellerLabelById[group.master.seller_id] || group.master.seller_id || "—"}  {fmtDateShort(group.master.created_at, locale)}
                          </Text>
                        </BlockStack>
                      </Box>
                      {group.duplicates.map((dup) => (
                        <InlineStack key={dup.id} align="space-between" blockAlign="center" wrap>
                          <BlockStack gap="050">
                            <Text as="p">
                              {dup.title || dup.id} · {sellerLabelById[dup.seller_id] || dup.seller_id || "—"}  {fmtDateShort(dup.created_at, locale)}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {fmtMoney(dup.price_cents, locale)} · {lt(locale, "Stock", "Stok", "Stock", "Stock", "Scorte", "Bestand")}: {dup.inventory ?? 0}
                            </Text>
                          </BlockStack>
                          <Button
                            onClick={() => mergeEanDuplicate(group.master.id, dup.id)}
                            loading={eanDuplicateMergingId === dup.id}
                            disabled={Boolean(eanDuplicateMergingId) && eanDuplicateMergingId !== dup.id}
                          >
                            {lt(locale, "Merge into original", "Orijinalle birleştir", "Fusionner avec l'original", "Fusionar con el original", "Unisci all'originale", "Mit Original zusammenführen")}
                          </Button>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
