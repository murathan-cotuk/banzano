"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import styled, { keyframes } from "styled-components";
import { useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/navigation";

import ShopHeader from "@/components/ShopHeader";
import Footer from "@/components/Footer";
import { ProductGrid } from "@/components/ProductGrid";
import { Link } from "@/i18n/navigation";
import { useMedusaProducts } from "@/hooks/useMedusa";
import { useShopStyles } from "@/context/ShopStylesContext";
import CatalogDrawerPortal, {
  CATALOG_DRAWER_MAX_PX,
  CATALOG_FILTER_OVERLAY_Z,
  CATALOG_FILTER_SIDEBAR_Z,
  catalogDrawerMaxCss,
} from "@/lib/catalog-drawer-portal";
import {
  SORT_OPTIONS,
  PER_PAGE,
  buildFacetsFromProducts,
  filterFacetsToCatalog,
  filterProductsByFacets,
  applyCatalogSort,
  getFacetGroupTitle,
  formatFacetOptionLabel,
  buildCategorySlugToNameMap,
} from "@/lib/catalog-listing";
import {
  dominantCategoryIdFromProducts,
  findCategoryNodeById,
  findCategoryNodeBySlug,
  findAncestors,
  visibleSubcats,
  filterProductsByCategorySubtree,
} from "@/lib/search-listing-helpers";
import { normCatId } from "@/lib/category-product-ids";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import CustomCheckbox from "../ui/CustomCheckbox";

const HEADER_H = 72;
const NARROW = "(max-width: 767px)";

const shimmer = keyframes`
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
`;
const Bone = styled.div`
  background: linear-gradient(90deg, #efefed 25%, #e5e5e3 50%, #efefed 75%);
  background-size: 800px 100%;
  animation: ${shimmer} 1.5s infinite linear;
`;

const ColHeader = styled.div`
  padding: 28px 32px 0;
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  @media (max-width: 767px) {
    padding: 16px 12px 0;
  }
`;

const CategoryTitle = styled.h1.attrs({ className: "shop-typo-catalog-title" })`
  margin: 0 0 4px 0;
`;

const TitleSub = styled.p`
  font-size: 16px;
  color: #6b7280;
  margin: 0 0 0 0;
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

const BreadcrumbRow = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 32px 10px;
  background: #fff;
  border-bottom: 1px solid #e8e8e6;
  @media (max-width: 600px) { padding: 6px 16px 8px; }

  @media (max-width: 767px) { display: none; }
`;

const SortBar = styled.div`
  position: sticky;
  top: ${HEADER_H}px;
  z-index: 20;
  background: #fff;
  border-top: 1px solid #e8e8e6;
  border-bottom: 1px solid #e8e8e6;

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
  gap: 7px;
  padding: 12px 0;
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${(p) => (p.$active ? "#111" : "#666")};
  cursor: pointer;
  transition: color 0.12s;
  border-bottom: 2px solid ${(p) => (p.$active ? "#111" : "transparent")};
  margin-bottom: -1px;

  svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.8; }
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
  @media ${NARROW} {
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
    width: min(360px, 90vw);
    height: 100dvh;
    max-height: 100dvh;
    z-index: ${CATALOG_FILTER_SIDEBAR_Z};
    background: #fff;
    box-shadow: 4px 0 32px rgba(0, 0, 0, 0.2);
    transform: translateX(${(p) => (p.$open ? "0" : "-100%")});
    transition: transform var(--app-duration-surface, 0.3s) var(--app-ease-out, cubic-bezier(0.4, 0, 0.2, 1));
    padding: ${(p) => (p.$filterMode ? "0" : "14px 16px 16px")};
    box-sizing: border-box;
    display: ${(p) => (p.$filterMode ? "flex" : "block")};
    flex-direction: column;
    overflow: ${(p) => (p.$filterMode ? "hidden" : "auto")};

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }
`;

const SidebarOverlay = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
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
  margin-bottom: ${(p) => (p.$filterMode ? "0" : "20px")};
  padding: ${(p) => (p.$filterMode ? "12px 14px" : "0 0 12px")};
  border-bottom: 1px solid #e8e8e6;
  @media (min-width: 1024px) {
    display: none;
  }
`;

const DesktopSidebarContent = styled.div`
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: none;
  }
