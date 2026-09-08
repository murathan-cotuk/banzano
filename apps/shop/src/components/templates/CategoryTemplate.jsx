"use client";

import React, { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import styled, { keyframes, css } from "styled-components";
import { CategoryProductListing } from "@/components/CategoryProductListing";
import { Link } from "@/i18n/navigation";
import { resolveImageUrl, rewriteImageUrlsInHtml } from "@/lib/image-url";
import {
  SORT_OPTIONS,
  PER_PAGE,
  buildFacetsFromProducts,
  filterFacetsToCatalog,
  filterProductsByFacets,
  applyCatalogSort,
  getFacetGroupTitle,
  formatFacetOptionLabel,
  isDiscountedProduct,
} from "@/lib/catalog-listing";
import { normCatId } from "@/lib/category-product-ids";
import { getLocalizedCategory } from "@/lib/format";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";
import LandingContainers from "@/components/landing/LandingContainers";
import { useShopStyles } from "@/context/ShopStylesContext";
import { useMarketPrefix } from "@/context/MarketPrefixContext";
import { SITE_URL, categorySeoFallback } from "@/lib/seo";
import CustomCheckbox from "../ui/CustomCheckbox";
import CatalogDrawerPortal, {
  CATALOG_DRAWER_MAX_PX,
  CATALOG_FILTER_OVERLAY_Z,
  CATALOG_FILTER_SIDEBAR_Z,
  catalogDrawerMaxCss,
} from "@/lib/catalog-drawer-portal";

const HEADER_H = 72;

const shimmer = keyframes`
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
`;
const Bone = styled.div`
  background: linear-gradient(90deg, #efefed 25%, #e5e5e3 50%, #efefed 75%);
  background-size: 800px 100%;
  animation: ${shimmer} 1.5s infinite linear;
`;

const CAT_BANNER_PRESETS = {
  strip:  { aspectRatio: "21 / 6", minHeight: "120px", maxHeight: "320px" },
  medium: { aspectRatio: "4 / 1",  minHeight: "200px", maxHeight: "480px" },
  tall:   { aspectRatio: "16 / 7", minHeight: "320px", maxHeight: "640px" },
};

const HeroBanner = styled.div`
  width: 100%;
  aspect-ratio: ${(p) => p.$aspect || "21 / 6"};
  min-height: ${(p) => p.$minH || "120px"};
  max-height: ${(p) => p.$maxH || "320px"};
  overflow: hidden;
  position: relative;
  background: #f4f4f2;

  /* Mobile: use sensible banner height regardless of desktop preset */
  @media (max-width: 767px) {
    aspect-ratio: 3 / 1 !important;
    min-height: 80px !important;
    max-height: 160px !important;
  }

  img, video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 1;
  }
`;

const HeroText = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 24px 32px;

  h1 {
    margin: 0 0 4px;
  }
`;

const ColHeader = styled.div`
  padding: 28px 32px 0;
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;

  @media (min-width: 1024px) {
    max-width: 1700px;
  }

  @media (max-width: 767px) {
    padding: 16px 12px 0;
  }

  h1 {
    margin: 0;
  }

  @media (max-width: 600px) { padding: 20px 16px 0; }
`;

const Breadcrumb = styled.nav`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #999;
  letter-spacing: 0.02em;

  a { color: #999; text-decoration: none; transition: color 0.12s; &:hover { color: #111; } }
  b { color: #444; font-weight: 500; }

  @media (max-width: 767px) {
    display: none;
  }
`;

/** Full-width strip below filter/sort bar, above product grid (breadcrumb only). */
const BreadcrumbRow = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 32px 10px;
  background: #fff;
  border-bottom: 1px solid #e8e8e6;

  @media (max-width: 600px) {
    padding: 6px 16px 8px;
  }

  @media (max-width: 767px) {
    display: none;
  }
`;

const SortBar = styled.div`
  position: sticky;
  top: ${HEADER_H}px;
  z-index: 20;
  background: #fff;
  border-top: 1px solid #e8e8e6;
  border-bottom: 1px solid #e8e8e6;

  /* Sticky offset vs fixed header (approx.; TopBar removed site-wide) */
  @media (max-width: 767px) {
    top: 72px;
  }
`;

const SortBarInner = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  @media (min-width: 1024px) {
    max-width: 1700px;
  }

  @media (max-width: 600px) { padding: 0 16px; }
`;

const SortBarLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  flex: 1;
`;

const FilterBtn = styled.button`
  display: none;
  align-items: center;
  gap: 5px;
  padding: 5px 0;
  background: none;
  border: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${(p) => (p.$active ? "#111" : "#666")};
  cursor: pointer;
  transition: color 0.12s;
  border-bottom: 1.5px solid ${(p) => (p.$active ? "#111" : "transparent")};
  margin-bottom: -1px;
  line-height: 1.2;

  svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 1.8; }
  &:hover { color: #111; }

  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: inline-flex;
  }
`;

const SortWrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #666;
`;

const SortLabel = styled.span`
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #999;
  white-space: nowrap;

  @media (max-width: 480px) { display: none; }
`;

const SortSelect = styled.select`
  appearance: none;
  background: transparent;
  border: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #111;
  cursor: pointer;
  outline: none;
  padding: 12px 20px 12px 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23555' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 4px center;
`;

const ContentWrap = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  padding: 14px 32px 80px;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  gap: 32px;
  align-items: flex-start;

  @media (min-width: 1024px) {
    max-width: 1700px;
  }

  @media (max-width: 767px) {
    padding: 6px 6px 80px;
    padding-left: 4px !important;
    padding-right: 4px !important;
    gap: 0;
  }
`;

const Sidebar = styled.aside`
  width: ${(p) => p.$width || "280px"};
  flex-shrink: 0;
  position: sticky;
  top: ${HEADER_H + 100}px;
  max-height: calc(100vh - ${HEADER_H + 100}px);
  overflow-y: auto;

  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    position: fixed;
    top: 0;
    left: 0;
    width: min(380px, 92vw);
    height: 100dvh;
    max-height: 100dvh;
    z-index: ${CATALOG_FILTER_SIDEBAR_Z};
    background: #fff;
    box-shadow: 4px 0 32px rgba(0,0,0,0.2);
    transform: translateX(${(p) => (p.$open ? "0" : "-100%")});
    transition: transform var(--app-duration-surface, 0.3s) var(--app-ease-out, cubic-bezier(0.4, 0, 0.2, 1));
    padding: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }
`;

const SidebarSplit = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0;
`;

const DesktopSidebarContent = styled.div`
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: none;
  }
`;

/** Mobile drawer: fixed header/tabs + scroll/split region */
const MobileDrawerChrome = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
`;

const MobileDrawerSegments = styled.div`
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #e7e5e4;
  background: linear-gradient(to bottom, #fafaf9, #f4f4f2);
`;

const MobileDrawerSegmentBtn = styled.button`
  flex: 1;
  padding: 10px 8px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border: 1px solid ${(p) => (p.$active ? "#0d9488" : "#d6d3d1")};
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
  background: ${(p) => (p.$active ? "#0f766e" : "#ffffff")};
  color: ${(p) => (p.$active ? "#ffffff" : "#57534e")};
  box-shadow: ${(p) => (p.$active ? "0 2px 8px rgba(15,118,110,0.25)" : "0 1px 2px rgba(0,0,0,0.04)")};
  transition: background 0.15s, color 0.15s, border-color 0.15s;
`;

const MobileCategoriesScroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 14px 14px 20px;
`;

const MobileCategoryBlockTitle = styled.div`
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: #78716c;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e7e5e4;
  display: flex;
  align-items: center;
  gap: 8px;

  &::before {
    content: "";
    width: 4px;
    height: 14px;
    background: #0f766e;
    border-radius: 2px;
    flex-shrink: 0;
  }
`;

/** Category rows in drawer — visually distinct from filter rails */
const MobileCatRow = styled(Link)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: ${(p) => (p.$variant === "muted" ? "9px 12px" : "12px 14px")};
  margin-bottom: ${(p) => (p.$variant === "muted" ? "10px" : "8px")};
  font-size: ${(p) => (p.$variant === "muted" ? 12 : 14)}px;
  font-weight: ${(p) => (p.$active ? 600 : p.$variant === "muted" ? 500 : 500)};
  line-height: 1.35;
  color: ${(p) => {
    if (p.$variant === "muted") return "#78716c";
    return p.$active ? "#115e59" : "#292524";
  }};
  text-decoration: none;
  background: ${(p) =>
    p.$variant === "muted" ? "#f5f5f4" : p.$active ? "#ccfbf1" : "#ffffff"};
  border: 1px solid ${(p) =>
    p.$variant === "muted" ? "#e7e5e4" : p.$active ? "#5eead4" : "#e7e5e4"};
  border-radius: ${(p) => (p.$variant === "muted" ? 8 : 12)}px;
  box-sizing: border-box;
  transition: background 0.12s, border-color 0.12s;

  &:active {
    background: ${(p) => (p.$variant === "muted" ? "#e7e5e4" : "#f0fdfa")};
  }

  ${(p) =>
    p.$variant !== "muted" &&
    css`
      &::after {
        content: "›";
        opacity: 0.32;
        font-size: 18px;
        font-weight: 400;
        line-height: 1;
        flex-shrink: 0;
      }
    `}
`;

const MobileFilterSplit = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
`;

const MobileFilterRailHeader = styled.div`
  flex-shrink: 0;
  padding: 10px 10px 8px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #1c1917;
  background: #e7e5e4;
  border-bottom: 1px solid #d6d3d1;
  line-height: 1.3;
  word-break: break-word;
`;

const MobileFilterLeft = styled.div`
  width: min(140px, 40vw);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #f5f5f4;
  border-right: 1px solid #d6d3d1;
`;

const MobileFilterLeftScroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
`;

const MobileFilterLeftBtn = styled.button`
  display: block;
  width: 100%;
  padding: 12px 10px;
  font-size: 11px;
  font-weight: ${(p) => (p.$active ? 700 : 500)};
  text-align: left;
  background: ${(p) => (p.$active ? "#ffffff" : "transparent")};
  border: none;
  border-left: 4px solid ${(p) => (p.$active ? "#0f766e" : "transparent")};
  color: ${(p) => (p.$active ? "#134e4a" : "#44403c")};
  cursor: pointer;
  line-height: 1.35;
  letter-spacing: 0.02em;
  font-family: inherit;
  border-bottom: 1px solid #e7e5e4;
  &:last-child {
    border-bottom: none;
  }
`;

const MobileFilterRight = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #fafaf9;
`;

const MobileFilterRightScroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 14px 12px 20px;
`;

const MobileFilterRightHead = styled.h3`
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #0c0a09;
  line-height: 1.25;
`;

const MobileFilterRightHint = styled.p`
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.45;
  color: #78716c;
`;

const MobileFilterPillGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
`;

const MobileFilterPill = styled.button`
  padding: 10px 8px;
  font-size: 12px;
  font-weight: ${(p) => (p.$on ? 700 : 500)};
  background: ${(p) => (p.$on ? "#134e4a" : "#ffffff")};
  color: ${(p) => (p.$on ? "#ecfdf5" : "#44403c")};
  border: 1.5px solid ${(p) => (p.$on ? "#134e4a" : "#d6d3d1")};
  border-radius: 10px;
  cursor: pointer;
  text-align: center;
  line-height: 1.35;
  font-family: inherit;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  &:hover {
    border-color: #0f766e;
  }
  &:active {
    transform: scale(0.98);
  }
  word-break: break-word;
`;

const SidebarPane = styled.section`
  padding: 0 0 16px;

  & + & {
    padding-top: 16px;
    border-top: 1px solid #eceae7;
  }
`;

const SidebarOverlay = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: ${CATALOG_FILTER_OVERLAY_Z};
    opacity: ${(p) => (p.$open ? 1 : 0)};
    pointer-events: ${(p) => (p.$open ? "auto" : "none")};
    transition: opacity var(--app-duration-surface, 0.3s) var(--app-ease-out, cubic-bezier(0.4, 0, 0.2, 1));

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }
`;

const SidebarHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  margin-bottom: 0;
  padding: 14px 16px;
  border-bottom: 1px solid #e8e8e6;

  @media (min-width: 1024px) {
    display: none;
  }
`;

const FilterGroup = styled.div`
  border-bottom: 1px solid #eceae7;
`;

const FilterGroupTitle = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
`;

const FilterGroupHeading = styled.h4.attrs({ className: "shop-typo-sidebar-nav" })`
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
  text-align: left;
`;

const FilterGroupBody = styled.div`
  display: ${(p) => (p.$open ? "block" : "none")};
  padding: 0 0 12px;
`;

const FilterChevron = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: #9ca3af;
  transform: rotate(${(p) => (p.$open ? "180deg" : "0deg")});
  transition: transform 0.18s ease;

  svg {
    width: 12px;
    height: 12px;
    display: block;
  }
`;

const CheckRow = styled.label.attrs({ className: "shop-typo-sidebar-submenu" })`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
  color: ${(p) => (p.$on ? "var(--sidebar-nav-color, #111827)" : "var(--sidebar-submenu-color, #4b5563)")};
  font-weight: ${(p) => (p.$on ? 600 : "var(--sidebar-submenu-fw, 400)")};
  transition: color 0.12s;
  /* Do not override CustomCheckbox SVG size — parent CSS was forcing 15–18px and clipping strokes */

  & > label {
    flex-shrink: 0;
    width: ${(p) => p.$cbSize || 12}px;
    height: ${(p) => p.$cbSize || 12}px;
  }

  & > label svg {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }

  &:hover { color: var(--sidebar-nav-color, #111827); }
`;

const SubcategoryGroup = styled.div`
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 0;
`;

const SubcategoryLink = styled(Link).attrs((p) => ({
  className: p.$active ? "shop-typo-sidebar-submenu is-active" : "shop-typo-sidebar-submenu",
}))`
  display: block;
  padding: 5px 8px;
  text-decoration: none;
  border-radius: 6px;
  background: ${(p) => (p.$active ? "#e5e7eb" : "transparent")};
  margin-bottom: 1px;
  transition: background 0.12s, color 0.12s;
  color: ${(p) => (p.$active ? "var(--sidebar-nav-color, #111827)" : "var(--sidebar-submenu-color, #4b5563)")};
  font-weight: ${(p) => (p.$active ? 600 : "var(--sidebar-submenu-fw, 400)")};

  &:hover {
    background: #e5e7eb;
    color: var(--sidebar-nav-color, #111827);
  }
`;

const ClearAllBtn = styled.button`
  background: none;
  border: 1px solid #ccc;
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #555;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover { border-color: #111; color: #111; }
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
`;

const ChipBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 14px 0 0;
`;

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: #111;
  color: #fff;
  border: none;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s;

  &:hover { background: #333; }
`;

const ResultBar = styled.div`
  padding: 16px 0 12px;
  font-size: 11.5px;
  color: #999;
  letter-spacing: 0.04em;
`;

const Pager = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding-top: 48px;
`;

const PBtn = styled.button`
  min-width: 36px;
  height: 36px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid ${(p) => (p.$on ? "#111" : "#ddd")};
  background: ${(p) => (p.$on ? "#111" : "#fff")};
  color: ${(p) => (p.$on ? "#fff" : "#555")};
  font-size: 12.5px;
  font-weight: ${(p) => (p.$on ? "700" : "400")};
  cursor: ${(p) => (p.disabled ? "not-allowed" : "pointer")};
  opacity: ${(p) => (p.disabled ? "0.3" : "1")};
  transition: border-color 0.12s, color 0.12s, background 0.12s;

  &:not(:disabled):hover {
    border-color: #111;
    color: ${(p) => (p.$on ? "#fff" : "#111")};
  }
`;

const Desc = styled.div`
  margin-top: 56px;
  padding-top: 28px;
  border-top: 1px solid #e8e8e6;
  font-size: var(--body-fs);
  line-height: var(--body-lh);
  color: var(--body-color);
  font-family: var(--body-font);
  max-width: ${(p) => (p.$maxWidth === "full" ? "none" : (p.$maxWidth || "700px"))};
  margin-left: ${(p) => (p.$align === "center" ? "auto" : "0")};
  margin-right: ${(p) => (p.$align === "center" ? "auto" : "0")};
  text-align: ${(p) => (p.$align === "center" ? "center" : "left")};

  & h1 {
    font-family: var(--h1-ff);
    font-size: var(--h1-fs);
    font-weight: var(--h1-fw);
    font-style: var(--h1-style);
    color: var(--h1-color);
    letter-spacing: var(--h1-ls);
    line-height: var(--h1-lh);
    margin: 1.25em 0 0.5em;
  }
  & h2 {
    font-family: var(--h2-ff);
    font-size: var(--h2-fs);
    font-weight: var(--h2-fw);
    font-style: var(--h2-style);
    color: var(--h2-color);
    letter-spacing: var(--h2-ls);
    line-height: var(--h2-lh);
    margin: 1.25em 0 0.5em;
  }
  & h3 {
    font-family: var(--h3-ff);
    font-size: var(--h3-fs);
    font-weight: var(--h3-fw);
    font-style: var(--h3-style);
    color: var(--h3-color);
    letter-spacing: var(--h3-ls);
    line-height: var(--h3-lh);
    margin: 1em 0 0.4em;
  }
  & p { margin: 0 0 0.75em; }
  a { color: var(--shop-primary, #111); text-decoration: underline; }
`;

function safeUrl(val) {
  if (!val) return null;
  if (typeof val === "string") {
    const s = val.trim();
    if (s.startsWith("[")) {
      try {
        const arr = JSON.parse(s);
        return Array.isArray(arr) && arr[0] ? String(arr[0]) : null;
      } catch { return null; }
    }
    return s || null;
  }
  if (Array.isArray(val)) return val[0] ? String(val[0]) : null;
  return null;
}

function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\s*on\w+=["'][^"']*["']/gi, "");
}

function parseCategoryMetadata(category) {
  let m = category?.metadata;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      m = {};
    }
  }
  return m && typeof m === "object" ? m : {};
}

function findCategoryNodeBySlug(nodes, slug, seen = new WeakSet()) {
  const norm = String(slug || "").replace(/^\//, "");
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (seen.has(n)) continue;
    seen.add(n);
    const s = String(n.slug || n.handle || "").replace(/^\//, "");
    if (s === norm) return n;
    const child = findCategoryNodeBySlug(n.children, slug, seen);
    if (child) return child;
  }
  return null;
}

function findCategoryNodeById(nodes, id, seen = new WeakSet()) {
  const nid = String(id || "");
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (seen.has(n)) continue;
    seen.add(n);
    if (String(n.id) === nid) return n;
    const child = findCategoryNodeById(n.children, id, seen);
    if (child) return child;
  }
  return null;
}

/** Returns ancestor nodes (root → direct parent) for a given slug, or null if not found. */
function findAncestors(nodes, slug, path = [], seen = new WeakSet()) {
  const norm = String(slug || "").replace(/^\//, "");
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (seen.has(n)) continue;
    seen.add(n);
    const s = String(n.slug || n.handle || "").replace(/^\//, "");
    if (s === norm) return path;
    const found = findAncestors(n.children || [], slug, [...path, n], seen);
    if (found !== null) return found;
  }
  return null;
}

function visibleSubcats(children) {
  return (children || []).filter((c) => c && c.active !== false && c.is_visible !== false && c.has_products !== false);
}

export default function CategoryTemplate() {
  const tCommon = useTranslations("common");
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params?.slug ? String(params.slug) : params?.handle ? String(params.handle) : "";
  const locale = params?.locale ? String(params.locale) : "de";
  const marketPrefixVal = useMarketPrefix();
  const shopStyles = useShopStyles();
  const tmpl = shopStyles?.category_template || {};
  const filterCheckboxSize = Math.min(14, Math.max(8, Number(tmpl.filter_checkbox_size) || 10));

  const [category, setCategory] = useState(null);
  const [products, setProducts] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [parentCategory, setParentCategory] = useState(null);
  const [ancestors, setAncestors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const initialSortVal = searchParams?.get("sort") || "";
  const [sort, setSort] = useState(
    ["bestseller", "newest", "price_asc", "price_desc", "title_asc", "title_desc"].includes(initialSortVal) ? initialSortVal : "default"
  );
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [openFilterGroups, setOpenFilterGroups] = useState({});
  const [activeMobileFilterGroup, setActiveMobileFilterGroup] = useState(null);
  const [mobileDrawerTab, setMobileDrawerTab] = useState("categories");
  const [metafieldDefinitions, setMetafieldDefinitions] = useState({});

  const bodyRef = useRef(null);

  useEffect(() => {
    setFilters({});
    setPage(1);
  }, [slug]);

  // Mobile: auto-open sidebar when navigating from a category link
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia(catalogDrawerMaxCss).matches) return;
    if (sessionStorage.getItem("cat_nav_open") === "1") {
      sessionStorage.removeItem("cat_nav_open");
      setPanelOpen(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!window.matchMedia(catalogDrawerMaxCss).matches) return undefined;
    const prev = document.body.style.overflow;
    if (panelOpen) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [panelOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/store-metafield-definitions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setMetafieldDefinitions(data?.definitions || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [catResBySlug, catResTree, productRes] = await Promise.all([
          fetch(`/api/store-categories${storeCategoriesQuery(locale, { slug })}`).then((r) => r.json()).catch(() => ({ categories: [] })),
          cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 }).catch(() => ({ tree: [] })),
          fetch(`/api/store-products?category=${encodeURIComponent(slug)}&limit=5000`).then((r) => r.json()).catch(() => ({ products: [] })),
        ]);
        if (cancelled) return;
        const cat = catResBySlug?.category || (Array.isArray(catResBySlug?.categories) ? catResBySlug.categories[0] : null);
        const tree = catResTree.tree || catResTree.categories || [];
        const roots = Array.isArray(tree) ? tree : [tree];
        const currentFromTree = findCategoryNodeBySlug(roots, slug);
        const resolvedCategory = cat || currentFromTree || null;
        setCategory(resolvedCategory);
        if (!resolvedCategory) {
          setProducts([]);
          setSubcategories([]);
          setParentCategory(null);
          setAncestors([]);
          setLoading(false);
          return;
        }
        const current = currentFromTree || findCategoryNodeById(roots, resolvedCategory.id);

        // Ancestor chain (root → direct parent)
        const ancestorChain = findAncestors(roots, slug) || [];
        setAncestors(ancestorChain);
        // Direct parent (last ancestor)
        const directParent = ancestorChain.length > 0 ? ancestorChain[ancestorChain.length - 1] : null;
        setParentCategory(directParent);

        // Direct children of current category for sidebar navigation
        const subs = visibleSubcats(current?.children).filter((s) => s && normCatId(s.id));
        setSubcategories(subs);

        setProducts(productRes?.products ?? []);

      } catch (err) {
        if (!cancelled) {
          setError(err?.message || "Failed to load category");
          setProducts([]);
          setSubcategories([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const meta = parseCategoryMetadata(category);
  const localizedName = getLocalizedCategory(category, locale).name;
  const displayTitle =
    (meta.display_title && String(meta.display_title).trim()) ||
    localizedName ||
    slug ||
    "Category";
  const rawBanner = safeUrl(category?.banner_image_url);
  const bannerUrl = rawBanner ? resolveImageUrl(rawBanner) : "";
  const rawBannerVideo = safeUrl(category?.metadata?.banner_video_url);
  const bannerVideoUrl = rawBannerVideo ? resolveImageUrl(rawBannerVideo) : "";
  const richtextHtml = category?.long_content
    ? sanitizeHtml(rewriteImageUrlsInHtml(category.long_content))
    : "";

  /* ── Category template settings ── */
  const catBannerStyle  = tmpl.banner_style || "strip";
  const catBannerPreset = CAT_BANNER_PRESETS[catBannerStyle] || CAT_BANNER_PRESETS.strip;
  const showCatBanner   = catBannerStyle !== "none" && (!!bannerUrl || !!bannerVideoUrl);
  const showSidebar     = tmpl.show_sidebar !== false;
  const sidebarWidth    = tmpl.sidebar_width || "280px";
  const colsPerRow      = Number(tmpl.products_per_row) || 4;
  const colsPerRowMobile = Number(tmpl.products_per_row_mobile) || 2;
  const richtextAlign   = tmpl.richtext_align || "left";
  const richtextMaxW    = tmpl.richtext_max_width || "700px";
  const contentPadX     = tmpl.content_padding_x || "32px";

  useEffect(() => {
    if (!category || typeof document === "undefined") return;
    const m = parseCategoryMetadata(category);
    const dt =
      (m.display_title && String(m.display_title).trim()) ||
      getLocalizedCategory(category, locale).name ||
      slug ||
      "Category";
    const seo = categorySeoFallback(category, locale);
    const docTitle = seo.title || dt;
    document.title = docTitle;
    const desc = seo.description || "";
    const keywords =
      (category.seo_keywords && String(category.seo_keywords).trim()) ||
      (m.keywords && String(m.keywords).trim()) ||
      "";
    const ensureMeta = (selector, create) => {
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement("meta");
        Object.entries(create).forEach(([k, v]) => el.setAttribute(k, v));
        document.head.appendChild(el);
      }
      return el;
    };
    if (desc) {
      const el = ensureMeta('meta[name="description"]', { name: "description" });
      el.setAttribute("content", desc);
      ensureMeta('meta[property="og:description"]', { property: "og:description" }).setAttribute("content", desc);
    }
    if (docTitle) {
      ensureMeta('meta[property="og:title"]', { property: "og:title" }).setAttribute("content", docTitle);
    }
    if (keywords) {
      ensureMeta('meta[name="keywords"]', { name: "keywords" }).setAttribute("content", keywords);
    }
  }, [category, slug, locale]);

  useEffect(() => {
    if (typeof document === "undefined" || !slug) return;
    const prefix = (marketPrefixVal || "").replace(/\/$/, "") || `/${(locale || "de").toLowerCase()}`;
    let el = document.querySelector('link[rel="canonical"]');
    if (!el) {
      el = document.createElement("link");
      el.rel = "canonical";
      document.head.appendChild(el);
    }
    el.href = `${SITE_URL}${prefix}/${slug}`;
  }, [slug, locale, marketPrefixVal]);

  const rawFacets = filterFacetsToCatalog(buildFacetsFromProducts(products), metafieldDefinitions);
  const facets = Object.fromEntries(
    Object.entries(rawFacets).filter(([k]) => k !== "category" && k !== "category_slug")
  );
  const hasFacets = Object.keys(facets).length > 0;
  const hasSubcategories = subcategories.length > 0;
  const showCatalogSidebar = hasFacets || hasSubcategories || !!parentCategory;
  const showMobileCatNav = hasSubcategories || !!parentCategory;

  useEffect(() => {
    if (!panelOpen) return;
    setMobileDrawerTab(showMobileCatNav ? "categories" : "filters");
  }, [panelOpen, showMobileCatNav]);

  /* Mobile: sidebar stays closed on load — user opens manually via filter button */

  useEffect(() => {
    const facetKeys = Object.keys(facets);
    setOpenFilterGroups((prev) => {
      let changed = false;
      const next = { ...prev };
      facetKeys.forEach((key) => {
        if (!(key in next)) {
          next[key] = Boolean(filters[key]?.length);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [facets, filters]);

  useEffect(() => {
    if (!panelOpen || !hasFacets) return;
    const keys = Object.keys(facets);
    if (keys.length > 0 && (!activeMobileFilterGroup || !facets[activeMobileFilterGroup])) {
      setActiveMobileFilterGroup(keys[0]);
    }
  }, [panelOpen, facets, hasFacets, activeMobileFilterGroup]);

  const toggle = (key, val) => {
    setFilters((prev) => {
      const cur = prev[key] || [];
      const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      if (!next.length) {
        const u = { ...prev };
        delete u[key];
        return u;
      }
      return { ...prev, [key]: next };
    });
    setPage(1);
  };

  const saleOnly = searchParams?.get("sale") === "1";

  let filtered = [...products];
  if (saleOnly) filtered = filtered.filter(isDiscountedProduct);
  filtered = filterProductsByFacets(filtered, filters);
  const sorted = applyCatalogSort(filtered, sort, { bestsellerOnly: false });
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const paginated = sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);
  const activeCount = Object.values(filters).reduce((n, v) => n + (v?.length || 0), 0);

  if (loading) {
    return (
      <>
        <Bone style={{ height: 220 }} />
        <ContentWrap>
          <Body>
            <Bone style={{ height: 13, width: 200, margin: "24px 0 32px" }} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${colsPerRow}, 1fr)`,
                gap: 1,
                background: "#e8e8e6",
              }}
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <Bone key={i} style={{ aspectRatio: "3/4" }} />
              ))}
            </div>
          </Body>
        </ContentWrap>
      </>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "48px 32px", color: "#b91c1c", fontSize: 14 }}>{error}</div>
    );
  }

  if (!category) {
    return (
      <div style={{ padding: "48px 32px", color: "#6b7280", fontSize: 14 }}>
        Kategorie nicht gefunden.
      </div>
    );
  }

  return (
    <>
      {showCatBanner ? (
        <HeroBanner $aspect={catBannerPreset.aspectRatio} $minH={catBannerPreset.minHeight} $maxH={catBannerPreset.maxHeight}>
          {bannerVideoUrl ? (
            <video autoPlay muted loop playsInline src={bannerVideoUrl} />
          ) : (
            <img src={bannerUrl} alt={displayTitle} />
          )}
          <HeroText>
            <h1 className="shop-typo-catalog-title shop-typo-catalog-title--on-dark">{displayTitle}</h1>
          </HeroText>
        </HeroBanner>
      ) : (
        <ColHeader style={{ paddingLeft: contentPadX, paddingRight: contentPadX }}>
          <h1 className="shop-typo-catalog-title">{displayTitle}</h1>
        </ColHeader>
      )}

      {category?.id ? <LandingContainers categoryId={String(category.id)} /> : null}

      <SortBar>
        <SortBarInner>
          <SortBarLeft>
            {showCatalogSidebar && showSidebar && (
              <FilterBtn
                type="button"
                $active={panelOpen || activeCount > 0}
                onClick={() => setPanelOpen((o) => !o)}
                aria-expanded={panelOpen}
              >
                <svg viewBox="0 0 16 12">
                  <line x1="0" y1="2" x2="16" y2="2" />
                  <line x1="0" y1="6" x2="16" y2="6" />
                  <line x1="0" y1="10" x2="16" y2="10" />
                  <circle cx="5" cy="2" r="1.5" fill="#111" stroke="none" />
                  <circle cx="11" cy="6" r="1.5" fill="#111" stroke="none" />
                  <circle cx="5" cy="10" r="1.5" fill="#111" stroke="none" />
                </svg>
                {tCommon("categories")}{activeCount > 0 ? ` (${activeCount})` : ""}
              </FilterBtn>
            )}
            {/* Breadcrumb — desktop only */}
            <Breadcrumb aria-label="Breadcrumb" style={{ margin: 0 }}>
              <Link href={`/${locale}`}>Home</Link>
              {ancestors.map((anc) => {
                const ancSlug = String(anc.slug || anc.handle || "").replace(/^\//, "");
                return (
                  <React.Fragment key={anc.id || ancSlug}>
                    <span style={{ color: "#ccc", margin: "0 2px" }}>&gt;</span>
                    <Link href={`/${ancSlug}`}>{anc.name || ancSlug}</Link>
                  </React.Fragment>
                );
              })}
              <span style={{ color: "#ccc", margin: "0 2px" }}>&gt;</span>
              <b>{displayTitle}</b>
            </Breadcrumb>
          </SortBarLeft>
          <SortWrap>
            <SortLabel>Sort:</SortLabel>
            <SortSelect value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} aria-label="Sort products">
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SortSelect>
          </SortWrap>
        </SortBarInner>
      </SortBar>

      <ContentWrap ref={bodyRef} style={{ paddingLeft: contentPadX, paddingRight: contentPadX }}>
        {showCatalogSidebar && showSidebar && (
          <CatalogDrawerPortal>
            <>
              <SidebarOverlay $open={panelOpen} onClick={() => setPanelOpen(false)} />
              <Sidebar $open={panelOpen} $width={sidebarWidth}>
            <SidebarHead>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#1c1917" }}>
                {showMobileCatNav && hasFacets
                  ? (mobileDrawerTab === "categories" ? tCommon("categories") : `${tCommon("filter")}${activeCount > 0 ? ` (${activeCount})` : ""}`)
                  : hasFacets
                    ? `${tCommon("filter")}${activeCount > 0 ? ` (${activeCount})` : ""}`
                    : tCommon("categories")}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {activeCount > 0 && (
                  <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); }} style={{ padding: "4px 10px", fontSize: 10 }}>
                    {tCommon("clear")}
                  </ClearAllBtn>
                )}
                <button type="button" aria-label={tCommon("close")} onClick={() => setPanelOpen(false)} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#57534e", lineHeight: 1, padding: 4 }}>×</button>
              </div>
            </SidebarHead>

            {/* Desktop: accordion layout — hidden on mobile when two-panel is present */}
            <DesktopSidebarContent>
            <SidebarSplit>
              {(hasSubcategories || parentCategory) && (
                <SidebarPane>
                  <SubcategoryGroup style={{ marginTop: 0 }}>
                    {hasSubcategories ? (
                      <>
                        {parentCategory && (
                          <SubcategoryLink
                            href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                            $active={false}
                            style={{ marginBottom: 2, opacity: 0.75 }}
                          >
                            ← {parentCategory.name || parentCategory.slug}
                          </SubcategoryLink>
                        )}
                        <div className="shop-typo-sidebar-nav" style={{ marginBottom: 4, marginTop: parentCategory ? 4 : 0 }}>
                          {displayTitle}
                        </div>
                        <SubcategoryLink href={slug ? `/${slug}` : "#"} $active={true} onClick={() => { setFilters({}); setPage(1); }}>
                          Alle
                        </SubcategoryLink>
                        {subcategories.map((sub) => {
                          const subSlug = String(sub.slug || "").replace(/^\//, "");
                          return (
                            <SubcategoryLink key={sub.id} href={subSlug ? `/${subSlug}` : "#"} $active={false} onClick={() => { setFilters({}); setPage(1); sessionStorage.setItem("cat_nav_open", "1"); }}>
                              {sub.name || sub.slug}
                            </SubcategoryLink>
                          );
                        })}
                      </>
                    ) : (
                      <>
                        <SubcategoryLink
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          $active={false}
                          style={{ marginBottom: 2, opacity: 0.75 }}
                        >
                          ← {parentCategory.name || parentCategory.slug}
                        </SubcategoryLink>
                        <div className="shop-typo-sidebar-nav" style={{ marginBottom: 4, marginTop: 4 }}>
                          {parentCategory.name || parentCategory.slug}
                        </div>
                        <SubcategoryLink
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          $active={false}
                          onClick={() => { setFilters({}); setPage(1); }}
                        >
                          Alle
                        </SubcategoryLink>
                        {visibleSubcats(parentCategory.children || []).map((sibling) => {
                          const sibSlug = String(sibling.slug || "").replace(/^\//, "");
                          const isCurrent = sibSlug === slug;
                          return (
                            <SubcategoryLink key={sibling.id} href={sibSlug ? `/${sibSlug}` : "#"} $active={isCurrent} onClick={() => { setFilters({}); setPage(1); if (!isCurrent) sessionStorage.setItem("cat_nav_open", "1"); }}>
                              {sibling.name || sibling.slug}
                            </SubcategoryLink>
                          );
                        })}
                      </>
                    )}
                  </SubcategoryGroup>
                </SidebarPane>
              )}
              <SidebarPane>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#111", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e8e8e6" }}>
                  {tCommon("filter")}
                  {activeCount > 0 && (
                    <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); }} style={{ float: "right", padding: "2px 8px", fontSize: 10 }}>{tCommon("clear")}</ClearAllBtn>
                  )}
                </div>
                {hasFacets ? (
                  Object.entries(facets).map(([key, vals]) => (
                    <FilterGroup key={key}>
                      <FilterGroupTitle type="button" onClick={() => setOpenFilterGroups((prev) => ({ ...prev, [key]: !prev[key] }))}>
                        <FilterGroupHeading>{getFacetGroupTitle(key, locale, metafieldDefinitions)}</FilterGroupHeading>
                        <FilterChevron $open={!!openFilterGroups[key]} aria-hidden>
                          <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </FilterChevron>
                      </FilterGroupTitle>
                      <FilterGroupBody $open={!!openFilterGroups[key]}>
                        {vals.map((val) => {
                          const on = (filters[key] || []).includes(val);
                          const label = formatFacetOptionLabel(key, val, null, locale, metafieldDefinitions);
                          return (
                            <CheckRow key={label} $on={on} $cbSize={filterCheckboxSize}>
                              <CustomCheckbox checked={on} onChange={() => toggle(key, val)} size={filterCheckboxSize} />
                              {label}
                            </CheckRow>
                          );
                        })}
                      </FilterGroupBody>
                    </FilterGroup>
                  ))
                ) : (
                  <div style={{ fontSize: 12, color: "#8b8b8b", padding: "6px 2px" }}>{tCommon("noFilters")}</div>
                )}
                {activeCount > 0 && (
                  <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}>{tCommon("clearAllFilters")}</ClearAllBtn>
                )}
              </SidebarPane>
            </SidebarSplit>
            </DesktopSidebarContent>

            {/* Mobile: tabs separate categories vs. product filters */}
            <MobileDrawerChrome>
              {showMobileCatNav && hasFacets ? (
                <MobileDrawerSegments role="tablist" aria-label={tCommon("catalogNavigation")}>
                  <MobileDrawerSegmentBtn
                    type="button"
                    role="tab"
                    aria-selected={mobileDrawerTab === "categories"}
                    $active={mobileDrawerTab === "categories"}
                    onClick={() => setMobileDrawerTab("categories")}
                  >
                    {tCommon("categories")}
                  </MobileDrawerSegmentBtn>
                  <MobileDrawerSegmentBtn
                    type="button"
                    role="tab"
                    aria-selected={mobileDrawerTab === "filters"}
                    $active={mobileDrawerTab === "filters"}
                    onClick={() => setMobileDrawerTab("filters")}
                  >
                    {tCommon("filter")}{activeCount > 0 ? ` · ${activeCount}` : ""}
                  </MobileDrawerSegmentBtn>
                </MobileDrawerSegments>
              ) : null}

              {showMobileCatNav && (!hasFacets || mobileDrawerTab === "categories") ? (
                <MobileCategoriesScroll>
                  <MobileCategoryBlockTitle>{tCommon("categoryNavigation")}</MobileCategoryBlockTitle>
                  {hasSubcategories ? (
                    <>
                      {parentCategory ? (
                        <MobileCatRow
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          $variant="muted"
                          onClick={() => {
                            setFilters({});
                            setPage(1);
                            sessionStorage.setItem("cat_nav_open", "1");
                            setPanelOpen(false);
                          }}
                        >
                          ← {parentCategory.name || parentCategory.slug}
                        </MobileCatRow>
                      ) : null}
                      {subcategories.map((sub) => {
                        const subSlug = String(sub.slug || "").replace(/^\//, "");
                        return (
                          <MobileCatRow
                            key={sub.id}
                            href={subSlug ? `/${subSlug}` : "#"}
                            onClick={() => {
                              setFilters({});
                              setPage(1);
                              sessionStorage.setItem("cat_nav_open", "1");
                              setPanelOpen(false);
                            }}
                          >
                            {sub.name || sub.slug}
                          </MobileCatRow>
                        );
                      })}
                    </>
                  ) : (
                    parentCategory ? (
                      <>
                        <MobileCatRow
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          $variant="muted"
                          onClick={() => {
                            setFilters({});
                            setPage(1);
                            sessionStorage.setItem("cat_nav_open", "1");
                            setPanelOpen(false);
                          }}
                        >
                          ← {parentCategory.name || parentCategory.slug}
                        </MobileCatRow>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#78716c", margin: "12px 0 8px" }}>
                          Weitere Unterkategorien
                        </div>
                        <MobileCatRow
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          onClick={() => {
                            setFilters({});
                            setPage(1);
                            setPanelOpen(false);
                          }}
                        >
                          Alle in „{parentCategory.name || parentCategory.slug}“
                        </MobileCatRow>
                        {visibleSubcats(parentCategory.children || []).map((sibling) => {
                          const sibSlug = String(sibling.slug || "").replace(/^\//, "");
                          const isCurrent = sibSlug === slug;
                          return (
                            <MobileCatRow
                              key={sibling.id}
                              href={sibSlug ? `/${sibSlug}` : "#"}
                              $active={isCurrent}
                              onClick={() => {
                                setFilters({});
                                setPage(1);
                                if (!isCurrent) sessionStorage.setItem("cat_nav_open", "1");
                                setPanelOpen(false);
                              }}
                            >
                              {sibling.name || sibling.slug}
                            </MobileCatRow>
                          );
                        })}
                      </>
                    ) : null
                  )}
                </MobileCategoriesScroll>
              ) : null}

              {hasFacets && (!showMobileCatNav || mobileDrawerTab === "filters") ? (
                <MobileFilterSplit>
                  <MobileFilterLeft>
                    <MobileFilterRailHeader>{tCommon("productProperties")}</MobileFilterRailHeader>
                    <MobileFilterLeftScroll>
                      {Object.entries(facets).map(([key]) => {
                        const cnt = (filters[key] || []).length;
                        return (
                          <MobileFilterLeftBtn key={key} type="button" $active={activeMobileFilterGroup === key} onClick={() => setActiveMobileFilterGroup(key)}>
                            {getFacetGroupTitle(key, locale, metafieldDefinitions)}
                            {cnt > 0 ? (
                              <span style={{ display: "block", fontSize: 10, color: "#0f766e", fontWeight: 800, marginTop: 4 }}>{cnt} {tCommon("active")}</span>
                            ) : null}
                          </MobileFilterLeftBtn>
                        );
                      })}
                    </MobileFilterLeftScroll>
                  </MobileFilterLeft>
                  <MobileFilterRight>
                    <MobileFilterRightScroll>
                      {activeMobileFilterGroup && facets[activeMobileFilterGroup] ? (
                        <>
                          <MobileFilterRightHead>{getFacetGroupTitle(activeMobileFilterGroup, locale, metafieldDefinitions)}</MobileFilterRightHead>
                          <MobileFilterRightHint>{tCommon("filterHint")}</MobileFilterRightHint>
                          <MobileFilterPillGrid>
                            {facets[activeMobileFilterGroup].map((val) => {
                              const on = (filters[activeMobileFilterGroup] || []).includes(val);
                              return (
                                <MobileFilterPill key={val} type="button" $on={on} onClick={() => toggle(activeMobileFilterGroup, val)}>
                                  {formatFacetOptionLabel(activeMobileFilterGroup, val, null, locale, metafieldDefinitions)}
                                </MobileFilterPill>
                              );
                            })}
                          </MobileFilterPillGrid>
                        </>
                      ) : (
                        <div style={{ color: "#a8a29e", fontSize: 13, lineHeight: 1.45, paddingTop: 8 }}>
                          Wählen Sie links eine Produkteigenschaft.
                        </div>
                      )}
                    </MobileFilterRightScroll>
                  </MobileFilterRight>
                </MobileFilterSplit>
              ) : null}
            </MobileDrawerChrome>
          </Sidebar>
            </>
          </CatalogDrawerPortal>
        )}

        <Body>
          {activeCount > 0 && (
            <ChipBar>
              {Object.entries(filters).flatMap(([k, vals]) =>
                (vals || []).map((v) => (
                  <Chip key={`${k}:${v}`} type="button" onClick={() => toggle(k, v)}>
                    {formatFacetOptionLabel(k, v, null, locale, metafieldDefinitions)} ×
                  </Chip>
                )),
              )}
            </ChipBar>
          )}

          <ResultBar>
            {total} {total === 1 ? "product" : "products"}
          </ResultBar>

          {paginated.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 0", color: "#bbb", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              No products match your filters.
            </div>
          ) : (
            <CategoryProductListing
              products={paginated}
              activeFilters={filters}
              maxColumns={colsPerRow}
              maxColumnsMobile={colsPerRowMobile}
            />
          )}

          {totalPages > 1 && (
            <Pager>
              <PBtn
                type="button"
                disabled={curPage <= 1}
                onClick={() => { setPage((p) => p - 1); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
              >‹</PBtn>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
                .reduce((acc, p, idx, arr) => {
                  if (idx > 0 && p - arr[idx - 1] > 1) acc.push("…");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === "…"
                    ? <span key={`d${i}`} style={{ width: 36, textAlign: "center", color: "#bbb", fontSize: 12 }}>…</span>
                    : (
                      <PBtn
                        key={p}
                        type="button"
                        $on={p === curPage}
                        onClick={() => { setPage(p); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
                      >
                        {p}
                      </PBtn>
                    ))}
              <PBtn
                type="button"
                disabled={curPage >= totalPages}
                onClick={() => { setPage((p) => p + 1); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
              >›</PBtn>
            </Pager>
          )}

          {richtextHtml ? (
            <Desc $align={richtextAlign} $maxWidth={richtextMaxW} dangerouslySetInnerHTML={{ __html: richtextHtml }} />
          ) : null}
        </Body>
      </ContentWrap>
    </>
  );
}
