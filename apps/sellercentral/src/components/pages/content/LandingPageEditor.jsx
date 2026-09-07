"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Button,
  TextField,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  Modal,
  Select,
  Badge,
  Divider,
  Tabs as PolarisTabs,
  Checkbox,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import RichTextEditor from "@/components/RichTextEditor";
import { mergeLoadedShopStyles } from "@andertal/shop-theme";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import { confirmDelete } from "@/lib/confirm-delete";
import { useLocale } from "next-intl";
import { getNewContainerSeed } from "@/lib/landing-page-editor-i18n";
import { createContext, useContext } from "react";
import { getLandingEditorCopy, getContainerTypes } from "@/lib/landing-page-editor-i18n";
import ApiPageSettingsPanel from "@/components/pages/content/ApiPageSettingsPanel";
import {
  ContainerTypePreview,
} from "@/components/pages/content/ContainerTypePreview";
import { groupContainerTypes, groupLabel } from "@/lib/landing-container-catalog";

const LandingCopyContext = createContext(null);
function useLandingCopy() {
  const ctx = useContext(LandingCopyContext);
  if (!ctx) return getLandingEditorCopy("en");
  return ctx;
}

const BACKEND_URL = (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

// ── i18n helpers ──────────────────────────────────────────────────────────────

/** Read a translatable text field from a container or item */
function gi(obj, field, lang) {
  if (!lang || lang === "de") return obj?.[field] ?? "";
  return obj?._i18n?.[lang]?.[field] ?? obj?.[field] ?? "";
}

/** Return updated object with a translatable field set for the given language */
function si(obj, field, lang, value) {
  if (!lang || lang === "de") return { ...obj, [field]: value };
  return {
    ...obj,
    _i18n: {
      ...(obj._i18n || {}),
      [lang]: { ...(obj._i18n?.[lang] || {}), [field]: value },
    },
  };
}

/** Shop locales for texts + images (_i18n keys = URL segment en, de, tr, …) */
function shopContentLangOptions(locale) {
  return getLandingEditorCopy(locale).shopContentLangOptions();
}

function resolveUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) return url;
  return `${BACKEND_URL}/uploads/${url}`;
}

// Parse a CSS padding shorthand into [top, right, bottom, left]
function parsePadding(val) {
  const parts = (val || "0px").trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** Kompakte, umbrechende Feldgruppen (statt 4 Felder in einer quetschten Zeile) */
const EDITOR_FIELD_GRID = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 12,
  width: "100%",
};

/** Hauptinhalt (links) + Abstand-Panel (rechts) */
const CONTAINER_EDITOR_ROW = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: 24,
  width: "100%",
};
const CONTAINER_EDITOR_MAIN = { flex: "1 1 420px", minWidth: 0, maxWidth: "100%" };
const CONTAINER_EDITOR_CHROME = { flex: "0 0 300px", minWidth: 260, maxWidth: "100%", position: "sticky", top: 16, alignSelf: "flex-start" };

/** Einheitliche Innenabstand-Defaults pro Container-Typ (Landing Page) */
const CONTAINER_PADDING_DEFAULTS = {
  hero_banner: "0px 0px 0px 0px",
  text_block: "48px 24px 48px 24px",
  image_text: "48px 24px 48px 24px",
  image_grid: "32px 24px 32px 24px",
  image_carousel: "32px 24px 32px 24px",
  video_block: "32px 24px 32px 24px",
  banner_cta: "32px 48px 40px 48px",
  collection_carousel: "32px 24px 32px 24px",
  bestseller_carousel: "32px 24px 32px 24px",
  brands_directory: "32px 24px 32px 24px",
  category_sidebar: "0px 0px 0px 0px",
  seller_carousel: "32px 24px 32px 24px",
  collections_carousel: "32px 24px 32px 24px",
  content_mosaic: "32px 24px 32px 24px",
  accordion: "48px 24px 48px 24px",
  tabs: "48px 24px 48px 24px",
  single_product: "48px 24px 48px 24px",
  blog_carousel: "40px 24px 40px 24px",
  newsletter: "48px 24px 48px 24px",
  feature_grid: "64px 24px 64px 24px",
  testimonials: "64px 24px 64px 24px",
  support_hero: "64px 24px 64px 24px",
  support_case_wizard: "48px 24px 48px 24px",
  support_topic_grid: "48px 24px 48px 24px",
  support_faq: "48px 24px 48px 24px",
};

function getContainerPaddingDefault(type) {
  return CONTAINER_PADDING_DEFAULTS[type] || "32px 24px 32px 24px";
}

/** true = nur links/rechts (2 Felder) — schnell; false = 4-Seiten-Padding (z. B. CTA-Banner) */
function containerPaddingHorizontalOnly(type) {
  return type !== "banner_cta";
}

// horizontalOnly=true: only shows Rechts/Links fields (vertical spacing comes from ContainerSpacingEditor)
function PaddingEditor({ label, value, onChange, defaultValue = "0px 0px 0px 0px", horizontalOnly = false }) {
  const c = useLandingCopy();
  const [t, r, b, l] = parsePadding(value || defaultValue);
  const emit = (top, right, bottom, left) => onChange(`${top} ${right} ${bottom} ${left}`);
  if (horizontalOnly) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{label || c.padding}</Text>
        <div style={EDITOR_FIELD_GRID}>
          <TextField label={c.paddingRight} value={r} onChange={(v) => emit(t, v, b, l)} autoComplete="off" placeholder="0px" />
          <TextField label={c.paddingLeft} value={l} onChange={(v) => emit(t, r, b, v)} autoComplete="off" placeholder="0px" />
        </div>
      </BlockStack>
    );
  }
  return (
    <BlockStack gap="200">
      <Text as="p" variant="bodyMd" fontWeight="semibold">{label || c.padding}</Text>
      <div style={EDITOR_FIELD_GRID}>
        <TextField label={c.paddingTop} value={t} onChange={(v) => emit(v, r, b, l)} autoComplete="off" placeholder="0px" />
        <TextField label={c.paddingBottom} value={b} onChange={(v) => emit(t, r, v, l)} autoComplete="off" placeholder="0px" />
        <TextField label={c.paddingRight} value={r} onChange={(v) => emit(t, v, b, l)} autoComplete="off" placeholder="0px" />
        <TextField label={c.paddingLeft} value={l} onChange={(v) => emit(t, r, b, v)} autoComplete="off" placeholder="0px" />
      </div>
    </BlockStack>
  );
}

function getContainerTypesFromLocale(locale) {
  return getContainerTypes(locale);
}

const CAT_HEADING = "__heading_categories__";
const PAGE_HEADING = "__heading_cms_pages__";
const BLOG_HEADING = "__heading_blog_posts__";
const API_HEADING = "__heading_api_pages__";

function flattenCategoriesForSelect(nodes, depth = 0, acc = []) {
  if (!Array.isArray(nodes)) return acc;
  for (const n of nodes) {
    if (!n?.id) continue;
    const pad = depth > 0 ? `${"\u00A0\u00A0".repeat(depth)}\u2022 ` : "";
    acc.push({
      label: `${pad}${n.name || n.slug || n.id}`,
      value: `cat:${n.id}`,
    });
    if (Array.isArray(n.children) && n.children.length) {
      flattenCategoriesForSelect(n.children, depth + 1, acc);
    }
  }
  return acc;
}

/** Normalisiert gespeicherte Landing-Settings inkl. Shop-Subnav / Filterleiste. */
const POPUP_DEVICE_DEFAULTS = {
  enabled: false,
  trigger: "delay",
  delay: 3,
  scroll_pct: 40,
  frequency: "session",
  position: "center",
  animation: "fade",
  overlay: 0.5,
  show_close: true,
  width: "600px",
  max_height: "80vh",
  bg_color: "#ffffff",
  text_color: "#111827",
  border_radius: 16,
  title: "",
  body: "",
  image: "",
  btn_text: "",
  btn_url: "",
  btn_bg: "#111827",
  btn_color: "#ffffff",
  btn_radius: 8,
};

function normalizePopupDevice(raw) {
  if (!raw || typeof raw !== "object") return { ...POPUP_DEVICE_DEFAULTS };
  return { ...POPUP_DEVICE_DEFAULTS, ...raw };
}

function normalizePopupConfig(raw) {
  const p = (raw && typeof raw === "object") ? raw : {};
  return {
    desktop: normalizePopupDevice(p.desktop),
    tablet: normalizePopupDevice(p.tablet),
    mobile: normalizePopupDevice(p.mobile),
  };
}

function normalizeLandingPageSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    ...s,
    show_submenu_left: s.show_submenu_left === true,
    show_filter_bar: s.show_filter_bar !== false,
    show_product_filter_bar: s.show_product_filter_bar === true,
    second_nav_desktop_classic: s.second_nav_desktop_classic === true,
    page_padding_top: s.page_padding_top || "",
    popup: normalizePopupConfig(s.popup),
  };
}

function newContainer(type) {
  const id = Math.random().toString(36).slice(2);
  const base = { id, type, visible: true };
  switch (type) {
    case "hero_banner":
      return { ...base, brand_mark: "", slides: [{ image: "", title: "", subtitle: "", btn_text: "", btn_url: "", btn2_text: "", btn2_url: "", btn2_variant: "ghost", overlay: 0, text_color: "#ffffff", title_color: "#ffffff", subtitle_color: "#ffffff", text_position: "center", title_size: "clamp(24px,4vw,56px)", subtitle_size: "clamp(14px,2vw,22px)", title_font: "system", subtitle_font: "system", content_padding: "32px 48px", btn_variant: "andertal_orange", btn_bg: "#ff971c", btn_color: "#fff", btn_hover_bg: "#e8860f", btn_hover_color: "#fff", btn_border: "2px solid #000", btn_radius: 8 }], height: "500px", mobile_height: "70vh", autoplay: true, delay: 4000, padding: "0px 0px 0px 0px", content_layout: "full" };
    case "text_block":
      return { ...base, title: "", body: "", btn_text: "", btn_url: "", align: "center", bg_color: "#ffffff", text_color: "#111827", padding: "48px 24px", btn_bg: "#ff971c", btn_color: "#fff", btn_border: "2px solid #000", btn_radius: 8, content_layout: "full" };
    case "image_text":
      return { ...base, image: "", title: "", body: "", btn_text: "", btn_url: "", image_side: "left", bg_color: "#ffffff", text_color: "#111827", text_align: "left", padding: "48px 24px", btn_bg: "#ff971c", btn_color: "#fff", btn_border: "2px solid #000", btn_radius: 8, content_layout: "full" };
    case "image_grid":
      return { ...base, images: [{ url: "", link: "", aspect_ratio: "1/1" }, { url: "", link: "", aspect_ratio: "1/1" }], cols: 2, gap: 16, padding: "32px 24px", content_layout: "full" };
    case "content_mosaic":
      return {
        ...base,
        title: "",
        source: "images",
        images: [{ url: "", link: "", aspect_ratio: "1/1", title: "", text: "" }],
        collection_id: "",
        collection_handle: "",
        product_captions: "",
        collections: [],
        layout_pattern_desktop: "1,2",
        layout_pattern_mobile: "1",
        gap: 16,
        gap_mobile: undefined,
        card_aspect_ratio: "4/5",
        card_image_object_fit: "cover",
        bg_color: "#ffffff",
        padding: "32px 24px",
        content_layout: "full",
      };
    case "image_carousel": {
      const emptySlide = {
        url: "",
        link: "",
        title: "",
        text: "",
      };
      return {
        ...base,
        title: "",
        images: [emptySlide, { ...emptySlide }],
        items_per_row: 4,
        items_per_row_mobile: 2,
        gap: 16,
        mobile_layout: "row",
        mobile_grid_rows: 2,
        mobile_grid_cols: 2,
        aspect_ratio: "4/5",
        aspect_ratio_custom: "",
        aspect_ratio_mobile: "",
        aspect_ratio_mobile_custom: "",
        mobile_item_width: "",
        min_height_mobile: "",
        max_height: "",
        max_height_mobile: "",
        padding: "32px 24px",
        content_layout: "full",
      };
    }
    case "banner_cta":
      return { ...base, title: "", subtitle: "", btn_text: "", btn_url: "", bg_color: "#ff971c", text_color: "#ffffff", text_position: "center", padding: "32px 48px 40px 48px", btn_bg: "#ffffff", btn_color: "#111827", btn_border: "2px solid #000", btn_radius: 8, content_layout: "full" };
    case "collection_carousel":
      return { ...base, title: "", collection_id: "", collection_handle: "", product_captions: "", items_per_row: 4, items_per_row_mobile: 2, gap: 16, mobile_layout: "row", mobile_grid_rows: 2, mobile_grid_cols: 2, padding: "32px 24px", content_layout: "full" };
    case "bestseller_carousel":
      return { ...base, title: "", category_slug: "", mode: "bestseller", items_per_row: 4, items_per_row_mobile: 2, gap: 16, mobile_layout: "row", mobile_grid_rows: 2, mobile_grid_cols: 2, padding: "32px 24px", content_layout: "full" };
    case "category_sidebar":
      return { ...base, title: "" };
    case "seller_carousel":
      return { ...base, title: "", limit: 20, items_per_row: 4, items_per_row_mobile: 2, gap: 16, padding: "32px 24px", content_layout: "full" };
    case "brands_directory":
      return { ...base, title: "", items_per_row: 5, items_per_row_mobile: 2, max_rows: 10, gap: 14, padding: "32px 24px", content_layout: "full" };
    case "collections_carousel":
      return {
        ...base,
        title: "",
        collections: [],
        items_per_row: 4,
        items_per_row_mobile: 2,
        gap: 16,
        mobile_layout: "row",
        mobile_grid_rows: 2,
        mobile_grid_cols: 2,
        padding: "32px 24px",
        card_aspect_ratio: "4/5",
        card_image_object_fit: "cover",
        content_layout: "full",
      };
    case "accordion":
      return {
        ...base,
        title: "",
        items: [{ question: "", answer: "" }, { question: "", answer: "" }],
        bg_color: "#ffffff",
        text_color: "#111827",
        padding: "48px 24px",
        border_color: "#e5e7eb",
        icon_color: "#111827",
        content_layout: "full",
      };
    case "tabs":
      return { ...base, tabs: [{ label: "", content: "" }, { label: "", content: "" }], bg_color: "#ffffff", text_color: "#111827", padding: "48px 24px", tab_style: "underline", active_color: "#ff971c", tab_bg: "#f3f4f6", content_layout: "full" };
    case "single_product":
      return { ...base, title: "", product_id: "", product_handle: "", bg_color: "#ffffff", text_color: "#111827", padding: "48px 24px", content_layout: "full" };
    case "blog_carousel":
      return {
        ...base,
        title: "Blog",
        posts: [],
        items_per_row: 3,
        items_per_row_mobile: 1,
        bg_color: "#ffffff",
        text_color: "#111827",
        padding: "40px 24px",
        content_layout: "full",
      };
    case "newsletter":
      return {
        ...base,
        title: "Newsletter",
        subtitle: "",
        button_text: "",
        first_name_placeholder: "",
        last_name_placeholder: "",
        email_placeholder: "",
        provider: "other",
        form_action: "",
        form_method: "post",
        first_name_field_name: "FNAME",
        last_name_field_name: "LNAME",
        email_field_name: "EMAIL",
        hidden_fields: [],
        privacy_note: "",
        bg_color: "#f3f4f6",
        text_color: "#111827",
        btn_bg: "#111827",
        btn_color: "#ffffff",
        padding: "48px 24px",
        content_layout: "full",
      };
    case "feature_grid":
      return {
        ...base,
        variant: "cards",
        eyebrow: "",
        title: "",
        subtitle: "",
        lead: "",
        title_align: "center",
        cols: 3,
        card_style: "bordered",
        icon_size: "40px",
        bg_color: "#ffffff",
        card_bg: "#f9fafb",
        card_border_color: "#e5e7eb",
        text_color: "#111827",
        icon_color: "#ff971c",
        padding: "64px 24px",
        content_layout: "full",
        items: [
          { icon: "⚡", title: "", body: "" },
          { icon: "🔒", title: "", body: "" },
          { icon: "↩️", title: "", body: "" },
        ],
      };
    case "testimonials":
      return {
        ...base,
        title: "",
        subtitle: "",
        title_align: "center",
        cols: 3,
        show_stars: true,
        card_bg: "#ffffff",
        card_border_color: "#e5e7eb",
        bg_color: "#f9fafb",
        text_color: "#111827",
        accent_color: "#ff971c",
        padding: "64px 24px",
        content_layout: "full",
        items: [
          { quote: "", author: "Maria S.", role: "", avatar: "", rating: 5 },
          { quote: "", author: "Thomas K.", role: "", avatar: "", rating: 5 },
          { quote: "", author: "Julia M.", role: "", avatar: "", rating: 4 },
        ],
      };
    case "video_block":
      return {
        ...base,
        title: "",
        caption: "",
        text_color: "#111827",
        video_mode: "file",
        video_url: "",
        video_url_mobile: "",
        embed_url: "",
        embed_url_mobile: "",
        poster_url: "",
        poster_url_mobile: "",
        aspect_ratio: "16/9",
        autoplay: false,
        muted: true,
        loop: false,
        controls: true,
        playsinline: true,
        bg_color: "#ffffff",
        padding: "32px 24px",
        content_layout: "full",
      };
    case "support_hero":
      return {
        ...base, title: "", description: "", trust_text: "", search_placeholder: "",
        primary_action_label: "", primary_action_url: "", secondary_action_label: "", secondary_action_url: "",
        open_case_count_enabled: true, open_case_count_text: "",
        bg_color: "#f5f7ff", text_color: "#17213c", accent_color: "#ff971c", image: "",
        layout: "split", padding: "64px 24px", content_layout: "contained", content_max_width: "1200px",
      };
    case "support_case_wizard":
      return {
        ...base, title: "", description: "", category_heading: "", subtopic_heading: "", order_heading: "",
        continue_label: "", back_label: "", categories: [],
        padding: "48px 24px", content_layout: "contained", content_max_width: "1000px",
      };
    case "support_topic_grid":
      return {
        ...base, title: "", description: "", columns: 3, topics: [],
        padding: "48px 24px", content_layout: "contained", content_max_width: "1200px",
      };
    case "support_faq":
      return {
        ...base, title: "", description: "", section_label: "", no_results_text: "", categories: [],
        padding: "48px 24px", content_layout: "contained", content_max_width: "1000px",
      };
    default:
      return base;
  }
}

function ImageField({ label, value, onPick, onClear, helpText }) {
  const c = useLandingCopy();
  const resolved = resolveUrl(value);
  return (
    <BlockStack gap="200">
      {label && <Text as="span" variant="bodyMd" fontWeight="medium">{label}</Text>}
      {helpText && <Text as="p" variant="bodySm" tone="subdued">{helpText}</Text>}
      <InlineStack gap="300" blockAlign="center">
        {resolved ? (
          <img src={resolved} alt="" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8, border: "1px solid var(--p-color-border)", display: "block", flexShrink: 0 }} />
        ) : (
          <div style={{ width: 80, height: 80, background: "var(--p-color-bg-surface-secondary)", borderRadius: 8, border: "1px dashed var(--p-color-border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Text as="span" variant="bodySm" tone="subdued">{c.noImage}</Text>
          </div>
        )}
        <BlockStack gap="100">
          <Button size="slim" onClick={onPick}>{resolved ? c.changeImage : c.selectImage}</Button>
          {resolved && <Button size="slim" tone="critical" onClick={onClear}>{c.remove}</Button>}
        </BlockStack>
      </InlineStack>
    </BlockStack>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <TextField
      label={label}
      value={value || ""}
      onChange={onChange}
      autoComplete="off"
      prefix={
        <div
          style={{ width: 16, height: 16, borderRadius: 3, background: value || "#ffffff", border: "1px solid var(--p-color-border)", cursor: "pointer", flexShrink: 0 }}
          onClick={() => {
            const el = document.createElement("input");
            el.type = "color";
            el.value = value || "#ffffff";
            el.oninput = (e) => onChange(e.target.value);
            el.click();
          }}
        />
      }
    />
  );
}

