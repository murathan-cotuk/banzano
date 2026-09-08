"use client";

/**
 * Navbar — scroll-linked chrome (0→1): desktop header + second nav slide up gradually;
 * mobile/tablet (≤1023px): scroll down → logo + search bar side by side (scaled); other chrome hides.
 * Alt bar (MobileNav) uses the same progress when theme enables recess on scroll.
 */

import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter as useNextRouter } from "next/navigation";
import { Link, usePathname } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import styled from "styled-components";
import { motion } from "framer-motion";
import { useCustomerAuth as useAuth, getToken } from "@andertal/lib";
import { getMedusaClient } from "@/lib/medusa-client";
import { useCart } from "@/context/CartContext";
import DropdownSearch from "@/components/DropdownSearch";
import ShopTopBar from "@/components/ShopTopBar";
import UserDropdownPanel from "@/components/UserDropdown";
import { SHOP_THEME_CSS_UPDATED } from "@/components/ShopStylesInjector";
import { tokens } from "@/design-system/tokens";
import { routing } from "@/i18n/routing";
import {
  parseMarketPath,
  marketPrefix,
  restPathFromPathname,
  defaultCurrencyForMarket,
  DEFAULT_MARKET,
  DEFAULT_CURRENCY,
} from "@/lib/shop-market";
import { useMarketPrefix } from "@/context/MarketPrefixContext";
import { useLandingChrome } from "@/context/LandingChromeContext";
import {
  CHROME_HIDE_SCROLL_PX,
  MOBILE_CHROME_SCROLL_THRESHOLD_PX as SCROLL_THRESHOLD,
  useMobileBottomNavScroll,
} from "@/context/MobileBottomNavScrollContext";
import { getShippableCountries } from "@/lib/countries";
import { menuItemHref } from "@/lib/shop-menu-href";
import { buildHeaderSurfaceCssVarsFromRoute, effectiveGradientEnabled, resolveSecondNavLinkStyles, resolveViewportTier, pickShopLogoSlot } from "@andertal/shop-theme";
import { useShopStyles } from "@/context/ShopStylesContext";
import { detectShopHeaderRouteScope } from "@/lib/header-route-scope";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";
import { extractSolidTintFromChromeCss } from "@/lib/header-status-tint";
import { applyDocumentFavicon } from "@/lib/apply-document-favicon";
import { resolveImageUrl } from "@/lib/image-url";
import { pickCategoryListImageRaw } from "@/lib/category-list-image";
import { findCategoryNodeById, mapCategoryNodesToMenuRows, shouldCategoryMenuDrill } from "@/lib/category-menu-rows";

/** Yukarı kaydırırken titreşimi süzmek için (alt menüyü tekrar göster) */
const SCROLL_UP_DELTA = 6;

function backdropBlurFromToken(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "blur(0px)";
  if (/blur\s*\(/i.test(s)) return s;
  return `blur(${s})`;
}
/** Ignore “scroll up” when near the document bottom (rubber-band / overscroll / addr. bar) to avoid header ↔ spacer feedback jitter */
const BOTTOM_IGNORE_SCROLL_UP_PX = 28;
const MIDDLE_BAR_BG = "#1b8880";
/** @media (max-width) for mobile/tablet header chrome (matches mega menu breakpoint) */
const HEADER_NARROW_MQ = 1023;

function writeCurrencyCookie(code) {
  if (typeof document === "undefined") return;
  const c = String(code || "").toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) return;
  document.cookie = `andertal_currency=${encodeURIComponent(c)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

function categoryRefFromMenuItem(item) {
  if (!item || String(item.link_type || "").toLowerCase() !== "category") return "";
  const raw = item.link_value;
  let value = String(raw || "").trim();
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      value = String(parsed?.slug || parsed?.handle || parsed?.id || value).trim();
    } catch (_) {}
  }
  return value.replace(/^\//, "").toLowerCase();
}

/** Map category slug → id from /store/categories tree (for menu items that only store slug). */
function walkCategorySlugMap(nodes, outMap) {
  if (!Array.isArray(nodes)) return;
  for (const n of nodes) {
    if (!n) continue;
    const key = String(n.slug || n.handle || "").trim().toLowerCase();
    if (key) outMap.set(key, String(n.id).trim().toLowerCase());
    if (n.children && n.children.length) walkCategorySlugMap(n.children, outMap);
  }
}

function menuItemDepth(item, idToItem) {
  let d = 0;
  let cur = item;
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(String(cur.parent_id))) {
    seen.add(String(cur.parent_id));
    d += 1;
    cur = idToItem.get(String(cur.parent_id));
    if (!cur) break;
  }
  return d;
}

const HeaderWrap = styled.header`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2147483600;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  will-change: transform;
  overflow: visible;

  /*
   * Status-bar / notch strip (in-viewport). Must sit at top:0 inside the padded
   * header — NOT at top:-safe-area (that paints above the screen and never shows).
   * Paint uses the same value as the navbar surface (--narrow-header-safe-fill).
   */
  &::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: env(safe-area-inset-top, 0px);
    background: var(
      --narrow-header-safe-fill,
      var(--header-chrome-bg, var(--header-bg, ${MIDDLE_BAR_BG}))
    );
    pointer-events: none;
    z-index: 0;
  }

  &[data-mobile-compact="true"] {
    @media (max-width: ${HEADER_NARROW_MQ}px) {
      background: transparent;
    }
  }

  @media (max-width: ${HEADER_NARROW_MQ}px) {
    background: var(--header-chrome-bg, var(--header-bg, ${MIDDLE_BAR_BG}));
    /* Push logo/search/icons below the OS status bar; ::before fills that inset. */
    padding-top: env(safe-area-inset-top, 0px);
  }
`;

/* Keep middle bar above mega panels so icon dropdowns render on top */
const HEADER_MIDDLE_Z = 3;

/** Einheitlicher Hintergrund für Hauptleiste + Second Nav (Farbe / Verlauf via Theme-CSS) */
const HeaderChrome = styled.div`
  width: 100%;
  position: relative;
  z-index: ${HEADER_MIDDLE_Z};

  @media (max-width: ${HEADER_NARROW_MQ}px) {
    ${(p) => {
      const t = Math.min(1, Math.max(0, p.$compactProgress ?? 0));
      return t > 0.02
        ? `box-shadow: 0 2px 8px rgba(0,0,0,${0.1 * t});`
        : "";
    }}
  }
