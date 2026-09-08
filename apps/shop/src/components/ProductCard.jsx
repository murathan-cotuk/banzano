"use client";

import React, { useState, useContext, useRef } from "react";
import Image from "next/image";
import { Link } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CartContext } from "@/context/CartContext";
import { formatPriceCents, getLocalizedProduct, htmlToText } from "@/lib/format";
import { storefrontProductHandle } from "@/lib/product-url-handle";
import { resolveImageUrl } from "@/lib/image-url";
import { colorSwatchFallback } from "@/lib/color-swatch";
import { resolveProductListingImage, resolveProductListingImageSecondary } from "@/lib/product-locale-media";
import { optionDisplayLabel, optionCanonicalValue, variationGroupDisplayName } from "@/lib/variation-labels";
import { enrichVariationGroups } from "@/lib/product-variations";
import { useMarketPrefix } from "@/context/MarketPrefixContext";
import { useShippingCountryForQuotes } from "@/hooks/useShippingCountryForQuotes";
import { findShippingGroup, resolveShippingQuoteStrict } from "@/lib/shipping-price";
import ProductWishlistHeart from "@/components/ProductWishlistHeart";
import { CustomProductBadges } from "@/components/CustomProductBadge";
import { getBruttoCentsFromPricesMap, resolveProductSaleCents } from "@/lib/product-price";
import styled, { css } from "styled-components";

/* ─────────────────────────────────────────────────────────── *
 *  Helpers
 * ─────────────────────────────────────────────────────────── */
function resolveImg(src) {
  if (!src) return null;
  if (typeof src === "object") {
    const nested = src.url ?? src.src ?? src.path ?? "";
    return nested ? resolveImageUrl(String(nested)) : null;
  }
  return resolveImageUrl(src) || null;
}

// Known dummy/placeholder hosts sometimes left in swatch data (e.g. "example.com/img/swatch-x.jpg"
// from a demo import) — these always 404 and are noisy in the console for no visual benefit since
// the CSS color-fallback swatch already covers the "no real image" case anyway.
const PLACEHOLDER_IMAGE_HOSTS = ["example.com", "example.org", "example.net"];
function resolveSwatchImg(src) {
  const url = resolveImg(src);
  if (!url) return null;
  try {
    const host = new URL(url, "https://placeholder.invalid").hostname;
    if (PLACEHOLDER_IMAGE_HOSTS.includes(host)) return null;
  } catch (_) {}
  return url;
}

/* ─────────────────────────────────────────────────────────── *
 *  Styled components
 * ─────────────────────────────────────────────────────────── */

const Card = styled.article`
  position: relative;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 10px;
  overflow: hidden;
  height: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  @media (max-width: 767px) {
    border-radius: 8px;
  }
`;

/* Image block: keep full image visible (no crop). */
const ImgBlock = styled.div`
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: #fff;
  isolation: isolate;
  @media (max-width: 767px) {
    aspect-ratio: 1 / 1;
  }

  /* Only product photos — never style Sellercentral badge images */
  img.img-primary,
  img.img-secondary {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #fff;
    padding: 2px;
    box-sizing: border-box;
    display: block;
    transition: none;
  }

  img.img-primary {
    z-index: 1;
  }
  img.img-secondary {
    display: none !important;
  }

  /* Badge images render via next/image \`fill\` (CustomProductBadge.jsx) — they now WANT the
     same absolute-fill treatment as img-primary/img-secondary above, not the old static/auto
     override that predates that conversion. */
  img.product-custom-badge-img {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    max-height: none !important;
    padding: 0 !important;
    object-fit: contain !important;
  }
`;