`;

const SidebarSplit = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0;
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

const MobileFilterLeft = styled.div`
  width: 92px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #f7f7f6;
  border-right: 1px solid #e8e8e6;
`;

const MobileFilterLeftBtn = styled.button`
  display: block;
  width: 100%;
  padding: 13px 8px 13px 11px;
  font-size: 11px;
  font-weight: ${(p) => (p.$active ? 700 : 400)};
  text-align: left;
  background: ${(p) => (p.$active ? "#fff" : "transparent")};
  border: none;
  border-left: 3px solid ${(p) => (p.$active ? "#111" : "transparent")};
  color: ${(p) => (p.$active ? "#111" : "#555")};
  cursor: pointer;
  line-height: 1.3;
  letter-spacing: 0.02em;
  font-family: inherit;
`;

const MobileNavLink = styled(Link)`
  display: block;
  width: 100%;
  padding: 12px 8px 12px 11px;
  font-size: 11px;
  font-weight: ${(p) => (p.$active ? 700 : 400)};
  text-align: left;
  background: ${(p) => (p.$active ? "#e5e7eb" : "transparent")};
  border-left: 3px solid ${(p) => (p.$active ? "#111" : "transparent")};
  color: ${(p) => (p.$active ? "#111" : "#555")};
  cursor: pointer;
  line-height: 1.3;
  letter-spacing: 0.02em;
  text-decoration: none;
  box-sizing: border-box;
`;

const MobileFilterRight = styled.div`
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 10px;
`;

const MobileFilterPillGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
`;

const MobileFilterPill = styled.button`
  padding: 9px 6px;
  font-size: 11.5px;
  font-weight: ${(p) => (p.$on ? 700 : 400)};
  background: ${(p) => (p.$on ? "#111" : "#fff")};
  color: ${(p) => (p.$on ? "#fff" : "#444")};
  border: 1.5px solid ${(p) => (p.$on ? "#111" : "#d1d5db")};
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  line-height: 1.3;
  font-family: inherit;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  &:hover { border-color: #111; }
  word-break: break-word;
`;

/** Mobile two-tab drawer chrome */
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