// ── Hero Banner editor ──────────────────────────────────────────────────────
function HeroBannerEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const [pickerIdx, setPickerIdx] = useState(null);
  const [videoPickerIdx, setVideoPickerIdx] = useState(null);

  const updateSlide = (idx, key, val) => {
    const slides = [...(container.slides || [])];
    slides[idx] = { ...slides[idx], [key]: val };
    onChange({ ...container, slides });
  };
  const updateSlideI18n = (idx, field, val) => {
    const slides = [...(container.slides || [])];
    slides[idx] = si(slides[idx], field, editLang, val);
    onChange({ ...container, slides });
  };
  const addSlide = () => {
    onChange({ ...container, slides: [...(container.slides || []), { image: "", title: "", subtitle: "", btn_text: "", btn_url: "", btn2_text: "", btn2_url: "", btn2_variant: "ghost", overlay: 0, text_color: "#ffffff", title_color: "#ffffff", subtitle_color: "#ffffff", text_position: "center", title_size: "clamp(24px,4vw,56px)", subtitle_size: "clamp(14px,2vw,22px)", title_font: "system", subtitle_font: "system", content_padding: "32px 48px", btn_variant: "andertal_orange", btn_bg: "#ff971c", btn_color: "#fff", btn_hover_bg: "#e8860f", btn_hover_color: "#fff", btn_border: "2px solid #000", btn_radius: 8 }] });
  };
  const removeSlide = (idx) => {
    onChange({ ...container, slides: (container.slides || []).filter((_, i) => i !== idx) });
  };
  const moveSlide = (idx, direction) => {
    const slides = [...(container.slides || [])];
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= slides.length) return;
    [slides[idx], slides[nextIdx]] = [slides[nextIdx], slides[idx]];
    onChange({ ...container, slides });
  };

  return (
    <BlockStack gap="400">
      {pickerIdx !== null && (
        <MediaPickerModal open multiple={false} onClose={() => setPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateSlideI18n(pickerIdx, "image", urls[0]); setPickerIdx(null); }} />
      )}
      {videoPickerIdx !== null && (
        <MediaPickerModal open multiple={false} title={c.selectVideo} onClose={() => setVideoPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateSlide(videoPickerIdx, "video_url", urls[0]); setVideoPickerIdx(null); }} />
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.sliderSettings}</Text>
          <BlockStack gap="300">
            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.height} value={container.height || "500px"} onChange={(v) => onChange({ ...container, height: v })} helpText={c.egPx} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.mobileHeight} value={container.mobile_height || "70vh"} onChange={(v) => onChange({ ...container, mobile_height: v })} helpText={c.egPx} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <Select label={c.autoplay} options={c.autoplayOptions()} value={container.autoplay !== false ? "true" : "false"} onChange={(v) => onChange({ ...container, autoplay: v === "true" })} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.delayMs} type="number" value={String(container.delay || 4000)} onChange={(v) => onChange({ ...container, delay: Number(v) || 4000 })} autoComplete="off" />
              </div>
            </InlineStack>
            <TextField label={c.brandMark} value={gi(container, "brand_mark", editLang)} onChange={(v) => onChange(si(container, "brand_mark", editLang, v))} helpText={c.brandMarkHelp} autoComplete="off" />
            <Text as="p" variant="bodySm" tone="subdued">{c.paddingHint}</Text>
          </BlockStack>
        </BlockStack>
      </Card>

      {(container.slides || []).map((slide, idx) => (
        <Card key={idx}>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.slideN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveSlide(idx, -1)}>
                  {c.moveUp}
                </Button>
                <Button size="slim" disabled={idx === (container.slides || []).length - 1} onClick={() => moveSlide(idx, 1)}>
                  {c.moveDown}
                </Button>
                {(container.slides || []).length > 1 && (
                  <Button size="slim" tone="critical" onClick={() => removeSlide(idx)}>{c.remove}</Button>
                )}
              </InlineStack>
            </InlineStack>

            <ImageField
              label={c.image}
              helpText={c.imageHelpHero}
              value={gi(slide, "image", editLang)}
              onPick={() => setPickerIdx(idx)}
              onClear={() => updateSlideI18n(idx, "image", "")}
            />

            <BlockStack gap="150">
              <Text as="p" variant="bodySm" fontWeight="medium">{c.imageOptional}</Text>
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="" labelHidden value={slide.video_url || ""} onChange={(v) => updateSlide(idx, "video_url", v)} placeholder="https://…/video.mp4" autoComplete="off" />
                </div>
                <Button size="slim" onClick={() => setVideoPickerIdx(idx)}>{c.mediaLibrary}</Button>
                {slide.video_url && <Button size="slim" tone="critical" onClick={() => updateSlide(idx, "video_url", "")}>×</Button>}
              </InlineStack>
              {slide.video_url && (
                <video src={resolveUrl(slide.video_url)} style={{ width: "100%", maxHeight: 100, objectFit: "cover", borderRadius: 8, border: "1px solid var(--p-color-border)" }} muted playsInline />
              )}
            </BlockStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.title} value={gi(slide, "title", editLang)} onChange={(v) => updateSlideI18n(idx, "title", v)} placeholder={c.headingPh} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.subtitle} value={gi(slide, "subtitle", editLang)} onChange={(v) => updateSlideI18n(idx, "subtitle", v)} placeholder={c.subtitlePh} autoComplete="off" />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.buttonText} value={gi(slide, "btn_text", editLang)} onChange={(v) => updateSlideI18n(idx, "btn_text", v)} placeholder={c.discoverPh} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.urlImageButton} value={slide.btn_url || ""} onChange={(v) => updateSlide(idx, "btn_url", v)} placeholder="/de/collections/..." autoComplete="off" />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 2 }}>
                <Select label={c.textPosition} options={c.textPositionOptions()} value={slide.text_position || "center"} onChange={(v) => updateSlide(idx, "text_position", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <ColorField label={c.titleColor} value={slide.title_color || slide.text_color || "#ffffff"} onChange={(v) => updateSlide(idx, "title_color", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <ColorField label={c.subtitleColor} value={slide.subtitle_color || slide.text_color || "#ffffff"} onChange={(v) => updateSlide(idx, "subtitle_color", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.overlay} type="number" value={String(slide.overlay ?? 0)} onChange={(v) => updateSlide(idx, "overlay", Math.min(100, Math.max(0, Number(v))))} autoComplete="off" helpText={c.overlayHelp} />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <Select label={c.titleFont} options={c.fontFamilyOptions()} value={slide.title_font || "system"} onChange={(v) => updateSlide(idx, "title_font", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <Select label={c.subtitleFont} options={c.fontFamilyOptions()} value={slide.subtitle_font || "system"} onChange={(v) => updateSlide(idx, "subtitle_font", v)} />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.titleSize} value={slide.title_size || "clamp(24px,4vw,56px)"} onChange={(v) => updateSlide(idx, "title_size", v)} autoComplete="off" helpText={c.eg48px} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.subtitleSize} value={slide.subtitle_size || "clamp(14px,2vw,22px)"} onChange={(v) => updateSlide(idx, "subtitle_size", v)} autoComplete="off" helpText={c.eg20px} />
              </div>
              <div style={{ flex: 1 }}>
                <PaddingEditor label={c.contentPadding} value={slide.content_padding || "32px 48px 32px 48px"} onChange={(v) => updateSlide(idx, "content_padding", v)} defaultValue="32px 48px 32px 48px" />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <Select label={c.buttonStyle} options={c.buttonVariantOptions()} value={slide.btn_variant || "andertal_orange"} onChange={(v) => updateSlide(idx, "btn_variant", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <ColorField label={c.buttonBg} value={slide.btn_bg || "#ff971c"} onChange={(v) => updateSlide(idx, "btn_bg", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <ColorField label={c.buttonTextColor} value={slide.btn_color || "#ffffff"} onChange={(v) => updateSlide(idx, "btn_color", v)} />
              </div>
            </InlineStack>
            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <ColorField label={c.buttonHoverBg} value={slide.btn_hover_bg || "#e8860f"} onChange={(v) => updateSlide(idx, "btn_hover_bg", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <ColorField label={c.buttonHoverColor} value={slide.btn_hover_color || "#ffffff"} onChange={(v) => updateSlide(idx, "btn_hover_color", v)} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.buttonBorder} value={slide.btn_border || "2px solid #000"} onChange={(v) => updateSlide(idx, "btn_border", v)} autoComplete="off" helpText={c.egNone} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.buttonRadius} value={String(slide.btn_radius ?? 8)} onChange={(v) => updateSlide(idx, "btn_radius", Number(v) || 0)} autoComplete="off" helpText={c.pxUnit} />
              </div>
            </InlineStack>

            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.secondaryButtonText} value={slide.btn2_text || ""} onChange={(v) => updateSlide(idx, "btn2_text", v)} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.secondaryButtonUrl} value={slide.btn2_url || ""} onChange={(v) => updateSlide(idx, "btn2_url", v)} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <Select label={c.secondaryButtonStyle} options={c.buttonVariantOptions()} value={slide.btn2_variant || "ghost"} onChange={(v) => updateSlide(idx, "btn2_variant", v)} />
              </div>
            </InlineStack>
          </BlockStack>
        </Card>
      ))}

      <Button onClick={addSlide}>{c.addSlide}</Button>
    </BlockStack>
  );
}

// ── Text Block editor ───────────────────────────────────────────────────────
function TextBlockEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  return (
    <BlockStack gap="400">
      <TextField label={c.heading} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} placeholder={c.headingPh} autoComplete="off" />
      <RichTextEditor label={c.text} value={gi(container, "body", editLang)} onChange={(v) => onChange(si(container, "body", editLang, v))} placeholder={c.enterText} minHeight="160px" />
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonText} value={gi(container, "btn_text", editLang)} onChange={(v) => onChange(si(container, "btn_text", editLang, v))} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonUrl} value={container.btn_url || ""} onChange={(v) => onChange({ ...container, btn_url: v })} autoComplete="off" />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <Select label={c.alignment} options={c.alignOptions()} value={container.align || "center"} onChange={(v) => onChange({ ...container, align: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.backgroundColor} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <ColorField label={c.buttonBg} value={container.btn_bg || "#ff971c"} onChange={(v) => onChange({ ...container, btn_bg: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.buttonTextColor} value={container.btn_color || "#ffffff"} onChange={(v) => onChange({ ...container, btn_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonBorder} value={container.btn_border || "2px solid #000"} onChange={(v) => onChange({ ...container, btn_border: v })} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonRadius} value={String(container.btn_radius ?? 8)} onChange={(v) => onChange({ ...container, btn_radius: Number(v) || 0 })} autoComplete="off" />
        </div>
      </InlineStack>
    </BlockStack>
  );
}

// ── Image + Text editor ─────────────────────────────────────────────────────
function ImageTextEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  return (
    <BlockStack gap="400">
      {pickerOpen && (
        <MediaPickerModal
          open
          multiple={false}
          onClose={() => setPickerOpen(false)}
          onSelect={(urls) => {
            if (urls[0]) onChange(si(container, "image", editLang, urls[0]));
            setPickerOpen(false);
          }}
        />
      )}
      {videoPickerOpen && (
        <MediaPickerModal open multiple={false} title={c.selectVideo} onClose={() => setVideoPickerOpen(false)} onSelect={(urls) => { if (urls[0]) onChange({ ...container, video_url: urls[0] }); setVideoPickerOpen(false); }} />
      )}
      <ImageField label={c.image} value={gi(container, "image", editLang)} onPick={() => setPickerOpen(true)} onClear={() => onChange(si(container, "image", editLang, ""))} />
      <BlockStack gap="150">
        <Text as="p" variant="bodySm" fontWeight="medium">{c.imageOptional}</Text>
        <InlineStack gap="200" blockAlign="end" wrap={false}>
          <div style={{ flex: 1 }}>
            <TextField label="" labelHidden value={container.video_url || ""} onChange={(v) => onChange({ ...container, video_url: v })} placeholder="https://…/video.mp4" autoComplete="off" />
          </div>
          <Button size="slim" onClick={() => setVideoPickerOpen(true)}>{c.mediaLibrary}</Button>
          {container.video_url && <Button size="slim" tone="critical" onClick={() => onChange({ ...container, video_url: "" })}>×</Button>}
        </InlineStack>
        {container.video_url && (
          <video src={resolveUrl(container.video_url)} style={{ width: "100%", maxHeight: 100, objectFit: "cover", borderRadius: 8, border: "1px solid var(--p-color-border)" }} muted playsInline />
        )}
      </BlockStack>
      <Select label={c.imageSide} options={c.imageSideOptions()} value={container.image_side || "left"} onChange={(v) => onChange({ ...container, image_side: v })} />
      <TextField label={c.eyebrow} value={gi(container, "eyebrow", editLang)} onChange={(v) => onChange(si(container, "eyebrow", editLang, v))} autoComplete="off" helpText={c.optional} />
      <TextField label={c.heading} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <Select
            label={c.titleFont}
            options={c.fontFamilyOptions()}
            value={container.title_font || "serif"}
            onChange={(v) => onChange({ ...container, title_font: v })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Select
            label={c.subtitleFont}
            options={c.fontFamilyOptions()}
            value={container.subtitle_font || "sans"}
            onChange={(v) => onChange({ ...container, subtitle_font: v })}
          />
        </div>
      </InlineStack>
      <RichTextEditor label={c.text} value={gi(container, "body", editLang)} onChange={(v) => onChange(si(container, "body", editLang, v))} placeholder={c.enterText} minHeight="130px" />
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <ColorField label={c.titleColor} value={container.title_color || container.text_color || "#111827"} onChange={(v) => onChange({ ...container, title_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.subtitleColor} value={container.subtitle_color || container.text_color || "#111827"} onChange={(v) => onChange({ ...container, subtitle_color: v })} />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonText} value={gi(container, "btn_text", editLang)} onChange={(v) => onChange(si(container, "btn_text", editLang, v))} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonUrl} value={container.btn_url || ""} onChange={(v) => onChange({ ...container, btn_url: v })} autoComplete="off" />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <Select label={c.textAlign} options={c.alignOptions()} value={container.text_align || "left"} onChange={(v) => onChange({ ...container, text_align: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.backgroundColor} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <ColorField label={c.buttonBg} value={container.btn_bg || "#ff971c"} onChange={(v) => onChange({ ...container, btn_bg: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.buttonTextColor} value={container.btn_color || "#ffffff"} onChange={(v) => onChange({ ...container, btn_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonBorder} value={container.btn_border || "2px solid #000"} onChange={(v) => onChange({ ...container, btn_border: v })} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonRadius} value={String(container.btn_radius ?? 8)} onChange={(v) => onChange({ ...container, btn_radius: Number(v) || 0 })} autoComplete="off" />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <Select
            label={c.buttonStyle}
            options={c.buttonVariantOptions()}
            value={container.btn_variant || "andertal_orange"}
            onChange={(v) => onChange({ ...container, btn_variant: v })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField
            label={c.buttonHoverBg}
            value={container.btn_hover_bg || container.btn_bg || "#e8860f"}
            onChange={(v) => onChange({ ...container, btn_hover_bg: v })}
          />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField
            label={c.buttonHoverColor}
            value={container.btn_hover_color || container.btn_color || "#ffffff"}
            onChange={(v) => onChange({ ...container, btn_hover_color: v })}
          />
        </div>
      </InlineStack>
    </BlockStack>
  );
}

// ── Image Grid editor ───────────────────────────────────────────────────────
function ImageGridEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const [pickerIdx, setPickerIdx] = useState(null);
  const updateImg = (idx, key, val) => {
    const images = [...(container.images || [])];
    images[idx] = key === "url" ? si(images[idx], "url", editLang, val) : { ...images[idx], [key]: val };
    onChange({ ...container, images });
  };
  const updateImgI18n = (idx, field, val) => {
    const images = [...(container.images || [])];
    images[idx] = si(images[idx], field, editLang, val);
    onChange({ ...container, images });
  };
  const addImg = () => onChange({ ...container, images: [...(container.images || []), { url: "", link: "", aspect_ratio: "1/1", title: "", text: "" }] });
  const removeImg = (idx) => onChange({ ...container, images: (container.images || []).filter((_, i) => i !== idx) });
  const moveImg = (idx, dir) => {
    const images = [...(container.images || [])];
    const next = idx + dir;
    if (next < 0 || next >= images.length) return;
    [images[idx], images[next]] = [images[next], images[idx]];
    onChange({ ...container, images });
  };

  return (
    <BlockStack gap="400">
      {pickerIdx !== null && (
        <MediaPickerModal open multiple={false} onClose={() => setPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateImg(pickerIdx, "url", urls[0]); setPickerIdx(null); }} />
      )}
      <InlineStack gap="400">
        <div style={{ flex: 1 }}>
          <Select label={c.columns} options={c.colsOptions()} value={String(container.cols || 2)} onChange={(v) => onChange({ ...container, cols: Number(v) })} />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.gapPx} type="number" value={String(container.gap || 16)} onChange={(v) => onChange({ ...container, gap: Number(v) || 16 })} autoComplete="off" />
        </div>
      </InlineStack>

      {(container.images || []).map((img, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.imageN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveImg(idx, -1)}>↑</Button>
                <Button size="slim" disabled={idx === (container.images || []).length - 1} onClick={() => moveImg(idx, 1)}>↓</Button>
                {(container.images || []).length > 1 && (
                  <Button size="slim" tone="critical" onClick={() => removeImg(idx)}>{c.remove}</Button>
                )}
              </InlineStack>
            </InlineStack>
            <ImageField value={gi(img, "url", editLang)} onPick={() => setPickerIdx(idx)} onClear={() => updateImg(idx, "url", "")} />
            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.linkUrlOptional} value={img.link || ""} onChange={(v) => updateImg(idx, "link", v)} placeholder="https://…" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <Select label={c.aspectRatio} options={c.aspectRatioOptions()} value={img.aspect_ratio || "1/1"} onChange={(v) => updateImg(idx, "aspect_ratio", v)} />
              </div>
            </InlineStack>
            <TextField
              label={c.captionUnderImage}
              value={gi(img, "title", editLang)}
              onChange={(v) => updateImgI18n(idx, "title", v)}
              autoComplete="off"
              placeholder={c.captionPh}
              helpText={c.captionShopHelp}
            />
            <RichTextEditor label={c.textOptional} value={gi(img, "text", editLang)} onChange={(v) => updateImgI18n(idx, "text", v)} placeholder={c.enterText} minHeight="160px" />
          </BlockStack>
        </Card>
      ))}
      <Button onClick={addImg}>{c.addImage}</Button>
    </BlockStack>
  );
}

// ── Content-Mosaik: freies Zeilenmuster, Quelle wählbar ─────────────────────
function ContentMosaicEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const client = getMedusaAdminClient();
  const [pickerIdx, setPickerIdx] = useState(null);
  const [hubCollections, setHubCollections] = useState([]);
  const [allCollections, setAllCollections] = useState([]);
  const [addColId, setAddColId] = useState("");

  const source = String(container.source || "images");

  useEffect(() => {
    if (source !== "collection") return;
    client.request("/admin-hub/collections").then((r) => {
      setHubCollections(Array.isArray(r?.collections) ? r.collections : []);
    }).catch(() => {});
  }, [client, source]);

  useEffect(() => {
    if (source !== "collections") return;
    client.getMedusaCollections({ adminHub: true })
      .then((r) => {
        setAllCollections(Array.isArray(r?.collections) ? r.collections : []);
      })
      .catch(() => {});
  }, [client, source]);

  const colOptions = [
    { label: c.chooseCollection, value: "" },
    ...hubCollections.map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
  ];

  const chosen = Array.isArray(container.collections) ? container.collections : [];
  const addCollectionOptions = [
    { label: c.chooseCollectionAdd, value: "" },
    ...allCollections
      .filter((c) => !chosen.some((entry) => entry.id === c.id))
      .map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
  ];

  const addCollection = (id) => {
    if (!id) return;
    const col = allCollections.find((c) => c.id === id);
    if (!col) return;
    onChange({
      ...container,
      collections: [
        ...chosen,
        {
          id: col.id,
          title: col.title || "",
          handle: col.handle || "",
          image: col.image_url || col.image || col.thumbnail || "",
          item_heading: "",
        },
      ],
    });
    setAddColId("");
  };

  const removeCollection = (id) => {
    onChange({ ...container, collections: chosen.filter((entry) => entry.id !== id) });
  };

  const moveCollection = (idx, direction) => {
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= chosen.length) return;
    const next = [...chosen];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    onChange({ ...container, collections: next });
  };

  const updateMosaicCollectionEntry = (idx, key, val) => {
    const next = chosen.map((e, i) => (i === idx ? { ...e, [key]: val } : e));
    onChange({ ...container, collections: next });
  };

  const updateImg = (idx, key, val) => {
    const images = [...(container.images || [])];
    images[idx] = key === "url" ? si(images[idx], "url", editLang, val) : { ...images[idx], [key]: val };
    onChange({ ...container, images });
  };
  const updateImgI18n = (idx, field, val) => {
    const images = [...(container.images || [])];
    images[idx] = si(images[idx], field, editLang, val);
    onChange({ ...container, images });
  };
  const addImg = () => onChange({ ...container, images: [...(container.images || []), { url: "", link: "", aspect_ratio: "1/1", title: "", text: "" }] });
  const removeImg = (idx) => onChange({ ...container, images: (container.images || []).filter((_, i) => i !== idx) });

  const aspectValue = (() => {
    const raw = String(container.card_aspect_ratio || "4/5").trim().replace(/:/g, "/");
    const ok = c.collectionsCarouselAspectOptions().some((o) => o.value === raw);
    return ok ? raw : "4/5";
  })();

  return (
    <BlockStack gap="400">
      {pickerIdx !== null && (
        <MediaPickerModal open multiple={false} onClose={() => setPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateImg(pickerIdx, "url", urls[0]); setPickerIdx(null); }} />
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.contentMosaicHeading}</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {c.contentMosaicIntro}
          </Text>
          <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
          <TextField label={c.eyebrow} value={gi(container, "eyebrow", editLang)} onChange={(v) => onChange(si(container, "eyebrow", editLang, v))} autoComplete="off" />
          <ColorField label={c.backgroundColor} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
          <div style={EDITOR_FIELD_GRID}>
            <ColorField
              label={c.textColor}
              value={container.text_color || "#111827"}
              onChange={(v) => onChange({ ...container, text_color: v })}
            />
            <ColorField
              label={c.titleColor}
              value={container.title_color || container.text_color || "#111827"}
              onChange={(v) => onChange({ ...container, title_color: v })}
            />
            <ColorField
              label={c.subtitleColor}
              value={container.subtitle_color || container.text_color || "#6b7280"}
              onChange={(v) => onChange({ ...container, subtitle_color: v })}
            />
          </div>
          <Select
            label={c.content}
            options={c.contentMosaicSourceOptions()}
            value={source}
            onChange={(v) => onChange({ ...container, source: v })}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.gridShop}</Text>
          <TextField
            label={c.pattern}
            value={String(isMobileView ? (container.layout_pattern_mobile || "1") : (container.layout_pattern_desktop || "1,2"))}
            onChange={(v) => onChange({
              ...container,
              ...(isMobileView ? { layout_pattern_mobile: v } : { layout_pattern_desktop: v }),
            })}
            autoComplete="off"
            helpText={isMobileView ? c.patternHelpMobile : c.patternHelpDesktop}
          />
          <div style={EDITOR_FIELD_GRID}>
            <TextField
              label={c.gapPx}
              type="number"
              value={String(isMobileView ? (container.gap_mobile ?? "") : (container.gap ?? 16))}
              onChange={(v) => {
                const t = (v || "").trim();
                if (isMobileView) {
                  if (t === "") onChange({ ...container, gap_mobile: undefined });
                  else onChange({ ...container, gap_mobile: Number(v) || 0 });
                  return;
                }
                onChange({ ...container, gap: Number(v) || 16 });
              }}
              autoComplete="off"
              helpText={isMobileView ? c.gapFallsBackDesktop : undefined}
            />
          </div>
        </BlockStack>
      </Card>

      {source === "images" && (
        <>
          {(container.images || []).map((img, idx) => (
            <Card key={idx}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">{c.imageN(idx + 1)}</Text>
                  {(container.images || []).length > 1 && (
                    <Button size="slim" tone="critical" onClick={() => removeImg(idx)}>{c.remove}</Button>
                  )}
                </InlineStack>
                <ImageField value={gi(img, "url", editLang)} onPick={() => setPickerIdx(idx)} onClear={() => updateImg(idx, "url", "")} />
                <InlineStack gap="400" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField label={c.linkUrlOptional} value={img.link || ""} onChange={(v) => updateImg(idx, "link", v)} placeholder="https://…" autoComplete="off" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select label={c.aspectRatio} options={c.aspectRatioOptions()} value={img.aspect_ratio || "1/1"} onChange={(v) => updateImg(idx, "aspect_ratio", v)} />
                  </div>
                </InlineStack>
                <TextField
                  label={c.captionUnderImage}
                  value={gi(img, "title", editLang)}
                  onChange={(v) => updateImgI18n(idx, "title", v)}
                  autoComplete="off"
                  helpText={c.captionShopHelp}
                />
                <RichTextEditor label={c.textOptional} value={gi(img, "text", editLang)} onChange={(v) => updateImgI18n(idx, "text", v)} placeholder={c.enterText} minHeight="120px" />
                <div style={EDITOR_FIELD_GRID}>
                  <TextField
                    label={c.imageAreaLeft}
                    value={img.cell_padding_left != null ? String(img.cell_padding_left) : ""}
                    onChange={(v) => updateImg(idx, "cell_padding_left", v)}
                    autoComplete="off"
                    placeholder={c.imageAreaPh}
                    helpText={c.imageAreaHelp}
                  />
                  <TextField
                    label={c.imageAreaRight}
                    value={img.cell_padding_right != null ? String(img.cell_padding_right) : ""}
                    onChange={(v) => updateImg(idx, "cell_padding_right", v)}
                    autoComplete="off"
                    placeholder={c.imageAreaPh}
                  />
                  <TextField
                    label={c.imageAreaTop}
                    value={img.cell_padding_top != null ? String(img.cell_padding_top) : ""}
                    onChange={(v) => updateImg(idx, "cell_padding_top", v)}
                    autoComplete="off"
                    placeholder="0"
                  />
                  <TextField
                    label={c.imageAreaBottom}
                    value={img.cell_padding_bottom != null ? String(img.cell_padding_bottom) : ""}
                    onChange={(v) => updateImg(idx, "cell_padding_bottom", v)}
                    autoComplete="off"
                    placeholder="0"
                  />
                </div>
              </BlockStack>
            </Card>
          ))}
          <Button onClick={addImg}>{c.addImage}</Button>
        </>
      )}

      {source === "collection" && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">{c.collectionProductCards}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{c.collectionProductCardsHelp}</Text>
            <Select
              label={c.collection}
              options={colOptions}
              value={container.collection_id || ""}
              onChange={(id) => {
                const col = hubCollections.find((c) => c.id === id);
                onChange({ ...container, collection_id: id, collection_handle: col?.handle || "" });
              }}
            />
            <TextField
              label={c.productCaptions}
              value={String(container.product_captions || "")}
              onChange={(v) => onChange({ ...container, product_captions: v })}
              multiline={5}
              autoComplete="off"
              helpText={c.productCaptionsHelp}
            />
          </BlockStack>
        </Card>
      )}

      {source === "collections" && (
        <BlockStack gap="400">
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">{c.collectionCards}</Text>
            <Select
              label={c.addCollection}
              options={addCollectionOptions}
              value={addColId}
              onChange={(id) => {
                setAddColId(id);
                addCollection(id);
              }}
            />
            <div style={EDITOR_FIELD_GRID}>
              <Select
                label={c.aspectRatioCards}
                options={c.collectionsCarouselAspectOptions()}
                value={aspectValue}
                onChange={(v) => onChange({ ...container, card_aspect_ratio: v })}
              />
              <Select
                label={c.imageInFrame}
                options={c.collectionsCarouselObjectFitOptions()}
                value={container.card_image_object_fit === "contain" ? "contain" : "cover"}
                onChange={(v) => onChange({ ...container, card_image_object_fit: v })}
              />
            </div>
          </BlockStack>
          {chosen.length === 0 ? (
            <Card>
              <Box padding="400">
                <Text as="p" tone="subdued">{c.noCollectionsYet}</Text>
              </Box>
            </Card>
          ) : (
            chosen.map((entry, idx) => (
              <Card key={entry.id || idx}>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">{entry.title || entry.handle || c.collectionN(idx + 1)}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">/{entry.handle || c.withoutHandle}</Text>
                    </BlockStack>
                    <InlineStack gap="200">
                      <Button size="slim" disabled={idx === 0} onClick={() => moveCollection(idx, -1)}>{c.moveUp}</Button>
                      <Button size="slim" disabled={idx === chosen.length - 1} onClick={() => moveCollection(idx, 1)}>{c.moveDown}</Button>
                      <Button size="slim" tone="critical" onClick={() => removeCollection(entry.id)}>{c.remove}</Button>
                    </InlineStack>
                  </InlineStack>
                  <TextField
                    label={c.captionUnderCard}
                    value={entry.item_heading != null ? String(entry.item_heading) : ""}
                    onChange={(v) => updateMosaicCollectionEntry(idx, "item_heading", v)}
                    autoComplete="off"
                    helpText={c.captionUnderCardBannerHelp}
                  />
                </BlockStack>
              </Card>
            ))
          )}
        </BlockStack>
      )}
    </BlockStack>
  );
}