const ImgPlaceholder = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ccc;
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
`;

const AddToCartBtn = styled.button`
  width: calc(100% - 12px);
  margin: 5px 6px 0;
  padding: 7px 10px;
  @media (max-width: 767px) {
    margin-top: 3px;
  }
  background: #111;
  color: #fff;
  border: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  &:hover:not(:disabled) { background: #333; }
  &:disabled { opacity: 0.5; cursor: not-allowed; background: #999; }
`;

const QtyRow = styled.div`
  width: calc(100% - 12px);
  margin: 4px 6px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #f3f4f6;
  overflow: hidden;
`;

const QtyBtn = styled.button`
  width: 30px;
  height: 28px;
  border: 0;
  background: transparent;
  color: #6b7280;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: #e5e7eb;
    color: #111827;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const QtyInput = styled.input`
  flex: 1;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  letter-spacing: 0.02em;
  border: 0;
  background: transparent;
  outline: none;
  min-width: 0;
  padding: 0 4px;
  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  &[type="number"] {
    -moz-appearance: textfield;
  }
`;

const CartNotice = styled.div`
  margin: 6px 10px 0;
  font-size: 12.5px;
  font-weight: 700;
  color: #065f46;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.28);
  border-radius: 10px;
  padding: 8px 10px;
  text-align: center;
  opacity: ${(p) => (p.$visible ? 1 : 0)};
  transform: translateY(${(p) => (p.$visible ? "0px" : "6px")});
  transition: opacity 250ms ease, transform 250ms ease;
  pointer-events: none;
`;

const ReviewRow = styled.div`
  margin-top: 0;
  height: 18px;
  font-size: 13px;
  @media (max-width: 767px) {
    height: 14px;
    font-size: 10px;
  }
`;

/* Badges */
const Badges = styled.div`
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  z-index: 8;
  pointer-events: none;
`;

const RankBadge = styled.span`
  display: inline-block;
  padding: 2px 5px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  letter-spacing: 0.02em;
  line-height: 1.4;
`;

const WishlistHeartWrap = styled.div`
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 50;
  pointer-events: auto;
`;

const Badge = styled.span`
  display: inline-block;
  padding: 5px 9px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 6px;
  color: #fff;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  background: ${(p) =>
    p.$sale ? "#e11d48" : p.$sold ? "#9ca3af" : p.$comingSoon ? "#c2410c" : "#18181b"};
`;

/* Info block below image — flex: 1 so all cards in a row share the same height */
const Info = styled.div`
  padding: 6px 6px 4px;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
  @media (max-width: 767px) {
    padding: 5px 5px 3px;
  }
`;

const Name = styled.h3`
  font-family: var(--h3-ff, inherit);
  font-size: 13px;
  font-weight: 500;
  color: #111;
  line-height: 1.4;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Prices = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 2px;
  margin-bottom: 1px;
`;

const CurrentPrice = styled.span`
  font-size: 15px;
  font-weight: 700;
  color: ${(p) => (p.$sale ? "#e53e3e" : "#111")};
  @media (min-width: 768px) {
    font-size: 18px;
  }
`;

const OriginalPrice = styled.span`
  font-size: 12.5px;
  color: #aaa;
  text-decoration: line-through;
`;

/* Variant groups area */
const VariantGroups = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 4px;
  min-width: 0;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
`;

const VGroupRow = styled.div`
  min-width: 0;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
`;

const VGroupLabel = styled.div`
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #888;
  margin-bottom: 3px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/* Variant pills */
const Pills = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
  @media (max-width: 767px) {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 2px;
    &::-webkit-scrollbar { display: none; }
  }
`;

const Pill = styled.button`
  padding: ${(p) => (p.$swatch ? "0" : "7px 10px")};
  width: ${(p) => (p.$swatch ? "26px" : "auto")};
  height: ${(p) => (p.$swatch ? "26px" : "auto")};
  min-width: ${(p) => (p.$swatch ? "26px" : "0")};
  max-width: ${(p) => (p.$swatch ? "26px" : "100%")};
  min-height: ${(p) => (p.$swatch ? "26px" : "32px")};
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.1;
  border-radius: ${(p) => (p.$swatch ? "50%" : "8px")};
  border: ${(p) => p.$swatch
    ? `3px solid ${p.$on ? "#111" : "#e0e0e0"}`
    : `1.5px solid ${p.$on ? "#111" : "#e0e0e0"}`};
  background: ${(p) => (p.$swatch ? "none" : p.$on ? "#111" : "transparent")};
  color: ${(p) => (p.$on ? "#fff" : p.$outOfStock ? "#bbb" : "#555")};
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s, transform 0.12s;
  transform: ${(p) => (p.$swatch && p.$on ? "scale(1.05)" : "scale(1)")};
  text-decoration: ${(p) => (p.$outOfStock && !p.$on ? "line-through" : "none")};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  ${(p) => (p.$swatch
    ? css`flex-shrink: 0;`
    : css`
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `)}
  opacity: ${(p) => (p.$outOfStock && !p.$on ? 0.5 : 1)};

  &:hover {
    border-color: #111;
    color: ${(p) => (p.$on ? "#fff" : "#111")};
  }
`;

const MorePill = styled.button`
  padding: 0 9px;
  height: 26px;
  font-size: 11px;
  font-weight: 500;
  color: #555;
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  flex-shrink: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  &:hover {
    background: #ebebeb;
    border-color: #bbb;
    color: #111;
  }
`;

/* ─────────────────────────────────────────────────────────── *
 *  Component
 * ─────────────────────────────────────────────────────────── */

export function ProductCard({ product, activeFilters = {}, plainImage = false, isBestseller: _isBestsellerProp, rank, hideBestsellerBadge: _hideBestsellerBadge = false }) {
  const locale = useLocale();
  const tp = useTranslations("product");
  const marketPrefixVal = useMarketPrefix();
  const marketCountry = (marketPrefixVal?.split("/").filter(Boolean)[0] || "de").toUpperCase();
  const countryCode = useShippingCountryForQuotes(marketCountry);
  const { title: displayTitle, description: localizedDescription } = getLocalizedProduct(product, locale);
  const cartCtx = useContext(CartContext);
  const addToCart = cartCtx?.addToCart ?? (async () => null);
  const openCartSidebar = cartCtx?.openCartSidebar ?? (() => {});
  const cartLoading = cartCtx?.loading ?? false;
  const shippingGroups = cartCtx?.shippingGroups ?? [];

  const variants = product.variants || [];
  const variationGroupsRaw = Array.isArray(product.variation_groups) && product.variation_groups.length > 0
    ? product.variation_groups : null;

  // Normalize variants for linked-group products (title "Red / S" → option_values ["Red","S"])
  const normalizedVariants = variationGroupsRaw ? variants.map((v) => {
    const ov = Array.isArray(v.option_values) ? v.option_values : [];
    if (ov.length === variationGroupsRaw.length) return v;
    const titleStr = v.title || v.value || "";
    if (!titleStr.includes(" / ")) return v;
    const parts = titleStr.split(" / ").map((s) => s.trim()).filter(Boolean);
    if (parts.length === variationGroupsRaw.length) return { ...v, option_values: parts };
    return v;
  }) : variants;

  const variationGroups = variationGroupsRaw
    ? enrichVariationGroups(variationGroupsRaw, normalizedVariants)
    : null;

  // Find best initial variant: filter-matching first, then first in-stock, then 0
  const filterVals = Object.values(activeFilters).flat().map(s => String(s).toLowerCase());
  const bestVariantIdx = (() => {
    if (filterVals.length > 0) {
      const idx = normalizedVariants.findIndex(v => {
        const ov = (Array.isArray(v.option_values) ? v.option_values : []).map(x => String(x).toLowerCase());
        return filterVals.some(fv => ov.includes(fv));
      });
      if (idx >= 0) return idx;
    }
    const stockIdx = normalizedVariants.findIndex(v => {
      const inStock = !v.manage_inventory || (v.inventory_quantity ?? v.inventory ?? 0) > 0;
      return inStock;
    });
    return stockIdx >= 0 ? stockIdx : 0;
  })();

  const [selIdx, setSelIdx] = useState(bestVariantIdx);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [cartNotice, setCartNotice] = useState({ text: "", visible: false });
  const [expandedGroups, setExpandedGroups] = useState({});
  const [expandedFlat, setExpandedFlat] = useState(false);
  const cartNoticeTimersRef = useRef({ hide: null, clear: null });

  // For grouped display: track selected option per group index
  const [selectedOpts, setSelectedOpts] = useState(() => {
    if (!variationGroups) return {};
    const target = normalizedVariants[bestVariantIdx] ?? normalizedVariants[0];
    const ov = Array.isArray(target?.option_values) ? target.option_values : [];
    const init = {};
    variationGroups.forEach((_, i) => { if (ov[i]) init[i] = ov[i]; });
    return init;
  });

  // Find variant matching all selected group options (empty = skip that group)
  const effectiveIdx = (() => {
    if (!variationGroups) return selIdx;
    const numGroups = variationGroups.length;
    const opts = variationGroups.map((_, i) => selectedOpts[i] || "");
    const idx = normalizedVariants.findIndex((v) => {
      const ov = Array.isArray(v.option_values) ? v.option_values : [];
      return ov.length === numGroups && opts.every((o, i) => !o || String(ov[i]).toLowerCase() === o.toLowerCase());
    });
    return idx >= 0 ? idx : 0;
  })();

  const variant = normalizedVariants[effectiveIdx] ?? normalizedVariants[0] ?? variants[0];

  /* Cover: selected/first child image; if that child has none, walk other children, then parent. */
  const rawImg = resolveProductListingImage(product, locale, variant);
  const imgSrc = resolveImg(rawImg);
  const rawImg2 = resolveProductListingImageSecondary(product, locale, variant);
  const imgSrc2 = resolveImg(rawImg2);

  /* Price — single EUR list price; VAT/shipping vary by market */
  const variantCountryPrice = (() => {
    const vm = variant?.metadata && typeof variant.metadata === "object" ? variant.metadata : {};
    const prices = vm.prices && typeof vm.prices === "object" ? vm.prices : {};
    return getBruttoCentsFromPricesMap(prices, countryCode, marketCountry);
  })();
  const parentCountryPrice = (() => {
    const pm = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
    const prices = pm.prices && typeof pm.prices === "object" ? pm.prices : {};
    return getBruttoCentsFromPricesMap(prices, countryCode, marketCountry);
  })();
  const priceCents =
    variantCountryPrice != null
      ? variantCountryPrice
      : (variant?.prices?.[0]?.amount != null
          ? Number(variant.prices[0].amount)
          : (parentCountryPrice != null
              ? parentCountryPrice
              : (product.price != null ? Math.round(Number(product.price) * 100) : 0)));
  const saleCents = resolveProductSaleCents(product, variant, countryCode, marketCountry);
  const hasSale = saleCents != null && saleCents > 0 && saleCents < priceCents;

  /* Flags */
  const publishDate = product.metadata?.publish_date ? new Date(product.metadata.publish_date) : null;
  const isComingSoon = publishDate && !isNaN(publishDate.getTime()) && publishDate.getTime() > Date.now();
  const managesInventory = variant?.manage_inventory === true;
  const inventoryQty = variant?.inventory_quantity ?? product.variants?.[0]?.inventory_quantity;
  const outOfStock = managesInventory && typeof inventoryQty === "number" && inventoryQty <= 0;
  const maxQty = Number(inventoryQty) > 0 ? Number(inventoryQty) : 9999;

  const meta = product.metadata || {};
  const shippingGroupIdRaw = meta.shipping_group_id;
  const shippingGroup =
    shippingGroupIdRaw != null && String(shippingGroupIdRaw).trim() !== ""
      ? findShippingGroup(shippingGroups, shippingGroupIdRaw)
      : null;
  const shippingPriceCents = shippingGroup ? resolveShippingQuoteStrict(shippingGroup.prices, countryCode || marketCountry) : null;
  const hasShippingGroup = shippingGroupIdRaw != null && String(shippingGroupIdRaw).trim() !== "" && shippingGroup != null;
  const shippingUnavailable = hasShippingGroup && shippingPriceCents === null;
  const reviewAvg = meta.review_avg != null ? Number(meta.review_avg) : 0;
  const reviewCount = meta.review_count != null ? Number(meta.review_count) : 0;

  const productHandle = storefrontProductHandle(product, locale);
  const productUrl = productHandle ? `/${productHandle}` : null;

  const handleQuickAdd = async (e) => {
    e.preventDefault();
    const vid = variant?.id;
    if (!vid || outOfStock || shippingUnavailable) return;
    setAdding(true);
    // Avoid timer races
    if (cartNoticeTimersRef.current.hide) window.clearTimeout(cartNoticeTimersRef.current.hide);
    if (cartNoticeTimersRef.current.clear) window.clearTimeout(cartNoticeTimersRef.current.clear);

    const successText = tp("addedToCart");
    const errorText = tp("addToCartFailed");

    try {
      const ok = await addToCart(vid, quantity);
      if (ok) openCartSidebar();
      setCartNotice({ text: ok ? successText : errorText, visible: true });
      cartNoticeTimersRef.current.hide = window.setTimeout(
        () => setCartNotice((s) => ({ ...s, visible: false })),
        2200
      );
      cartNoticeTimersRef.current.clear = window.setTimeout(
        () => setCartNotice({ text: "", visible: false }),
        2700
      );
    } catch {
      setCartNotice({ text: errorText, visible: true });
    }
    setAdding(false);
    // Reset grouped selection back to first variant after add
  };

  const showPills = variants.length > 1;
  const clampQty = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return 1;
    return Math.max(1, Math.floor(num));
  };

  return (
    <Card>
      {/* ── Image ── */}
      <ImgBlock $plain={plainImage}>
        {productUrl ? (
          <Link href={productUrl} aria-label={displayTitle} style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            {imgSrc ? (
              <>
                <Image className="img-primary" src={imgSrc} alt={displayTitle} fill sizes="(max-width: 767px) 50vw, 300px" referrerPolicy="no-referrer" />
                {imgSrc2 && !plainImage ? <Image className="img-secondary" src={imgSrc2} alt="" aria-hidden fill sizes="(max-width: 767px) 50vw, 300px" /> : null}
              </>
            ) : (
              <ImgPlaceholder>No image</ImgPlaceholder>
            )}
          </Link>
        ) : (
          <>
            {imgSrc ? (
              <>
                <Image className="img-primary" src={imgSrc} alt={displayTitle} fill sizes="(max-width: 767px) 50vw, 300px" referrerPolicy="no-referrer" />
                {imgSrc2 && !plainImage ? <Image className="img-secondary" src={imgSrc2} alt="" aria-hidden fill sizes="(max-width: 767px) 50vw, 300px" /> : null}
              </>
            ) : (
              <ImgPlaceholder>No image</ImgPlaceholder>
            )}
          </>
        )}

        {/* Status + Sellercentral custom badges only (no built-in Sale/Bestseller/New) */}
        <Badges>
          {rank != null && !isComingSoon && <RankBadge>#{rank}</RankBadge>}
          {isComingSoon && <Badge $comingSoon>{tp("comingSoon")}</Badge>}
          {shippingUnavailable && !isComingSoon && <Badge $sold>{tp("notAvailable")}</Badge>}
          {outOfStock && !isComingSoon && <Badge $sold>{tp("outOfStock")}</Badge>}
        </Badges>
        <CustomProductBadges badges={product?.metadata?.custom_badges} locale={locale} />
        {product?.id && (
          <WishlistHeartWrap
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <ProductWishlistHeart productId={product.id} positionAbsolute={false} />
          </WishlistHeartWrap>
        )}
      </ImgBlock>

      <AddToCartBtn
        type="button"
        onClick={handleQuickAdd}
        disabled={cartLoading || adding || outOfStock || isComingSoon || shippingUnavailable}
      >
        {adding ? "…" : isComingSoon ? tp("comingSoon") : shippingUnavailable ? tp("notAvailable") : outOfStock ? tp("outOfStock") : tp("addToCart")}
      </AddToCartBtn>

      {cartNotice.text ? <CartNotice $visible={!!cartNotice.visible}>{cartNotice.text}</CartNotice> : null}

      {/* ── Info ── */}
      <Info>
        <Link href={productUrl} style={{ textDecoration: "none" }}>
          <Name>{displayTitle}</Name>
        </Link>

        <ReviewRow>
          {reviewCount > 0 && (
            <Link href={productUrl ? `${productUrl}#reviews` : "#"} style={{ textDecoration: "none", display: "inline-flex" }}>
              <StarRating average={reviewAvg} count={reviewCount} />
            </Link>
          )}
        </ReviewRow>

        <Prices>
          {hasSale && (
            <OriginalPrice>{formatPriceCents(priceCents)} €</OriginalPrice>
          )}
          <CurrentPrice $sale={hasSale}>
            {formatPriceCents(hasSale ? saleCents : priceCents)} €
          </CurrentPrice>
        </Prices>

        {showPills && (
          variationGroups ? (
            /* Grouped display: one row per variation group */
            <VariantGroups>
              {variationGroups.map((group, gIdx) => {
                const isExpanded = !!expandedGroups[gIdx];
                const allOpts = group.options || [];
                const MAX_OPTS = 5;
                const opts = isExpanded ? allOpts : allOpts.slice(0, MAX_OPTS);
                const extra = isExpanded ? 0 : Math.max(0, allOpts.length - MAX_OPTS);
                const pMeta = product.metadata || {};
                const isSwatchGroup = allOpts.some((o) => typeof o === "object" && o.swatch_image);
                return (
                  <VGroupRow key={gIdx}>
                    <VGroupLabel>{variationGroupDisplayName(group, gIdx, pMeta, locale) || group.name}</VGroupLabel>
                    <Pills>
                      {opts.map((opt, oIdx) => {
                        const val = optionCanonicalValue(opt);
                        const displayStr = optionDisplayLabel(opt, locale) || val;
                        const swatchUrl = typeof opt === "object" && opt.swatch_image ? resolveSwatchImg(opt.swatch_image) : null;
                        const isOn = (selectedOpts[gIdx] || "").toLowerCase() === val.toLowerCase();
                        const hasStock = normalizedVariants.some((v) => {
                          const ov = Array.isArray(v.option_values) ? v.option_values : [];
                          if (String(ov[gIdx] || "").toLowerCase() !== val.toLowerCase()) return false;
                          const qty = v.inventory_quantity ?? v.inventory ?? 0;
                          return Number(qty) > 0;
                        });
                        return (
                          <Pill
                            key={oIdx}
                            $on={isOn}
                            $outOfStock={!hasStock}
                            $swatch={isSwatchGroup}
                            type="button"
                            title={displayStr}
                            onClick={(e) => {
                              e.preventDefault();
                              setSelectedOpts((prev) => ({ ...prev, [gIdx]: val }));
                            }}
                          >
                            {isSwatchGroup ? (
                              <>
                                {swatchUrl && (
                                  <Image
                                    src={swatchUrl}
                                    alt={displayStr}
                                    width={26}
                                    height={26}
                                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "50%" }}
                                    onError={(e) => {
                                      e.currentTarget.style.display = "none";
                                      const fallback = e.currentTarget.nextSibling;
                                      if (fallback) fallback.style.display = "block";
                                    }}
                                  />
                                )}
                                <span
                                  style={{
                                    display: swatchUrl ? "none" : "block",
                                    width: "100%",
                                    height: "100%",
                                    borderRadius: "50%",
                                    background: colorSwatchFallback(val),
                                  }}
                                />
                              </>
                            ) : displayStr}
                          </Pill>
                        );
                      })}
                      {extra > 0 && (
                        <MorePill
                          type="button"
                          onClick={(e) => { e.preventDefault(); setExpandedGroups((prev) => ({ ...prev, [gIdx]: true })); }}
                        >
                          +{extra}
                        </MorePill>
                      )}
                    </Pills>
                  </VGroupRow>
                );
              })}
            </VariantGroups>
          ) : (
            /* Legacy: flat pill list */
            <Pills style={{ marginTop: 4 }}>
              {normalizedVariants.slice(0, expandedFlat ? undefined : 5).map((v, i) => {
                const qty = v.inventory_quantity ?? v.inventory ?? 0;
                const outOfStock = Number(qty) <= 0;
                const swatchUrl = v.swatch_image_url ? resolveSwatchImg(v.swatch_image_url) : null;
                return (
                  <Pill
                    key={i}
                    $on={i === selIdx}
                    $outOfStock={outOfStock}
                    $swatch={!!swatchUrl}
                    type="button"
                    onClick={(e) => { e.preventDefault(); setSelIdx(i); }}
                    title={v.title || v.value || `${i + 1}`}
                  >
                    {swatchUrl ? (
                      <Image src={swatchUrl} alt={v.value || v.title || ""} width={26} height={26} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "50%" }} />
                    ) : (v.title || v.value || `${i + 1}`)}
                  </Pill>
                );
              })}
              {!expandedFlat && normalizedVariants.length > 5 && (
                <MorePill
                  type="button"
                  onClick={(e) => { e.preventDefault(); setExpandedFlat(true); }}
                >
                  +{normalizedVariants.length - 5}
                </MorePill>
              )}
            </Pills>
          )
        )}
      </Info>

      <QtyRow>
        <QtyBtn
          type="button"
          onClick={() => setQuantity((q) => clampQty(q - 1))}
          disabled={quantity <= 1 || outOfStock || isComingSoon || shippingUnavailable || adding || cartLoading}
          aria-label={tp("decreaseQty")}
        >
          −
        </QtyBtn>
        <QtyInput
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(clampQty(e.target.value))}
          onBlur={(e) => setQuantity(clampQty(e.target.value))}
          disabled={outOfStock || isComingSoon || shippingUnavailable || adding || cartLoading}
          aria-label={tp("qty")}
        />
        <QtyBtn
          type="button"
          onClick={() => setQuantity((q) => clampQty(q + 1))}
          disabled={quantity >= maxQty || outOfStock || isComingSoon || shippingUnavailable || adding || cartLoading}
          aria-label={tp("increaseQty")}
        >
          +
        </QtyBtn>
      </QtyRow>
    </Card>
  );
}

