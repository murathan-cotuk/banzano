"use client";

import Image from "next/image";
import { useProductBadgeStyles, mergeBadgeWithLiveStyle } from "@/components/ProductBadgeStylesProvider";

/**
 * Sellercentral Product Badges over a product image.
 * Sizes and offsets are percentages of the image box so cards and PDP match
 * across mobile / tablet / desktop. Offset 0 = flush to the chosen corner.
 * Visual fields are merged with live /store/product-badges so size edits
 * appear even when product API responses are still CDN-cached.
 */

function clampPct(n, fallback, min = 0, max = 100) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Width/height: values ≤100 are %, larger numbers are legacy px → approx %. */
export function badgeSizePct(raw, fallback = 22) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n <= 100) return clampPct(n, fallback, 1, 100);
  return clampPct(Math.round((n / 360) * 100), fallback, 8, 45);
}

/** Corner inset: 0 = flush. Values ≤40 treated as %; larger = legacy px. */
export function badgeOffsetPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 40) return clampPct(n, 0, 0, 40);
  return clampPct(Math.round(n / 10), 0, 0, 30);
}

/** Text size as % of image width (cqw). Legacy px (e.g. 12) → ~3.5cqw. */
export function badgeFontPct(raw, fallback = 4.5) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n <= 20) return clampPct(n, fallback, 1.5, 20);
  return clampPct(Math.round((n / 360) * 100 * 10) / 10, fallback, 2, 12);
}

function bt(badge, field, locale) {
  if (!locale || locale === "de") return badge?.[field] ?? "";
  return badge?.i18n?.[locale]?.[field] ?? badge?.[field] ?? "";
}

function cornerBoxStyle(b, stackIndex = 0) {
  const style = {
    position: "absolute",
    zIndex: 2,
    pointerEvents: "none",
    lineHeight: 0,
    boxSizing: "border-box",
  };
  const ox = badgeOffsetPct(b.offset_x);
  const wRaw = Number(b.image_width);
  const hRaw = Number(b.image_height);
  const hasW = Number.isFinite(wRaw) && wRaw > 0;
  const hasH = Number.isFinite(hRaw) && hRaw > 0;
  const size = hasW ? badgeSizePct(wRaw, 22) : 22;
  const stack = stackIndex > 0 ? stackIndex * (size + 2) : 0;
  const oy = badgeOffsetPct(b.offset_y) + stack;

  // Image: width always (default 22%); height only when the merchant explicitly set one —
  // forcing a square default here squashes non-square badge art (e.g. a wide ribbon) into a
  // letterboxed box, visibly detaching it from the corner it's supposed to be flush against.
  // Without an explicit height the <img> below renders at its own natural aspect ratio instead.
  // Text: width/height only when merchant set them (text naturally sizes to its content).
  if (b.badge_type === "image") {
    style.width = `${size}%`;
    if (hasH) style.height = `${badgeSizePct(hRaw, size)}%`;
  } else {
    if (hasW) style.width = `${size}%`;
    if (hasH) style.height = `${badgeSizePct(hRaw, hasW ? size : 22)}%`;
  }

  if (b.position === "top-left") {
    style.top = `${oy}%`;
    style.left = `${ox}%`;
  } else if (b.position === "top-right") {
    style.top = `${oy}%`;
    style.right = `${ox}%`;
  } else if (b.position === "bottom-left") {
    style.bottom = `${oy}%`;
    style.left = `${ox}%`;
  } else {
    style.bottom = `${oy}%`;
    style.right = `${ox}%`;
  }
  return style;
}