// ── Image Carousel editor ───────────────────────────────────────────────────
function ImageCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const [pickerIdx, setPickerIdx] = useState(null);
  const images = container.images || [];
  const n = images.length;

  const updateImg = (idx, key, val) => {
    const next = [...(container.images || [])];
    next[idx] = key === "url" ? si(next[idx], "url", editLang, val) : { ...next[idx], [key]: val };
    onChange({ ...container, images: next });
  };
  const updateImgI18n = (idx, field, val) => {
    const next = [...(container.images || [])];
    next[idx] = si(next[idx], field, editLang, val);
    onChange({ ...container, images: next });
  };
  const newSlide = () => ({
    url: "",
    link: "",
    title: "",
    text: "",
  });
  const addImg = () => {
    const list = [...(container.images || []), newSlide()];
    onChange({ ...container, images: list });
  };
  const removeImg = (idx) => {
    const next = (container.images || []).filter((_, i) => i !== idx);
    onChange({ ...container, images: next });
  };
  const moveImg = (idx, dir) => {
    const next = [...(container.images || [])];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...container, images: next });
  };

  return (
    <BlockStack gap="400">
      {pickerIdx !== null && (
        <MediaPickerModal open multiple={false} onClose={() => setPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateImg(pickerIdx, "url", urls[0]); setPickerIdx(null); }} />
      )}

      <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">{c.imagesAndGrid}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{c.imagesAndGridHelp}</Text>
            <TextField label={c.sectionTitleOptional} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" placeholder={c.sectionTitlePh} />
            <div style={EDITOR_FIELD_GRID}>
              {!isMobileView && (
                <TextField
                  label={c.imagesPerRowDesktop}
                  type="number"
                  value={String(container.items_per_row || 4)}
                  onChange={(v) => onChange({ ...container, items_per_row: Number(v) || 4 })}
                  autoComplete="off"
                />
              )}
              {isMobileView ? (
                <>
                  <TextField
                    label={c.mobileImageWidth}
                    value={container.mobile_item_width != null ? String(container.mobile_item_width) : ""}
                    onChange={(v) => onChange({ ...container, mobile_item_width: v })}
                    autoComplete="off"
                    placeholder={c.mobileImageWidthPh}
                    helpText={c.mobileImageWidthHelp}
                  />
                  <Select
                    label={c.imageOrientation}
                    options={c.imageCarouselAspectOptions()}
                    value={container.aspect_ratio_mobile != null && container.aspect_ratio_mobile !== "" ? container.aspect_ratio_mobile : ""}
                    onChange={(v) => onChange({ ...container, aspect_ratio_mobile: v })}
                  />
                  <TextField
                    label={c.customRatioOptional}
                    value={container.aspect_ratio_mobile_custom != null ? String(container.aspect_ratio_mobile_custom) : ""}
                    onChange={(v) => onChange({ ...container, aspect_ratio_mobile_custom: v })}
                    autoComplete="off"
                    placeholder={c.customRatioPhMobile}
                  />
                  <TextField
                    label={c.minHeightOptional}
                    value={container.min_height_mobile != null ? String(container.min_height_mobile) : ""}
                    onChange={(v) => onChange({ ...container, min_height_mobile: v })}
                    autoComplete="off"
                    placeholder={c.minHeightPh}
                  />
                  <TextField
                    label={c.maxHeightOptional}
                    value={container.max_height_mobile != null ? String(container.max_height_mobile) : ""}
                    onChange={(v) => onChange({ ...container, max_height_mobile: v })}
                    autoComplete="off"
                    placeholder={c.maxHeightPhMobile}
                  />
                </>
              ) : (
                <>
                  <Select
                    label={c.imageOrientation}
                    options={c.imageCarouselAspectOptions()}
                    value={container.aspect_ratio || "4/5"}
                    onChange={(v) => onChange({ ...container, aspect_ratio: v })}
                  />
                  <TextField
                    label={c.customRatioOptional}
                    value={container.aspect_ratio_custom != null ? String(container.aspect_ratio_custom) : ""}
                    onChange={(v) => onChange({ ...container, aspect_ratio_custom: v })}
                    autoComplete="off"
                    placeholder={c.customRatioPhDesktop}
                  />
                  <TextField
                    label={c.maxHeightOptional}
                    value={container.max_height != null ? String(container.max_height) : ""}
                    onChange={(v) => onChange({ ...container, max_height: v })}
                    autoComplete="off"
                    placeholder={c.maxHeightPhDesktop}
                  />
                </>
              )}
            </div>
            <Button onClick={addImg}>{c.addImage}</Button>
          </BlockStack>
      </Card>

      <Card>
          {n === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued" variant="bodySm">{c.noImagesYet}</Text>
            </Box>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
              {images.map((img, idx) => (
                <Card key={idx}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">{c.imageN(idx + 1)}</Text>
                      <InlineStack gap="200">
                        <Button size="slim" disabled={idx === 0} onClick={() => moveImg(idx, -1)}>↑</Button>
                        <Button size="slim" disabled={idx === n - 1} onClick={() => moveImg(idx, 1)}>↓</Button>
                        {n > 1 && (
                          <Button size="slim" tone="critical" onClick={() => removeImg(idx)}>{c.remove}</Button>
                        )}
                      </InlineStack>
                    </InlineStack>
                    <ImageField value={gi(img, "url", editLang)} onPick={() => setPickerIdx(idx)} onClear={() => updateImg(idx, "url", "")} />
                    <TextField
                      label={c.linkOptional}
                      value={img.link || ""}
                      onChange={(v) => updateImg(idx, "link", v)}
                      placeholder="https://…"
                      autoComplete="off"
                    />
                    <TextField
                      label={c.captionUnderImage}
                      value={gi(img, "title", editLang)}
                      onChange={(v) => updateImgI18n(idx, "title", v)}
                      autoComplete="off"
                    />
                    <RichTextEditor
                      label={c.textOptional}
                      value={gi(img, "text", editLang)}
                      onChange={(v) => updateImgI18n(idx, "text", v)}
                      placeholder={c.enterText}
                      minHeight="120px"
                    />
                    <div style={EDITOR_FIELD_GRID}>
                      <TextField
                        label={c.imageAreaLeft}
                        value={img.cell_padding_left != null ? String(img.cell_padding_left) : ""}
                        onChange={(v) => updateImg(idx, "cell_padding_left", v)}
                        autoComplete="off"
                        placeholder={c.imageAreaPh}
                        helpText={c.imageAreaHelp}
                      />
                      <TextField
                        label={c.imageAreaRight}
                        value={img.cell_padding_right != null ? String(img.cell_padding_right) : ""}
                        onChange={(v) => updateImg(idx, "cell_padding_right", v)}
                        autoComplete="off"
                        placeholder={c.imageAreaPh}
                      />
                      <TextField
                        label={c.imageAreaTop}
                        value={img.cell_padding_top != null ? String(img.cell_padding_top) : ""}
                        onChange={(v) => updateImg(idx, "cell_padding_top", v)}
                        autoComplete="off"
                        placeholder="0"
                      />
                      <TextField
                        label={c.imageAreaBottom}
                        value={img.cell_padding_bottom != null ? String(img.cell_padding_bottom) : ""}
                        onChange={(v) => updateImg(idx, "cell_padding_bottom", v)}
                        autoComplete="off"
                        placeholder="0"
                      />
                    </div>
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">{c.headerGradientHelp}</Text>
                    <ColorField
                      label={c.gradientColor}
                      value={img.color || ""}
                      onChange={(v) => updateImg(idx, "color", v)}
                    />
                    {img.color && (
                      <>
                        <Select
                          label={c.gradientDirection}
                          options={c.gradientDirectionOptions()}
                          value={img.gradient_direction || "to bottom"}
                          onChange={(v) => updateImg(idx, "gradient_direction", v)}
                        />
                        <TextField
                          label={c.gradientStop}
                          value={img.gradient_stop != null ? String(img.gradient_stop) : ""}
                          onChange={(v) => updateImg(idx, "gradient_stop", v)}
                          autoComplete="off"
                          placeholder={c.gradientStopPh}
                          helpText={c.gradientStopHelp}
                        />
                      </>
                    )}
                  </BlockStack>
                </Card>
              ))}
            </div>
          )}
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">CTA button</Text>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <TextField
                label={c.buttonText}
                value={gi(container, "btn_text", editLang)}
                onChange={(v) => onChange(si(container, "btn_text", editLang, v))}
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                label={c.buttonUrl}
                value={container.btn_url || ""}
                onChange={(v) => onChange({ ...container, btn_url: v })}
                autoComplete="off"
              />
            </div>
          </InlineStack>

          <Select
            label={c.buttonStyle}
            options={c.buttonVariantOptions()}
            value={container.btn_variant || "seller_brass"}
            onChange={(v) => onChange({ ...container, btn_variant: v })}
          />

          <div style={EDITOR_FIELD_GRID}>
            <ColorField label={c.buttonBg} value={container.btn_bg || "#ff971c"} onChange={(v) => onChange({ ...container, btn_bg: v })} />
            <ColorField label={c.buttonTextColor} value={container.btn_color || "#fff"} onChange={(v) => onChange({ ...container, btn_color: v })} />
          </div>
          <div style={EDITOR_FIELD_GRID}>
            <ColorField label={c.buttonHoverBg} value={container.btn_hover_bg || container.btn_bg || "#e8860f"} onChange={(v) => onChange({ ...container, btn_hover_bg: v })} />
            <ColorField label={c.buttonHoverColor} value={container.btn_hover_color || container.btn_color || "#fff"} onChange={(v) => onChange({ ...container, btn_hover_color: v })} />
          </div>
          <div style={EDITOR_FIELD_GRID}>
            <TextField
              label={`${c.buttonBorder} (CSS)`}
              value={container.btn_border || "2px solid #000"}
              onChange={(v) => onChange({ ...container, btn_border: v })}
              autoComplete="off"
              helpText={c.egNone}
            />
            <TextField
              label={c.buttonRadius}
              value={String(container.btn_radius ?? 8)}
              onChange={(v) => onChange({ ...container, btn_radius: Number(v) || 0 })}
              autoComplete="off"
              helpText={c.pxUnit}
            />
          </div>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// ── CTA Banner editor ───────────────────────────────────────────────────────
function BannerCtaEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  return (
    <BlockStack gap="400">
      <TextField label={c.heading} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <TextField label={c.subtitle} value={gi(container, "subtitle", editLang)} onChange={(v) => onChange(si(container, "subtitle", editLang, v))} autoComplete="off" />
      <TextField label={c.eyebrow} value={gi(container, "eyebrow", editLang)} onChange={(v) => onChange(si(container, "eyebrow", editLang, v))} autoComplete="off" />
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonText} value={gi(container, "btn_text", editLang)} onChange={(v) => onChange(si(container, "btn_text", editLang, v))} autoComplete="off" />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label={c.buttonUrl} value={container.btn_url || ""} onChange={(v) => onChange({ ...container, btn_url: v })} autoComplete="off" />
        </div>
      </InlineStack>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 2 }}>
          <Select label={c.textPosition} options={c.textPositionOptions()} value={container.text_position || "center"} onChange={(v) => onChange({ ...container, text_position: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.backgroundColor} value={container.bg_color || "#ff971c"} onChange={(v) => onChange({ ...container, bg_color: v })} />
        </div>
        <div style={{ flex: 1 }}>
          <ColorField label={c.textColor} value={container.text_color || "#ffffff"} onChange={(v) => onChange({ ...container, text_color: v })} />
        </div>
      </InlineStack>
      <Text as="p" variant="bodySm" tone="subdued">{c.ctaBannerPaddingHint}</Text>
      <div style={EDITOR_FIELD_GRID}>
        <ColorField label={c.buttonBg} value={container.btn_bg || "#ffffff"} onChange={(v) => onChange({ ...container, btn_bg: v })} />
        <ColorField label={c.buttonTextColor} value={container.btn_color || "#111827"} onChange={(v) => onChange({ ...container, btn_color: v })} />
        <TextField label={`${c.buttonBorder} (CSS)`} value={container.btn_border || "2px solid #000"} onChange={(v) => onChange({ ...container, btn_border: v })} autoComplete="off" />
        <TextField label={c.buttonRadius} value={String(container.btn_radius ?? 8)} onChange={(v) => onChange({ ...container, btn_radius: Number(v) || 0 })} autoComplete="off" />
      </div>
    </BlockStack>
  );
}

// ── Collection Carousel editor ──────────────────────────────────────────────
function CollectionCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const client = getMedusaAdminClient();
  const [collections, setCollections] = useState([]);

  useEffect(() => {
    client.request("/admin-hub/collections").then((r) => {
      setCollections(Array.isArray(r?.collections) ? r.collections : []);
    }).catch(() => {});
  }, []);

  const colOptions = [
    { label: c.chooseCollection, value: "" },
    ...collections.map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
  ];

  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <Select
        label={c.collection}
        options={colOptions}
        value={container.collection_id || ""}
        onChange={(id) => {
          const col = collections.find((c) => c.id === id);
          onChange({ ...container, collection_id: id, collection_handle: col?.handle || "" });
        }}
      />
      <TextField
        label={c.productCaptions}
        value={String(container.product_captions || "")}
        onChange={(v) => onChange({ ...container, product_captions: v })}
        multiline={5}
        autoComplete="off"
        helpText={c.productCaptionsHelpShort}
      />
      <div style={EDITOR_FIELD_GRID}>
        <Select
          label={c.productsPerRow}
          options={(isMobileView ? [1, 2, 3, 4] : [2, 3, 4, 5, 6]).map((n) => ({ label: String(n), value: String(n) }))}
          value={String(isMobileView ? (container.items_per_row_mobile ?? 2) : (container.items_per_row || 4))}
          onChange={(v) => onChange({
            ...container,
            ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }),
          })}
        />
        <TextField
          label={c.cardGapPx}
          type="number"
          value={String(container.gap ?? 16)}
          onChange={(v) => onChange({ ...container, gap: Number(v) || 16 })}
          autoComplete="off"
        />
      </div>
      {isMobileView && (
        <>
          <Divider />
          <Text as="h3" variant="headingSm">{c.mobileViewport}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.display}
              options={c.mobileCarouselLayoutOptions()}
              value={container.mobile_layout === "grid" ? "grid" : "row"}
              onChange={(v) => onChange({ ...container, mobile_layout: v === "grid" ? "grid" : "row" })}
            />
            <Select
              label={c.gridCols}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_cols)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_cols: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
            <Select
              label={c.gridRows}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_rows)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_rows: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
          </div>
        </>
      )}
    </BlockStack>
  );
}

function BestsellerCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const client = getMedusaAdminClient();
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    client.getAdminHubCategories({ all: true }).then((r) => {
      const flat = [];
      function flatten(list) {
        (list || []).forEach((c) => {
          flat.push(c);
          if (c.children?.length) flatten(c.children);
        });
      }
      flatten(Array.isArray(r?.categories) ? r.categories : (Array.isArray(r) ? r : []));
      setCategories(flat);
    }).catch(() => {});
  }, []);

  // Backward-compat: if category_id missing but category_slug set, derive ID from slug
  const resolvedCategoryId = useMemo(() => {
    if (container.category_id) return container.category_id;
    if (!container.category_slug || !categories.length) return "";
    const match = categories.find((c) => (c.slug || c.handle || "") === container.category_slug);
    return match?.id || "";
  }, [container.category_id, container.category_slug, categories]);

  const handleCategoryChange = (id) => {
    const cat = categories.find((c) => c.id === id);
    onChange({ ...container, category_id: id || "", category_slug: cat?.slug || cat?.handle || "" });
  };

  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <Select
        label={c.carouselModeLabel}
        options={[
          { label: c.carouselModeBestseller, value: "bestseller" },
          { label: c.carouselModeSale, value: "sale" },
        ]}
        value={container.mode === "sale" ? "sale" : "bestseller"}
        onChange={(v) => onChange({ ...container, mode: v })}
        helpText={container.mode === "sale" ? c.carouselModeSaleHelp : c.carouselModeBestsellerHelp}
      />
      <div>
        <CategoryDrilldownSelect
          label={c.category}
          categories={categories}
          value={resolvedCategoryId}
          onChange={handleCategoryChange}
          noneLabel={c.chooseCategory}
          placeholder={c.chooseCategoryPh}
        />
        <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>{c.bestsellerCategoryHelp}</div>
      </div>
      <div style={EDITOR_FIELD_GRID}>
        <Select
          label={c.productsPerRow}
          options={(isMobileView ? [1, 2, 3, 4] : [2, 3, 4, 5, 6]).map((n) => ({ label: String(n), value: String(n) }))}
          value={String(isMobileView ? (container.items_per_row_mobile ?? 2) : (container.items_per_row || 4))}
          onChange={(v) => onChange({
            ...container,
            ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }),
          })}
        />
        <TextField
          label={c.cardGapPx}
          type="number"
          value={String(container.gap ?? 16)}
          onChange={(v) => onChange({ ...container, gap: Number(v) || 16 })}
          autoComplete="off"
        />
      </div>
      {isMobileView && (
        <>
          <Divider />
          <Text as="h3" variant="headingSm">{c.mobileViewport}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.display}
              options={c.mobileCarouselLayoutOptions()}
              value={container.mobile_layout === "grid" ? "grid" : "row"}
              onChange={(v) => onChange({ ...container, mobile_layout: v === "grid" ? "grid" : "row" })}
            />
            <Select
              label={c.gridCols}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_cols)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_cols: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
            <Select
              label={c.gridRows}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_rows)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_rows: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
          </div>
        </>
      )}
    </BlockStack>
  );
}

function CategorySidebarEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <Text as="p" variant="bodySm" tone="subdued">{c.categorySidebarHelp}</Text>
    </BlockStack>
  );
}

function BrandsDirectoryEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <div style={EDITOR_FIELD_GRID}>
        <Select
          label={c.productsPerRow}
          options={(isMobileView ? [1, 2, 3, 4] : [2, 3, 4, 5, 6]).map((n) => ({ label: String(n), value: String(n) }))}
          value={String(isMobileView ? (container.items_per_row_mobile ?? 2) : (container.items_per_row || 5))}
          onChange={(v) => onChange({ ...container, ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }) })}
        />
        <TextField
          label={c.cardGapPx}
          type="number"
          value={String(container.gap ?? 14)}
          onChange={(v) => onChange({ ...container, gap: Number(v) || 14 })}
          autoComplete="off"
        />
        <TextField
          label="Max. rows"
          type="number"
          value={String(container.max_rows ?? 10)}
          onChange={(v) => onChange({ ...container, max_rows: Math.max(1, Math.min(20, Number(v) || 10)) })}
          autoComplete="off"
          helpText="Desktop: columns x rows (default 5x10 = 50 brands)"
        />
      </div>
    </BlockStack>
  );
}

function SellerCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <div style={EDITOR_FIELD_GRID}>
        <Select
          label={c.productsPerRow}
          options={(isMobileView ? [1, 2, 3, 4] : [2, 3, 4, 5, 6]).map((n) => ({ label: String(n), value: String(n) }))}
          value={String(isMobileView ? (container.items_per_row_mobile ?? 2) : (container.items_per_row || 4))}
          onChange={(v) => onChange({ ...container, ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }) })}
        />
        <TextField
          label={c.cardGapPx}
          type="number"
          value={String(container.gap ?? 16)}
          onChange={(v) => onChange({ ...container, gap: Number(v) || 16 })}
          autoComplete="off"
        />
        <TextField
          label="Max. Sellers"
          type="number"
          value={String(container.limit ?? 20)}
          onChange={(v) => onChange({ ...container, limit: Math.max(1, Number(v) || 20) })}
          autoComplete="off"
        />
      </div>
    </BlockStack>
  );
}

function CollectionsCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const client = getMedusaAdminClient();
  const [collections, setCollections] = useState([]);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    client.getMedusaCollections({ adminHub: true })
      .then((r) => {
        setCollections(Array.isArray(r?.collections) ? r.collections : []);
      })
      .catch(() => {});
  }, [client]);

  const chosen = Array.isArray(container.collections) ? container.collections : [];
  const availableOptions = [
    { label: c.chooseCollectionAdd, value: "" },
    ...collections
      .filter((c) => !chosen.some((entry) => entry.id === c.id))
      .map((c) => ({ label: c.title || c.handle || c.id, value: c.id })),
  ];

  const addCollection = (id) => {
    if (!id) return;
    const col = collections.find((c) => c.id === id);
    if (!col) return;
    onChange({
      ...container,
      collections: [
        ...chosen,
        {
          id: col.id,
          title: col.title || "",
          handle: col.handle || "",
          image: col.image_url || col.image || col.thumbnail || "",
          item_heading: "",
        },
      ],
    });
    setSelectedId("");
  };

  const removeCollection = (id) => {
    onChange({
      ...container,
      collections: chosen.filter((entry) => entry.id !== id),
    });
  };

  const moveCollection = (idx, direction) => {
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= chosen.length) return;
    const next = [...chosen];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    onChange({ ...container, collections: next });
  };

  const updateListCollectionEntry = (idx, key, val) => {
    const next = chosen.map((e, i) => (i === idx ? { ...e, [key]: val } : e));
    onChange({ ...container, collections: next });
  };

  const aspectValue = (() => {
    const raw = String(container.card_aspect_ratio || "4/5").trim().replace(/:/g, "/");
    const ok = c.collectionsCarouselAspectOptions().some((o) => o.value === raw);
    return ok ? raw : "4/5";
  })();

  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <Select
        label={c.addCollection}
        options={availableOptions}
        value={selectedId}
        onChange={(id) => {
          setSelectedId(id);
          addCollection(id);
        }}
      />
      <InlineStack gap="400" wrap>
        <div style={{ flex: "1 1 200px", minWidth: 160 }}>
          <Select
            label={c.cardsPerRow}
            options={(isMobileView ? [1, 2, 3, 4] : [2, 3, 4, 5, 6]).map((n) => ({ label: String(n), value: String(n) }))}
            value={String(isMobileView ? (container.items_per_row_mobile ?? 2) : (container.items_per_row || 4))}
            onChange={(v) => onChange({
              ...container,
              ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }),
            })}
          />
        </div>
      </InlineStack>
      <div style={EDITOR_FIELD_GRID}>
        <TextField
          label={c.cardGapPx}
          type="number"
          value={String(container.gap ?? 16)}
          onChange={(v) => onChange({ ...container, gap: Number(v) || 16 })}
          autoComplete="off"
        />
      </div>
      {isMobileView && (
        <>
          <Divider />
          <Text as="h3" variant="headingSm">{c.mobileViewport}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.display}
              options={c.mobileCarouselLayoutOptions()}
              value={container.mobile_layout === "grid" ? "grid" : "row"}
              onChange={(v) => onChange({ ...container, mobile_layout: v === "grid" ? "grid" : "row" })}
            />
            <Select
              label={c.gridCols}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_cols)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_cols: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
            <Select
              label={c.gridRows}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(Math.min(4, Math.max(1, Math.round(Number(container.mobile_grid_rows)) || 2)))}
              onChange={(v) => onChange({ ...container, mobile_grid_rows: Number(v) })}
              disabled={container.mobile_layout !== "grid"}
            />
          </div>
        </>
      )}
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">{c.collectionCardsDisplay}</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {c.collectionCardsDisplayHelp}
        </Text>
        <Select
          label={c.aspectRatioPortraitSquareLandscape}
          options={c.collectionsCarouselAspectOptions()}
          value={aspectValue}
          onChange={(v) => onChange({ ...container, card_aspect_ratio: v })}
        />
        <Select
          label={c.imageInFrame}
          options={c.collectionsCarouselObjectFitOptions()}
          value={container.card_image_object_fit === "contain" ? "contain" : "cover"}
          onChange={(v) => onChange({ ...container, card_image_object_fit: v })}
        />
      </BlockStack>

      {chosen.length === 0 ? (
        <Card>
          <Box padding="400">
            <Text as="p" tone="subdued">{c.noCollectionsSelected}</Text>
          </Box>
        </Card>
      ) : chosen.map((entry, idx) => (
        <Card key={entry.id || idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">{entry.title || entry.handle || c.collectionN(idx + 1)}</Text>
                <Text as="p" variant="bodySm" tone="subdued">/{entry.handle || c.withoutHandle}</Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveCollection(idx, -1)}>{c.moveUp}</Button>
                <Button size="slim" disabled={idx === chosen.length - 1} onClick={() => moveCollection(idx, 1)}>{c.moveDown}</Button>
                <Button size="slim" tone="critical" onClick={() => removeCollection(entry.id)}>{c.remove}</Button>
              </InlineStack>
            </InlineStack>
            <TextField
              label={c.captionUnderCard}
              value={entry.item_heading != null ? String(entry.item_heading) : ""}
              onChange={(v) => updateListCollectionEntry(idx, "item_heading", v)}
              autoComplete="off"
              helpText={c.captionShopHelp}
            />
          </BlockStack>
        </Card>
      ))}
    </BlockStack>
  );
}

// ── Accordion editor ─────────────────────────────────────────────────────────
function AccordionEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const items = container.items || [];

  const updateItem = (idx, key, val) => {
    const next = items.map((item, i) => i === idx ? { ...item, [key]: val } : item);
    onChange({ ...container, items: next });
  };

  const updateItemI18n = (idx, field, val) => {
    const next = items.map((item, i) => i === idx ? si(item, field, editLang, val) : item);
    onChange({ ...container, items: next });
  };
  const addItem = () => onChange({ ...container, items: [...items, { question: `Frage ${items.length + 1}`, answer: "" }] });
  const removeItem = (idx) => onChange({ ...container, items: items.filter((_, i) => i !== idx) });
  const moveItem = (idx, dir) => {
    const next = [...items];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...container, items: next });
  };

  return (
    <BlockStack gap="400">
      {/* Global settings */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.accordionSettings}</Text>
          <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
          <TextField label={c.eyebrow} value={gi(container, "eyebrow", editLang)} onChange={(v) => onChange(si(container, "eyebrow", editLang, v))} autoComplete="off" helpText={c.optional} />
          <Select label={c.layoutVariant} options={c.accordionThemeOptions()} value={container.variant || container.theme || "light"} onChange={(v) => onChange({ ...container, variant: v, theme: v })} />
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}><TextField label={c.buttonText} value={gi(container, "btn_text", editLang)} onChange={(v) => onChange(si(container, "btn_text", editLang, v))} autoComplete="off" /></div>
            <div style={{ flex: 1 }}><TextField label={c.buttonUrl} value={container.btn_url || ""} onChange={(v) => onChange({ ...container, btn_url: v })} autoComplete="off" /></div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <Select
                label={c.buttonStyle}
                options={c.buttonVariantOptions()}
                value={container.btn_variant || "seller_brass"}
                onChange={(v) => onChange({ ...container, btn_variant: v })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <ColorField
                label={c.buttonBg}
                value={container.btn_bg || "#ff971c"}
                onChange={(v) => onChange({ ...container, btn_bg: v })}
              />
            </div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <ColorField
                label={c.buttonTextColor}
                value={container.btn_color || "#fff"}
                onChange={(v) => onChange({ ...container, btn_color: v })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <ColorField
                label={c.buttonHoverBg}
                value={container.btn_hover_bg || container.btn_bg || "#e8860f"}
                onChange={(v) => onChange({ ...container, btn_hover_bg: v })}
              />
            </div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <ColorField
                label={c.buttonHoverColor}
                value={container.btn_hover_color || container.btn_color || "#fff"}
                onChange={(v) => onChange({ ...container, btn_hover_color: v })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <TextField
                label={`${c.buttonBorder} (CSS)`}
                value={container.btn_border || "2px solid #000"}
                onChange={(v) => onChange({ ...container, btn_border: v })}
                autoComplete="off"
                helpText={c.egNone}
              />
            </div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <TextField
                label={c.buttonRadius}
                value={String(container.btn_radius ?? 8)}
                onChange={(v) => onChange({ ...container, btn_radius: Number(v) || 0 })}
                autoComplete="off"
                helpText={c.pxUnit}
              />
            </div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}><ColorField label={c.backgroundColor} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} /></div>
            <div style={{ flex: 1 }}><ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} /></div>
            <div style={{ flex: 1 }}><ColorField label={c.borderColor} value={container.border_color || "#e5e7eb"} onChange={(v) => onChange({ ...container, border_color: v })} /></div>
            <div style={{ flex: 1 }}><ColorField label={c.iconColor} value={container.icon_color || "#111827"} onChange={(v) => onChange({ ...container, icon_color: v })} /></div>
          </InlineStack>
        </BlockStack>
      </Card>

      {/* Items */}
      {items.map((item, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.entryN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveItem(idx, -1)}>↑</Button>
                <Button size="slim" disabled={idx === items.length - 1} onClick={() => moveItem(idx, 1)}>↓</Button>
                {items.length > 1 && <Button size="slim" tone="critical" onClick={() => removeItem(idx)}>{c.remove}</Button>}
              </InlineStack>
            </InlineStack>
            <TextField label={c.questionTitle} value={gi(item, "question", editLang)} onChange={(v) => updateItemI18n(idx, "question", v)} autoComplete="off" />
            <div>
              <Text as="span" variant="bodyMd" fontWeight="medium">{c.answerContent}</Text>
              <Box paddingBlockStart="100">
                <RichTextEditor value={gi(item, "answer", editLang)} onChange={(v) => updateItemI18n(idx, "answer", v)} />
              </Box>
            </div>
          </BlockStack>
        </Card>
      ))}

      <InlineStack>
        <Button onClick={addItem}>{c.addEntry}</Button>
      </InlineStack>
    </BlockStack>
  );
}

// ── Tabs editor ───────────────────────────────────────────────────────────────
function TabsEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const tabs = container.tabs || [];

  const updateTab = (idx, key, val) => {
    const next = tabs.map((tab, i) => i === idx ? { ...tab, [key]: val } : tab);
    onChange({ ...container, tabs: next });
  };

  const updateTabI18n = (idx, field, val) => {
    const next = tabs.map((tab, i) => i === idx ? si(tab, field, editLang, val) : tab);
    onChange({ ...container, tabs: next });
  };
  const addTab = () => onChange({ ...container, tabs: [...tabs, { label: `Tab ${tabs.length + 1}`, content: "" }] });
  const removeTab = (idx) => onChange({ ...container, tabs: tabs.filter((_, i) => i !== idx) });
  const moveTab = (idx, dir) => {
    const next = [...tabs];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...container, tabs: next });
  };

  return (
    <BlockStack gap="400">
      {/* Global settings */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.tabSettings}</Text>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <Select
                label={c.tabStyle}
                options={c.tabStyleOptions()}
                value={container.tab_style || "underline"}
                onChange={(v) => onChange({ ...container, tab_style: v })}
              />
            </div>
            <div style={{ flex: 1 }}><ColorField label={c.activeColor} value={container.active_color || "#ff971c"} onChange={(v) => onChange({ ...container, active_color: v })} /></div>
            <div style={{ flex: 1 }}><ColorField label={c.tabBackground} value={container.tab_bg || "#f3f4f6"} onChange={(v) => onChange({ ...container, tab_bg: v })} /></div>
          </InlineStack>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}><ColorField label={c.pageBackground} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} /></div>
            <div style={{ flex: 1 }}><ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} /></div>
          </InlineStack>
        </BlockStack>
      </Card>

      {/* Tabs */}
      {tabs.map((tab, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.tabN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveTab(idx, -1)}>↑</Button>
                <Button size="slim" disabled={idx === tabs.length - 1} onClick={() => moveTab(idx, 1)}>↓</Button>
                {tabs.length > 1 && <Button size="slim" tone="critical" onClick={() => removeTab(idx)}>{c.remove}</Button>}
              </InlineStack>
            </InlineStack>
            <TextField label={c.tabLabel} value={gi(tab, "label", editLang)} onChange={(v) => updateTabI18n(idx, "label", v)} autoComplete="off" placeholder={c.tabLabelPh} />
            <div>
              <Text as="span" variant="bodyMd" fontWeight="medium">{c.content}</Text>
              <Box paddingBlockStart="100">
                <RichTextEditor value={gi(tab, "content", editLang)} onChange={(v) => updateTabI18n(idx, "content", v)} />
              </Box>
            </div>
          </BlockStack>
        </Card>
      ))}

      <InlineStack>
        <Button onClick={addTab}>{c.addTabBtn}</Button>
      </InlineStack>
    </BlockStack>
  );
}

function SingleProductEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const client = getMedusaAdminClient();
  const [products, setProducts] = useState([]);

  useEffect(() => {
    client.getAdminHubProducts({ limit: 500 }).then((r) => {
      setProducts(Array.isArray(r?.products) ? r.products : []);
    }).catch(() => {});
  }, [client]);

  const opts = [
    { label: c.chooseProduct, value: "" },
    ...products.map((p) => ({ label: `${p.title || p.handle || p.id}`, value: p.id })),
  ];

  return (
    <BlockStack gap="400">
      <TextField label={`${c.heading} ${c.optional}`} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <Select
        label={c.product}
        options={opts}
        value={container.product_id || ""}
        onChange={(id) => {
          const pr = products.find((p) => p.id === id);
          onChange({
            ...container,
            product_id: id,
            product_handle: pr?.handle || "",
          });
        }}
      />
      <Text as="p" variant="bodySm" tone="subdued">
        {c.singleProductHelp}
      </Text>
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}><ColorField label={c.background} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} /></div>
        <div style={{ flex: 1 }}><ColorField label={c.titleColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} /></div>
      </InlineStack>
    </BlockStack>
  );
}

function BlogCarouselEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const client = getMedusaAdminClient();
  const posts = Array.isArray(container.posts) ? container.posts : [];
  const [blogPages, setBlogPages] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await client.getPages({ limit: 200, page_type: "blog" });
        if (!cancelled) setBlogPages(data.pages || []);
      } catch {
        if (!cancelled) setBlogPages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const blogOptions = [
    { label: c.chooseBlogPost, value: "" },
    ...blogPages.map((p) => ({
      label: `${p.title || p.slug || p.id}${p.status === "published" ? "" : ` ${c.draftSuffix}`}`,
      value: String(p.id),
    })),
  ];

  const updatePost = (idx, key, val) => {
    const next = posts.map((p, i) => (i === idx ? { ...p, [key]: val } : p));
    onChange({ ...container, posts: next });
  };
  const addPost = () => {
    onChange({
      ...container,
      posts: [...posts, { id: Math.random().toString(36).slice(2), page_id: "" }],
    });
  };
  const removePost = (idx) => onChange({ ...container, posts: posts.filter((_, i) => i !== idx) });
  const movePost = (idx, dir) => {
    const next = [...posts];
    const t = idx + dir;
    if (t < 0 || t >= next.length) return;
    [next[idx], next[t]] = [next[t], next[idx]];
    onChange({ ...container, posts: next });
  };

  const resolveBlogPage = (pageId) => blogPages.find((p) => String(p.id) === String(pageId));

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.carousel}</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {c.blogCarouselHelp}
          </Text>
          <TextField label={c.sectionTitle} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
          <div style={EDITOR_FIELD_GRID}>
            <Select
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              label={c.cardsPerRow}
              value={String(isMobileView ? (container.items_per_row_mobile ?? 1) : (container.items_per_row || 3))}
              onChange={(v) => onChange({
                ...container,
                ...(isMobileView ? { items_per_row_mobile: Number(v) } : { items_per_row: Number(v) }),
              })}
            />
            <ColorField label={c.background} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
            <ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} />
          </div>
        </BlockStack>
      </Card>

      {posts.map((post, idx) => {
        const bp = post.page_id ? resolveBlogPage(post.page_id) : null;
        const legacy = !post.page_id && (post.title || post.image || post.body);
        return (
          <Card key={post.id || idx}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">{c.cardN(idx + 1)}</Text>
                <InlineStack gap="200">
                  <Button size="slim" disabled={idx === 0} onClick={() => movePost(idx, -1)}>↑</Button>
                  <Button size="slim" disabled={idx === posts.length - 1} onClick={() => movePost(idx, 1)}>↓</Button>
                  {posts.length > 1 && <Button size="slim" tone="critical" onClick={() => removePost(idx)}>{c.remove}</Button>}
                </InlineStack>
              </InlineStack>
              <Select
                label={c.blogPost}
                options={blogOptions}
                value={post.page_id ? String(post.page_id) : ""}
                onChange={(v) => updatePost(idx, "page_id", v)}
              />
              {legacy && (
                <Banner tone="warning">
                  {c.legacyEntryBanner}
                </Banner>
              )}
              {bp && (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm"><strong>{c.previewLabel}</strong> {bp.title} · /pages/{bp.slug}</Text>
                    {bp.meta_title ? <Text as="p" variant="bodySm" tone="subdued">{c.seoTitleLabel} {bp.meta_title}</Text> : null}
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Card>
        );
      })}

      <InlineStack>
        <Button onClick={addPost}>{c.addBlogCard}</Button>
      </InlineStack>
    </BlockStack>
  );
}

function NewsletterEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const hidden = Array.isArray(container.hidden_fields) ? container.hidden_fields : [];

  const setHidden = (next) => onChange({ ...container, hidden_fields: next });
  const updateHidden = (idx, key, val) => {
    const next = hidden.map((h, i) => (i === idx ? { ...h, [key]: val } : h));
    setHidden(next);
  };
  const addHidden = () => setHidden([...hidden, { name: "", value: "" }]);
  const removeHidden = (idx) => setHidden(hidden.filter((_, i) => i !== idx));

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        {c.newsletterBanner}
      </Banner>
      <TextField label={c.title} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
      <TextField label={c.subtitle} value={gi(container, "subtitle", editLang)} onChange={(v) => onChange(si(container, "subtitle", editLang, v))} multiline={2} autoComplete="off" />
      <TextField label={c.buttonText} value={gi(container, "button_text", editLang)} onChange={(v) => onChange(si(container, "button_text", editLang, v))} autoComplete="off" />
      <InlineStack gap="300" wrap={false}>
        <div style={{ flex: 1 }}>
          <TextField
            label={c.firstNamePlaceholder}
            value={gi(container, "first_name_placeholder", editLang)}
            onChange={(v) => onChange(si(container, "first_name_placeholder", editLang, v))}
            autoComplete="off"
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField
            label={c.lastNamePlaceholder}
            value={gi(container, "last_name_placeholder", editLang)}
            onChange={(v) => onChange(si(container, "last_name_placeholder", editLang, v))}
            autoComplete="off"
          />
        </div>
      </InlineStack>
      <TextField label={c.emailPlaceholder} value={gi(container, "email_placeholder", editLang)} onChange={(v) => onChange(si(container, "email_placeholder", editLang, v))} autoComplete="off" />
      <Select
        label={c.providerHint}
        options={c.newsletterProviderOptions()}
        value={container.provider || "other"}
        onChange={(v) => onChange({ ...container, provider: v })}
      />
      <TextField
        label={c.formActionUrl}
        value={container.form_action || ""}
        onChange={(v) => onChange({ ...container, form_action: v })}
        autoComplete="off"
        helpText={c.formActionHelp}
      />
      <Select
        label={c.method}
        options={[{ label: "POST", value: "post" }, { label: "GET", value: "get" }]}
        value={container.form_method || "post"}
        onChange={(v) => onChange({ ...container, form_method: v })}
      />
      <TextField
        label={c.firstNameFieldName}
        value={container.first_name_field_name || "FNAME"}
        onChange={(v) => onChange({ ...container, first_name_field_name: v })}
        autoComplete="off"
        helpText={c.fieldNameHelpFname}
      />
      <TextField
        label={c.lastNameFieldName}
        value={container.last_name_field_name || "LNAME"}
        onChange={(v) => onChange({ ...container, last_name_field_name: v })}
        autoComplete="off"
        helpText={c.fieldNameHelpLname}
      />
      <TextField
        label={c.emailFieldName}
        value={container.email_field_name || "EMAIL"}
        onChange={(v) => onChange({ ...container, email_field_name: v })}
        autoComplete="off"
        helpText={c.fieldNameHelpEmail}
      />
      <TextField label={c.privacyNote} value={container.privacy_note || ""} onChange={(v) => onChange({ ...container, privacy_note: v })} multiline={2} autoComplete="off" />
      <InlineStack gap="400" wrap={false}>
        <div style={{ flex: 1 }}><ColorField label={c.background} value={container.bg_color || "#f3f4f6"} onChange={(v) => onChange({ ...container, bg_color: v })} /></div>
        <div style={{ flex: 1 }}><ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} /></div>
        <div style={{ flex: 1 }}><ColorField label={c.buttonBg} value={container.btn_bg || "#111827"} onChange={(v) => onChange({ ...container, btn_bg: v })} /></div>
        <div style={{ flex: 1 }}><ColorField label={c.buttonText} value={container.btn_color || "#ffffff"} onChange={(v) => onChange({ ...container, btn_color: v })} /></div>
      </InlineStack>

      <Text as="h3" variant="headingSm">{c.hiddenFields}</Text>
      {hidden.map((h, idx) => (
        <InlineStack key={idx} gap="300" wrap={false} blockAlign="center">
          <div style={{ flex: 1 }}><TextField label={c.name} value={h.name || ""} onChange={(v) => updateHidden(idx, "name", v)} autoComplete="off" /></div>
          <div style={{ flex: 1 }}><TextField label={c.fieldValue} value={h.value || ""} onChange={(v) => updateHidden(idx, "value", v)} autoComplete="off" /></div>
          <Button size="slim" tone="critical" onClick={() => removeHidden(idx)}>✕</Button>
        </InlineStack>
      ))}
      <Button size="slim" onClick={addHidden}>{c.addHiddenField}</Button>
    </BlockStack>
  );
}

// ── Feature Grid editor ───────────────────────────────────────────────────────
function FeatureGridEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const items = container.items || [];

  const updateItem = (idx, key, val) => {
    const next = items.map((item, i) => i === idx ? { ...item, [key]: val } : item);
    onChange({ ...container, items: next });
  };

  const updateItemI18n = (idx, field, val) => {
    const next = items.map((item, i) => i === idx ? si(item, field, editLang, val) : item);
    onChange({ ...container, items: next });
  };
  const addItem = () => onChange({ ...container, items: [...items, { icon: "✨", title: `Merkmal ${items.length + 1}`, body: "" }] });
  const removeItem = (idx) => onChange({ ...container, items: items.filter((_, i) => i !== idx) });
  const moveItem = (idx, dir) => {
    const next = [...items];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...container, items: next });
  };

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.featureGridSettings}</Text>
          <TextField label={c.heading} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" helpText={c.featureGridTitleHelp} />
          <TextField label={`${c.subtitle} ${c.optional}`} value={gi(container, "subtitle", editLang)} onChange={(v) => onChange(si(container, "subtitle", editLang, v))} multiline={2} autoComplete="off" helpText={c.featureGridSubtitleHelp} />
          <TextField label={c.eyebrow} value={gi(container, "eyebrow", editLang)} onChange={(v) => onChange(si(container, "eyebrow", editLang, v))} autoComplete="off" helpText={c.optional} />
          <TextField label={c.leadText} value={gi(container, "lead", editLang)} onChange={(v) => onChange(si(container, "lead", editLang, v))} multiline={2} autoComplete="off" helpText={c.optional} />
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.layoutVariant}
              options={c.featureGridVariantOptions()}
              value={container.variant || "cards"}
              onChange={(v) => onChange({ ...container, variant: v })}
            />
            <Select
              label={c.titleAlign}
              options={c.titleAlignOptions()}
              value={container.title_align || "center"}
              onChange={(v) => onChange({ ...container, title_align: v })}
            />
            <Select
              label={c.columnsDesktop}
              options={[2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(container.cols || 3)}
              onChange={(v) => onChange({ ...container, cols: Number(v) })}
            />
            <Select
              label={c.cardStyle}
              options={c.cardStyleOptions()}
              value={container.card_style || "bordered"}
              onChange={(v) => onChange({ ...container, card_style: v })}
            />
            <TextField label={c.iconSize} value={container.icon_size || "40px"} onChange={(v) => onChange({ ...container, icon_size: v })} autoComplete="off" helpText={c.eg48px} />
            <ColorField label={c.background} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
            <ColorField label={c.cardBackground} value={container.card_bg || "#f9fafb"} onChange={(v) => onChange({ ...container, card_bg: v })} />
            <ColorField label={c.cardBorder} value={container.card_border_color || "#e5e7eb"} onChange={(v) => onChange({ ...container, card_border_color: v })} />
            <ColorField label={c.textColor} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} />
          </div>
        </BlockStack>
      </Card>

      {items.map((item, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.featureN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveItem(idx, -1)}>↑</Button>
                <Button size="slim" disabled={idx === items.length - 1} onClick={() => moveItem(idx, 1)}>↓</Button>
                {items.length > 1 && <Button size="slim" tone="critical" onClick={() => removeItem(idx)}>{c.remove}</Button>}
              </InlineStack>
            </InlineStack>
            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: "0 0 120px" }}>
                <TextField label={c.iconEmoji} value={item.icon || ""} onChange={(v) => updateItem(idx, "icon", v)} autoComplete="off" helpText={c.iconEmojiHelp} />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.title} value={gi(item, "title", editLang)} onChange={(v) => updateItemI18n(idx, "title", v)} autoComplete="off" />
              </div>
            </InlineStack>
            <TextField label={c.description} value={gi(item, "body", editLang)} onChange={(v) => updateItemI18n(idx, "body", v)} multiline={3} autoComplete="off" />
          </BlockStack>
        </Card>
      ))}

      <InlineStack>
        <Button onClick={addItem}>{c.addFeature}</Button>
      </InlineStack>
    </BlockStack>
  );
}

// ── Testimonials editor ───────────────────────────────────────────────────────
function TestimonialsEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const items = container.items || [];
  const [pickerIdx, setPickerIdx] = useState(null);

  const updateItem = (idx, key, val) => {
    const next = items.map((item, i) => i === idx ? { ...item, [key]: val } : item);
    onChange({ ...container, items: next });
  };

  const updateItemI18n = (idx, field, val) => {
    const next = items.map((item, i) => i === idx ? si(item, field, editLang, val) : item);
    onChange({ ...container, items: next });
  };
  const addItem = () => onChange({ ...container, items: [...items, { quote: "", author: `Kunde ${items.length + 1}`, role: "", avatar: "", rating: 5 }] });
  const removeItem = (idx) => onChange({ ...container, items: items.filter((_, i) => i !== idx) });
  const moveItem = (idx, dir) => {
    const next = [...items];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...container, items: next });
  };

  return (
    <BlockStack gap="400">
      {pickerIdx !== null && (
        <MediaPickerModal open multiple={false} onClose={() => setPickerIdx(null)} onSelect={(urls) => { if (urls[0]) updateItemI18n(pickerIdx, "avatar", urls[0]); setPickerIdx(null); }} />
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.testimonialsSettings}</Text>
          <TextField label={c.heading} value={gi(container, "title", editLang)} onChange={(v) => onChange(si(container, "title", editLang, v))} autoComplete="off" />
          <TextField label={`${c.subtitle} ${c.optional}`} value={gi(container, "subtitle", editLang)} onChange={(v) => onChange(si(container, "subtitle", editLang, v))} multiline={2} autoComplete="off" />
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.titleAlign}
              options={c.titleAlignOptions()}
              value={container.title_align || "center"}
              onChange={(v) => onChange({ ...container, title_align: v })}
            />
            <Select
              label={c.columnsDesktop}
              options={[1, 2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))}
              value={String(container.cols || 3)}
              onChange={(v) => onChange({ ...container, cols: Number(v) })}
            />
            <Select
              label={c.showStars}
              options={c.yesNoOptions()}
              value={container.show_stars !== false ? "true" : "false"}
              onChange={(v) => onChange({ ...container, show_stars: v === "true" })}
            />
            <ColorField label={c.background} value={container.bg_color || "#f9fafb"} onChange={(v) => onChange({ ...container, bg_color: v })} />
            <ColorField label={c.cardSurface} value={container.card_bg || "#ffffff"} onChange={(v) => onChange({ ...container, card_bg: v })} />
            <ColorField label={c.cardBorder} value={container.card_border_color || "#e5e7eb"} onChange={(v) => onChange({ ...container, card_border_color: v })} />
            <ColorField label={c.accentStars} value={container.accent_color || "#ff971c"} onChange={(v) => onChange({ ...container, accent_color: v })} />
          </div>
        </BlockStack>
      </Card>

      {items.map((item, idx) => (
        <Card key={idx}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.testimonialN(idx + 1)}</Text>
              <InlineStack gap="200">
                <Button size="slim" disabled={idx === 0} onClick={() => moveItem(idx, -1)}>↑</Button>
                <Button size="slim" disabled={idx === items.length - 1} onClick={() => moveItem(idx, 1)}>↓</Button>
                {items.length > 1 && <Button size="slim" tone="critical" onClick={() => removeItem(idx)}>{c.remove}</Button>}
              </InlineStack>
            </InlineStack>
            <TextField label={c.quote} value={gi(item, "quote", editLang)} onChange={(v) => updateItemI18n(idx, "quote", v)} multiline={3} autoComplete="off" />
            <InlineStack gap="400" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label={c.name} value={gi(item, "author", editLang)} onChange={(v) => updateItemI18n(idx, "author", v)} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label={c.roleTitleOptional} value={gi(item, "role", editLang)} onChange={(v) => updateItemI18n(idx, "role", v)} autoComplete="off" />
              </div>
              <div style={{ flex: "0 0 80px" }}>
                <Select
                  label={c.stars}
                  options={[5, 4, 3, 2, 1].map((n) => ({ label: `${n} ★`, value: String(n) }))}
                  value={String(item.rating || 5)}
                  onChange={(v) => updateItem(idx, "rating", Number(v))}
                />
              </div>
            </InlineStack>
            <ImageField
              label={c.avatarOptional}
              value={gi(item, "avatar", editLang)}
              onPick={() => setPickerIdx(idx)}
              onClear={() => updateItemI18n(idx, "avatar", "")}
            />
          </BlockStack>
        </Card>
      ))}

      <InlineStack>
        <Button onClick={addItem}>{c.addTestimonial}</Button>
      </InlineStack>
    </BlockStack>
  );
}

// ── Video block editor ─────────────────────────────────────────────────────
function VideoBlockEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  const c = useLandingCopy();
  const isMobileView = deviceTab >= 1;
  const [posterPicker, setPosterPicker] = useState(null);
  const mode = container.video_mode === "embed" ? "embed" : "file";
  return (
    <BlockStack gap="400">
      {posterPicker === "desktop" && (
        <MediaPickerModal
          open
          multiple={false}
          onClose={() => setPosterPicker(null)}
          onSelect={(urls) => { if (urls[0]) onChange(si(container, "poster_url", editLang, urls[0])); setPosterPicker(null); }}
        />
      )}
      {posterPicker === "mobile" && (
        <MediaPickerModal
          open
          multiple={false}
          onClose={() => setPosterPicker(null)}
          onSelect={(urls) => { if (urls[0]) onChange(si(container, "poster_url_mobile", editLang, urls[0])); setPosterPicker(null); }}
        />
      )}

      <TextField
        label={`${c.heading} ${c.optional}`}
        value={gi(container, "title", editLang)}
        onChange={(v) => onChange(si(container, "title", editLang, v))}
        autoComplete="off"
      />
      <TextField
        label={`${c.captionOptional}`}
        value={gi(container, "caption", editLang)}
        onChange={(v) => onChange(si(container, "caption", editLang, v))}
        multiline={2}
        autoComplete="off"
      />
      <ColorField label={`${c.textColor} (${c.title} & ${c.captionOptional})`} value={container.text_color || "#111827"} onChange={(v) => onChange({ ...container, text_color: v })} />
      <ColorField label={c.background} value={container.bg_color || "#ffffff"} onChange={(v) => onChange({ ...container, bg_color: v })} />

      <Select
        label={c.source}
        options={c.videoSourceOptions()}
        value={mode}
        onChange={(v) => onChange({ ...container, video_mode: v === "embed" ? "embed" : "file" })}
      />

      {mode === "file" ? (
        <BlockStack gap="300">
          <TextField
            label={c.videoUrl}
            value={isMobileView ? (container.video_url_mobile || "") : (container.video_url || "")}
            onChange={(v) => onChange({
              ...container,
              ...(isMobileView ? { video_url_mobile: v } : { video_url: v }),
            })}
            autoComplete="off"
            placeholder={c.videoUrlPh}
            helpText={c.videoUrlHelp}
          />
          <div style={EDITOR_FIELD_GRID}>
            <ImageField
              label={c.posterOptional}
              value={isMobileView ? gi(container, "poster_url_mobile", editLang) : gi(container, "poster_url", editLang)}
              onPick={() => setPosterPicker(isMobileView ? "mobile" : "desktop")}
              onClear={() =>
                onChange(
                  si(container, isMobileView ? "poster_url_mobile" : "poster_url", editLang, ""),
                )}
            />
          </div>
        </BlockStack>
      ) : (
        <BlockStack gap="300">
          <TextField
            label={c.embedUrl}
            value={isMobileView ? (container.embed_url_mobile || "") : (container.embed_url || "")}
            onChange={(v) => onChange({
              ...container,
              ...(isMobileView ? { embed_url_mobile: v } : { embed_url: v }),
            })}
            autoComplete="off"
            placeholder="https://www.youtube.com/watch?v=…"
          />
        </BlockStack>
      )}

      <Select
        label={c.displayAspectRatio}
        options={c.videoAspectOptions()}
        value={String(container.aspect_ratio || "16/9").replace(/:/g, "/").trim() || "16/9"}
        onChange={(v) => onChange({ ...container, aspect_ratio: v })}
      />

      <Text as="h3" variant="headingSm">{c.playbackFileOnly}</Text>
      <div style={EDITOR_FIELD_GRID}>
        <Checkbox
          label={c.autoplayNeedsMuted}
          checked={container.autoplay === true}
          onChange={(c) => onChange({ ...container, autoplay: c })}
        />
        <Checkbox
          label={c.startMuted}
          checked={container.muted !== false}
          onChange={(c) => onChange({ ...container, muted: c })}
        />
        <Checkbox
          label={c.loopPlayback}
          checked={container.loop === true}
          onChange={(c) => onChange({ ...container, loop: c })}
        />
        <Checkbox
          label={c.controlsPlayPause}
          checked={container.controls !== false}
          onChange={(c) => onChange({ ...container, controls: c })}
        />
        <Checkbox
          label={c.playsInline}
          checked={container.playsinline !== false}
          onChange={(c) => onChange({ ...container, playsinline: c })}
        />
      </div>
    </BlockStack>
  );
}

function ContainerLayoutEditor({ container, onChange, embedded = false }) {
  const c = useLandingCopy();
  const layout = container.content_layout === "full" ? "full" : "contained";
  const maxW =
    container.content_max_width !== undefined && container.content_max_width !== null
      ? String(container.content_max_width)
      : "";
  const inner = (
    <BlockStack gap="300">
      <Text variant="headingSm" as="h3">{c.contentWidth}</Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {c.contentWidthHelp}
      </Text>
      <Select
        label={c.content}
        options={c.contentLayoutOptions()}
        value={layout}
        onChange={(v) => onChange({ ...container, content_layout: v })}
      />
      {layout === "contained" ? (
        <TextField
          label={c.maxWidth}
          value={maxW}
          onChange={(v) => {
            const t = v != null ? String(v).trim() : "";
            onChange({
              ...container,
              content_max_width: t === "" ? undefined : t,
            });
          }}
          autoComplete="off"
          placeholder={c.maxWidthPh}
          helpText={c.maxWidthHelp}
        />
      ) : null}
    </BlockStack>
  );
  if (embedded) {
    return <Box paddingBlockStart="0">{inner}</Box>;
  }
  return (
    <div>
      <Divider />
      <Box paddingBlockStart="400">{inner}</Box>
    </div>
  );
}

function ContainerSpacingEditor({ container, onChange, embedded = false }) {
  const c = useLandingCopy();
  const m = container.margin || {};
  const set = (k, v) => {
    const next = { ...m };
    const trimmed = v != null ? String(v).trim() : "";
    if (trimmed === "") delete next[k];
    else next[k] = v;
    const keys = Object.keys(next);
    onChange({ ...container, margin: keys.length ? next : undefined });
  };
  const fields = [
    { key: "top",    label: c.paddingTop },
    { key: "bottom", label: c.paddingBottom },
    { key: "left",   label: c.alignLeft },
    { key: "right",  label: c.alignRight },
  ];
  const inner = (
    <BlockStack gap="300">
      <Text variant="headingSm" as="h3">{c.containerOuterMargin}</Text>
      <Box background="bg-surface-secondary" padding="400" borderRadius="200">
        <div style={EDITOR_FIELD_GRID}>
          {fields.map(({ key, label: lbl }) => (
            <TextField
              key={key}
              label={lbl}
              value={m[key] !== undefined ? String(m[key]) : ""}
              onChange={(v) => set(key, v)}
              autoComplete="off"
              placeholder="0"
            />
          ))}
        </div>
      </Box>
    </BlockStack>
  );
  if (embedded) {
    return <Box paddingBlockStart="0">{inner}</Box>;
  }
  return (
    <div>
      <Divider />
      <Box paddingBlockStart="400">{inner}</Box>
    </div>
  );
}