`;

const MiddleBarWrap = styled.div`
  width: 100%;
  min-height: var(--header-h, 72px);
  background-color: transparent;
  color: var(--header-text, #111827);
  transition: color 0.28s ease, backdrop-filter 0.28s ease, min-height 0.28s ease;
  position: relative;
  z-index: ${HEADER_MIDDLE_Z};

  @media (max-width: ${HEADER_NARROW_MQ}px) {
    min-height: ${(p) => {
      const t = Math.min(1, Math.max(0, p.$compactProgress ?? 0));
      return `calc(${1 - t} * var(--header-h, 72px) + ${t} * var(--header-h-compact, var(--header-h, 72px)))`;
    }};
  }
`;

const MiddleBarInner = styled.div`
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 24px;
  min-height: var(--header-h, 72px);
  display: flex;
  align-items: center;

  /* Desktop's 24px side padding ate ~13% of a phone's width before any content even started
     (logo/search bar visibly cramped away from the edges) — mobile gets a much tighter inset. */
  @media (max-width: ${HEADER_NARROW_MQ}px) {
    padding: 0 10px;
    min-height: ${(p) => {
      const t = Math.min(1, Math.max(0, p.$compactProgress ?? 0));
      return `calc(${1 - t} * var(--header-h, 72px) + ${t} * var(--header-h-compact, var(--header-h, 72px)))`;
    }};
  }
`;

const MiddleBarLeft = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-shrink: 0;
`;

const MiddleBarLogo = styled(Link)`
  color: var(--header-text, #fff);
  font-size: 1.35rem;
  font-weight: 700;
  font-family: ${tokens.fontFamily.sans};
  text-decoration: none;
  padding: 0 4px 0 0;
  letter-spacing: -0.02em;
  transition: opacity 0.2s ease;
  display: flex;
  align-items: center;
  max-height: 200px;
  overflow: hidden;

  &:hover {
    opacity: 0.92;
    color: var(--header-text, #fff);
  }
`;

const MiddleBarCenter = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  margin-left: 28px;
  margin-right: 4px;
  gap: 0;
`;

const NarrowHeaderChrome = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
`;

/* Kategorien dropdown hemen search bar'ın solunda */
const CategoriesDropdown = styled.div`
  position: relative;
  flex-shrink: 0;
  margin-right: 4px;

  /* On mobile the bottom nav handles menu; hide header hamburger */
  @media (max-width: 767px) {
    display: none !important;
  }
`;

/* ── Mega menu nav (desktop only) ─────────────────────────── */
const MegaNav = styled.nav`
  display: none;
  @media (min-width: 1024px) {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    margin-right: 12px;
    height: var(--header-h, 72px);
  }
`;

const MegaNavItem = styled.div`
  position: relative;
  display: flex;
  align-items: stretch;
`;

/* Shared visual style for both link and button variants */
const megaNavItemCss = `
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding: 0 14px;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  color: var(--header-text, #fff);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;

  &:hover,
  &[data-active="true"] {
    background: rgba(255, 255, 255, 0.12);
    border-bottom-color: rgba(255, 255, 255, 0.8);
    color: var(--header-text, #fff);
  }
`;

const MegaNavLink = styled(Link)`
  ${megaNavItemCss}
`;

const MegaNavBtn = styled.button`
  ${megaNavItemCss}
`;

/* Full-width mega panel — absolutely positioned below the header */
const MegaPanel = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: #fff;
  border-top: 3px solid var(--shop-primary, #1b8880);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.13);
  z-index: 5000;
  overflow: hidden;
  max-height: ${(p) => (p.$open ? "480px" : "0")};
  transition: max-height 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: ${(p) => (p.$open ? "auto" : "none")};

  @media (max-width: 1023px) {
    display: none;
    border-top: none;
  }
`;

const MegaPanelInner = styled.div`
  max-width: 1280px;
  margin: 0 auto;
  padding: 28px 32px 32px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 36px;
`;

const MegaChildLink = styled(Link)`
  display: block;
  padding: 6px 10px;
  font-size: 13.5px;
  font-family: ${tokens.fontFamily.sans};
  color: ${tokens.dark[700]};
  text-decoration: none;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 0.13s ease, color 0.13s ease;

  &:hover {
    background: ${tokens.background.soft};
    color: var(--shop-primary, ${tokens.primary.DEFAULT});
    text-decoration: none;
  }
`;

const CategoriesButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  background: transparent;
  color: #fff !important;
  cursor: pointer;

  &:hover {
    opacity: 0.85;
  }
`;

/* Search bar: tek pill konteyner (div; içteki DropdownSearch kendi form'unu kullanır, form içinde form olmaz) */
const SearchBarForm = styled.div`
  flex: 1;
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  height: 37px;
  padding: 0 4px 0 12px;
  background: #fff;
  border-radius: 9999px;
  box-shadow: 0 1px 8px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03);
  transition: box-shadow 0.2s ease, transform 0.2s ease, height 0.2s ease;

  &:focus-within {
    box-shadow: 0 2px 14px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04);
  }
`;

const SearchBarButton = styled.button`
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-right: 12px;
  color: #6b7280;
  flex-shrink: 0;
  &:focus {
    outline: none;
  }
  &:hover {
    color: #374151;
  }
`;

const SearchBarInputWrap = styled.div`
  flex: 1;
  min-width: 0;
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
`;

const MiddleBarSearch = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
`;

const MiddleBarRight = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  position: relative;
  z-index: 10;
  color: #fff;
`;

const MiddleBarIconBtn = styled.button`
  width: 46px;
  height: 46px;
  border: none;
  background: transparent;
  color: #fff !important;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  transition: background 0.2s ease, color 0.2s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.14);
    color: #fff !important;
  }

  svg {
    color: #fff;
  }
`;

const MiddleBarCartBtn = styled(MiddleBarIconBtn)`
  position: relative;
  @media (max-width: 767px) {
    display: none !important;
  }
`;

const MiddleBarCartBadge = styled.span`
  position: absolute;
  top: 6px;
  right: 6px;
  background: #fff;
  color: ${MIDDLE_BAR_BG};
  border-radius: 50%;
  min-width: 18px;
  height: 18px;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
`;


/* Locale dropdown trigger – sadece ikon */
const MiddleBarLocaleBtn = styled(MiddleBarIconBtn)``;

/* User dropdown — hidden on mobile (bottom nav handles account) */
const MiddleBarUserWrap = styled.div`
  button {
    color: #fff !important;
  }

  @media (max-width: 767px) {
    display: none !important;
  }
`;

/* Tablet/mobile: panel unter der Leiste. Desktop: feste linke Sidebar + Backdrop */
const CategoryMegaBackdrop = styled.div`
  display: none;
  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.38);
    z-index: 2147483590;
    opacity: ${(p) => (p.$open ? 1 : 0)};
    visibility: ${(p) => (p.$open ? "visible" : "hidden")};
    transition: opacity 0.28s ease, visibility 0.28s ease;
    pointer-events: ${(p) => (p.$open ? "auto" : "none")};
  }
`;

const CategoryMegaPanel = styled.div`
  z-index: 2147483595;

  @media (max-width: ${HEADER_NARROW_MQ}px) {
    /* fixed + top: HeaderWrap transform ile fixed çökmesin — portal body + üst ofset */
    position: fixed;
    top: ${(p) => `${Math.max(52, Number(p.$topPx) || 0)}px`};
    left: 0;
    right: 0;
    background: #fff;
    border-top: 3px solid var(--shop-primary, #1b8880);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.13);
    overflow: hidden;
    max-height: ${(p) => (p.$open ? "600px" : "0")};
    transition: max-height 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: ${(p) => (p.$open ? "auto" : "none")};
  }

  @media (max-width: 767px) {
    border-top: none;
  }

  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    position: fixed;
    left: 0;
    top: ${(p) => `${Math.max(52, Number(p.$topPx) || 0)}px`};
    bottom: 0;
    width: min(400px, 38vw);
    right: auto;
    background: #fff;
    border: none;
    border-right: 1px solid #e5e7eb;
    box-shadow: 8px 0 44px rgba(0, 0, 0, 0.14);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: none;
    transform: translateX(${(p) => (p.$open ? "0" : "-100%")});
    transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: ${(p) => (p.$open ? "auto" : "none")};
  }
`;

const CategoryMegaSidebarHead = styled.div`
  display: none;
  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 14px 16px;
    border-bottom: 1px solid #e5e7eb;
    font-size: 15px;
    font-weight: 700;
    color: ${tokens.dark[800]};
    font-family: ${tokens.fontFamily.sans};
  }
`;

const CategoryMegaSidebarClose = styled.button`
  display: none;
  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin: -8px -10px -8px 0;
    padding: 0;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: ${tokens.dark[600]};
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
    &:hover {
      background: ${tokens.background.soft};
      color: ${tokens.dark[800]};
    }
  }
`;

const CategoryMegaInner = styled.div`
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 32px 28px;
  display: flex;
  gap: 0 8px;
  overflow-x: auto;

  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    flex: 1;
    min-height: 0;
    max-width: none;
    margin: 0;
    padding: 10px 12px 28px;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
`;

const CategoryMegaCol = styled.div`
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 160px;
`;

const CategoryMegaLink = styled(Link)`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  font-size: 13.5px;
  font-family: ${tokens.fontFamily.sans};
  color: ${tokens.dark[700]};
  text-decoration: none;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 0.13s ease, color 0.13s ease;

  &:hover {
    background: ${tokens.background.soft};
    color: var(--shop-primary, ${tokens.primary.DEFAULT});
  }

  @media (min-width: ${HEADER_NARROW_MQ + 1}px) {
    white-space: normal;
    padding: 10px 14px;
    border-radius: 8px;
    min-height: 56px;
  }
`;

const CategoryMegaThumb = styled.img`
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  background: #e5e7eb;
  flex-shrink: 0;
`;

const CategoryMegaThumbPlaceholder = styled.div`
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: linear-gradient(135deg, #e5e7eb 0%, #d1d5db 100%);
  flex-shrink: 0;
`;

const CategoryMegaLinkLabel = styled.span`
  flex: 1;
  min-width: 0;
  line-height: 1.35;
`;

const CategoryMegaBtnLink = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 14px;
  font-size: 13.5px;
  font-family: ${tokens.fontFamily.sans};
  font-weight: 600;
  color: ${tokens.dark[700]};
  text-decoration: none;
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  transition: background 0.13s ease, color 0.13s ease;

  &:hover {
    background: ${tokens.background.soft};
    color: var(--shop-primary, ${tokens.primary.DEFAULT});
  }
`;

const CategoryMegaSidebarCol = styled.div`
  flex-shrink: 0;
  width: 200px;
  border-right: 1px solid #e8e8e6;
  padding-right: 12px;
  margin-right: 12px;
  display: flex;
  flex-direction: column;
`;

const CategoryMegaRootLink = styled(Link)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13.5px;
  font-family: ${tokens.fontFamily.sans};
  color: ${(p) => (p.$active ? "var(--shop-primary, " + tokens.primary.DEFAULT + ")" : tokens.dark[700])};
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  background: ${(p) => (p.$active ? tokens.background.soft : "transparent")};
  text-decoration: none;
  border-radius: 6px;
  white-space: nowrap;
  transition: background 0.13s ease, color 0.13s ease;
  cursor: pointer;

  &:hover {
    background: ${tokens.background.soft};
    color: var(--shop-primary, ${tokens.primary.DEFAULT});
  }
`;

const CategoryMegaSubCols = styled.div`
  flex: 1;
  display: flex;
  gap: 0 8px;
  overflow-x: auto;
  align-content: flex-start;
`;


/* Keep for minimal bar & dropdowns */
const Right = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const NavDivider = styled.span`
  width: 1px;
  height: 24px;
  background: ${tokens.border.light};
`;

const IconBtn = styled(Link)`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: ${tokens.dark[600]};
  transition: background ${tokens.transition.base}, color ${tokens.transition.base};

  &:hover {
    background: ${tokens.background.soft};
    color: ${tokens.primary.DEFAULT};
  }
`;

const CartBtn = styled(IconBtn)`
  position: relative;
`;

const CartBadge = styled.span`
  position: absolute;
  top: 6px;
  right: 6px;
  background: ${tokens.primary.DEFAULT};
  color: white;
  border-radius: 50%;
  min-width: 18px;
  height: 18px;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid ${tokens.background.main};
`;

const UserMenu = styled.div`
  position: relative;
  z-index: 9999;
`;

const UserBtn = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: none;
  background: transparent;
  border-radius: 50%;
  color: ${tokens.dark[600]};
  cursor: pointer;
  transition: background ${tokens.transition.base}, color ${tokens.transition.base};

  &:hover {
    background: ${tokens.background.soft};
    color: ${tokens.primary.DEFAULT};
  }
`;


/* Outer clipper — collapses max-height AND clips SubNavWrap border via overflow:hidden */
const SubNavClipper = styled.div`
  width: 100%;
  overflow: hidden;
  max-height: ${(p) => {
    if (p.$chromeCover) return `var(--second-nav-h, 50px)`;
    const t = Math.min(1, Math.max(0, p.$hideProgress ?? 0));
    return `calc(var(--second-nav-h, 50px) * ${1 - t})`;
  }};
  opacity: ${(p) => 1 - Math.min(1, Math.max(0, p.$hideProgress ?? 0))};
  pointer-events: ${(p) => ((p.$hideProgress ?? 0) >= 0.95 ? "none" : "auto")};
`;

const SubNavWrap = styled.div`
  width: 100%;
  background: var(--second-nav-bg, transparent);
  overflow: hidden;
  display: flex;
  align-items: center;
  color: var(--second-nav-text, #374151);
  font-size: var(--second-nav-fs, 15px);
  font-weight: var(--second-nav-fw, 500);
  position: relative;
  z-index: 0;

  @media (max-width: ${HEADER_NARROW_MQ}px) {
    font-size: 13px;
  }
`;

const SecondMenuRowInner = styled.div`
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 ${tokens.containerPadding};
  display: flex;
  gap: ${tokens.spacing.lg};
  align-items: center;
  justify-content: flex-start;
  font-size: 15px;
  min-height: 42px;

  @media (max-width: 1023px) {
    overflow-x: auto;
    flex-wrap: nowrap;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 0 12px;
    gap: 16px;
    &::-webkit-scrollbar { display: none; }
  }
`;

const SecondLink = styled(Link)`
  color: var(--second-nav-text, ${tokens.dark[600]});
  font-weight: inherit;
  font-family: ${tokens.fontFamily.sans};
  text-decoration: none;
  transition: color ${tokens.transition.base}, opacity ${tokens.transition.base};
  display: inline-flex;
  align-items: center;
  line-height: 1.25;
  white-space: nowrap;
  flex-shrink: 0;
`;

const HeaderSpacer = styled.div`
  height: ${(p) => p.$height}px;
  flex-shrink: 0;
`;

const LocaleCurrencyWrap = styled.div`
  position: relative;
  flex-shrink: 0;
  z-index: 12000;
`;

const LocaleCurrencyBtn = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  height: 44px;
  background: transparent;
  border: none;
  border-radius: ${tokens.radius.button};
  font-size: 13px;
  font-weight: 600;
  color: ${tokens.dark[600]};
  cursor: pointer;
  font-family: ${tokens.fontFamily.sans};
  transition: background ${tokens.transition.base}, color ${tokens.transition.base};

  &:hover {
    background: ${tokens.background.soft};
    color: ${tokens.dark[900]};
  }
`;

const LocaleDropdown = styled.div`
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 520px;
  max-width: 96vw;
  background: ${tokens.background.card};
  border: 1px solid ${tokens.border.light};
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.18);
  z-index: 12000;
  display: ${(p) => (p.$open ? "flex" : "none")};
  overflow: hidden;
`;

const LocaleOption = styled.button`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  font-size: 14px;
  color: ${tokens.dark[700]};
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: ${tokens.fontFamily.sans};
  transition: background ${tokens.transition.base}, color ${tokens.transition.base};
  border-radius: 8px;

  &:hover {
    background: ${tokens.background.soft};
    color: ${tokens.primary.DEFAULT};
  }

  &[data-active="true"] {
    background: #eff6ff;
    color: #1d4ed8;
    font-weight: 600;
  }
`;

// SHOP_COUNTRIES is now computed dynamically from shippingGroups in the component

const SHOP_LOCALES = [
  { code: "en", label: "English",    flag: "🇬🇧" },
  { code: "de", label: "Deutsch",    flag: "🇩🇪" },
  { code: "fr", label: "Français",   flag: "🇫🇷" },
  { code: "it", label: "Italiano",   flag: "🇮🇹" },
  { code: "es", label: "Español",    flag: "🇪🇸" },
  { code: "tr", label: "Türkçe",     flag: "🇹🇷" },
];

export default function ShopHeader() {
  const { showHeaderFilterBar, landingHeaderBg, landingHeaderStatusColor, secondNavDesktopClassic } = useLandingChrome();
  const { publishMobileBottomNavScroll } = useMobileBottomNavScroll();
  const ctxPrefix = useMarketPrefix();
  const pathname = usePathname() || "/";
  const shopStyles = useShopStyles();
  const headerRestPath = useMemo(() => restPathFromPathname(pathname), [pathname]);
  const headerRouteScope = useMemo(() => detectShopHeaderRouteScope(headerRestPath), [headerRestPath]);
  const headerScopeCssVars = useMemo(
    () => buildHeaderSurfaceCssVarsFromRoute(shopStyles, headerRouteScope),
    [shopStyles, headerRouteScope],
  );
  const mc = shopStyles?.mobileChrome || {};
  const headerStickyNarrow = mc.header_sticky !== false;
  const marketParsed =
    parseMarketPath(pathname) || (ctxPrefix ? parseMarketPath(ctxPrefix) : null);
  const nextRouter = useNextRouter();
  const [scrollPastThreshold, setScrollPastThreshold] = useState(false);
  const [scrollingDown, setScrollingDown] = useState(false);
  const [chromeHideProgress, setChromeHideProgress] = useState(0);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const lastScrollYRef = useRef(0);
  const scrollingDownRef = useRef(false);
  const chromeHideProgressRef = useRef(0);
  const scrollPastThresholdRef = useRef(false);
  const headerRef = useRef(null);
  const middleBarRef = useRef(null);
  const megaMenuTimerRef = useRef(null);
  const [headerHeight, setHeaderHeight] = useState(72);
  const [computedHeaderSolidColor, setComputedHeaderSolidColor] = useState(MIDDLE_BAR_BG);
  const [categoryPanelPortalReady, setCategoryPanelPortalReady] = useState(false);
  const [mainMenuOpen, setMainMenuOpen] = useState(false);
  const [hoveredMenuItemId, setHoveredMenuItemId] = useState(null);
  const [shopBranding, setShopBranding] = useState({ shop_logo_url: "", shop_favicon_url: "", shop_logo_height: 34, logo_config: null });
  const [enabledShopLocales, setEnabledShopLocales] = useState(() => SHOP_LOCALES.map((l) => l.code));
  const [logoDeviceKey, setLogoDeviceKey] = useState("desktop");
  // userMenuOpen state removed — now managed by Radix DropdownMenu in UserDropdownPanel
  const [localeDropdownOpen, setLocaleDropdownOpen] = useState(false);
  const [mainMenuAllItems, setMainMenuAllItems] = useState([]);
  const [mainMenuConfig, setMainMenuConfig] = useState(null);
  const [secondMenuItems, setSecondMenuItems] = useState([]);
  const [categorySlugToId, setCategorySlugToId] = useState(() => new Map());
  const [categoriesFetchDone, setCategoriesFetchDone] = useState(false);
  const [categoryTree, setCategoryTree] = useState([]);
  const [categoryDrillStack, setCategoryDrillStack] = useState([]); // [] = root level
  const { isAuthenticated, user, logout } = useAuth();
  const { openCartSidebar, itemCount, shippingGroups } = useCart();
  const tLocale = useTranslations("locale");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tAccountPanel = useTranslations("accountPanel");
  const tSearch = useTranslations("search");
  const locale = useLocale();

  // Dynamically computed from shipping groups — only countries with configured prices
  const shopCountries = getShippableCountries(shippingGroups, locale);

  const selectedCountry = (() => {
    const t = marketParsed || (ctxPrefix ? parseMarketPath(ctxPrefix) : null);
    if (!t?.country) return String(DEFAULT_MARKET).toUpperCase();
    return t.country.toUpperCase();
  })();

  const navigateTriple = (countryLower, langLower, curLower) => {
    const tail = restPathFromPathname(pathname);
    const suffix = tail === "/" ? "" : tail;
    const cur = String(curLower || DEFAULT_CURRENCY).toLowerCase();
    writeCurrencyCookie(cur);
    // Full reload ensures middleware, prices and shipping re-initialize for the new market
    window.location.href = `${marketPrefix(countryLower, langLower)}${suffix}`;
  };

  /** Persist UI language on the customer account when logged in, then navigate. */
  const handleSelectLocale = (langCode) => {
    setLocaleDropdownOpen(false);
    const m = marketParsed?.country ?? DEFAULT_MARKET;
    const cur = defaultCurrencyForMarket(String(m).toLowerCase());
    const nextLang = String(langCode || "").toLowerCase();
    const go = () => navigateTriple(m, nextLang, cur);
    if (isAuthenticated && nextLang) {
      const token = getToken("customer");
      if (token) {
        getMedusaClient()
          .updateCustomerMe(token, { locale: nextLang })
          .catch(() => {})
          .finally(go);
        return;
      }
    }
    go();
  };

  const handleSelectCountry = (countryCode) => {
    const m = countryCode.toLowerCase();
    const lang = String(locale || routing.defaultLocale || "de").toLowerCase();
    const cur = defaultCurrencyForMarket(m);
    navigateTriple(m, lang, cur);
    setLocaleDropdownOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    const fetchBranding = () => {
      fetch("/api/store-seller-settings?seller_id=default", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          setShopBranding({
            shop_logo_url: d?.shop_logo_url || "",
            shop_favicon_url: d?.shop_favicon_url || "",
            shop_logo_height: d?.shop_logo_height != null ? Number(d.shop_logo_height) : 34,
            logo_config: d?.logo_config || null,
          });
          const raw = Array.isArray(d?.enabled_shop_locales) ? d.enabled_shop_locales : null;
          if (raw && raw.length) {
            const codes = SHOP_LOCALES.map((l) => l.code).filter((c) =>
              raw.map((x) => String(x || "").toLowerCase()).includes(c),
            );
            setEnabledShopLocales(codes.length ? codes : SHOP_LOCALES.map((l) => l.code));
          } else {
            setEnabledShopLocales(SHOP_LOCALES.map((l) => l.code));
          }
        })
        .catch(() => {});
    };
    fetchBranding();
    // Re-fetch when tab regains focus so logo changes from sellercentral appear immediately
    const onVisible = () => { if (document.visibilityState === "visible") fetchBranding(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyTier = () => setLogoDeviceKey(resolveViewportTier(window.innerWidth));
    applyTier();
    window.addEventListener("resize", applyTier, { passive: true });
    return () => window.removeEventListener("resize", applyTier);
  }, []);

  useEffect(() => {
    // Same-origin proxy (shop_favicon_url only). Re-bust when settings change.
    applyDocumentFavicon("/api/brand-favicon");
  }, [shopBranding.shop_favicon_url]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const root = document.documentElement;

    const setThemeColor = (color) => {
      const value = String(color || MIDDLE_BAR_BG).trim() || MIDDLE_BAR_BG;
      // iOS often ignores in-place content updates — remove + reinsert the meta tag.
      document.querySelectorAll("meta[name='theme-color']").forEach((el) => el.remove());
      const meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", value);
      document.head.appendChild(meta);
    };

    /**
     * Safari / mobil durum çubuğu rengi — header yüzeyinden düz tint.
     * html arka planına müdahale etmiyoruz (footer / overscroll ile çakışmayı önlemek için);
     * üst şerit HeaderWrap::before + theme-color ile hizalanır.
     */
    const apply = () => {
      requestAnimationFrame(() => {
        const cs = getComputedStyle(root);
        const chrome = cs.getPropertyValue("--header-chrome-bg").trim();
        const headerBg = cs.getPropertyValue("--header-bg").trim() || MIDDLE_BAR_BG;
        const solid = extractSolidTintFromChromeCss(chrome || headerBg, headerBg);
        setComputedHeaderSolidColor(solid || MIDDLE_BAR_BG);
        const mcLocal = shopStyles?.mobileChrome || {};
        const frostedScrollTint =
          isNarrowViewport &&
          scrollPastThreshold &&
          String(mcLocal.header_on_scroll || "") !== "inherit";
        if (frostedScrollTint) {
          setThemeColor(
            extractSolidTintFromChromeCss(mcLocal.frosted_bg || "rgba(255,255,255,0.92)", "#ffffff"),
          );
        } else if (landingHeaderStatusColor) {
          setThemeColor(extractSolidTintFromChromeCss(landingHeaderStatusColor, headerBg));
        } else if (landingHeaderBg) {
          setThemeColor(extractSolidTintFromChromeCss(landingHeaderBg, headerBg));
        } else {
          setThemeColor(solid);
        }
      });
    };

    apply();
    const onThemeInjected = () => apply();
    window.addEventListener(SHOP_THEME_CSS_UPDATED, onThemeInjected);
    return () => {
      window.removeEventListener(SHOP_THEME_CSS_UPDATED, onThemeInjected);
    };
  }, [pathname, shopStyles, headerScopeCssVars, landingHeaderBg, landingHeaderStatusColor, scrollPastThreshold, isNarrowViewport]);

  useEffect(() => {
    const norm = (s) => String(s || "").toLowerCase().trim();
    const applyMenus = (locData, menuData) => {
      const locs = locData?.locations || [];
      const menus = Array.isArray(menuData?.menus) ? menuData.menus : [];
      const subnavLoc = locs.find((l) => norm(l?.html_id) === "subnav");
      const subnavSlug = norm(subnavLoc?.slug || "second");
      // Prefer categories-with-products configured main menu for dropdown mode.
      const mainCandidates = menus.filter((m) => norm(m?.location) === "main");
      const main =
        mainCandidates.find((m) => Boolean(m?.categories_with_products)) ||
        mainCandidates.find((m) => (m.items || []).length > 0) ||
        mainCandidates[0] ||
        null;
      const second =
        menus.find((m) => norm(m?.location) === subnavSlug) ||
        menus.find((m) => norm(m?.slug) === "second-menu");
      const rootItems = (arr) => (arr || []).filter((i) => !i?.parent_id);
      setMainMenuAllItems(main ? main.items || [] : []);
      setMainMenuConfig(main || null);
      setSecondMenuItems(second ? rootItems(second.items) : []);
    };
    Promise.all([
      cachedJsonFetch("/api/store-menu-locations", { ttlMs: 15000 }).catch(() => ({ locations: [] })),
      cachedJsonFetch(`/api/store-menus?locale=${encodeURIComponent(locale)}`, { ttlMs: 15000 }).catch(() => ({ menus: [] })),
    ]).then(([locData, menuData]) => {
      const hasMenus = Array.isArray(menuData?.menus) && menuData.menus.length > 0;
      if (hasMenus) {
        applyMenus(locData, menuData);
        return;
      }
      const client = getMedusaClient();
      Promise.all([
        client.getMenuLocations().catch(() => ({ locations: [] })),
        client.getMenus({ locale }).catch(() => ({ menus: [] })),
      ]).then(([locData2, menuData2]) => applyMenus(locData2, menuData2));
    });
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 })
      .catch(() => ({ tree: [] }))
      .then((catRes) => {
        if (cancelled) return;
        const tree = catRes.tree || [];
        setCategoryTree(tree);
        const slugMap = new Map();
        walkCategorySlugMap(tree, slugMap);
        setCategorySlugToId(slugMap);
      })
      .catch(() => {
        if (!cancelled) {
          setCategorySlugToId(new Map());
          setCategoryTree([]);
        }
      })
      .finally(() => {
        if (!cancelled) setCategoriesFetchDone(true);
      });
    return () => { cancelled = true; };
  }, [locale]);

  useEffect(() => {
    let ticking = false;
    const readScrollTop = () => {
      if (typeof window === "undefined") return 0;
      const se = document.scrollingElement || document.documentElement;
      return (
        window.pageYOffset ??
        window.scrollY ??
        se.scrollTop ??
        0
      );
    };
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const current = readScrollTop();
        const prev = lastScrollYRef.current;
        const delta = current - prev;
        const el = document.documentElement;
        const maxScroll = Math.max(0, (el && el.scrollHeight) - window.innerHeight);
        const nearDocumentBottom =
          maxScroll > SCROLL_THRESHOLD * 2 && current >= maxScroll - BOTTOM_IGNORE_SCROLL_UP_PX;
        /* Kaydırma ile 0→1: üst chrome ve alt bar parmakla birlikte yavaşça gizlenir */
        let nextProgress = chromeHideProgressRef.current;
        if (current <= SCROLL_THRESHOLD) {
          nextProgress = 0;
        } else if (delta > 0 && current > SCROLL_THRESHOLD) {
          nextProgress = Math.min(1, nextProgress + delta / CHROME_HIDE_SCROLL_PX);
        } else if (delta < -SCROLL_UP_DELTA && !nearDocumentBottom) {
          nextProgress = Math.max(0, nextProgress + delta / CHROME_HIDE_SCROLL_PX);
        }
        chromeHideProgressRef.current = nextProgress;
        const nextScrollingDown = nextProgress > 0.04;
        scrollingDownRef.current = nextScrollingDown;
        setChromeHideProgress(nextProgress);
        setScrollingDown(nextScrollingDown);
        publishMobileBottomNavScroll({
          scrollY: current,
          scrollingDown: nextScrollingDown,
          chromeHideProgress: nextProgress,
        });
        lastScrollYRef.current = current;
        const nextPast = current > SCROLL_THRESHOLD;
        if (nextPast !== scrollPastThresholdRef.current) {
          scrollPastThresholdRef.current = nextPast;
          setScrollPastThreshold(nextPast);
        }

        ticking = false;
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    /* iOS / görünüm çubuğu: bazı durumlarda window ile birlikte visualViewport scroll da yararlı */
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (vv) vv.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (vv) vv.removeEventListener("scroll", handleScroll);
    };
  }, [publishMobileBottomNavScroll]);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${HEADER_NARROW_MQ}px)`);
    const apply = () => setIsNarrowViewport(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    setCategoryDrillStack([]);
    setMainMenuOpen(false);
    setLocaleDropdownOpen(false);
    setScrollingDown(false);
    setChromeHideProgress(0);
    chromeHideProgressRef.current = 0;
    scrollingDownRef.current = false;
    if (typeof window !== "undefined") {
      const y = window.scrollY ?? window.pageYOffset ?? 0;
      lastScrollYRef.current = y;
      const nextPast = y > SCROLL_THRESHOLD;
      scrollPastThresholdRef.current = nextPast;
      setScrollPastThreshold(nextPast);
      publishMobileBottomNavScroll({ scrollY: y, scrollingDown: false, chromeHideProgress: 0 });
    }
  }, [pathname, publishMobileBottomNavScroll]);

  useEffect(() => {
    setCategoryPanelPortalReady(true);
  }, []);

  // Track actual header height so the spacer is always accurate
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeaderHeight(Math.round(entry.contentRect.height));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (
        e.target.closest("[data-categories-dropdown]") ||
        e.target.closest("[data-user-menu]") ||
        e.target.closest("[data-locale-dropdown]") ||
        e.target.closest("[data-mega-nav]")
      ) {
        return;
      }
      setMainMenuOpen(false);
      setLocaleDropdownOpen(false);
      setHoveredMenuItemId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const effectiveHideProgress = mainMenuOpen ? 0 : chromeHideProgress;
  const snHideOnScroll = shopStyles?.secondNav?.hide_on_scroll !== false;
  const snChromeCover = shopStyles?.secondNav?.chrome_covers_on_scroll === true;
  const subNavHideProgress = !showHeaderFilterBar
    ? 1
    : snHideOnScroll && scrollPastThreshold
      ? effectiveHideProgress
      : 0;
  const secondNavHidden = subNavHideProgress >= 0.98 || !showHeaderFilterBar;
  const spacerHeight =
    isNarrowViewport && !headerStickyNarrow
      ? 0
      : Math.max(0, headerHeight - (isNarrowViewport && secondNavHidden ? 40 : 0));
  /** Mobile/tablet: scroll ile compact moda girer */
  const narrowCompactProgress = isNarrowViewport ? effectiveHideProgress : 0;
  /** Kaydırınca buzlu beyaz üst yüzey (tema / landing rengine bakmadan) */
  const mobileFrostedScrollActive =
    isNarrowViewport &&
    scrollPastThreshold &&
    String(mc.header_on_scroll || "") !== "inherit";
  /**
   * Sayfa en üstündeyken navbar + second nav tek yüzey (homepage landing veya header gradyanı).
   * Düz/solid header'da second nav kendi arka planını korur.
   */
  const headerGradientAnyViewport = useMemo(() => {
    const h = shopStyles?.header;
    if (!h) return false;
    return (
      effectiveGradientEnabled(h, "mobile") ||
      effectiveGradientEnabled(h, "tablet") ||
      effectiveGradientEnabled(h, "desktop")
    );
  }, [shopStyles?.header]);

  const desktopSecondNavOwnColorAtTop = shopStyles?.secondNav?.own_color_at_top_desktop === true;

  const unifiedHeaderAtTop =
    showHeaderFilterBar &&
    !mobileFrostedScrollActive &&
    !scrollPastThreshold &&
    (landingHeaderBg || headerGradientAnyViewport) &&
    !(desktopSecondNavOwnColorAtTop && !isNarrowViewport);

  const secondNavLinkDataAttrs = useMemo(() => {
    const resolved = resolveSecondNavLinkStyles(shopStyles || {});
    return {
      "data-sn-desktop": secondNavDesktopClassic ? "classic" : resolved.desktop,
      "data-sn-tablet": resolved.tablet,
      "data-sn-mobile": resolved.mobile,
    };
  }, [shopStyles, secondNavDesktopClassic]);
  /** Geniş ekran: üst header sabit — ikinci nav SubNavWrap kendi hide progress'i ile kaybolur */
  const desktopHeaderHideProgress = 0;

  const algoliaAttributes = {
    primaryText: "title",
    secondaryText: "description",
    tertiaryText: "brand",
    url: "handle",
    image: "thumbnail",
  };
  /** Tree payload is already roots with product-bearing children nested. */
  const categoryPanelRows = useMemo(
    () => mapCategoryNodesToMenuRows(categoryTree, locale).map((r) => ({ ...r, href: `/${r.slug}` })),
    [categoryTree, locale],
  );
  const categoryDrillParent = categoryDrillStack.length
    ? findCategoryNodeById(categoryTree, categoryDrillStack[categoryDrillStack.length - 1].id)
    : null;
  const categoryDrillRows = useMemo(
    () => mapCategoryNodesToMenuRows(categoryDrillParent?.children || [], locale).map((r) => ({ ...r, href: `/${r.slug}` })),
    [categoryDrillParent, locale],
  );

  /** slug/id → category image for menu-item fallback rows */
  const categoryImageByRef = useMemo(() => {
    const map = new Map();
    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (!n) continue;
        const imageRaw = pickCategoryListImageRaw(n);
        const imageUrl = imageRaw ? resolveImageUrl(imageRaw) : "";
        if (imageUrl) {
          const slug = String(n.slug || n.handle || "").trim().toLowerCase();
          const id = String(n.id || "").trim().toLowerCase();
          if (slug) map.set(slug, imageUrl);
          if (id) map.set(id, imageUrl);
        }
        if (n.children?.length) walk(n.children);
      }
    };
    walk(categoryTree);
    return map;
  }, [categoryTree]);

  // Root-level menu items (no parent) for direct link rendering
  const menuPanelItems = useMemo(
    () =>
      (mainMenuAllItems || [])
        .filter((i) => !i?.parent_id)
        .filter((i) => {
          if (String(i?.link_type || "").toLowerCase() !== "category") return true;
          const ref = categoryRefFromMenuItem(i);
          if (!ref) return false;
          /* Ağaç yüklenene kadar slug haritası boş — tüm kategori satırlarını silme (yarış) */
          if (!categoriesFetchDone) return true;
          // Only active/visible categories are present in categorySlugToId map.
          if (categorySlugToId.has(ref)) return true;
          for (const id of categorySlugToId.values()) {
            if (String(id).toLowerCase() === ref) return true;
          }
          return false;
        }),
    [mainMenuAllItems, categorySlugToId, categoriesFetchDone],
  );
  const showCategoriesMode = Boolean(mainMenuConfig?.categories_with_products);
  /** categories_with_products modunda ağaç doluysa panel ağacı kullanır; ağaç boşsa menü satırlarına düş */
  const categoryTreeNavReady = categoryPanelRows.length > 0;
  const useCategoryTreeForPanel = showCategoriesMode && categoryTreeNavReady;

  /** Panel tamamen boş kalmasın: kök menü öğeleri (filtre yok) yedek */
  const looseMenuPanelRows = useMemo(
    () =>
      (mainMenuAllItems || [])
        .filter((i) => !i?.parent_id)
        .map((item) => {
          const ref = categoryRefFromMenuItem(item);
          const imageUrl = ref
            ? categoryImageByRef.get(ref) || categoryImageByRef.get(String(item.link_value || "").trim().toLowerCase()) || ""
            : "";
          return {
            key: item.id,
            href: menuItemHref(item),
            label: item.label,
            imageUrl,
            onClick: () => {
              setMainMenuOpen(false);
            },
          };
        })
        .filter((r) => r.href && r.href !== "#"),
    [mainMenuAllItems, categoryImageByRef],
  );

  /* Mega menu — children grouped by parent id */
  const menuChildrenByParent = useMemo(() => {
    const map = new Map();
    for (const item of mainMenuAllItems) {
      if (item.parent_id) {
        const pid = String(item.parent_id);
        if (!map.has(pid)) map.set(pid, []);
        map.get(pid).push(item);
      }
    }
    return map;
  }, [mainMenuAllItems]);

  const hoveredChildren = useMemo(
    () => (hoveredMenuItemId ? menuChildrenByParent.get(hoveredMenuItemId) || [] : []),
    [hoveredMenuItemId, menuChildrenByParent],
  );

  const hasMegaNav = !showCategoriesMode && menuPanelItems.length > 0;

  const openMegaMenu = (id) => {
    clearTimeout(megaMenuTimerRef.current);
    setMainMenuOpen(false); // close hamburger panel when nav item is hovered
    setHoveredMenuItemId(id);
  };
  const closeMegaMenu = () => {
    megaMenuTimerRef.current = setTimeout(() => setHoveredMenuItemId(null), 140);
  };
  const keepMegaMenuOpen = () => clearTimeout(megaMenuTimerRef.current);

  useEffect(() => {
    if (effectiveHideProgress < 0.15) return;
    setMainMenuOpen(false);
    setLocaleDropdownOpen(false);
    setHoveredMenuItemId(null);
  }, [effectiveHideProgress]);

  return (
    <>
      <HeaderWrap
        ref={headerRef}
        data-mobile-compact={narrowCompactProgress > 0.5 ? "true" : "false"}
        data-unified-header-chrome={unifiedHeaderAtTop ? "true" : undefined}
        style={{
          transform: `translateY(-${desktopHeaderHideProgress * 100}%)`,
          zIndex: localeDropdownOpen ? 2147483650 : undefined,
          ...(isNarrowViewport && !headerStickyNarrow
            ? { position: "relative", top: "auto", left: "auto", right: "auto" }
            : {}),
          ...(headerScopeCssVars || {}),
          // Safe-area strip (::before, height = inset-top only) must use a SOLID top stop —
          // the same linear-gradient string sized to the short strip fades too fast and
          // seams against the navbar. HeaderWrap.background keeps the full-height gradient.
          ...(mobileFrostedScrollActive
            ? {
                background: mc.frosted_bg || "rgba(255,255,255,0.92)",
                backdropFilter: backdropBlurFromToken(mc.frosted_blur || "16px"),
                WebkitBackdropFilter: backdropBlurFromToken(mc.frosted_blur || "16px"),
                "--narrow-header-safe-fill": mc.frosted_bg || "rgba(255,255,255,0.92)",
              }
            : unifiedHeaderAtTop
              ? {
                  ...(landingHeaderBg
                    ? { background: landingHeaderBg }
                    : !isNarrowViewport
                      ? { background: "var(--header-chrome-bg)" }
                      : {}),
                  "--narrow-header-safe-fill":
                    landingHeaderStatusColor ||
                    (landingHeaderBg
                      ? extractSolidTintFromChromeCss(landingHeaderBg, computedHeaderSolidColor)
                      : null) ||
                    headerScopeCssVars?.["--header-chrome-bg"] ||
                    headerScopeCssVars?.["--header-bg"] ||
                    computedHeaderSolidColor,
                }
              : {
                  "--narrow-header-safe-fill":
                    headerScopeCssVars?.["--header-chrome-bg"] ||
                    headerScopeCssVars?.["--header-bg"] ||
                    computedHeaderSolidColor,
                }),
        }}
      >
        <ShopTopBar />
        <HeaderChrome
          className={`shop-header-chrome${
            unifiedHeaderAtTop ? " landing-clear" : ""
          }${mobileFrostedScrollActive ? " mobile-frosted-scroll" : ""}`}
          $compactProgress={narrowCompactProgress}
          style={localeDropdownOpen ? { zIndex: 12010 } : undefined}
        >
        <MiddleBarWrap
          ref={middleBarRef}
          className="shop-header-main"
          $compactProgress={narrowCompactProgress}
        >
          <MiddleBarInner $compactProgress={narrowCompactProgress}>
            <NarrowHeaderChrome $compactProgress={narrowCompactProgress} $keepOnCompact>
              <MiddleBarLeft $compactProgress={narrowCompactProgress}>
                <MiddleBarLogo href="/">
                  {(() => {
                    const devCfg = pickShopLogoSlot(shopBranding, logoDeviceKey);
                    const url = devCfg?.url || "";
                    const height = Math.min(devCfg?.size ?? devCfg?.height ?? 34, 200);
                    const pt = devCfg?.pt ?? 0;
                    const pr = devCfg?.pr ?? 0;
                    const pb = devCfg?.pb ?? 0;
                    const pl = devCfg?.pl ?? 0;
                    const imgH = isNarrowViewport && narrowCompactProgress > 0.02 ? Math.max(22, Math.round(height * (1 - 0.32 * narrowCompactProgress))) : height;
                    /* Width cap must scale with the configured height, not a flat px constant —
                       a flat cap silently squashed a deliberately large (e.g. wide/square) logo
                       back down regardless of the seller's size setting in Sellercentral. */
                    const maxW = Math.round(imgH * 2.2);
                    return url ? (
                      <img
                        src={url}
                        alt="Shop logo"
                        /* width/height attrs let the browser compute an intrinsic aspect-ratio and
                           reserve this box's space before the (arbitrary per-seller) image has
                           loaded — without them the element is 0-wide until load, which shifts the
                           search bar next to it once the real size resolves (CLS). */
                        width={isNarrowViewport ? Math.max(120, maxW) : Math.max(220, maxW)}
                        height={imgH}
                        style={{
                          height: imgH,
                          maxHeight: isNarrowViewport ? Math.max(22, height) : 200,
                          width: "auto",
                          maxWidth: isNarrowViewport ? Math.max(120, maxW) : Math.max(220, maxW),
                          objectFit: "contain",
                          display: "block",
                          paddingTop: pt,
                          paddingRight: pr,
                          paddingBottom: pb,
                          paddingLeft: pl,
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: isNarrowViewport && narrowCompactProgress > 0.02 ? "1rem" : "1.35rem" }}>
                        Andertal
                      </span>
                    );
                  })()}
                </MiddleBarLogo>
              </MiddleBarLeft>
            </NarrowHeaderChrome>

            <MiddleBarCenter $compactProgress={narrowCompactProgress}>
              <NarrowHeaderChrome
                $compactProgress={narrowCompactProgress}
                style={{ gap: 0, minWidth: 0 }}
              >
                <CategoriesDropdown data-categories-dropdown>
                  <CategoriesButton
                    type="button"
                    onClick={() => {
                      setLocaleDropdownOpen(false);
                      setHoveredMenuItemId(null);
                      setCategoryDrillStack([]);
                      setMainMenuOpen((v) => !v);
                    }}
                    aria-expanded={mainMenuOpen}
                    aria-label={tCommon("categories")}
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path fillRule="evenodd" clipRule="evenodd" d="M2 5.75C2 5.33579 2.33579 5 2.75 5H21.25C21.6642 5 22 5.33579 22 5.75C22 6.16421 21.6642 6.5 21.25 6.5H2.75C2.33579 6.5 2 6.16421 2 5.75ZM2 12C2 11.5858 2.33579 11.25 2.75 11.25H21.25C21.6642 11.25 22 11.5858 22 12C22 12.4142 21.6642 12.75 21.25 12.75H2.75C2.33579 12.75 2 12.4142 2 12ZM2 18.25C2 17.8358 2.33579 17.5 2.75 17.5H21.25C21.6642 17.5 22 17.8358 22 18.25C22 18.6642 21.6642 19 21.25 19H2.75C2.33579 19 2 18.6642 2 18.25Z" />
                    </svg>
                  </CategoriesButton>
                </CategoriesDropdown>

                {/* Desktop mega nav */}
                {hasMegaNav && (
                <MegaNav data-mega-nav>
                  {menuPanelItems.map((item) => {
                    const children = menuChildrenByParent.get(String(item.id)) || [];
                    const hasChildren = children.length > 0;
                    const href = menuItemHref(item);
                    const isActive = hoveredMenuItemId === String(item.id);
                    return (
                      <MegaNavItem
                        key={item.id}
                        onMouseEnter={() => openMegaMenu(String(item.id))}
                        onMouseLeave={closeMegaMenu}
                      >
                        {hasChildren ? (
                          <MegaNavBtn type="button" data-active={isActive ? "true" : "false"}>
                            {item.label}
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true" style={{ opacity: 0.7, marginTop: 1 }}>
                              <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            </svg>
                          </MegaNavBtn>
                        ) : (
                          <MegaNavLink
                            href={href === "#" ? "/" : href}
                            data-active={isActive ? "true" : "false"}
                            onClick={() => setHoveredMenuItemId(null)}
                          >
                            {item.label}
                          </MegaNavLink>
                        )}
                      </MegaNavItem>
                    );
                  })}
                </MegaNav>
              )}

              </NarrowHeaderChrome>

              <MiddleBarSearch $compactProgress={narrowCompactProgress}>
                <SearchBarForm $compactProgress={narrowCompactProgress} role="search">
                  <SearchBarButton
                    type="button"
                    aria-label={tSearch("label")}
                    onClick={() => {}}
                  >
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style={{ minWidth: 20, height: 20 }}>
                      <path d="M17.545 15.467l-3.779-3.779c0.57-0.935 0.898-2.035 0.898-3.21 0-3.417-2.961-6.377-6.378-6.377s-6.186 2.769-6.186 6.186c0 3.416 2.961 6.377 6.377 6.377 1.137 0 2.2-0.309 3.115-0.844l3.799 3.801c0.372 0.371 0.975 0.371 1.346 0l0.943-0.943c0.371-0.371 0.236-0.84-0.135-1.211zM4.004 8.287c0-2.366 1.917-4.283 4.282-4.283s4.474 2.107 4.474 4.474c0 2.365-1.918 4.283-4.283 4.283s-4.473-2.109-4.473-4.474z" />
                    </svg>
                  </SearchBarButton>
                  <SearchBarInputWrap>
                    <DropdownSearch
                      placeholder={tSearch("placeholder")}
                      hitsPerPage={5}
                      attributes={algoliaAttributes}
                      maxHeight={tokens.search.dropdownMaxHeight}
                      hideSearchIcon
                      pill
                    />
                  </SearchBarInputWrap>
                </SearchBarForm>
              </MiddleBarSearch>
            </MiddleBarCenter>

            <NarrowHeaderChrome $compactProgress={narrowCompactProgress} $keepOnCompact>
            <MiddleBarRight>
              <LocaleCurrencyWrap data-locale-dropdown>
                <MiddleBarLocaleBtn type="button" className="shop-header-action-icon" onClick={() => { setMainMenuOpen(false); setLocaleDropdownOpen((v) => !v); }} title={tLocale("label")} aria-label={tLocale("label")} aria-haspopup="listbox" aria-expanded={localeDropdownOpen}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                  </svg>
                </MiddleBarLocaleBtn>
                <LocaleDropdown $open={localeDropdownOpen}>
                  <div style={{ flex: 1, borderRight: "1px solid #e5e7eb", padding: "16px 0", minWidth: 0 }}>
                    <div style={{ padding: "4px 16px 10px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>Land</div>
                    {shopCountries.length === 0 ? (
                      <div style={{ padding: "8px 16px", fontSize: 13, color: "#9ca3af" }}>Keine Länder konfiguriert</div>
                    ) : shopCountries.map((c) => (
                      <LocaleOption
                        key={c.code}
                        type="button"
                        data-active={selectedCountry === c.code ? "true" : "false"}
                        onClick={() => handleSelectCountry(c.code)}
                      >
                        <span style={{ fontSize: 20 }}>{c.flag}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{c.label}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>
                            {defaultCurrencyForMarket(c.code.toLowerCase()).toUpperCase()}
                          </div>
                        </div>
                      </LocaleOption>
                    ))}
                  </div>
                  <div style={{ flex: 1, padding: "16px 0", minWidth: 0 }}>
                    <div style={{ padding: "4px 16px 10px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em" }}>Sprache</div>
                    {SHOP_LOCALES.filter((l) => enabledShopLocales.includes(l.code)).map((l) => (
                      <LocaleOption
                        key={l.code}
                        type="button"
                        data-active={locale === l.code ? "true" : "false"}
                        onClick={() => handleSelectLocale(l.code)}
                      >
                        <span style={{ fontSize: 20 }}>{l.flag}</span>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{l.label}</div>
                      </LocaleOption>
                    ))}
                  </div>
                </LocaleDropdown>
              </LocaleCurrencyWrap>
              <MiddleBarUserWrap>
                <UserDropdownPanel
                  layoutAnchorRef={middleBarRef}
                  isAuthenticated={isAuthenticated}
                  user={user}
                  onLogout={() => {
                    document.cookie = "andertal_cauth=; path=/; max-age=0; SameSite=Lax";
                    logout();
                  }}
                  onOpen={() => { setLocaleDropdownOpen(false); setMainMenuOpen(false); }}
                />
              </MiddleBarUserWrap>
              <MiddleBarCartBtn type="button" className="shop-header-action-icon" onClick={openCartSidebar} title={tCommon("cart")} aria-label={tCommon("cart")}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" clipRule="evenodd" d="M1 2.75C1 2.33579 1.33579 2 1.75 2H2.27029C3.34283 2 4.26626 2.75703 4.4766 3.80874L4.71485 5H20.2676C21.3791 5 22.209 6.02281 21.98 7.11052L20.5682 13.8165C20.3003 15.0891 19.1777 16 17.8772 16H7.63961C6.32874 16 5.20009 15.0747 4.94301 13.7893L3.00573 4.10291C2.93562 3.75234 2.6278 3.5 2.27029 3.5H1.75C1.33579 3.5 1 3.16421 1 2.75ZM6 19C6 17.8954 6.89543 17 8 17C9.10457 17 10 17.8954 10 19C10 20.1046 9.10457 21 8 21C6.89543 21 6 20.1046 6 19ZM15 19C15 17.8954 15.8954 17 17 17C18.1046 17 19 17.8954 19 19C19 20.1046 18.1046 21 17 21C15.8954 21 15 20.1046 15 19Z" />
                </svg>
                {itemCount > 0 && <MiddleBarCartBadge>{itemCount}</MiddleBarCartBadge>}
              </MiddleBarCartBtn>
            </MiddleBarRight>
            </NarrowHeaderChrome>
          </MiddleBarInner>
        </MiddleBarWrap>
        </HeaderChrome>

        <SubNavClipper
          $hideProgress={subNavHideProgress}
          $chromeCover={snChromeCover}
        >
          <SubNavWrap
            id="subnav"
            className="second-nav"
            {...secondNavLinkDataAttrs}
            style={{
              ...(unifiedHeaderAtTop
                ? { background: "transparent", borderTop: "none", borderBottom: "none" }
                : snChromeCover
                  ? { background: "var(--header-chrome-bg)" }
                  : {}),
              ...(scrollPastThreshold ? { "--second-nav-text": "var(--second-nav-text-scrolled)" } : {}),
            }}
          >
            <SecondMenuRowInner>
              {secondMenuItems.map((item) => {
                const href = menuItemHref(item);
                const isActive =
                  href !== "#" &&
                  (headerRestPath === href || headerRestPath.startsWith(`${href}/`));
                return (
                  <SecondLink
                    key={item.id}
                    href={href}
                    className={isActive ? "active" : undefined}
                  >
                    {item.label}
                  </SecondLink>
                );
              })}
            </SecondMenuRowInner>
          </SubNavWrap>
        </SubNavClipper>

        {/* Mega menu panel — floats below the header bar */}
        {hasMegaNav && (
          <MegaPanel
            $open={hoveredMenuItemId !== null && hoveredChildren.length > 0}
            data-mega-nav
            onMouseEnter={keepMegaMenuOpen}
            onMouseLeave={closeMegaMenu}
          >
            <MegaPanelInner>
              {hoveredChildren.map((child) => (
                <MegaChildLink
                  key={child.id}
                  href={menuItemHref(child) === "#" ? "/" : menuItemHref(child)}
                  onClick={() => setHoveredMenuItemId(null)}
                >
                  {child.label}
                </MegaChildLink>
              ))}
            </MegaPanelInner>
          </MegaPanel>
        )}

      </HeaderWrap>

      {categoryPanelPortalReady
        ? createPortal(
            <>
              {!isNarrowViewport ? (
                <CategoryMegaBackdrop
                  $open={mainMenuOpen}
                  aria-hidden={!mainMenuOpen}
                  onClick={() => {
                    setMainMenuOpen(false);
                    setCategoryDrillStack([]);
                  }}
                />
              ) : null}
              <CategoryMegaPanel
                $open={mainMenuOpen}
                $topPx={headerHeight}
                data-categories-dropdown
                onClick={(e) => {
                  if (!isNarrowViewport) return;
                  if (e.target === e.currentTarget) {
                    setMainMenuOpen(false);
                    setCategoryDrillStack([]);
                  }
                }}
              >
                {!isNarrowViewport ? (
                  <CategoryMegaSidebarHead>
                    <span>
                      {useCategoryTreeForPanel && categoryDrillStack.length
                        ? categoryDrillStack[categoryDrillStack.length - 1].label
                        : tCommon("categories")}
                    </span>
                    <CategoryMegaSidebarClose
                      type="button"
                      aria-label={tAccountPanel("close")}
                      onClick={() => {
                        setMainMenuOpen(false);
                        setCategoryDrillStack([]);
                      }}
                    >
                      ×
                    </CategoryMegaSidebarClose>
                  </CategoryMegaSidebarHead>
                ) : null}
                <CategoryMegaInner>
                  {(() => {
                    const imageForMenuItem = (item) => {
                      const ref = categoryRefFromMenuItem(item);
                      if (!ref) return "";
                      return categoryImageByRef.get(ref) || categoryImageByRef.get(String(item.link_value || "").trim().toLowerCase()) || "";
                    };

                    const treeLevelRows = categoryDrillStack.length > 0 ? categoryDrillRows : categoryPanelRows;
                    const drillCurrent = categoryDrillStack.length > 0
                      ? categoryDrillStack[categoryDrillStack.length - 1]
                      : null;

                    const primaryRows =
                      !useCategoryTreeForPanel && menuPanelItems.length > 0
                        ? menuPanelItems.map((item) => ({
                            key: item.id,
                            href: menuItemHref(item),
                            label: item.label,
                            imageUrl: imageForMenuItem(item),
                            hasChildren: false,
                            onClick: () => {
                              setMainMenuOpen(false);
                            },
                          }))
                        : treeLevelRows.map((row) => ({
                            key: row.key,
                            id: row.id,
                            href: row.href || `/${row.slug}`,
                            slug: row.slug,
                            label: row.label,
                            imageUrl: row.imageUrl || "",
                            hasChildren: !!row.hasChildren,
                          })).filter((r) => r.href && r.href !== "#");

                    const rows = primaryRows.length > 0 ? primaryRows : looseMenuPanelRows;
                    const canDrill = useCategoryTreeForPanel;

                    const renderRow = (row) => (
                      <CategoryMegaLink
                        key={row.key}
                        href={row.href}
                        onClick={(e) => {
                          if (canDrill && shouldCategoryMenuDrill(e, row.hasChildren)) {
                            e.preventDefault();
                            setCategoryDrillStack((s) => [...s, { id: row.id, label: row.label, slug: row.slug }]);
                            return;
                          }
                          if (row.onClick) row.onClick();
                          else {
                            setMainMenuOpen(false);
                            setCategoryDrillStack([]);
                          }
                        }}
                      >
                        {row.imageUrl ? (
                          <CategoryMegaThumb src={row.imageUrl} alt="" />
                        ) : (
                          <CategoryMegaThumbPlaceholder aria-hidden />
                        )}
                        <CategoryMegaLinkLabel>{row.label}</CategoryMegaLinkLabel>
                        {canDrill && row.hasChildren ? (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.55 }}>
                            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : null}
                      </CategoryMegaLink>
                    );

                    const drillChrome = canDrill && drillCurrent ? (
                      <>
                        <CategoryMegaBtnLink
                          type="button"
                          onClick={() => setCategoryDrillStack((s) => s.slice(0, -1))}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <path d="M7.5 2.5L4 6L7.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {tCommon("back")}
                        </CategoryMegaBtnLink>
                        <CategoryMegaLink
                          href={`/${String(drillCurrent.slug || "").replace(/^\//, "")}`}
                          onClick={() => {
                            setMainMenuOpen(false);
                            setCategoryDrillStack([]);
                          }}
                        >
                          <CategoryMegaThumbPlaceholder aria-hidden />
                          <CategoryMegaLinkLabel>{drillCurrent.label}</CategoryMegaLinkLabel>
                        </CategoryMegaLink>
                      </>
                    ) : null;

                    if (rows.length === 0 && !drillChrome) {
                      return (
                        <div style={{ padding: "8px 0", color: tokens.dark[500], fontSize: 14 }}>
                          {tNav("categoryMenuEmpty")}
                        </div>
                      );
                    }

                    if (!isNarrowViewport) {
                      return (
                        <>
                          {drillChrome}
                          {rows.map((row) => renderRow(row))}
                        </>
                      );
                    }

                    const COLS_MAX = 8;
                    const cols = [];
                    for (let i = 0; i < rows.length; i += COLS_MAX) {
                      cols.push(rows.slice(i, i + COLS_MAX));
                    }

                    return (
                      <>
                        {drillChrome}
                        {cols.map((col, ci) => (
                          <CategoryMegaCol key={ci}>
                            {col.map((row) => renderRow(row))}
                          </CategoryMegaCol>
                        ))}
                      </>
                    );
                  })()}
                </CategoryMegaInner>
              </CategoryMegaPanel>
            </>,
            document.body,
          )
        : null}

      <HeaderSpacer $height={spacerHeight} />
    </>
  );
}