const SidebarPane = styled.section`
  padding: 0 0 16px;
  & + & {
    padding-top: 16px;
    border-top: 1px solid #eceae7;
  }
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
  padding: 8px 10px;
  text-decoration: none;
  border-radius: 6px;
  background: ${(p) => (p.$active ? "#e5e7eb" : "transparent")};
  margin-bottom: 2px;
  transition: background 0.12s, color 0.12s;
  color: ${(p) => (p.$active ? "var(--sidebar-nav-color, #111827)" : "var(--sidebar-submenu-color, #4b5563)")};
  font-weight: ${(p) => (p.$active ? 600 : "var(--sidebar-submenu-fw, 400)")};
  &:hover {
    background: #e5e7eb;
    color: var(--sidebar-nav-color, #111827);
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
  gap: 12px;
  padding: 12px 0;
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
  font-size: 14px;
  line-height: 1;
  color: #666;
  transform: rotate(${(p) => (p.$open ? "180deg" : "0deg")});
  transition: transform 0.18s ease;
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

  & > label {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
  }

  & > label svg {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }

  &:hover { color: var(--sidebar-nav-color, #111827); }
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

function normalizeSearchText(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSubsequence(needle, haystack) {
  if (!needle || !haystack) return false;
  let i = 0;
  let j = 0;
  while (i < needle.length && j < haystack.length) {
    if (needle[i] === haystack[j]) i += 1;
    j += 1;
  }
  return i === needle.length;
}

function scoreProductForQuery(product, needle, tokens) {
  const title = normalizeSearchText(product?.title || "");
  const desc = normalizeSearchText(product?.description || "");
  const brand = normalizeSearchText(product?.brand || product?.brand_name || "");
  const category = normalizeSearchText(product?.category || product?.category_name || "");
  const merged = `${title} ${brand} ${category} ${desc}`.trim();
  if (!merged) return 0;

  let score = 0;
  if (title.includes(needle)) score += 120;
  else if (brand.includes(needle) || category.includes(needle)) score += 90;
  else if (desc.includes(needle)) score += 60;

  for (const t of tokens) {
    if (!t) continue;
    if (title.includes(t)) score += 24;
    else if (brand.includes(t) || category.includes(t)) score += 16;
    else if (desc.includes(t)) score += 10;
    else if (isSubsequence(t, title) || isSubsequence(t, brand) || isSubsequence(t, category)) score += 7;
    else if (isSubsequence(t, merged)) score += 3;
  }

  if (score === 0 && isSubsequence(needle, merged)) score += 5;
  return score;
}

function textMatchProducts(q, products) {
  if (!q || !Array.isArray(products)) return [];
  const needle = normalizeSearchText(q);
  if (!needle) return [];
  const tokens = needle.split(" ").filter(Boolean);

  const scored = products
    .map((p) => ({ p, s: scoreProductForQuery(p, needle, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);

  if (scored.length > 0) return scored;
  return [...products];
}

function buildSearchUrl(pathname, q, cat) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (cat) p.set("cat", cat);
  return `${pathname}?${p.toString()}`;
}

export default function SearchTemplate() {
  const tCommon = useTranslations("common");
  const tHome = useTranslations("home");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const locale = params?.locale ? String(params.locale) : "de";
  const shopStyles = useShopStyles();
  const tmpl = shopStyles?.category_template || {};
  const sidebarWidth = tmpl.sidebar_width || "280px";
  const showSidebarTmpl = tmpl.show_sidebar !== false;
  const contentPadX = tmpl.content_padding_x || "32px";
  const productsPerRow = Number(tmpl.products_per_row) || 4;
  const productsPerRowMobile = Number(tmpl.products_per_row_mobile) || 2;

  const q = (searchParams?.get("q") || "").trim();
  const catParam = (searchParams?.get("cat") || "").trim();

  const { products, loading, error } = useMedusaProducts();
  const [tree, setTree] = useState([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [sort, setSort] = useState("default");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [openFilterGroups, setOpenFilterGroups] = useState({});
  const [activeMobileFilterGroup, setActiveMobileFilterGroup] = useState(null);
  const [metafieldDefinitions, setMetafieldDefinitions] = useState({});
  const [mobileDrawerTab, setMobileDrawerTab] = useState("categories");
  const bodyRef = useRef(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
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
    let c = true;
    (async () => {
      try {
        setTreeLoading(true);
        const j = await cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 }).catch(() => ({ tree: [] }));
        if (!c) return;
        const t = j.tree || j.categories || [];
        setTree(Array.isArray(t) ? t : [t].filter(Boolean));
      } catch {
        if (c) setTree([]);
      } finally {
        if (c) setTreeLoading(false);
      }
    })();
    return () => { c = false; };
  }, [locale]);

  const textHits = useMemo(
    () => (loading ? [] : textMatchProducts(q, products || [])),
    [q, products, loading],
  );

  const roots = useMemo(() => (Array.isArray(tree) ? tree : []), [tree]);

  const dominantId = useMemo(
    () => dominantCategoryIdFromProducts(textHits),
    [textHits],
  );

  const currentNode = useMemo(() => {
    if (!dominantId) return null;
    return findCategoryNodeById(roots, dominantId) || null;
  }, [roots, dominantId]);

  const currentSlug = currentNode
    ? String(currentNode.slug || currentNode.handle || "").replace(/^\//, "")
    : "";

  const { parentCategory, subcategories, hasSubcategories, branchNav } = useMemo(() => {
    if (!currentNode || !currentSlug) {
      return { parentCategory: null, subcategories: [], hasSubcategories: false, branchNav: true };
    }
    const chain = findAncestors(roots, currentSlug) || [];
    const directParent = chain.length > 0 ? chain[chain.length - 1] : null;
    const subs = visibleSubcats(currentNode.children).filter((s) => s && normCatId(s.id));
    if (subs.length > 0) {
      return {
        parentCategory: directParent,
        subcategories: subs,
        hasSubcategories: true,
        branchNav: true,
      };
    }
    if (directParent) {
      return {
        parentCategory: directParent,
        subcategories: visibleSubcats(directParent.children).filter((s) => s && normCatId(s.id)),
        hasSubcategories: false,
        branchNav: false,
      };
    }
    return { parentCategory: null, subcategories: [], hasSubcategories: false, branchNav: true };
  }, [roots, currentNode, currentSlug]);

  const displayTitle =
    (currentNode && (currentNode.name || currentSlug)) || "";

  const categorySlugToName = useMemo(
    () => buildCategorySlugToNameMap(roots),
    [roots],
  );

  const allowedCatSlugs = useMemo(() => {
    const s = new Set();
    s.add("");
    if (!currentNode) return s;
    if (hasSubcategories) {
      for (const sub of subcategories) {
        const sl = String(sub.slug || "").replace(/^\//, "");
        if (sl) s.add(sl);
      }
    } else if (parentCategory) {
      const psl = String(parentCategory.slug || "").replace(/^\//, "");
      if (psl) s.add(psl);
      for (const sub of subcategories) {
        const sl = String(sub.slug || "").replace(/^\//, "");
        if (sl) s.add(sl);
      }
    }
    return s;
  }, [currentNode, hasSubcategories, subcategories, parentCategory]);

  const catInvalid = Boolean(catParam && !allowedCatSlugs.has(catParam));
  const effectiveCat = catParam && !catInvalid ? catParam : "";

  const catNodeForFilter = useMemo(() => {
    if (!effectiveCat) return null;
    return findCategoryNodeBySlug(roots, effectiveCat);
  }, [effectiveCat, roots]);

  const pushSearch = useCallback(
    (nextQ, nextCat) => {
      const target = buildSearchUrl(pathname, nextQ, nextCat);
      router.replace(target);
    },
    [pathname, router],
  );

  useEffect(() => {
    if (!catParam || !catInvalid) return;
    pushSearch(q, "");
  }, [catParam, catInvalid, q, pushSearch]);

  useEffect(() => {
    setFilters({});
    setPage(1);
  }, [q, effectiveCat]);

  const baseAfterCat = useMemo(() => {
    if (!q) return [];
    if (!catNodeForFilter) return textHits;
    return filterProductsByCategorySubtree(catNodeForFilter, textHits);
  }, [q, textHits, catNodeForFilter]);

  const facets = useMemo(() => {
    const raw = filterFacetsToCatalog(buildFacetsFromProducts(baseAfterCat), metafieldDefinitions);
    return Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "category" && k !== "category_slug"));
  }, [baseAfterCat, metafieldDefinitions]);
  const hasFacets = Object.keys(facets).length > 0;

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

  let afterFacets = filterProductsByFacets(baseAfterCat, filters);
  const sorted = applyCatalogSort(afterFacets, sort, { bestsellerOnly: false });
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const paginated = sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);
  const activeCount = Object.values(filters).reduce((n, v) => n + (v?.length || 0), 0);

  const hasNavPane = Boolean(
    currentNode
      && (hasSubcategories
        || (!hasSubcategories && parentCategory && (subcategories || []).length > 0)),
  );

  useEffect(() => {
    if (!panelOpen) return;
    setMobileDrawerTab(hasNavPane ? "categories" : "filters");
  }, [panelOpen, hasNavPane]);

  const showCatalogSidebar =
    Boolean(q)
    && (textHits.length > 0)
    && (hasNavPane || hasFacets)
    && !!currentNode
    && !treeLoading
    && showSidebarTmpl;

  const searchHrefForSub = (slug) => {
    const sl = String(slug || "").replace(/^\//, "");
    if (!sl) {
      return buildSearchUrl(pathname, q, "");
    }
    return buildSearchUrl(pathname, q, sl);
  };

  const title = q ? `${tCommon("search")}: "${q}"` : tCommon("search");

  // ── Nav content helpers ──────────────────────────────────────────────────────

  function renderDesktopNavPane() {
    if (!hasNavPane) return null;
    return (
      <SidebarPane>
        {branchNav && hasSubcategories ? (
          <SubcategoryGroup style={{ marginTop: 0 }}>
            {parentCategory && (
              <SubcategoryLink
                href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                $active={false}
                style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}
              >
                ← {parentCategory.name || parentCategory.slug}
              </SubcategoryLink>
            )}
            <div className="shop-typo-sidebar-nav" style={{ marginBottom: 4, marginTop: parentCategory ? 4 : 0 }}>
              {displayTitle}
            </div>
            <SubcategoryLink href={searchHrefForSub("")} $active={!effectiveCat} onClick={() => { setFilters({}); setPage(1); }}>
              Alle
            </SubcategoryLink>
            {subcategories.map((sub) => {
              const subSlug = String(sub.slug || "").replace(/^\//, "");
              return (
                <SubcategoryLink key={sub.id} href={searchHrefForSub(subSlug)} $active={effectiveCat === subSlug} onClick={() => { setFilters({}); setPage(1); }}>
                  {sub.name || sub.slug}
                </SubcategoryLink>
              );
            })}
          </SubcategoryGroup>
        ) : parentCategory && (
          <SubcategoryGroup style={{ marginTop: 0 }}>
            <SubcategoryLink
              href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
              $active={false}
              style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}
            >
              ← {parentCategory.name || parentCategory.slug}
            </SubcategoryLink>
            <div className="shop-typo-sidebar-nav" style={{ marginBottom: 4, marginTop: 4 }}>
              {parentCategory.name || parentCategory.slug}
            </div>
            <SubcategoryLink
              href={searchHrefForSub(String(parentCategory.slug || "").replace(/^\//, ""))}
              $active={effectiveCat === String(parentCategory.slug || "").replace(/^\//, "")}
              onClick={() => { setFilters({}); setPage(1); }}
            >
              Alle
            </SubcategoryLink>
            {subcategories.map((sibling) => {
              const sibSlug = String(sibling.slug || "").replace(/^\//, "");
              return (
                <SubcategoryLink key={sibling.id} href={searchHrefForSub(sibSlug)} $active={effectiveCat === sibSlug} onClick={() => { setFilters({}); setPage(1); }}>
                  {sibling.name || sibling.slug}
                </SubcategoryLink>
              );
            })}
          </SubcategoryGroup>
        )}
      </SidebarPane>
    );
  }

  function renderMobileNavSection(close) {
    if (!hasNavPane) return null;
    return (
      <div>
        <div style={{ padding: "8px 8px 4px 11px", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#999" }}>{tCommon("categories")}</div>
        {branchNav && hasSubcategories ? (
          <>
            {parentCategory && (
              <MobileNavLink
                href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                $active={false}
                onClick={() => { setFilters({}); setPage(1); close(); }}
                style={{ fontSize: 10, color: "#9ca3af", borderBottom: "1px solid #e8e8e6" }}
              >
                ← {parentCategory.name || parentCategory.slug}
              </MobileNavLink>
            )}
            <MobileNavLink href={searchHrefForSub("")} $active={!effectiveCat} onClick={() => { setFilters({}); setPage(1); close(); }}>
              Alle
            </MobileNavLink>
            {subcategories.map((sub) => {
              const subSlug = String(sub.slug || "").replace(/^\//, "");
              return (
                <MobileNavLink key={sub.id} href={searchHrefForSub(subSlug)} $active={effectiveCat === subSlug} onClick={() => { setFilters({}); setPage(1); close(); }}>
                  {sub.name || sub.slug}
                </MobileNavLink>
              );
            })}
          </>
        ) : parentCategory && (
          <>
            <MobileNavLink
              href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
              $active={false}
              onClick={() => { setFilters({}); setPage(1); close(); }}
              style={{ fontSize: 10, color: "#9ca3af", borderBottom: "1px solid #e8e8e6" }}
            >
              ← {parentCategory.name || parentCategory.slug}
            </MobileNavLink>
            {subcategories.map((sibling) => {
              const sibSlug = String(sibling.slug || "").replace(/^\//, "");
              return (
                <MobileNavLink key={sibling.id} href={searchHrefForSub(sibSlug)} $active={effectiveCat === sibSlug} onClick={() => { setFilters({}); setPage(1); close(); }}>
                  {sibling.name || sibling.slug}
                </MobileNavLink>
              );
            })}
          </>
        )}
        <div style={{ height: 1, background: "#e8e8e6", margin: "4px 0" }} />
      </div>
    );
  }

  if (loading && !textHits.length) {
    return (
      <div className="min-h-screen flex flex-col bg-white">
        <ShopHeader />
        <main className="flex-grow bg-white" aria-label="Search results">
          <Bone style={{ height: 220 }} />
          <div style={{ maxWidth: 1440, margin: "0 auto", padding: "14px 32px" }}>
            <Bone style={{ height: 13, width: 200, margin: "24px 0 32px" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 1, background: "#e8e8e6" }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Bone key={i} style={{ aspectRatio: "3/4" }} />
              ))}
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col bg-white">
        <ShopHeader />
        <div style={{ padding: "24px" }} className="text-red-800">{tHome("error")}</div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <ShopHeader />
      <main className="flex-grow bg-white" aria-label="Search results">
        <ColHeader style={{ paddingLeft: contentPadX, paddingRight: contentPadX }}>
          <CategoryTitle>{title}</CategoryTitle>
          {q ? <TitleSub>{textHits.length} {textHits.length === 1 ? "Ergebnis" : "Ergebnisse"}</TitleSub> : null}
        </ColHeader>

        <SortBar>
          <SortBarInner>
            <SortBarLeft>
              {showCatalogSidebar && (
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
                  Navigation{activeCount > 0 ? ` (${activeCount})` : ""}
                </FilterBtn>
              )}
            </SortBarLeft>
            <SortWrap>
              <SortLabel>Sort:</SortLabel>
              <SortSelect
                value={sort}
                onChange={(e) => { setSort(e.target.value); setPage(1); }}
                aria-label="Sort products"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SortSelect>
            </SortWrap>
          </SortBarInner>
        </SortBar>

        <BreadcrumbRow style={{ paddingLeft: contentPadX, paddingRight: contentPadX }}>
          <Breadcrumb aria-label="Breadcrumb">
            <Link href={`/${locale}`}>Home</Link>
            <span style={{ color: "#ccc" }}>/</span>
            <b>{tCommon("search")}</b>
            {q ? (
              <>
                <span style={{ color: "#ccc" }}>/</span>
                <b style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {q}
                </b>
              </>
            ) : null}
          </Breadcrumb>
        </BreadcrumbRow>

        <ContentWrap ref={bodyRef} style={{ paddingLeft: contentPadX, paddingRight: contentPadX }}>
          {showCatalogSidebar && (
            <CatalogDrawerPortal>
              <>
                <SidebarOverlay $open={panelOpen} onClick={() => setPanelOpen(false)} />
                <Sidebar $open={panelOpen} $width={sidebarWidth} $filterMode={hasFacets}>
              <SidebarHead $filterMode={hasFacets}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                  Navigation{activeCount > 0 ? ` (${activeCount})` : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {activeCount > 0 && (
                    <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); }} style={{ padding: "2px 8px", fontSize: 10 }}>
                      {tCommon("clear")}
                    </ClearAllBtn>
                  )}
                  <button
                    type="button"
                    aria-label={tCommon("close")}
                    onClick={() => setPanelOpen(false)}
                    style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#555", lineHeight: 1, padding: 0 }}
                  >
                    ×
                  </button>
                </div>
              </SidebarHead>

              {/* Desktop: accordion layout */}
              <DesktopSidebarContent>
                <SidebarSplit>
                  {renderDesktopNavPane()}
                  <SidebarPane>
                    <div className="shop-typo-sidebar-nav" style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e8e8e6" }}>
                      {tCommon("filter")}
                      {activeCount > 0 && (
                        <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); }} style={{ float: "right", padding: "2px 8px", fontSize: 10 }}>
                          {tCommon("clear")}
                        </ClearAllBtn>
                      )}
                    </div>
                    {hasFacets ? (
                      Object.entries(facets).map(([key, vals]) => (
                        <FilterGroup key={key}>
                          <FilterGroupTitle type="button" onClick={() => setOpenFilterGroups((prev) => ({ ...prev, [key]: !prev[key] }))}>
                            <FilterGroupHeading>{getFacetGroupTitle(key, locale, metafieldDefinitions)}</FilterGroupHeading>
                            <FilterChevron $open={!!openFilterGroups[key]}>⌄</FilterChevron>
                          </FilterGroupTitle>
                          <FilterGroupBody $open={!!openFilterGroups[key]}>
                            {vals.map((val) => {
                              const on = (filters[key] || []).includes(val);
                              return (
                                <CheckRow key={val} $on={on}>
                                  <CustomCheckbox checked={on} onChange={() => toggle(key, val)} size={12} />
                                  {formatFacetOptionLabel(key, val, categorySlugToName, locale, metafieldDefinitions)}
                                </CheckRow>
                              );
                            })}
                          </FilterGroupBody>
                        </FilterGroup>
                      ))
                    ) : (
                      <div style={{ fontSize: 12, color: "#8b8b8b", padding: "6px 2px" }}>
                        No filters for this result set.
                      </div>
                    )}
                    {activeCount > 0 && (
                      <ClearAllBtn type="button" onClick={() => { setFilters({}); setPage(1); }}>
                        {tCommon("clearAllFilters")}
                      </ClearAllBtn>
                    )}
                  </SidebarPane>
                </SidebarSplit>
              </DesktopSidebarContent>

              {/* Mobile: two-tab drawer (Kategorien / Filter) */}
              <MobileDrawerChrome>
                {hasNavPane && hasFacets && (
                  <MobileDrawerSegments role="tablist" aria-label="Navigation">
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
                )}

                {/* Category navigation tab */}
                {hasNavPane && (!hasFacets || mobileDrawerTab === "categories") && (
                  <MobileCategoriesScroll>
                    <MobileCategoryBlockTitle>{tCommon("categoryNavigation")}</MobileCategoryBlockTitle>
                    {branchNav && hasSubcategories ? (
                      <>
                        {parentCategory && (
                          <MobileNavLink
                            href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                            $active={false}
                            onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                            style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}
                          >
                            ← {parentCategory.name || parentCategory.slug}
                          </MobileNavLink>
                        )}
                        <MobileNavLink
                          href={searchHrefForSub("")}
                          $active={!effectiveCat}
                          onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                        >
                          Alle
                        </MobileNavLink>
                        {subcategories.map((sub) => {
                          const subSlug = String(sub.slug || "").replace(/^\//, "");
                          return (
                            <MobileNavLink
                              key={sub.id}
                              href={searchHrefForSub(subSlug)}
                              $active={effectiveCat === subSlug}
                              onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                            >
                              {sub.name || sub.slug}
                            </MobileNavLink>
                          );
                        })}
                      </>
                    ) : parentCategory && (
                      <>
                        <MobileNavLink
                          href={parentCategory.slug ? `/${String(parentCategory.slug).replace(/^\//, "")}` : "#"}
                          $active={false}
                          onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                          style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}
                        >
                          ← {parentCategory.name || parentCategory.slug}
                        </MobileNavLink>
                        <MobileNavLink
                          href={searchHrefForSub(String(parentCategory.slug || "").replace(/^\//, ""))}
                          $active={effectiveCat === String(parentCategory.slug || "").replace(/^\//, "")}
                          onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                        >
                          Alle
                        </MobileNavLink>
                        {subcategories.map((sibling) => {
                          const sibSlug = String(sibling.slug || "").replace(/^\//, "");
                          return (
                            <MobileNavLink
                              key={sibling.id}
                              href={searchHrefForSub(sibSlug)}
                              $active={effectiveCat === sibSlug}
                              onClick={() => { setFilters({}); setPage(1); setPanelOpen(false); }}
                            >
                              {sibling.name || sibling.slug}
                            </MobileNavLink>
                          );
                        })}
                      </>
                    )}
                  </MobileCategoriesScroll>
                )}

                {/* Filter tab */}
                {hasFacets && (!hasNavPane || mobileDrawerTab === "filters") && (
                  <MobileFilterSplit>
                    <MobileFilterLeft>
                      {Object.entries(facets).map(([key]) => {
                        const cnt = (filters[key] || []).length;
                        return (
                          <MobileFilterLeftBtn
                            key={key}
                            type="button"
                            $active={activeMobileFilterGroup === key}
                            onClick={() => setActiveMobileFilterGroup(key)}
                          >
                            {getFacetGroupTitle(key, locale, metafieldDefinitions)}
                            {cnt > 0 && (
                              <span style={{ display: "block", fontSize: 9, color: "#ff971c", fontWeight: 800, marginTop: 2 }}>
                                {cnt} ausgewählt
                              </span>
                            )}
                          </MobileFilterLeftBtn>
                        );
                      })}
                    </MobileFilterLeft>
                    <MobileFilterRight>
                      {activeMobileFilterGroup && facets[activeMobileFilterGroup] ? (
                        <MobileFilterPillGrid>
                          {facets[activeMobileFilterGroup].map((val) => {
                            const on = (filters[activeMobileFilterGroup] || []).includes(val);
                            return (
                              <MobileFilterPill
                                key={val}
                                type="button"
                                $on={on}
                                onClick={() => toggle(activeMobileFilterGroup, val)}
                              >
                                {formatFacetOptionLabel(activeMobileFilterGroup, val, categorySlugToName, locale, metafieldDefinitions)}
                              </MobileFilterPill>
                            );
                          })}
                        </MobileFilterPillGrid>
                      ) : (
                        <div style={{ color: "#a8a29e", fontSize: 13, lineHeight: 1.45, paddingTop: 8 }}>
                          {tCommon("filterSelectHint")}
                        </div>
                      )}
                    </MobileFilterRight>
                  </MobileFilterSplit>
                )}
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
                      {formatFacetOptionLabel(k, v, categorySlugToName, locale, metafieldDefinitions)}
                      {" "}×
                    </Chip>
                  )))}
              </ChipBar>
            )}

            {q ? (
              <ResultBar>
                {total} {total === 1 ? "product" : "products"}
              </ResultBar>
            ) : null}

            {!q ? (
              <div style={{ textAlign: "center", padding: "48px 0", color: "#888" }}>
                {tCommon("search")}
              </div>
            ) : null}

            {q && paginated.length === 0 ? (
              <>
                <div style={{ textAlign: "center", padding: "24px 0 14px", color: "#6b7280", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  Keine direkten Treffer - wir zeigen ähnliche Produkte.
                </div>
                <ProductGrid
                  products={applyCatalogSort(products || [], sort, { bestsellerOnly: false }).slice(0, PER_PAGE)}
                  activeFilters={{}}
                  maxColumns={productsPerRow}
                  maxColumnsMobile={productsPerRowMobile}
                />
              </>
            ) : null}

            {q && paginated.length > 0 ? (
              <ProductGrid
                products={paginated}
                activeFilters={filters}
                maxColumns={productsPerRow}
                maxColumnsMobile={productsPerRowMobile}
              />
            ) : null}

            {q && totalPages > 1 ? (
              <Pager>
                <PBtn
                  type="button"
                  disabled={curPage <= 1}
                  onClick={() => { setPage((p) => p - 1); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
                >
                  ‹
                </PBtn>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
                  .reduce((acc, p, idx, arr) => {
                    if (idx > 0 && p - arr[idx - 1] > 1) acc.push("…");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) =>
                    p === "…" ? (
                      <span key={`d${i}`} style={{ width: 36, textAlign: "center", color: "#bbb", fontSize: 12 }}>…</span>
                    ) : (
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
                >
                  ›
                </PBtn>
              </Pager>
            ) : null}
          </Body>
        </ContentWrap>
      </main>
      <Footer />
    </div>
  );
}