/** Inhalt + Außen: ein Mal rechts, für alle Containertypen */
function ContainerChromePanel({ container, onChange, deviceTab = 0 }) {
  const c = useLandingCopy();
  const t = container.type;
  const def = getContainerPaddingDefault(t);
  const hOnly = containerPaddingHorizontalOnly(t);
  const isMobileView = deviceTab >= 1;
  const isImageCarousel = t === "image_carousel";
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingSm">{c.containerSpacingSettings}</Text>
        {!isImageCarousel && (
          <PaddingEditor
            label={c.innerPaddingHorizontal}
            value={container.padding || def}
            onChange={(v) => onChange({ ...container, padding: v })}
            defaultValue={def}
            horizontalOnly={hOnly}
          />
        )}
        {isImageCarousel && (
          <>
            <TextField
              label={c.imageGapPx}
              type="number"
              value={String(isMobileView ? (container.gap_mobile ?? "") : (container.gap ?? 16))}
              onChange={(v) => {
                const trimmed = String(v || "").trim();
                if (isMobileView) {
                  if (trimmed === "") onChange({ ...container, gap_mobile: undefined });
                  else onChange({ ...container, gap_mobile: Number(v) || 0 });
                  return;
                }
                onChange({ ...container, gap: Number(v) || 16 });
              }}
              autoComplete="off"
              helpText={isMobileView ? c.gapFallsBackDesktop : undefined}
            />
          </>
        )}
        {!isMobileView && (
          <>
            <Divider />
            <ContainerLayoutEditor container={container} onChange={onChange} embedded />
          </>
        )}
        <Divider />
        <ContainerSpacingEditor container={container} onChange={onChange} embedded />
      </BlockStack>
    </Card>
  );
}

function ArrayItemActions({ index, length, onMove, onRemove }) {
  const c = useLandingCopy();
  return (
    <InlineStack gap="200">
      <Button size="slim" disabled={index === 0} onClick={() => onMove(index, -1)}>↑</Button>
      <Button size="slim" disabled={index === length - 1} onClick={() => onMove(index, 1)}>↓</Button>
      <Button size="slim" tone="critical" onClick={() => onRemove(index)}>{c.remove}</Button>
    </InlineStack>
  );
}

function moveArrayItem(items, index, direction) {
  const next = [...items];
  const target = index + direction;
  if (target < 0 || target >= next.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next.map((item, order) => ({ ...item, order }));
}

function SupportTextField({ object, field, editLang, onChange, ...props }) {
  return (
    <TextField
      {...props}
      value={gi(object, field, editLang)}
      onChange={(value) => onChange(si(object, field, editLang, value))}
      autoComplete="off"
    />
  );
}

function SupportHeroEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <BlockStack gap="400">
      {pickerOpen && (
        <MediaPickerModal
          open
          multiple={false}
          onClose={() => setPickerOpen(false)}
          onSelect={(urls) => {
            if (urls[0]) onChange(si(container, "image", editLang, urls[0]));
            setPickerOpen(false);
          }}
        />
      )}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.supportCoreContent}</Text>
          <SupportTextField object={container} field="title" editLang={editLang} onChange={onChange} label={c.title} />
          <SupportTextField object={container} field="description" editLang={editLang} onChange={onChange} label={c.description} multiline={3} />
          <SupportTextField object={container} field="trust_text" editLang={editLang} onChange={onChange} label={c.supportTrustText} />
          <SupportTextField object={container} field="search_placeholder" editLang={editLang} onChange={onChange} label={c.supportSearchPlaceholder} />
          <Checkbox label={c.supportOpenCaseCountEnabled} checked={container.open_case_count_enabled === true} onChange={(v) => onChange({ ...container, open_case_count_enabled: v })} />
          {container.open_case_count_enabled && (
            <SupportTextField object={container} field="open_case_count_text" editLang={editLang} onChange={onChange} label={c.supportOpenCaseCountText} />
          )}
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.supportPrimaryAction}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <SupportTextField object={container} field="primary_action_label" editLang={editLang} onChange={onChange} label={c.supportActionLabel} />
            <TextField label={c.supportActionUrl} value={container.primary_action_url || ""} onChange={(v) => onChange({ ...container, primary_action_url: v })} autoComplete="off" />
          </div>
          <Text as="h3" variant="headingSm">{c.supportSecondaryAction}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <SupportTextField object={container} field="secondary_action_label" editLang={editLang} onChange={onChange} label={c.supportActionLabel} />
            <TextField label={c.supportActionUrl} value={container.secondary_action_url || ""} onChange={(v) => onChange({ ...container, secondary_action_url: v })} autoComplete="off" />
          </div>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <Select label={c.supportLayout} options={c.supportLayoutOptions()} value={container.layout || "split"} onChange={(v) => onChange({ ...container, layout: v })} />
          <ImageField label={c.image} value={gi(container, "image", editLang)} onPick={() => setPickerOpen(true)} onClear={() => onChange(si(container, "image", editLang, ""))} />
          <div style={EDITOR_FIELD_GRID}>
            <ColorField label={c.backgroundColor} value={container.bg_color || "#f5f7ff"} onChange={(v) => onChange({ ...container, bg_color: v })} />
            <ColorField label={c.textColor} value={container.text_color || "#17213c"} onChange={(v) => onChange({ ...container, text_color: v })} />
            <ColorField label={c.supportAccentColor} value={container.accent_color || "#ff971c"} onChange={(v) => onChange({ ...container, accent_color: v })} />
          </div>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

function SupportCaseWizardEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const categories = Array.isArray(container.categories) ? container.categories : [];
  const setCategories = (next) => onChange({ ...container, categories: next });
  const updateCategory = (index, updater) => setCategories(categories.map((item, i) => i === index ? updater(item) : item));
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.supportWizardHeadings}</Text>
          <SupportTextField object={container} field="title" editLang={editLang} onChange={onChange} label={c.title} />
          <SupportTextField object={container} field="description" editLang={editLang} onChange={onChange} label={c.description} multiline={3} />
          <div style={EDITOR_FIELD_GRID}>
            {[
              ["category_heading", c.supportCategoryHeading], ["subtopic_heading", c.supportSubtopicHeading],
              ["order_heading", c.supportOrderHeading], ["continue_label", c.supportContinueLabel], ["back_label", c.supportBackLabel],
            ].map(([field, label]) => <SupportTextField key={field} object={container} field={field} editLang={editLang} onChange={onChange} label={label} />)}
          </div>
        </BlockStack>
      </Card>
      <Text as="h3" variant="headingSm">{c.supportCategories}</Text>
      {categories.map((category, index) => {
        const subtopics = Array.isArray(category.subtopics) ? category.subtopics : [];
        const setSubtopics = (next) => updateCategory(index, (item) => ({ ...item, subtopics: next }));
        return (
          <Card key={`${category.key}-${index}`}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">{c.supportCategory} {index + 1}</Text>
                <ArrayItemActions index={index} length={categories.length} onMove={(i, d) => setCategories(moveArrayItem(categories, i, d))} onRemove={(i) => setCategories(categories.filter((_, x) => x !== i).map((item, order) => ({ ...item, order })))} />
              </InlineStack>
              <div style={EDITOR_FIELD_GRID}>
                <SupportTextField object={category} field="label" editLang={editLang} onChange={(next) => updateCategory(index, () => next)} label={c.title} />
                <TextField label={c.supportCategoryKey} value={category.key || ""} onChange={(v) => updateCategory(index, (item) => ({ ...item, key: v }))} autoComplete="off" />
                <TextField label={c.supportRuntimeCategory} value={category.runtime_category || category.key || ""} onChange={(v) => updateCategory(index, (item) => ({ ...item, runtime_category: v }))} autoComplete="off" helpText={c.supportRuntimeCategoryHelp} />
                <TextField label={c.supportOrder} type="number" value={String(category.order ?? index)} onChange={(v) => updateCategory(index, (item) => ({ ...item, order: Number(v) || 0 }))} autoComplete="off" />
              </div>
              <InlineStack gap="400">
                <Checkbox label={c.supportOrderRelated} checked={category.order_related === true} onChange={(v) => updateCategory(index, (item) => ({ ...item, order_related: v }))} />
                <Checkbox label={c.supportPlatform} checked={category.platform === true} onChange={(v) => updateCategory(index, (item) => ({ ...item, platform: v }))} />
              </InlineStack>
              <Text as="h4" variant="headingSm">{c.supportSubtopics}</Text>
              {subtopics.map((subtopic, subIndex) => (
                <Card key={subIndex}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span">{c.supportSubtopic} {subIndex + 1}</Text>
                      <ArrayItemActions index={subIndex} length={subtopics.length} onMove={(i, d) => setSubtopics(moveArrayItem(subtopics, i, d))} onRemove={(i) => setSubtopics(subtopics.filter((_, x) => x !== i).map((item, order) => ({ ...item, order })))} />
                    </InlineStack>
                    <SupportTextField object={subtopic} field="label" editLang={editLang} onChange={(next) => setSubtopics(subtopics.map((item, i) => i === subIndex ? next : item))} label={c.supportSubtopic} />
                  </BlockStack>
                </Card>
              ))}
              <Button size="slim" onClick={() => setSubtopics([...subtopics, { label: "", order: subtopics.length }])}>{c.supportAddSubtopic}</Button>
            </BlockStack>
          </Card>
        );
      })}
      <Button onClick={() => setCategories([...categories, { key: `category_${categories.length + 1}`, runtime_category: "technical", label: "", order: categories.length, order_related: false, platform: true, subtopics: [{ label: "", order: 0 }] }])}>{c.supportAddCategory}</Button>
    </BlockStack>
  );
}

function SupportTopicGridEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const topics = Array.isArray(container.topics) ? container.topics : [];
  const setTopics = (next) => onChange({ ...container, topics: next });
  const update = (index, updater) => setTopics(topics.map((item, i) => i === index ? updater(item) : item));
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <SupportTextField object={container} field="title" editLang={editLang} onChange={onChange} label={c.title} />
          <SupportTextField object={container} field="description" editLang={editLang} onChange={onChange} label={c.description} multiline={3} />
          <Select label={c.columnsDesktop} options={[2, 3, 4].map((n) => ({ label: String(n), value: String(n) }))} value={String(container.columns || 3)} onChange={(v) => onChange({ ...container, columns: Number(v) })} />
        </BlockStack>
      </Card>
      <Text as="h3" variant="headingSm">{c.supportTopics}</Text>
      {topics.map((topic, index) => (
        <Card key={index}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">{c.supportTopic} {index + 1}</Text>
              <ArrayItemActions index={index} length={topics.length} onMove={(i, d) => setTopics(moveArrayItem(topics, i, d))} onRemove={(i) => setTopics(topics.filter((_, x) => x !== i).map((item, order) => ({ ...item, order })))} />
            </InlineStack>
            <div style={EDITOR_FIELD_GRID}>
              <TextField label={c.iconEmoji} value={topic.icon || ""} onChange={(v) => update(index, (item) => ({ ...item, icon: v }))} autoComplete="off" />
              <SupportTextField object={topic} field="title" editLang={editLang} onChange={(next) => update(index, () => next)} label={c.title} />
              <TextField label={c.supportTopicCategory} value={topic.category || ""} onChange={(v) => update(index, (item) => ({ ...item, category: v }))} autoComplete="off" />
              <TextField label={c.supportOrder} type="number" value={String(topic.order ?? index)} onChange={(v) => update(index, (item) => ({ ...item, order: Number(v) || 0 }))} autoComplete="off" />
            </div>
            <SupportTextField object={topic} field="description" editLang={editLang} onChange={(next) => update(index, () => next)} label={c.description} multiline={3} />
          </BlockStack>
        </Card>
      ))}
      <Button onClick={() => setTopics([...topics, { icon: "❓", title: "", description: "", category: "general", order: topics.length }])}>{c.supportAddTopic}</Button>
    </BlockStack>
  );
}

function SupportFaqEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  const categories = Array.isArray(container.categories) ? container.categories : [];
  const setCategories = (next) => onChange({ ...container, categories: next });
  const updateCategory = (index, updater) => setCategories(categories.map((item, i) => i === index ? updater(item) : item));
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <SupportTextField object={container} field="title" editLang={editLang} onChange={onChange} label={c.title} />
          <SupportTextField object={container} field="description" editLang={editLang} onChange={onChange} label={c.description} multiline={3} />
          <div style={EDITOR_FIELD_GRID}>
            <SupportTextField object={container} field="section_label" editLang={editLang} onChange={onChange} label={c.supportSectionLabel} />
            <SupportTextField object={container} field="no_results_text" editLang={editLang} onChange={onChange} label={c.supportNoResults} />
          </div>
        </BlockStack>
      </Card>
      <Text as="h3" variant="headingSm">{c.supportFaqCategories}</Text>
      {categories.map((category, index) => {
        const items = Array.isArray(category.items) ? category.items : [];
        const setItems = (next) => updateCategory(index, (current) => ({ ...current, items: next }));
        return (
          <Card key={index}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingSm">{c.supportFaqCategory} {index + 1}</Text>
                <ArrayItemActions index={index} length={categories.length} onMove={(i, d) => setCategories(moveArrayItem(categories, i, d))} onRemove={(i) => setCategories(categories.filter((_, x) => x !== i).map((item, order) => ({ ...item, order })))} />
              </InlineStack>
              <SupportTextField object={category} field="title" editLang={editLang} onChange={(next) => updateCategory(index, () => next)} label={c.title} />
              <Text as="h4" variant="headingSm">{c.supportFaqItems}</Text>
              {items.map((item, itemIndex) => (
                <Card key={itemIndex}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span">{c.supportFaqItem} {itemIndex + 1}</Text>
                      <ArrayItemActions index={itemIndex} length={items.length} onMove={(i, d) => setItems(moveArrayItem(items, i, d))} onRemove={(i) => setItems(items.filter((_, x) => x !== i).map((entry, order) => ({ ...entry, order })))} />
                    </InlineStack>
                    <SupportTextField object={item} field="question" editLang={editLang} onChange={(next) => setItems(items.map((entry, i) => i === itemIndex ? next : entry))} label={c.supportQuestion} />
                    <SupportTextField object={item} field="answer" editLang={editLang} onChange={(next) => setItems(items.map((entry, i) => i === itemIndex ? next : entry))} label={c.supportAnswer} multiline={4} />
                    <div style={EDITOR_FIELD_GRID}>
                      <SupportTextField object={item} field="action_label" editLang={editLang} onChange={(next) => setItems(items.map((entry, i) => i === itemIndex ? next : entry))} label={`${c.supportActionLabel} ${c.optional}`} />
                      <TextField label={`${c.supportActionUrl} ${c.optional}`} value={item.action_url || ""} onChange={(v) => setItems(items.map((entry, i) => i === itemIndex ? { ...entry, action_url: v } : entry))} autoComplete="off" />
                    </div>
                  </BlockStack>
                </Card>
              ))}
              <Button size="slim" onClick={() => setItems([...items, { question: "", answer: "", order: items.length, action_label: "", action_url: "" }])}>{c.supportAddFaq}</Button>
            </BlockStack>
          </Card>
        );
      })}
      <Button onClick={() => setCategories([...categories, { title: "", order: categories.length, items: [{ question: "", answer: "", order: 0, action_label: "", action_url: "" }] }])}>{c.supportAddCategory}</Button>
    </BlockStack>
  );
}

function PersonalizedProductRowEditor({ container, onChange, editLang = "de" }) {
  const c = useLandingCopy();
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">{c.personalizedAlgorithm}</Text>
          <Text as="p" variant="bodySm" tone="subdued">{c.personalizedAlgorithmHelp}</Text>
          <Select
            label={c.personalizedAlgorithm}
            options={c.personalizedAlgorithmOptions()}
            value={container.algorithm || "top_picks"}
            onChange={(v) => onChange({ ...container, algorithm: v })}
          />
          <TextField
            label={`${c.heading} ${c.optional}`}
            value={gi(container, "title", editLang)}
            onChange={(v) => onChange(si(container, "title", editLang, v))}
            autoComplete="off"
            placeholder={c.headingPh}
            helpText={c.sectionTitleOptional}
          />
          <div style={EDITOR_FIELD_GRID}>
            <TextField
              label={c.visibleCount}
              type="number"
              value={String(container.visible_count ?? 4)}
              onChange={(v) => onChange({ ...container, visible_count: Math.min(8, Math.max(2, Number(v) || 4)) })}
              autoComplete="off"
            />
            <TextField
              label={c.gapPx}
              type="number"
              value={String(container.gap ?? 12)}
              onChange={(v) => onChange({ ...container, gap: Number(v) || 12 })}
              autoComplete="off"
            />
          </div>
        </BlockStack>
      </Card>
      <Divider />
      <ContainerLayoutEditor container={container} onChange={onChange} embedded />
      <Divider />
      <ContainerSpacingEditor container={container} onChange={onChange} embedded />
    </BlockStack>
  );
}