function textStyle(b) {
  const fs = badgeFontPct(b.font_size, 4.5);
  const br = Number(b.border_radius);
  const bw = Number(b.border_width);
  const hasW = Number.isFinite(Number(b.image_width)) && Number(b.image_width) > 0;
  const hasH = Number.isFinite(Number(b.image_height)) && Number(b.image_height) > 0;
  // Padding scales with font size so “Schriftgröße” also changes visual bulk
  // (Sellercentral has no separate padding field for text badges).
  const padY = Math.max(0.12, Math.min(0.55, fs * 0.055));
  const padX = Math.max(0.28, Math.min(0.9, fs * 0.1));
  return {
    display: hasW || hasH ? "flex" : "inline-block",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: hasW ? "100%" : undefined,
    height: hasH ? "100%" : undefined,
    background: b.bg_color || "#e53935",
    color: b.text_color || "#ffffff",
    fontSize: `${fs}cqw`,
    borderWidth: Number.isFinite(bw) && bw > 0 ? `${Math.min(bw, 8) * 0.15}cqw` : 0,
    borderStyle: "solid",
    borderColor: b.border_color || "#000000",
    borderRadius: Number.isFinite(br) ? `${Math.max(0, br) * 0.12}cqw` : "0.2cqw",
    padding: `${padY}em ${padX}em`,
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: hasW ? "normal" : "nowrap",
    textAlign: "center",
    overflow: "hidden",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.16)",
  };
}

/** Single badge absolutely positioned over the product image box. */
export default function CustomProductBadge({ badge, stackIndex = 0, locale }) {
  const { byId } = useProductBadgeStyles();
  const b = mergeBadgeWithLiveStyle(badge, byId);
  if (!b) return null;
  if (b.badge_type === "image") {
    const imageUrl = bt(b, "image_url", locale);
    if (!imageUrl) return null;
    const hasExplicitHeight = Number.isFinite(Number(b.image_height)) && Number(b.image_height) > 0;
    return (
      <div style={cornerBoxStyle(b, stackIndex)}>
        {hasExplicitHeight ? (
          // Both dimensions known → box has real width+height, next/image `fill` can reserve
          // space for it without distorting the badge's own aspect ratio.
          <Image
            className="product-custom-badge-img"
            src={imageUrl}
            alt={bt(b, "label", locale) || ""}
            fill
            sizes="120px"
            loading="lazy"
            style={{
              objectFit: "contain",
              padding: 0,
              margin: 0,
              border: "none",
              boxShadow: "none",
              background: "transparent",
            }}
            draggable={false}
          />
        ) : (
          // No configured height → let the image render at its own natural aspect ratio
          // (width 100%, height auto) instead of forcing it into a square box, which would
          // letterbox non-square badge art and visibly detach it from the corner it should
          // sit flush against.
          <img
            className="product-custom-badge-img-auto"
            src={imageUrl}
            alt={bt(b, "label", locale) || ""}
            loading="lazy"
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              maxWidth: "none",
              maxHeight: "none",
              objectFit: "contain",
              position: "static",
              inset: "auto",
              padding: 0,
              margin: 0,
              border: "none",
              boxShadow: "none",
              background: "transparent",
            }}
            draggable={false}
          />
        )}
      </div>
    );
  }
  const label = bt(b, "label", locale);
  if (!label) return null;
  return (
    <div style={cornerBoxStyle(b, stackIndex)}>
      <span style={textStyle(b)}>{label}</span>
    </div>
  );
}

/**
 * Overlay layer: fills the product image container so % / cqw resolve against that box.
 * Parent must be position:relative (ImgBlock, MainImageWrap, etc.).
 */
export function CustomProductBadges({ badges, locale }) {
  if (!Array.isArray(badges) || badges.length === 0) return null;
  const seenAtPosition = {};
  return (
    <div
      className="product-custom-badges-layer"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        pointerEvents: "none",
        containerType: "size",
        overflow: "hidden",
      }}
      aria-hidden
    >
      {badges.map((b) => {
        const stackIndex = seenAtPosition[b.position] || 0;
        seenAtPosition[b.position] = stackIndex + 1;
        return (
          <CustomProductBadge
            key={b.id || `${b.position}-${stackIndex}-${b.label}`}
            badge={b}
            stackIndex={stackIndex}
            locale={locale}
          />
        );
      })}
    </div>
  );
}