export function StarRating({ average = 0, count = 0 }) {
  const full = Math.floor(average);
  const half = average - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, lineHeight: 1 }}>
      <span aria-hidden style={{ display: "flex", fontSize: "1em" }}>
        {[...Array(full)].map((_, i) => <span key={`f${i}`} style={{ color: "#f59e0b" }}>★</span>)}
        {half ? <span style={{ color: "#f59e0b" }}>★</span> : null}
        {[...Array(empty)].map((_, i) => <span key={`e${i}`} style={{ color: "#d1d5db" }}>★</span>)}
      </span>
      <span style={{ fontSize: "0.85em", color: "#9ca3af" }}>({count})</span>
    </div>
  );
}

/* ─── Mobile list-view item (horizontal) ───────────────────── */

const ListCard = styled.article`
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
  min-width: 0;
  background: #fff;
`;

const ListImgWrap = styled.div`
  flex-shrink: 0;
  width: 110px;
  height: 110px;
  border-radius: 10px;
  overflow: hidden;
  background: #f8f8f8;
  position: relative;
  > a > img,
  > img:not(.product-custom-badge-img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    padding: 2px;
    box-sizing: border-box;
  }
  img.product-custom-badge-img {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    padding: 0 !important;
    object-fit: contain !important;
  }
`;