function ContainerEditor({ container, onChange, deviceTab = 0, editLang = "de" }) {
  let editor = null;
  switch (container.type) {
    case "hero_banner":          editor = <HeroBannerEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "text_block":           editor = <TextBlockEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "image_text":           editor = <ImageTextEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "image_grid":           editor = <ImageGridEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "content_mosaic":       editor = <ContentMosaicEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "image_carousel":       editor = <ImageCarouselEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "banner_cta":           editor = <BannerCtaEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "collection_carousel":  editor = <CollectionCarouselEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "bestseller_carousel":  editor = <BestsellerCarouselEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "category_sidebar":     editor = <CategorySidebarEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "brands_directory":     editor = <BrandsDirectoryEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "seller_carousel":      editor = <BrandsDirectoryEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "collections_carousel": editor = <CollectionsCarouselEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "accordion":            editor = <AccordionEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "tabs":                 editor = <TabsEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "single_product":       editor = <SingleProductEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "blog_carousel":        editor = <BlogCarouselEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "newsletter":           editor = <NewsletterEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "feature_grid":         editor = <FeatureGridEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "testimonials":              editor = <TestimonialsEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "video_block":               editor = <VideoBlockEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "personalized_product_row":  editor = <PersonalizedProductRowEditor container={container} onChange={onChange} deviceTab={deviceTab} editLang={editLang} />; break;
    case "support_hero":              editor = <SupportHeroEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "support_case_wizard":       editor = <SupportCaseWizardEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "support_topic_grid":        editor = <SupportTopicGridEditor container={container} onChange={onChange} editLang={editLang} />; break;
    case "support_faq":               editor = <SupportFaqEditor container={container} onChange={onChange} editLang={editLang} />; break;
    default: return null;
  }
  return (
    <div style={{ ...CONTAINER_EDITOR_ROW, gap: container.type === "image_carousel" ? 12 : CONTAINER_EDITOR_ROW.gap }}>
      <div style={CONTAINER_EDITOR_MAIN}>
        <BlockStack gap="500">{editor}</BlockStack>
      </div>
      <div style={CONTAINER_EDITOR_CHROME}>
        <ContainerChromePanel container={container} onChange={onChange} deviceTab={deviceTab} />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const DEFAULT_PAGE_ID = "__default__"; // shop homepage (legacy single-row table)

const TEMPLATE_DEFAULTS = {
  collection_template: {
    banner_style: "strip",
    show_sidebar: true,
    sidebar_width: "220px",
    products_per_row: 4,
    products_per_row_mobile: 2,
    richtext_align: "left",
    richtext_max_width: "700px",
    content_padding_x: "32px",
    filter_checkbox_size: 10,
  },
  category_template: {
    banner_style: "strip",
    show_sidebar: true,
    sidebar_width: "280px",
    products_per_row: 4,
    products_per_row_mobile: 2,
    richtext_align: "left",
    richtext_max_width: "700px",
    content_padding_x: "32px",
    filter_checkbox_size: 10,
  },
};

/** API dropdown values → CMS page slugs (containers live on CMS Seiten). */
const API_CMS_SLUG = {
  "api:bestsellers": "bestsellers",
  "api:sales": "sales",
  "api:brands": "brands",
  "api:neuheiten": "new-in",
};

const CATALOG_CMS_SLUG_ORDER = ["bestsellers", "sales", "new-in", "brands"];

function sortCmsPagesForSelect(list) {
  const rank = (slug) => {
    const i = CATALOG_CMS_SLUG_ORDER.indexOf(String(slug || ""));
    return i === -1 ? 1000 : i;
  };
  return [...list].sort((a, b) => {
    const d = rank(a.slug) - rank(b.slug);
    if (d !== 0) return d;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

// ── Popup Editor ─────────────────────────────────────────────────────────────
function PopupDeviceEditor({ config, onChange }) {
  const c = useLandingCopy();
  const [pickerOpen, setPickerOpen] = useState(false);
  const upd = (key, val) => onChange({ ...config, [key]: val });

  return (
    <BlockStack gap="400">
      <Checkbox
        label={c.popupEnableDevice}
        checked={config.enabled === true}
        onChange={(v) => upd("enabled", v)}
      />

      {config.enabled && (
        <>
          {pickerOpen && (
            <MediaPickerModal
              open
              multiple={false}
              onClose={() => setPickerOpen(false)}
              onSelect={(urls) => { if (urls[0]) upd("image", urls[0]); setPickerOpen(false); }}
            />
          )}

          {/* ── Trigger ── */}
          <Divider />
          <Text as="h3" variant="headingSm">{c.popupTriggerHeading}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.popupTriggerType}
              options={c.popupTriggerOptions()}
              value={config.trigger || "delay"}
              onChange={(v) => upd("trigger", v)}
            />
            {(config.trigger === "delay" || !config.trigger) && (
              <TextField
                label={c.delaySeconds}
                type="number"
                value={String(config.delay ?? 3)}
                onChange={(v) => upd("delay", Number(v) || 0)}
                autoComplete="off"
                min={0}
              />
            )}
            {config.trigger === "scroll" && (
              <TextField
                label={c.scrollDepthPct}
                type="number"
                value={String(config.scroll_pct ?? 40)}
                onChange={(v) => upd("scroll_pct", Math.min(100, Math.max(0, Number(v) || 0)))}
                autoComplete="off"
                min={0}
                max={100}
              />
            )}
            <Select
              label={c.displayFrequency}
              options={c.popupFrequencyOptions()}
              value={config.frequency || "session"}
              onChange={(v) => upd("frequency", v)}
            />
          </div>

          {/* ── Content ── */}
          <Divider />
          <Text as="h3" variant="headingSm">{c.content}</Text>
          <TextField
            label={c.heading}
            value={config.title || ""}
            onChange={(v) => upd("title", v)}
            autoComplete="off"
          />
          <RichTextEditor
            label={c.textBody}
            value={config.body || ""}
            onChange={(v) => upd("body", v)}
            placeholder={c.popupContentPh}
            minHeight="100px"
          />
          <ImageField
            label={`${c.image} ${c.optional}`}
            value={config.image || ""}
            onPick={() => setPickerOpen(true)}
            onClear={() => upd("image", "")}
          />
          <div style={EDITOR_FIELD_GRID}>
            <TextField
              label={c.buttonText}
              value={config.btn_text || ""}
              onChange={(v) => upd("btn_text", v)}
              autoComplete="off"
            />
            <TextField
              label={c.buttonUrl}
              value={config.btn_url || ""}
              onChange={(v) => upd("btn_url", v)}
              autoComplete="off"
            />
          </div>
          <div style={EDITOR_FIELD_GRID}>
            <ColorField label={c.buttonBg} value={config.btn_bg || "#111827"} onChange={(v) => upd("btn_bg", v)} />
            <ColorField label={c.buttonTextColor} value={config.btn_color || "#ffffff"} onChange={(v) => upd("btn_color", v)} />
            <TextField label={c.buttonRadius} value={String(config.btn_radius ?? 8)} onChange={(v) => upd("btn_radius", Number(v) || 0)} autoComplete="off" />
          </div>

          {/* ── Design ── */}
          <Divider />
          <Text as="h3" variant="headingSm">{c.designAndPosition}</Text>
          <div style={EDITOR_FIELD_GRID}>
            <Select
              label={c.position}
              options={c.popupPositionOptions()}
              value={config.position || "center"}
              onChange={(v) => upd("position", v)}
            />
            <Select
              label={c.animation}
              options={c.popupAnimationOptions()}
              value={config.animation || "fade"}
              onChange={(v) => upd("animation", v)}
            />
            <TextField
              label={`${c.widthLabel} (${c.widthPh})`}
              value={config.width || "600px"}
              onChange={(v) => upd("width", v)}
              autoComplete="off"
            />
            <TextField
              label={`${c.maxHeight} (${c.maxHeightPh})`}
              value={config.max_height || "80vh"}
              onChange={(v) => upd("max_height", v)}
              autoComplete="off"
            />
          </div>
          <div style={EDITOR_FIELD_GRID}>
            <ColorField label={c.backgroundColor} value={config.bg_color || "#ffffff"} onChange={(v) => upd("bg_color", v)} />
            <ColorField label={c.textColor} value={config.text_color || "#111827"} onChange={(v) => upd("text_color", v)} />
            <TextField
              label={c.cornerRadius}
              type="number"
              value={String(config.border_radius ?? 16)}
              onChange={(v) => upd("border_radius", Number(v) || 0)}
              autoComplete="off"
            />
            <TextField
              label={c.overlayOpacity}
              type="number"
              value={String(config.overlay ?? 0.5)}
              onChange={(v) => upd("overlay", Math.min(1, Math.max(0, parseFloat(v) || 0)))}
              autoComplete="off"
            />
          </div>
          <Checkbox
            label={c.showCloseButton}
            checked={config.show_close !== false}
            onChange={(v) => upd("show_close", v)}
          />
        </>
      )}
    </BlockStack>
  );
}

function PopupEditor({ settings, onChange }) {
  const c = useLandingCopy();
  const [deviceTab, setDeviceTab] = useState(0);
  const popup = settings?.popup || {};

  const deviceKeys = ["desktop", "tablet", "mobile"];
  const currentKey = deviceKeys[deviceTab] || "desktop";
  const currentConfig = { ...POPUP_DEVICE_DEFAULTS, ...(popup[currentKey] || {}) };

  const handleDeviceChange = (updated) => {
    onChange({ popup: { ...popup, [currentKey]: updated } });
  };

  return (
    <BlockStack gap="400">
      <Banner tone="info">
        <p>
          {c.popupBanner}
        </p>
      </Banner>
      <Card>
        <PolarisTabs
          tabs={[
            { id: "popup-d", content: c.desktop },
            { id: "popup-t", content: c.tablet },
            { id: "popup-m", content: c.mobile },
          ]}
          selected={deviceTab}
          onSelect={setDeviceTab}
        >
          <Box paddingBlockStart="400">
            <PopupDeviceEditor key={currentKey} config={currentConfig} onChange={handleDeviceChange} />
          </Box>
        </PolarisTabs>
      </Card>
    </BlockStack>
  );
}

export default function LandingPageEditor() {
  const uiLocale = useLocale();
  const copy = useMemo(() => getLandingEditorCopy(uiLocale), [uiLocale]);
  const containerTypes = useMemo(() => getContainerTypesFromLocale(uiLocale), [uiLocale]);
  const containerTypeGroups = useMemo(
    () => groupContainerTypes(containerTypes, uiLocale),
    [containerTypes, uiLocale]
  );
  const [containerSearch, setContainerSearch] = useState("");
  const filteredContainerTypeGroups = useMemo(() => {
    const q = containerSearch.trim().toLowerCase();
    if (!q) return containerTypeGroups;
    return containerTypeGroups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (t) => t.label?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [containerTypeGroups, containerSearch]);
  const client = getMedusaAdminClient();
  const unsaved = useUnsavedChanges();

  // ── Top-level tab: 0 = Seiten, 1 = Templates
  const [mainTab, setMainTab] = useState(0);
  /** Landing-Inhalt: Texte + Bilder pro Shop-Sprache (_i18n); „de“ = Root-Felder + Fallback im Shop */
  const [contentEditLang, setContentEditLang] = useState("de");
  // Templates: 0 = Desktop, 1 = Mobil (Kollektions- / Kategorie-Raster)
  const [templateDeviceTab, setTemplateDeviceTab] = useState(0);

  // ── Template settings (collection + category)
  const [tmpl, setTmpl] = useState(TEMPLATE_DEFAULTS);
  const [tmplSaving, setTmplSaving] = useState(false);
  const [tmplSaved, setTmplSaved] = useState(false);
  const [tmplErr, setTmplErr] = useState("");
  const [tmplSnapshot, setTmplSnapshot] = useState(JSON.stringify(TEMPLATE_DEFAULTS));

  const loadTemplates = useCallback(async () => {
    try {
      const data = await client.getStyles();
      const merged = mergeLoadedShopStyles(data?.styles || {});
      const loaded = {
        collection_template: { ...TEMPLATE_DEFAULTS.collection_template, ...(merged.collection_template || {}) },
        category_template:   { ...TEMPLATE_DEFAULTS.category_template,   ...(merged.category_template   || {}) },
      };
      setTmpl(loaded);
      setTmplSnapshot(JSON.stringify(loaded));
    } catch (_) {}
  }, [client]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const saveTemplates = useCallback(async () => {
    setTmplSaving(true);
    setTmplErr("");
    setTmplSaved(false);
    try {
      // Mevcut styles'ı al, sadece template alanlarını güncelle
      const data = await client.getStyles();
      const current = data?.styles || {};
      await client.saveStyles({ ...current, collection_template: tmpl.collection_template, category_template: tmpl.category_template });
      setTmplSnapshot(JSON.stringify(tmpl));
      setTmplSaved(true);
      setTimeout(() => setTmplSaved(false), 3500);
    } catch (e) {
      setTmplErr(e?.message || copy.saveError);
    }
    setTmplSaving(false);
  }, [client, tmpl]);

  const updateTmpl = (section, key, val) =>
    setTmpl((prev) => ({ ...prev, [section]: { ...prev[section], [key]: val } }));

  const tmplDirty = JSON.stringify(tmpl) !== tmplSnapshot;

  const [pages, setPages] = useState([]);
  const [selectedPageId, setSelectedPageId] = useState(DEFAULT_PAGE_ID);
  const [containers, setContainers] = useState([]);
  const [isDirty, setIsDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [activeTab, setActiveTab] = useState(0);
  /** Seiten → Container: 0 = Desktop, 1 = Tablet (600–1199px), 2 = Mobil (≤599px) */
  const [seitenDeviceTab, setSeitenDeviceTab] = useState(0);
  const [categoryRows, setCategoryRows] = useState([]);
  const [categorySettings, setCategorySettings] = useState({ show_submenu_left: false });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([
        client.getPages({ limit: 200 }),
        client.getAdminHubCategories().catch(() => ({ categories: [] })),
      ])
        .then(([r, catRes]) => {
          if (cancelled) return;
          const list = Array.isArray(r?.pages) ? r.pages : [];
          setPages(list);
          const tree = catRes?.tree || catRes?.categories || [];
          const flat = flattenCategoriesForSelect(Array.isArray(tree) ? tree : []);
          setCategoryRows(flat);
        })
        .catch((e) => {
          if (cancelled) return;
          setPages([]);
          setErr(copy.loadPagesError + ": " + (e?.message || copy.saveError));
        });
    load();
    // Retry once shortly after mount — token/localStorage can race on first paint.
    const t = setTimeout(load, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, copy.loadPagesError, copy.saveError]);

  const loadContainers = useCallback(async (pageId) => {
    if (!pageId) return;
    setLoading(true);
    setErr("");
    try {
      let data;
      if (pageId === DEFAULT_PAGE_ID) {
        data = await client.request("/admin-hub/landing-page");
        setCategorySettings(normalizeLandingPageSettings(data?.settings));
      } else if (String(pageId).startsWith("cat:")) {
        const cid = String(pageId).slice(4);
        data = await client.getLandingPageCategoryContainers(cid);
        setCategorySettings(normalizeLandingPageSettings(data?.settings));
      } else {
        data = await client.getLandingPageContainers(pageId);
        setCategorySettings(normalizeLandingPageSettings(data?.settings));
      }
      setContainers(Array.isArray(data?.containers) ? data.containers : []);
    } catch (e) {
      setContainers([]);
      setCategorySettings(normalizeLandingPageSettings({}));
      setErr(e?.message || copy.loadContainersError);
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    if (!selectedPageId) return;
    if (String(selectedPageId).startsWith("api:")) {
      const slug = API_CMS_SLUG[selectedPageId];
      const hit = pages.find((p) => String(p.slug) === slug);
      if (hit?.id) loadContainers(String(hit.id));
      else setContainers([]);
      return;
    }
    loadContainers(selectedPageId);
  }, [selectedPageId, pages, loadContainers]);

  const resolveSavePageId = useCallback(() => {
    if (String(selectedPageId).startsWith("api:")) {
      const slug = API_CMS_SLUG[selectedPageId];
      const hit = pages.find((p) => String(p.slug) === slug);
      return hit?.id ? String(hit.id) : null;
    }
    return selectedPageId;
  }, [selectedPageId, pages]);

  const handleSave = useCallback(async () => {
    if (!selectedPageId) return;
    setSaving(true);
    setErr("");
    setSaved(false);
    try {
      if (selectedPageId === DEFAULT_PAGE_ID) {
        await client.request("/admin-hub/landing-page", {
          method: "PUT",
          body: JSON.stringify({ containers, settings: categorySettings }),
        });
      } else if (String(selectedPageId).startsWith("cat:")) {
        const cid = String(selectedPageId).slice(4);
        await client.saveLandingPageCategoryContainers(cid, { containers, settings: categorySettings });
      } else {
        const pageId = resolveSavePageId();
        if (!pageId) throw new Error(copy.loadContainersError);
        await client.saveLandingPageContainers(pageId, { containers, settings: categorySettings });
      }
      setSaved(true);
      setIsDirty(false);
      setTimeout(() => setSaved(false), 4000);
    } catch (e) {
      setErr(e?.message || copy.saveError);
    }
    setSaving(false);
  }, [selectedPageId, containers, categorySettings, client, resolveSavePageId, copy.loadContainersError, copy.saveError]);

  const handleDiscard = useCallback(async () => {
    setIsDirty(false);
    const pageId = resolveSavePageId();
    if (pageId) await loadContainers(pageId);
  }, [resolveSavePageId, loadContainers]);

  // Wire up top-bar Save/Discard buttons via UnsavedChanges context
  useEffect(() => {
    unsaved?.setDirty(isDirty);
    if (!isDirty) {
      unsaved?.clearHandlers();
      return;
    }
    unsaved?.setHandlers({ onSave: handleSave, onDiscard: handleDiscard });
    return () => unsaved?.clearHandlers();
  }, [isDirty, handleSave, handleDiscard]);

  // Reset dirty state and viewport-Tab when switching pages
  useEffect(() => {
    setIsDirty(false);
    setSeitenDeviceTab(0);
  }, [selectedPageId]);

  /**
   * Reiter = Ziel-Viewport: neue Container bekommen visible_on per Tab (addContainer).
   * Tab 0 = Desktop, Tab 1 = Tablet, Tab 2 = Mobil.
   * Legacy: visible_on "both" erscheint in Desktop- und Mobil-Reitern (kein Tablet).
   */
  const matchContainerSeitenTab = (c, tab) => {
    const v = c.visible_on || "desktop";
    if (tab === 0) return v === "both" || v === "desktop";
    if (tab === 1) return v === "tablet";
    return v === "both" || v === "mobile";
  };

  const filteredSeitenContainers = useMemo(() => {
    if (!Array.isArray(containers)) return [];
    return containers.filter((c) => matchContainerSeitenTab(c, seitenDeviceTab));
  }, [containers, seitenDeviceTab]);

  const addContainer = (type) => {
    const created = newContainer(type);
    const seed = getNewContainerSeed(uiLocale, type);
    const base = { ...created, ...seed };
    if (Array.isArray(seed.slides) && Array.isArray(created.slides)) {
      base.slides = created.slides.map((s, i) => ({ ...s, ...(seed.slides[i] || {}) }));
    }
    if (Array.isArray(seed.items) && Array.isArray(created.items)) {
      base.items = created.items.map((s, i) => ({ ...s, ...(seed.items[i] || {}) }));
    }
    if (Array.isArray(seed.tabs) && Array.isArray(created.tabs)) {
      base.tabs = created.tabs.map((s, i) => ({ ...s, ...(seed.tabs[i] || {}) }));
    }
    const isTabletTab = seitenDeviceTab === 1;
    const isMobileTab = seitenDeviceTab === 2;
    const carouselTypes = ["collection_carousel", "collections_carousel", "blog_carousel"];
    const narrowOverrides = (isTabletTab || isMobileTab) && carouselTypes.includes(type)
      ? { items_per_row: 2, items_per_row_mobile: 2 }
      : {};
    const visible_on = isMobileTab ? "mobile" : isTabletTab ? "tablet" : "desktop";
    const c = { ...base, ...narrowOverrides, visible_on };
    setContainers((prev) => [...prev, c]);
    setExpandedId(c.id);
    setAddModalOpen(false);
    setIsDirty(true);
  };

  /** Duplicate a container to the Mobile tab (tab 2). Original becomes desktop-only; copy becomes mobile-only. */
  const duplicateToMobile = (srcId) => {
    const src = containers.find((c) => c.id === srcId);
    if (!src) return;
    const copy = {
      ...src,
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      visible_on: "mobile",
      ...(["collection_carousel", "collections_carousel", "blog_carousel", "image_carousel"].includes(src.type)
        ? { items_per_row: 2, items_per_row_mobile: 2 }
        : {}),
    };
    setContainers((prev) => [
      ...prev.map((c) => c.id === srcId ? { ...c, visible_on: "desktop" } : c),
      copy,
    ]);
    setExpandedId(copy.id);
    setSeitenDeviceTab(2);
    setIsDirty(true);
  };

  /** Duplicate a container to the Tablet tab (tab 1). Original keeps its visible_on; copy becomes tablet-only. */
  const duplicateToTablet = (srcId) => {
    const src = containers.find((c) => c.id === srcId);
    if (!src) return;
    const copy = {
      ...src,
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      visible_on: "tablet",
      ...(["collection_carousel", "collections_carousel", "blog_carousel", "image_carousel"].includes(src.type)
        ? { items_per_row: 3, items_per_row_mobile: 3 }
        : {}),
    };
    setContainers((prev) => [...prev, copy]);
    setExpandedId(copy.id);
    setSeitenDeviceTab(1);
    setIsDirty(true);
  };

  /** Duplicate a container to the Desktop tab. Original becomes mobile-only; copy becomes desktop-only. */
  const duplicateToDesktop = (srcId) => {
    const src = containers.find((c) => c.id === srcId);
    if (!src) return;
    const copy = {
      ...src,
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      visible_on: "desktop",
    };
    setContainers((prev) => [
      ...prev.map((c) => c.id === srcId ? { ...c, visible_on: "mobile" } : c),
      copy,
    ]);
    setExpandedId(copy.id);
    setSeitenDeviceTab(0);
    setIsDirty(true);
  };

  const updateContainer = (id, updated) => { setContainers((prev) => prev.map((c) => c.id === id ? updated : c)); setIsDirty(true); };
  const removeContainer = (id) => { setContainers((prev) => prev.filter((c) => c.id !== id)); if (expandedId === id) setExpandedId(null); setIsDirty(true); };

  /** Reihenfolge nur innerhalb des aktuellen Desktop- bzw. Mobil-Reiters. */
  const moveContainerInSeitenTab = (id, dir) => {
    setContainers((prev) => {
      const inTab = prev.filter((c) => matchContainerSeitenTab(c, seitenDeviceTab));
      const pos = inTab.findIndex((c) => c.id === id);
      if (pos < 0) return prev;
      const newPos = pos + dir;
      if (newPos < 0 || newPos >= inTab.length) return prev;
      const idA = id;
      const idB = inTab[newPos].id;
      const iA = prev.findIndex((c) => c.id === idA);
      const iB = prev.findIndex((c) => c.id === idB);
      if (iA < 0 || iB < 0) return prev;
      const n = [...prev];
      [n[iA], n[iB]] = [n[iB], n[iA]];
      return n;
    });
    setIsDirty(true);
  };

  const typeInfo = (type) => containerTypes.find((t) => t.type === type) || { label: type };
  const cmsPages  = sortCmsPagesForSelect(pages.filter((p) => p.page_type !== "blog"));
  const blogPosts = pages.filter((p) => p.page_type === "blog");
  const pageOptions = [
    { label: copy.selectPlaceholder, value: "" },
    { label: copy.homepage, value: "__default__" },
    { label: copy.cmsPagesHeading, value: PAGE_HEADING, disabled: true },
    ...(cmsPages.length
      ? cmsPages.map((p) => ({ label: `${p.title || copy.defaultPage} (/${p.slug || p.id})`, value: String(p.id) }))
      : [{ label: copy.noCmsPages, value: "__no_page__", disabled: true }]),
    { label: copy.blogPostsHeading, value: BLOG_HEADING, disabled: true },
    ...(blogPosts.length
      ? blogPosts.map((p) => ({ label: `${p.title || copy.defaultPost} (/${p.slug || p.id})`, value: String(p.id) }))
      : [{ label: copy.noBlogPosts, value: "__no_blog__", disabled: true }]),
    { label: copy.apiPagesHeading, value: API_HEADING, disabled: true },
    { label: copy.apiBestsellerLabel, value: "api:bestsellers" },
    { label: copy.apiSaleLabel, value: "api:sales" },
    { label: copy.apiNeuheitenLabel, value: "api:neuheiten" },
    { label: copy.apiBrandsLabel, value: "api:brands" },
  ];
  const isCategorySelection = String(selectedPageId).startsWith("cat:");
  const isApiSelection = String(selectedPageId).startsWith("api:");
  const apiHasSettings = selectedPageId === "api:bestsellers" || selectedPageId === "api:sales";
  const linkedCmsForApi = isApiSelection
    ? pages.find((p) => String(p.slug) === API_CMS_SLUG[selectedPageId])
    : null;
  const showContainerEditor = selectedPageId && (!isApiSelection || !!linkedCmsForApi);
  const editorTabs = [
    { id: "containers", content: copy.tabContainers },
    { id: "category", content: copy.tabCategory },
    { id: "filter", content: copy.tabFilterBar },
    { id: "popup", content: copy.tabPopup },
  ];

  const apiPageLabel =
    selectedPageId === "api:bestsellers" ? copy.apiBestsellerLabel
      : selectedPageId === "api:sales" ? copy.apiSaleLabel
        : selectedPageId === "api:neuheiten" ? copy.apiNeuheitenLabel
          : selectedPageId === "api:brands" ? copy.apiBrandsLabel
            : copy.apiBestsellerLabel;

  const mainTabs = [
    { id: "seiten", content: copy.tabPages },
    { id: "templates", content: copy.tabTemplates },
  ];

  return (
    <LandingCopyContext.Provider value={copy}>
    <Page
      title={copy.pageTitle}
      subtitle={copy.pageSubtitle}
      primaryAction={mainTab === 1 ? {
        content: tmplSaving ? copy.saving : copy.save,
        onAction: saveTemplates,
        loading: tmplSaving,
        disabled: !tmplDirty,
      } : undefined}
    >
      <Layout>
        {err && <Layout.Section><Banner tone="critical" onDismiss={() => setErr("")}>{err}</Banner></Layout.Section>}
        {saved && <Layout.Section><Banner tone="success" onDismiss={() => setSaved(false)}>{copy.saved}</Banner></Layout.Section>}
        {tmplErr && <Layout.Section><Banner tone="critical" onDismiss={() => setTmplErr("")}>{tmplErr}</Banner></Layout.Section>}
        {tmplSaved && <Layout.Section><Banner tone="success" onDismiss={() => setTmplSaved(false)}>{copy.templateSaved}</Banner></Layout.Section>}

        {/* ── Hauptnavigation: Seiten / Templates ── */}
        <Layout.Section>
          <Card>
            <PolarisTabs tabs={mainTabs} selected={mainTab} onSelect={setMainTab} />
          </Card>
        </Layout.Section>

        {/* ── TAB 0: Seiten ── */}
        {mainTab === 0 && <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">{copy.selectPage}</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {copy.selectPageHelp}{" "}
                <a href="/content/pages" style={{ color: "var(--p-color-text-emphasis)" }}>{copy.managePagesLink}</a>
              </Text>
              <Select
                label={copy.pageLabel}
                labelHidden
                options={pageOptions}
                value={selectedPageId}
                onChange={(v) => {
                  if (!v || v === CAT_HEADING || v === PAGE_HEADING || v === BLOG_HEADING || v === API_HEADING || v === "__no_cat__" || v === "__no_page__" || v === "__no_blog__") return;
                  setSelectedPageId(v);
                  setExpandedId(null);
                  setActiveTab(0);
                }}
              />
            </BlockStack>
          </Card>
        </Layout.Section>}

        {mainTab === 0 && selectedPageId && isApiSelection && apiHasSettings && (
          <Layout.Section>
            <Card>
              <ApiPageSettingsPanel
                slug={String(selectedPageId).slice(4)}
                pageLabel={apiPageLabel}
              />
            </Card>
          </Layout.Section>
        )}

        {mainTab === 0 && selectedPageId && isApiSelection && (
          <Layout.Section>
            <Banner tone="info">
              <p>{copy.apiContainersHint}</p>
              {linkedCmsForApi ? (
                <p style={{ marginTop: 8 }}>
                  CMS: <strong>{linkedCmsForApi.title}</strong> (/{linkedCmsForApi.slug})
                </p>
              ) : (
                <p style={{ marginTop: 8 }}>{copy.noCmsPages}</p>
              )}
            </Banner>
          </Layout.Section>
        )}

        {mainTab === 0 && showContainerEditor && (
          <Layout.Section>
            <Card>
              <PolarisTabs tabs={editorTabs} selected={activeTab} onSelect={setActiveTab}>
                <Box paddingBlockStart="400">
                  {activeTab === 1 && (
                    <BlockStack gap="400">
                      <Text as="p" variant="bodySm" tone="subdued">{copy.categoryTabIntro}</Text>
                      <Checkbox
                        label={copy.showSubcategoriesLeft}
                        helpText={
                          isCategorySelection
                            ? copy.showSubcategoriesHelpCat
                            : copy.showSubcategoriesHelpOther
                        }
                        checked={categorySettings.show_submenu_left === true}
                        onChange={(checked) => {
                          setCategorySettings((prev) => ({ ...prev, show_submenu_left: checked }));
                          setIsDirty(true);
                        }}
                      />
                      <Checkbox
                        label={copy.showFilterBar}
                        helpText={copy.showFilterBarHelp}
                        checked={categorySettings.show_filter_bar !== false}
                        onChange={(checked) => {
                          setCategorySettings((prev) => ({ ...prev, show_filter_bar: checked }));
                          setIsDirty(true);
                        }}
                      />
                      <Checkbox
                        label={copy.secondNavClassic}
                        helpText={copy.secondNavClassicHelp}
                        checked={categorySettings.second_nav_desktop_classic === true}
                        onChange={(checked) => {
                          setCategorySettings((prev) => ({ ...prev, second_nav_desktop_classic: checked }));
                          setIsDirty(true);
                        }}
                      />
                      <TextField
                        label={copy.pagePaddingTop}
                        helpText={copy.pagePaddingTopHelp}
                        value={categorySettings.page_padding_top || ""}
                        onChange={(v) => {
                          setCategorySettings((prev) => ({ ...prev, page_padding_top: v }));
                          setIsDirty(true);
                        }}
                        autoComplete="off"
                        placeholder="0px"
                      />
                    </BlockStack>
                  )}

                  {activeTab === 2 && (
                    <BlockStack gap="400">
                      <Text as="p" variant="bodySm" tone="subdued">{copy.filterBarTemplateHelp}</Text>
                      <Checkbox
                        label={copy.showProductFilterBar}
                        helpText={copy.showProductFilterBarHelp}
                        checked={categorySettings.show_product_filter_bar === true}
                        onChange={(checked) => {
                          setCategorySettings((prev) => ({ ...prev, show_product_filter_bar: checked }));
                          setIsDirty(true);
                        }}
                      />
                      <Banner tone="info">
                        <p>{copy.stylesSidebarNavHint}</p>
                      </Banner>
                    </BlockStack>
                  )}

                  {activeTab === 3 && (
                    <PopupEditor
                      settings={categorySettings}
                      onChange={(partial) => {
                        setCategorySettings((prev) => ({ ...prev, ...partial }));
                        setIsDirty(true);
                      }}
                    />
                  )}

                  {activeTab === 0 && (
                    <>
                      {loading ? (
                        <Box paddingBlock="600"><Text as="p" tone="subdued" alignment="center">{copy.loading}</Text></Box>
                      ) : (
                        <BlockStack gap="400">
                          <Card>
                            <PolarisTabs
                              tabs={[
                                { id: "seiten-d", content: copy.desktop },
                                { id: "seiten-t", content: copy.tablet },
                                { id: "seiten-m", content: copy.mobile },
                              ]}
                              selected={seitenDeviceTab}
                              onSelect={setSeitenDeviceTab}
                            />
                          </Card>

                          <Banner tone="info">
                            <p><strong>{copy.editLanguage}:</strong> {copy.langBanner}</p>
                          </Banner>
                          <div style={{ maxWidth: 320 }}>
                            <Select
                              label={copy.editLanguage}
                              options={shopContentLangOptions(uiLocale)}
                              value={contentEditLang}
                              onChange={setContentEditLang}
                            />
                          </div>

                          {isCategorySelection && (
                            <Banner tone="success">{copy.categoryBanner}</Banner>
                          )}

                          {containers.length === 0 && (
                            <Box paddingBlock="600">
                              <BlockStack gap="300" align="center">
                                <Text as="p" variant="bodyLg" tone="subdued" alignment="center">{copy.noContainers}</Text>
                                <InlineStack align="center">
                                  <Button variant="primary" onClick={() => setAddModalOpen(true)}>{copy.addContainer}</Button>
                                </InlineStack>
                              </BlockStack>
                            </Box>
                          )}

                          {containers.length > 0 && filteredSeitenContainers.length === 0 && (
                            <Banner tone="info">
                              {seitenDeviceTab === 0
                                ? copy.noDesktopBlocks
                                : seitenDeviceTab === 1
                                ? copy.noTabletBlocks
                                : copy.noMobileBlocks}
                            </Banner>
                          )}

                          {filteredSeitenContainers.map((c, idx) => {
                            const info = typeInfo(c.type);
                            const isExpanded = expandedId === c.id;
                            const vis = c.visible_on || "desktop";
                            const isLegacyBoth = vis === "both";
                            const last = idx === filteredSeitenContainers.length - 1;
                            const gLabel = groupLabel(info.group || "content", uiLocale);
                            return (
                              <Card key={c.id}>
                                <BlockStack gap="0">
                                  <Box paddingBlockEnd={isExpanded ? "400" : "0"}>
                                    <InlineStack align="space-between" blockAlign="center" gap="300">
                                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                                        <ContainerTypePreview type={c.type} label={info.label} />
                                        <BlockStack gap="100">
                                          <InlineStack gap="200" blockAlign="center" wrap>
                                            <Text as="h3" variant="headingSm">{info.label}</Text>
                                            <Badge>{gLabel}</Badge>
                                            <Badge tone={c.visible ? "success" : undefined}>{c.visible ? copy.visible : copy.hidden}</Badge>
                                            {isLegacyBoth && <Badge tone="info">{copy.legacyBoth}</Badge>}
                                            <Text as="span" variant="bodySm" tone="subdued">#{idx + 1}</Text>
                                          </InlineStack>
                                        </BlockStack>
                                      </InlineStack>
                                      <InlineStack gap="200" blockAlign="center">
                                        <Button size="slim" onClick={() => { updateContainer(c.id, { ...c, visible: !c.visible }); }}>{c.visible ? copy.hide : copy.show}</Button>
                                        <Button size="slim" disabled={idx === 0} onClick={() => moveContainerInSeitenTab(c.id, -1)}>↑</Button>
                                        <Button size="slim" disabled={last} onClick={() => moveContainerInSeitenTab(c.id, 1)}>↓</Button>
                                        <Button size="slim" variant={isExpanded ? "primary" : "secondary"} onClick={() => setExpandedId(isExpanded ? null : c.id)}>
                                          {isExpanded ? copy.collapse : copy.edit}
                                        </Button>
                                      </InlineStack>
                                    </InlineStack>
                                  </Box>
                                  {isExpanded && (
                                    <>
                                      <Divider />
                                      <Box paddingBlockStart="400">
                                        <ContainerEditor container={c} onChange={(updated) => updateContainer(c.id, updated)} deviceTab={seitenDeviceTab} editLang={contentEditLang} />
                                        <Box paddingBlockStart="400">
                                          <InlineStack align="end">
                                            <Button size="slim" tone="critical" onClick={async () => { if (await confirmDelete(copy.removeContainerConfirm)) removeContainer(c.id); }}>
                                              {copy.remove}
                                            </Button>
                                          </InlineStack>
                                        </Box>
                                      </Box>
                                    </>
                                  )}
                                </BlockStack>
                              </Card>
                            );
                          })}

                          {!loading && containers.length > 0 && (
                            <InlineStack>
                              <Button onClick={() => setAddModalOpen(true)}>{copy.addContainerShort}</Button>
                            </InlineStack>
                          )}
                        </BlockStack>
                      )}
                    </>
                  )}
                </Box>
              </PolarisTabs>
            </Card>
          </Layout.Section>
        )}

        {/* ── TAB 1: Templates ── */}
        {mainTab === 1 && (
          <>
            <Layout.Section>
              <Card>
                <PolarisTabs
                  tabs={[
                    { id: "t-desktop", content: copy.desktop },
                    { id: "t-mobil", content: copy.mobile },
                    { id: "t-filter", content: copy.tabFilterBar },
                  ]}
                  selected={templateDeviceTab}
                  onSelect={setTemplateDeviceTab}
                />
                <Box paddingBlockStart="300">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {templateDeviceTab === 0
                      ? copy.templateDesktopHint
                      : templateDeviceTab === 1
                        ? copy.templateMobileHint
                        : copy.filterBarTemplateHelp}
                  </Text>
                </Box>
              </Card>
            </Layout.Section>

            {templateDeviceTab === 2 && (
              <Layout.Section>
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">{copy.filterBarTemplateTitle}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{copy.filterBarTemplateHelp}</Text>
                    </BlockStack>
                    <Divider />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                      <Select
                        label={copy.filterSidebar}
                        options={copy.sidebarShowHideOptions()}
                        value={tmpl.category_template.show_sidebar === false ? "false" : "true"}
                        onChange={(v) => {
                          updateTmpl("category_template", "show_sidebar", v === "true");
                          updateTmpl("collection_template", "show_sidebar", v === "true");
                        }}
                      />
                      <TextField
                        label={copy.filterCheckboxSize}
                        type="number"
                        min={8}
                        max={14}
                        value={String(tmpl.category_template.filter_checkbox_size ?? 10)}
                        onChange={(v) => {
                          const n = Math.min(14, Math.max(8, parseInt(v, 10) || 10));
                          updateTmpl("category_template", "filter_checkbox_size", n);
                          updateTmpl("collection_template", "filter_checkbox_size", n);
                        }}
                        autoComplete="off"
                        helpText={copy.filterCheckboxSizeHelp}
                      />
                      <TextField
                        label={copy.sidebarWidth}
                        value={tmpl.category_template.sidebar_width}
                        onChange={(v) => updateTmpl("category_template", "sidebar_width", v)}
                        autoComplete="off"
                        helpText={copy.sidebarWidthHelpCategory}
                      />
                    </div>
                    <Banner tone="info">
                      <p>{copy.stylesSidebarNavHint}</p>
                    </Banner>
                  </BlockStack>
                </Card>
              </Layout.Section>
            )}

            {templateDeviceTab === 0 && (
            <>
            {/* Kollektion-Template — Desktop */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">{copy.collectionTemplate}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {copy.collectionTemplateHelp}
                    </Text>
                  </BlockStack>
                  <Divider />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                    <Select
                      label={copy.bannerStyle}
                      options={[
                        { label: copy.bannerStyleStrip, value: "strip" },
                        { label: copy.bannerStyleMedium, value: "medium" },
                        { label: copy.bannerStyleTall, value: "tall" },
                        { label: copy.bannerStyleNone, value: "none" },
                      ]}
                      value={tmpl.collection_template.banner_style}
                      onChange={(v) => updateTmpl("collection_template", "banner_style", v)}
                    />
                    <Select
                      label={copy.productsPerRow}
                      options={[2,3,4,5,6].map((n) => ({ label: String(n), value: String(n) }))}
                      value={String(tmpl.collection_template.products_per_row)}
                      onChange={(v) => updateTmpl("collection_template", "products_per_row", Number(v))}
                    />
                    <Select
                      label={copy.filterSidebar}
                      options={copy.sidebarShowHideOptions()}
                      value={tmpl.collection_template.show_sidebar === false ? "false" : "true"}
                      onChange={(v) => updateTmpl("collection_template", "show_sidebar", v === "true")}
                    />
                    <TextField
                      label={copy.sidebarWidth}
                      value={tmpl.collection_template.sidebar_width}
                      onChange={(v) => updateTmpl("collection_template", "sidebar_width", v)}
                      autoComplete="off"
                      helpText={copy.sidebarWidthHelpCollection}
                    />
                    <Select
                      label={copy.descriptionAlign}
                      options={copy.alignLeftCenterOptions()}
                      value={tmpl.collection_template.richtext_align}
                      onChange={(v) => updateTmpl("collection_template", "richtext_align", v)}
                    />
                    <Select
                      label={copy.descriptionWidth}
                      options={copy.descriptionWidthOptions()}
                      value={tmpl.collection_template.richtext_max_width}
                      onChange={(v) => updateTmpl("collection_template", "richtext_max_width", v)}
                    />
                    <TextField
                      label={copy.pagePaddingX}
                      value={tmpl.collection_template.content_padding_x}
                      onChange={(v) => updateTmpl("collection_template", "content_padding_x", v)}
                      autoComplete="off"
                      helpText={copy.pagePaddingHelp}
                    />
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>

            {/* Kategorie-Template — Desktop */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">{copy.categoryTemplate}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {copy.categoryTemplateHelp}
                    </Text>
                  </BlockStack>
                  <Divider />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                    <Select
                      label={copy.bannerStyle}
                      options={[
                        { label: copy.bannerStyleStrip, value: "strip" },
                        { label: copy.bannerStyleMedium, value: "medium" },
                        { label: copy.bannerStyleTall, value: "tall" },
                        { label: copy.bannerStyleNone, value: "none" },
                      ]}
                      value={tmpl.category_template.banner_style}
                      onChange={(v) => updateTmpl("category_template", "banner_style", v)}
                    />
                    <Select
                      label={copy.productsPerRow}
                      options={[2,3,4,5,6].map((n) => ({ label: String(n), value: String(n) }))}
                      value={String(tmpl.category_template.products_per_row ?? 4)}
                      onChange={(v) => updateTmpl("category_template", "products_per_row", Number(v))}
                    />
                    <Select
                      label={copy.navSidebar}
                      options={copy.sidebarShowHideOptions()}
                      value={tmpl.category_template.show_sidebar === false ? "false" : "true"}
                      onChange={(v) => updateTmpl("category_template", "show_sidebar", v === "true")}
                    />
                    <TextField
                      label={copy.sidebarWidth}
                      value={tmpl.category_template.sidebar_width}
                      onChange={(v) => updateTmpl("category_template", "sidebar_width", v)}
                      autoComplete="off"
                      helpText={copy.sidebarWidthHelpCategory}
                    />
                    <Select
                      label={copy.descriptionAlign}
                      options={copy.alignLeftCenterOptions()}
                      value={tmpl.category_template.richtext_align}
                      onChange={(v) => updateTmpl("category_template", "richtext_align", v)}
                    />
                    <Select
                      label={copy.descriptionWidth}
                      options={copy.descriptionWidthOptions()}
                      value={tmpl.category_template.richtext_max_width}
                      onChange={(v) => updateTmpl("category_template", "richtext_max_width", v)}
                    />
                    <TextField
                      label={copy.pagePaddingX}
                      value={tmpl.category_template.content_padding_x}
                      onChange={(v) => updateTmpl("category_template", "content_padding_x", v)}
                      autoComplete="off"
                      helpText={copy.pagePaddingHelp}
                    />
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>
            </>
            )}

            {templateDeviceTab === 1 && (
            <>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">{copy.collectionTemplateMobile}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{copy.mobileCollectionHelp}</Text>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                    <Select
                      label={copy.visibleSideBySideMobile}
                      options={[1,2,3,4].map((n) => ({ label: String(n), value: String(n) }))}
                      value={String(tmpl.collection_template.products_per_row_mobile ?? 2)}
                      onChange={(v) => updateTmpl("collection_template", "products_per_row_mobile", Number(v))}
                    />
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">{copy.categoryTemplateMobile}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{copy.mobileCategoryHelp}</Text>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
                    <Select
                      label={copy.visibleSideBySideMobile}
                      options={[1,2,3,4].map((n) => ({ label: String(n), value: String(n) }))}
                      value={String(tmpl.category_template.products_per_row_mobile ?? 2)}
                      onChange={(v) => updateTmpl("category_template", "products_per_row_mobile", Number(v))}
                    />
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>
            </>
            )}
          </>
        )}

        <Modal
          open={addModalOpen}
          onClose={() => { setAddModalOpen(false); setContainerSearch(""); }}
          title={copy.selectContainer}
          size="large"
        >
          <Modal.Section>
            <BlockStack gap="500">
              <Text as="p" variant="bodySm" tone="subdued">
                {copy.containerGroupsHint}
              </Text>
              <TextField
                label={copy.searchContainers}
                labelHidden
                value={containerSearch}
                onChange={setContainerSearch}
                placeholder={copy.searchContainersPlaceholder}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setContainerSearch("")}
              />
              {filteredContainerTypeGroups.length === 0 && (
                <Text as="p" tone="subdued" alignment="center">{copy.noContainersFound}</Text>
              )}
              {filteredContainerTypeGroups.map((group) => (
                <BlockStack key={group.id} gap="300">
                  <Text as="h3" variant="headingSm">{group.label}</Text>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {group.items.map((t) => (
                      <div
                        key={t.type}
                        style={{
                          border: "1px solid var(--p-color-border, #e1e3e5)",
                          borderRadius: 10,
                          background: "var(--p-color-bg-surface, #fff)",
                          padding: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          minHeight: 148,
                        }}
                      >
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <ContainerTypePreview type={t.type} label={t.label} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <BlockStack gap="100">
                              <Text as="p" variant="bodyMd" fontWeight="semibold">{t.label}</Text>
                              <Text as="p" variant="bodySm" tone="subdued">{t.description}</Text>
                            </BlockStack>
                          </div>
                        </InlineStack>
                        <div style={{ marginTop: "auto" }}>
                          <Button variant="primary" size="slim" fullWidth onClick={() => addContainer(t.type)}>
                            {copy.choose}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </BlockStack>
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      </Layout>
    </Page>
    </LandingCopyContext.Provider>
  );
}