const ListBody = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
`;

const ListName = styled.h3`
  font-size: 13.5px;
  font-weight: 600;
  color: #111;
  line-height: 1.35;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const ListPriceRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 1px;
`;

const ListPriceMain = styled.span`
  font-size: 15px;
  font-weight: 700;
  color: ${(p) => (p.$sale ? "#e53e3e" : "#111")};
`;

const ListPriceOld = styled.span`
  font-size: 12px;
  color: #aaa;
  text-decoration: line-through;
`;

const ListShippingLine = styled.div`
  font-size: 11.5px;
  color: #6b7280;
`;

const ListCartBtn = styled.button`
  margin-top: 6px;
  padding: 8px 12px;
  background: #111;
  color: #fff;
  border: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  border-radius: 6px;
  cursor: pointer;
  align-self: flex-start;
  white-space: nowrap;
  &:hover:not(:disabled) { background: #333; }
  &:disabled { opacity: 0.45; cursor: not-allowed; background: #888; }
`;

const ListBadge = styled.span`
  display: inline-block;
  padding: 4px 8px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  border-radius: 6px;
  color: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  background: ${(p) => p.$sale ? "#e11d48" : p.$gray ? "#9ca3af" : p.$orange ? "#c2410c" : "#15803d"};
`;

export function ProductListItem({ product, activeFilters = {}, isBestseller: _isBestsellerProp }) {
  const locale = useLocale();
  const tp = useTranslations("product");
  const marketPrefixVal = useMarketPrefix();
  const marketCountry = (marketPrefixVal?.split("/").filter(Boolean)[0] || "de").toUpperCase();
  const countryCode = useShippingCountryForQuotes(marketCountry);
  const { title: displayTitle } = getLocalizedProduct(product, locale);
  const cartCtx = useContext(CartContext);
  const addToCart = cartCtx?.addToCart ?? (async () => null);
  const openCartSidebar = cartCtx?.openCartSidebar ?? (() => {});
  const cartLoading = cartCtx?.loading ?? false;
  const shippingGroups = cartCtx?.shippingGroups ?? [];

  const variants = product.variants || [];
  const variant = variants[0] ?? null;

  const [adding, setAdding] = useState(false);
  const [cartNotice, setCartNotice] = useState({ text: "", visible: false });
  const cartTimers = useRef({ hide: null, clear: null });

  const rawImg = resolveProductListingImage(product, locale, variant);
  const imgSrc = resolveImg(rawImg);

  const variantCountryPrice = (() => {
    const vm = variant?.metadata && typeof variant.metadata === "object" ? variant.metadata : {};
    const prices = vm.prices && typeof vm.prices === "object" ? vm.prices : {};
    return getBruttoCentsFromPricesMap(prices, countryCode, marketCountry);
  })();
  const parentCountryPrice = (() => {
    const pm = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
    const prices = pm.prices && typeof pm.prices === "object" ? pm.prices : {};
    return getBruttoCentsFromPricesMap(prices, countryCode, marketCountry);
  })();
  const priceCents = variantCountryPrice != null ? variantCountryPrice
    : (variant?.prices?.[0]?.amount != null ? Number(variant.prices[0].amount)
    : (parentCountryPrice != null ? parentCountryPrice
    : (product.price != null ? Math.round(Number(product.price) * 100) : 0)));
  const saleCents = resolveProductSaleCents(product, variant, countryCode, marketCountry);
  const hasSale = saleCents != null && saleCents > 0 && saleCents < priceCents;

  const meta = product.metadata || {};
  const publishDate = meta.publish_date ? new Date(meta.publish_date) : null;
  const isComingSoon = publishDate && !isNaN(publishDate.getTime()) && publishDate.getTime() > Date.now();
  const inventoryQty = variant?.inventory_quantity ?? null;
  const outOfStock = variant?.manage_inventory === true && typeof inventoryQty === "number" && inventoryQty <= 0;
  const shippingGroupIdRaw = meta.shipping_group_id;
  const shippingGroup = shippingGroupIdRaw != null && String(shippingGroupIdRaw).trim() !== "" ? findShippingGroup(shippingGroups, shippingGroupIdRaw) : null;
  const shippingPriceCents = shippingGroup ? resolveShippingQuoteStrict(shippingGroup.prices, countryCode || marketCountry) : null;
  const hasShippingGroup = shippingGroupIdRaw != null && String(shippingGroupIdRaw).trim() !== "" && shippingGroup != null;
  const shippingUnavailable = hasShippingGroup && shippingPriceCents === null;
  const reviewAvg = meta.review_avg != null ? Number(meta.review_avg) : 0;
  const reviewCount = meta.review_count != null ? Number(meta.review_count) : 0;
  const productHandle = storefrontProductHandle(product, locale);
  const productUrl = productHandle ? `/${productHandle}` : "#";

  const handleQuickAdd = async (e) => {
    e.preventDefault();
    const vid = variant?.id;
    if (!vid || outOfStock || shippingUnavailable) return;
    setAdding(true);
    if (cartTimers.current.hide) clearTimeout(cartTimers.current.hide);
    if (cartTimers.current.clear) clearTimeout(cartTimers.current.clear);
    const successText = tp("addedToCart");
    const errorText = tp("addToCartFailed");
    try {
      const ok = await addToCart(vid, 1);
      if (ok) openCartSidebar();
      setCartNotice({ text: ok ? successText : errorText, visible: true });
      cartTimers.current.hide = setTimeout(() => setCartNotice((s) => ({ ...s, visible: false })), 2200);
      cartTimers.current.clear = setTimeout(() => setCartNotice({ text: "", visible: false }), 2700);
    } catch {
      setCartNotice({ text: errorText, visible: true });
    }
    setAdding(false);
  };

  const btnLabel = adding ? "…" : isComingSoon ? tp("comingSoon")
    : shippingUnavailable ? tp("notAvailable")
    : outOfStock ? tp("outOfStock")
    : tp("addToCart");

  return (
    <ListCard>
      <Link href={productUrl} style={{ flexShrink: 0, textDecoration: "none" }}>
        <ListImgWrap>
          {imgSrc ? <Image src={imgSrc} alt={displayTitle} fill sizes="110px" style={{ objectFit: "contain" }} referrerPolicy="no-referrer" /> : null}
          <CustomProductBadges badges={product?.metadata?.custom_badges} locale={locale} />
        </ListImgWrap>
      </Link>
      <ListBody>
        <Link href={productUrl} style={{ textDecoration: "none" }}>
          <ListName>{displayTitle}</ListName>
        </Link>
        {reviewCount > 0 && <StarRating average={reviewAvg} count={reviewCount} />}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 1 }}>
          {isComingSoon && <ListBadge $orange>{tp("comingSoon")}</ListBadge>}
          {outOfStock && !isComingSoon && <ListBadge $gray>{tp("outOfStock")}</ListBadge>}
        </div>
        <ListPriceRow>
          {hasSale && <ListPriceOld>{formatPriceCents(priceCents)} €</ListPriceOld>}
          <ListPriceMain $sale={hasSale}>{formatPriceCents(hasSale ? saleCents : priceCents)} €</ListPriceMain>
        </ListPriceRow>
        {hasShippingGroup && shippingPriceCents != null && (
          <ListShippingLine>
            {shippingPriceCents === 0 ? tp("freeShipping") : `${tp("shipping")}: ${formatPriceCents(shippingPriceCents)} €`}
          </ListShippingLine>
        )}
        <ListCartBtn
          type="button"
          onClick={handleQuickAdd}
          disabled={cartLoading || adding || outOfStock || isComingSoon || shippingUnavailable}
        >
          {btnLabel}
        </ListCartBtn>
        {cartNotice.text ? (
          <CartNotice $visible={!!cartNotice.visible}>{cartNotice.text}</CartNotice>
        ) : null}
      </ListBody>
    </ListCard>
  );
}
