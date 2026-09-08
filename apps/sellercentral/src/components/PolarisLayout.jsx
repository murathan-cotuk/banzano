"use client";

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, forwardRef, useMemo } from "react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useTranslations, useLocale } from "next-intl";
import { lt } from "@/lib/locale-text";
import {
  AppProvider,
  Frame,
  Navigation,
  TopBar,
  Button,
  Modal,
  Text,
  Popover,
  ActionList,
  UnstyledLink,
  Icon,
  Toast,
} from "@shopify/polaris";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import { useSellerImpersonation } from "@/context/SellerImpersonationContext";
import SellerImperBar from "@/components/SellerImperBar";
import { __registerConfirmModal, __resolveConfirmModal } from "@/lib/confirm-delete";
import {
  HomeIcon,
  ProductIcon,
  OrderIcon,
  ProfileIcon,
  ChartVerticalIcon,
  MegaphoneIcon,
  DiscountIcon,
  SettingsIcon,
  ListBulletedIcon,
  ImportIcon,
  StoreIcon,
  EditIcon,
  QuestionCircleIcon,
} from "@shopify/polaris-icons";
import GroupedDropdownSearch from "./GroupedDropdownSearch";
import { applyDocumentFavicon } from "@/lib/apply-document-favicon";
import { polarisI18nFor } from "@/lib/polaris-locale";
import { getApprovalBannerCopy } from "@/lib/approval-banner-i18n";
import "@shopify/polaris/build/esm/styles.css";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { fieldNameDisplayLabel } from "@/lib/product-change-request-format";
import { getNotificationsCopy } from "@/lib/notifications-i18n";
import { statusLabel as localizeStatus } from "@/lib/status-labels";
import { __registerToast } from "@/lib/toast";

const discardBtnStyles = `
  .andertal-discard-topbar-btn,
  .andertal-discard-topbar-btn *,
  .andertal-discard-topbar-btn span { color: #ffffff !important; }
`;

/** Polaris Frame logo img: never pass empty/invalid src (React 19 + browser warning). */
function normalizeSellerCentralLogoUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === "null" || low === "undefined" || low === "about:blank") return null;
  if (s === "/") return null;
  if (/^https?:\/\//i.test(s) || s.startsWith("data:image/")) return s;
  if (/^\/\/[^/]/i.test(s)) return s;
  if (s.startsWith("/") && s.length > 1) return s;
  return null;
}

/** logo_config.sellercentral.{desktop,tablet,mobile} + legacy flat fields */
function buildSellercentralLogoSlotsFromSettings(d) {
  const legUrl = String(d?.sellercentral_logo_url ?? "").trim();
  const legH = d?.sellercentral_logo_height != null ? Number(d.sellercentral_logo_height) : 30;
  const pad = (b) => ({
    pt: Number(b?.pt || 0),
    pr: Number(b?.pr || 0),
    pb: Number(b?.pb || 0),
    pl: Number(b?.pl || 0),
  });
  const sc = d?.logo_config?.sellercentral;
  if (!sc || typeof sc !== "object") {
    const u = normalizeSellerCentralLogoUrl(legUrl) ?? "";
    const slot = (size) => ({ url: u || "", size, height: size, ...pad({}) });
    return { desktop: slot(legH), tablet: slot(28), mobile: slot(26) };
  }
  const deskBlock = sc.desktop || {};
  const deskUrlStr = String(deskBlock.url ?? "").trim() || legUrl;
  const slotSize = (block, fallback) => {
    if (block?.size != null && Number.isFinite(Number(block.size))) return Number(block.size);
    if (block?.height != null && Number.isFinite(Number(block.height))) return Number(block.height);
    return fallback;
  };
  const desktop = {
    url: normalizeSellerCentralLogoUrl(deskUrlStr) ?? "",
    size: slotSize(deskBlock, legH),
    height: slotSize(deskBlock, legH),
    ...pad(deskBlock),
  };
  const tabBlock = sc.tablet || {};
  const tabUrlStr = String(tabBlock.url ?? "").trim() || deskUrlStr;
  const tablet = {
    url: normalizeSellerCentralLogoUrl(tabUrlStr) ?? "",
    size: slotSize(tabBlock, 28),
    height: slotSize(tabBlock, 28),
    ...pad(tabBlock),
  };
  const mobBlock = sc.mobile || {};
  const mobUrlStr = String(mobBlock.url ?? "").trim() || deskUrlStr;
  const mobile = {
    url: normalizeSellerCentralLogoUrl(mobUrlStr) ?? "",
    size: slotSize(mobBlock, 26),
    height: slotSize(mobBlock, 26),
    ...pad(mobBlock),
  };
  return { desktop, tablet, mobile };
}

/**
 * Polaris Navigation.Section passes `key: label` to Item — label must stay a string, not a React node.
 * Strip our meta flags so unknown props are not forwarded into Navigation.Item.
 */
function sanitizePolarisNavItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const { superuserOnly, ...rest } = item;
    const subNavigationItems = Array.isArray(item.subNavigationItems)
      ? item.subNavigationItems.map((sub) => {
          const { superuserOnly: _su, ...subRest } = sub;
          return subRest;
        })
      : item.subNavigationItems;
    return { ...rest, subNavigationItems };
  });
}

/** Drop superuserOnly entries for non-superusers before sanitize. */
function stripSuperuserOnlyNav(items, isSuperuser) {
  if (!Array.isArray(items)) return [];
  if (isSuperuser) return items;
  return items
    .filter((item) => !item.superuserOnly)
    .map((item) => {
      if (!Array.isArray(item.subNavigationItems)) return item;
      return {
        ...item,
        subNavigationItems: item.subNavigationItems.filter((sub) => !sub.superuserOnly),
      };
    })
    .filter((item) => !item.subNavigationItems || item.subNavigationItems.length > 0 || !item.url?.includes("-menu"));
}

/** Href path fragments for superuser-only entries (matches locale-prefixed URLs). */
const SUPERUSER_NAV_HREF_FRAGMENTS = [
  "/products/collections",
  "/orders/abandoned-checkouts",
  "/sellers-menu",
  "/sellers",
  "/customers/newsletter",
  "/marketing/automations",
  "/marketing/seo",
  "/content/menus",
  "/content/categories",
  "/content/landing-page",
  "/content/styles",
  "/content/pages",
  "/content/blog-posts",
  "/content/flows",
  "/content/metaobjects",
  "/content/compliance-review",
  "/content/compliance-profiles",
  "/content/payout-risk",
  "/affiliate-admin",
  "/analytics/live-view",
];

/** Polaris puts label color on inner Text/spans and CSS vars — anchor-only rules only showed on hover. */
const SUPERUSER_NAV_ACCENT_COLOR = "#601b1b";

const SUPERUSER_NAV_ACCENT_CSS = SUPERUSER_NAV_HREF_FRAGMENTS.map((frag) => {
  const a = `.Polaris-Navigation a[href*="${frag}"]`;
  return [
    `${a}`,
    `${a}:hover`,
    `${a}:focus-visible`,
    `${a}[aria-current="page"]`,
    `${a} span`,
    `${a} .Polaris-Text--root`,
    `${a} .Polaris-Text--bodyMd`,
    `${a} [class*="Polaris-Text"]`,
    `${a}:hover span`,
    `${a}:hover .Polaris-Text--root`,
    `${a}:hover [class*="Polaris-Text"]`,
  ].join(",");
}).join(",") +
  `{color:${SUPERUSER_NAV_ACCENT_COLOR}!important;font-weight:600!important;--p-color-text:${SUPERUSER_NAV_ACCENT_COLOR}!important;--p-color-text-secondary:${SUPERUSER_NAV_ACCENT_COLOR}!important;}` +
  SUPERUSER_NAV_HREF_FRAGMENTS.map((frag) => {
    const a = `.Polaris-Navigation a[href*="${frag}"]`;
    return `${a} svg, ${a}:hover svg, ${a}:focus-visible svg`;
  }).join(",") +
  `{color:${SUPERUSER_NAV_ACCENT_COLOR}!important;fill:${SUPERUSER_NAV_ACCENT_COLOR}!important;}`;

/** Polaris Navigation.Section uses `label` as React key — must never be a React element / object. */
function coercePolarisNavLabel(label, urlFallback = "") {
  if (React.isValidElement(label)) {
    const seg = String(urlFallback || "").split("/").filter(Boolean).pop() || "menu";
    return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
  }
  if (typeof label === "string") return label;
  if (typeof label === "number" || typeof label === "bigint") return String(label);
  if (label == null || typeof label === "boolean") {
    const u = String(urlFallback || "");
    return u.replace(/^\//, "") || "Menu";
  }
  const u = String(urlFallback || "");
  return u.replace(/^\//, "") || "Menu";
}

/** Strip ids and unknown shapes before Polaris Navigation (Section passes keys from labels internally). */
function finalizePolarisSectionItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const { id: _dropTopId, ...rest } = item;
    const subNavigationItems = Array.isArray(rest.subNavigationItems)
      ? rest.subNavigationItems.map((sub) => {
          const { id: _sid, ...subRest } = sub;
          return {
            ...subRest,
            label: coercePolarisNavLabel(subRest.label, subRest.url),
          };
        })
      : rest.subNavigationItems;
    return {
      ...rest,
      label: coercePolarisNavLabel(rest.label, rest.url),
      subNavigationItems,
    };
  });
}

function getMenuItemsMain(t, isSuperuser = false) {
  const tx = (key, fallback) => {
    try {
      if (typeof t.has === "function" && !t.has(key)) return fallback;
      return t(key);
    } catch {
      return fallback;
    }
  };
  const items = [
    { url: "/dashboard", label: tx("home", "Home"), icon: HomeIcon },
    {
      url: "/orders",
      label: tx("orders", "Orders"),
      icon: OrderIcon,
      subNavigationItems: [
        { url: "/orders", label: tx("view", "View") },
        { url: "/orders/returns", label: tx("returns", "Returns") },
        {
          url: "/orders/abandoned-checkouts",
          label: tx("abandonedCheckouts", "Abandoned checkouts"),
          superuserOnly: true,
        },
      ],
    },
    {
      url: "/products",
      label: tx("products", "Products"),
      icon: ProductIcon,
      subNavigationItems: [
        { url: "/products/inventory", label: tx("inventory", "Inventory") },
        { url: "/products/collections", label: tx("collections", "Collections"), superuserOnly: true },
        { url: "/products/product-groups", label: tx("productGroups", "Product groups") },
      ],
    },
    {
      url: "/customers-menu",
      label: tx("customers", "Customers"),
      icon: ProfileIcon,
      superuserOnly: true,
      subNavigationItems: [
        { url: "/customers", label: tx("list", "List"), superuserOnly: true },
        { url: "/customers/reviews", label: tx("reviews", "Reviews"), superuserOnly: true },
        { url: "/customers/newsletter", label: tx("newsletter", "Newsletter"), superuserOnly: true },
      ],
    },
  ];

  if (isSuperuser) {
    items.push({
      url: "/sellers-menu",
      label: tx("sellers", "Sellers"),
      superuserOnly: true,
      icon: StoreIcon,
      subNavigationItems: [
        { url: "/sellers", label: tx("view", "View"), superuserOnly: true },
        { url: "/sellers/errors", label: tx("issueLog", "Issue log"), superuserOnly: true },
      ],
    });
  }

  items.push(
    {
      url: "/marketing",
      label: tx("marketing", "Marketing"),
      icon: MegaphoneIcon,
      subNavigationItems: [
        { url: "/marketing/campaigns", label: tx("campaigns", "Campaigns") },
        { url: "/marketing/attribution", label: tx("attribution", "Attribution") },
        { url: "/marketing/affiliate", label: tx("affiliateMarketing", "Affiliate") },
        { url: "/affiliate-admin", label: tx("affiliateAdmin", "Affiliate admin"), superuserOnly: true },
        { url: "/marketing/seo", label: tx("seo", "SEO"), superuserOnly: true },
        { url: "/marketing/automations", label: tx("automations", "Automations"), superuserOnly: true },
      ],
    },
    {
      url: "/discounts",
      label: tx("discounts", "Discounts"),
      icon: DiscountIcon,
      subNavigationItems: [
        { url: "/discounts/coupons", label: tx("coupons", "Coupons") },
        { url: "/discounts/campaigns", label: tx("promotions", "Promotions") },
      ],
    },
    {
      url: "/content",
      label: tx("content", "Content"),
      icon: ListBulletedIcon,
      subNavigationItems: [
        { url: "/content/media", label: tx("media", "Media") },
        { url: "/content/menus", label: tx("menus", "Menus"), superuserOnly: true },
        { url: "/content/categories", label: tx("categories", "Categories"), superuserOnly: true },
        { url: "/content/brands", label: tx("brands", "Brands") },
        { url: "/content/metaobjects", label: tx("metaobjects", "Metaobjects"), superuserOnly: true },
        { url: "/content/landing-page", label: tx("landingPage", "Landing Page"), superuserOnly: true },
        { url: "/content/styles", label: tx("styles", "Styles"), superuserOnly: true },
        { url: "/content/pages", label: tx("pages", "Pages"), superuserOnly: true },
        { url: "/content/blog-posts", label: tx("blogPosts", "Blog Posts"), superuserOnly: true },
        { url: "/content/flows", label: tx("flows", "Flows"), superuserOnly: true },
        { url: "/content/compliance-review", label: tx("complianceReview", "Compliance review"), superuserOnly: true },
        { url: "/content/compliance-profiles", label: tx("complianceProfiles", "Compliance profiles"), superuserOnly: true },
        { url: "/content/payout-risk", label: tx("payoutRisk", "Payout risk"), superuserOnly: true },
      ],
    },
    {
      url: "/analytics",
      label: tx("analytics", "Analytics"),
      icon: ChartVerticalIcon,
      subNavigationItems: [
        { url: "/analytics/reports", label: tx("reports", "Reports") },
        { url: "/analytics/transactions", label: tx("transactions", "Transactions") },
        { url: "/analytics/live-view", label: tx("liveView", "Live View"), superuserOnly: true },
        { url: "/analytics/ranking", label: tx("ranking", "Ranking") },
      ],
    },
    { url: "/import-export", label: tx("importExport", "Import/Export"), icon: ImportIcon },
  );
  return items;
}

function getMenuItemsSettings(t, isSuperuser = false) {
  const tx = (key, fallback) => {
    try {
      if (typeof t.has === "function" && !t.has(key)) return fallback;
      return t(key);
    } catch {
      return fallback;
    }
  };
  return [
    {
      url: "/help",
      label: tx("help", "Hilfe & Leitfäden"),
      icon: QuestionCircleIcon,
    },
    {
      url: "/settings",
      label: t("settings"),
      icon: SettingsIcon,
    },
  ];
}

// Parent nav URLs that should expand/collapse sub-menus on click (no page navigation)
const PARENT_NAV_URLS = new Set([
  "/products", "/marketing", "/content", "/analytics", "/customers-menu", "/sellers-menu", "/discounts",
]);
const NAV_VIRTUAL_URL_FALLBACK = {
  "/customers-menu": "/customers",
  "/sellers-menu": "/sellers",
};

const isModifiedOrNewTabClick = (e) => {
  if (!e) return false;
  return (
    e.metaKey ||
    e.ctrlKey ||
    e.shiftKey ||
    e.altKey ||
    e.button === 1
  );
};

// Toggle-only parents (see PARENT_NAV_URLS) never get a real href: even if some click
// interceptor upstream (Next's <Link>, a browser extension, bfcache restore, etc.) ever
// fails to honor preventDefault(), a "#" target is a guaranteed no-op instead of a real
// navigation into the first child page.
const isToggleOnlyNavUrl = (url, onClick) => PARENT_NAV_URLS.has(url || "") && typeof onClick === "function";

/**
 * Soft-nav through next-intl router.push (not raw next/link alone).
 * Raw Link + middleware locale redirect often updates the address bar while leaving the
 * previous RSC page mounted until a second click or hard reload.
 */
const NextLink = forwardRef(function NextLink({ url, children, external, onClick, ...rest }, ref) {
  const router = useRouter();
  const toggleOnly = isToggleOnlyNavUrl(url, onClick);
  const target = NAV_VIRTUAL_URL_FALLBACK[url] || (url || "");
  const href = toggleOnly ? "#" : target;
  const handleClick = (e) => {
    if (isModifiedOrNewTabClick(e) || external) {
      onClick?.(e);
      return;
    }
    if (toggleOnly) {
      e.preventDefault();
      onClick?.(e);
      return;
    }
    if (!target || target.startsWith("#")) {
      onClick?.(e);
      return;
    }
    e.preventDefault();
    onClick?.(e);
    router.push(target);
  };
  return (
    <Link href={href} ref={ref} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
});

const UnsavedAwareLink = forwardRef(function UnsavedAwareLink({ url, children, external, onClick, ...rest }, ref) {
  const ctx = useUnsavedChanges();
  const router = useRouter();
  const toggleOnly = isToggleOnlyNavUrl(url, onClick);
  const target = NAV_VIRTUAL_URL_FALLBACK[url] || (url || "");
  const href = toggleOnly ? "#" : (target || "#");
  const handleClick = (e) => {
    if (isModifiedOrNewTabClick(e) || external) {
      onClick?.(e);
      return;
    }
    if (toggleOnly) {
      e.preventDefault();
      onClick?.(e);
      return;
    }
    if (ctx?.isDirty && target && !target.startsWith("#")) {
      e.preventDefault();
      ctx.startNavigate(target);
      return;
    }
    if (!target || target.startsWith("#")) {
      onClick?.(e);
      return;
    }
    e.preventDefault();
    onClick?.(e);
    router.push(target);
  };
  return (
    <Link ref={ref} href={href} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
});

const LOCALES = [
  { code: "en", label: "EN" },
  { code: "de", label: "DE" },
  { code: "tr", label: "TR" },
  { code: "fr", label: "FR" },
  { code: "it", label: "IT" },
  { code: "es", label: "ES" },
];

export default function PolarisLayout({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const tRaw = useTranslations("nav");
  const tCommon = useTranslations("common");
  const t = useCallback((key) => {
    try {
      return tRaw(key);
    } catch {
      return String(key);
    }
  }, [tRaw]);
  t.has = (key) => {
    try {
      return typeof tRaw.has === "function" ? tRaw.has(key) : true;
    } catch {
      return false;
    }
  };
  const locale = useLocale();
  useEffect(() => {
    getMedusaAdminClient().setUiLocale(locale);
  }, [locale]);
  const notifCopy = useMemo(() => getNotificationsCopy(locale), [locale]);
  const unsaved = useUnsavedChanges();
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(
    typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true"
  );
  const [userPermissions, setUserPermissions] = useState(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(localStorage.getItem("sellerPermissions") || "null"); } catch { return null; }
  });
  const impersonation = useSellerImpersonation();
  const [confirmDeleteState, setConfirmDeleteState] = useState({ open: false, message: "" });
  const confirmDeleteLabels = useMemo(
    () => ({
      title: lt(locale, "Confirm deletion", "Silme işlemini onayla", "Confirmer la suppression", "Confirmar eliminación", "Conferma eliminazione", "Löschen bestätigen"),
      confirm: lt(locale, "Delete", "Sil", "Supprimer", "Eliminar", "Elimina", "Löschen"),
      cancel: lt(locale, "Cancel", "İptal", "Annuler", "Cancelar", "Annulla", "Abbrechen"),
    }),
    [locale],
  );
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifData, setNotifData] = useState(null);
  const [msgUnread, setMsgUnread] = useState(0);
  const [orderToast, setOrderToast] = useState(null);
  const [pageToast, setPageToast] = useState(null);
  useEffect(() => {
    __registerToast(setPageToast);
  }, []);
  const prevOrdersCountRef = useRef(null);
  const notifRef = useRef(null);
  // Track which parent nav item has its sub-menu expanded
  const [expandedNavKey, setExpandedNavKey] = useState(null);
  const [storeName, setStoreName] = useState(
    typeof window !== "undefined"
      ? localStorage.getItem("storeName") || "Seller Account"
      : "Seller Account"
  );
  const [approvalStatus, setApprovalStatus] = useState(
    typeof window !== "undefined" ? String(localStorage.getItem("sellerApprovalStatus") || "").toLowerCase() : ""
  );
  const [scLogoByDevice, setScLogoByDevice] = useState({
    desktop: { url: "", height: 30, pt: 0, pr: 0, pb: 0, pl: 0 },
    tablet: { url: "", height: 28, pt: 0, pr: 0, pb: 0, pl: 0 },
    mobile: { url: "", height: 26, pt: 0, pr: 0, pb: 0, pl: 0 },
  });
  const [sellercentralFavicon, setSellercentralFavicon] = useState("");
  const [logoViewportTier, setLogoViewportTier] = useState("desktop");

  const loadSellercentralShellBranding = useCallback(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("sellerToken");
    const base = (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "").replace(/\/$/, "");
    if (!base) return;
    fetch(`${base}/admin-hub/seller-settings?seller_id=default`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d) => {
        setScLogoByDevice(buildSellercentralLogoSlotsFromSettings(d || {}));
        setSellercentralFavicon(String(d?.sellercentral_favicon_url ?? "").trim());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSellercentralShellBranding();
  }, [loadSellercentralShellBranding]);

  // Register delete confirm modal
  useEffect(() => {
    __registerConfirmModal(setConfirmDeleteState);
  }, []);

  // Listen for impersonation context changes → update nav/header state
  useEffect(() => {
    const handler = () => {
      setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
      setStoreName(localStorage.getItem("storeName") || "Seller Account");
      try {
        setUserPermissions(JSON.parse(localStorage.getItem("sellerPermissions") || "null"));
      } catch { setUserPermissions(null); }
    };
    window.addEventListener("andertal-impersonation-changed", handler);
    return () => window.removeEventListener("andertal-impersonation-changed", handler);
  }, []);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const readTier = () => {
      const w = window.innerWidth;
      if (w < 768) return "mobile";
      if (w < 1024) return "tablet";
      return "desktop";
    };
    setLogoViewportTier(readTier());
    const onResize = () => setLogoViewportTier(readTier());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRefresh = () => loadSellercentralShellBranding();
    window.addEventListener("andertal-sellercentral-branding-refresh", onRefresh);
    return () => window.removeEventListener("andertal-sellercentral-branding-refresh", onRefresh);
  }, [loadSellercentralShellBranding]);

  const platformBranding = useMemo(() => {
    const slot = scLogoByDevice[logoViewportTier] || scLogoByDevice.desktop;
    return {
      sellercentral_logo_url: slot?.url || "",
      sellercentral_favicon_url: sellercentralFavicon,
      sellercentral_logo_height: slot?.size ?? slot?.height ?? 30,
      logo_pt: slot?.pt ?? 0,
      logo_pr: slot?.pr ?? 0,
      logo_pb: slot?.pb ?? 0,
      logo_pl: slot?.pl ?? 0,
    };
  }, [scLogoByDevice, logoViewportTier, sellercentralFavicon]);

  useEffect(() => {
    // Same-origin proxy (sellercentral_favicon_url only — never shop).
    applyDocumentFavicon("/api/brand-favicon?app=sellercentral");
  }, [platformBranding.sellercentral_favicon_url]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const h = Math.min(Math.max(platformBranding.sellercentral_logo_height || 30, 16), 44);
    const id = "andertal-sc-logo-height";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = `[class*="LogoContainer"] img,[class*="LogoLink"] img,.Polaris-TopBar__LogoContainer img{height:${h}px!important;width:auto!important;max-height:${h}px!important;}`;
  }, [platformBranding.sellercentral_logo_height]);

  const refreshNotifications = useCallback(async () => {
    try {
      const d = await getMedusaAdminClient().getNotificationsUnread();
      if (d && !d.__error) {
        setNotifData(d);
        setMsgUnread(d.messages || 0);
        const prevCount = prevOrdersCountRef.current;
        const nextCount = typeof d.orders === "number" ? d.orders : 0;
        // Only toast once we have a baseline from a previous poll — otherwise every
        // page load with pre-existing unread orders would pop a toast.
        if (prevCount !== null && nextCount > prevCount) {
          setOrderToast(notifCopy.newOrdersToast(nextCount - prevCount));
        }
        prevOrdersCountRef.current = nextCount;
      }
    } catch {
      // Backend unreachable — silently ignore
    }
  }, [notifCopy]);

  // Poll notifications + message unread count every 60s
  useEffect(() => {
    if (!isAuthenticated) return;
    refreshNotifications();
    const id = setInterval(refreshNotifications, 60000);
    return () => clearInterval(id);
  }, [isAuthenticated, refreshNotifications]);

  // Inbox: refresh badge immediately after messages are marked read (not only on 60s poll)
  useEffect(() => {
    if (!isAuthenticated || typeof window === "undefined") return;
    const onRefresh = () => {
      refreshNotifications();
    };
    window.addEventListener("andertal-msg-unread-refresh", onRefresh);
    window.addEventListener("andertal-notifications-refresh", onRefresh);
    return () => {
      window.removeEventListener("andertal-msg-unread-refresh", onRefresh);
      window.removeEventListener("andertal-notifications-refresh", onRefresh);
    };
  }, [isAuthenticated, refreshNotifications]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!pathname || !pathname.includes("/inbox")) return;
    refreshNotifications();
  }, [pathname, isAuthenticated, refreshNotifications]);

  // Close notif dropdown on outside click
  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [notifOpen]);

  // Routes blocked for non-superuser sellers
  const SELLER_BLOCKED_ROUTES = new Set([
    "/sellers",
    "/sellers/errors",
    "/products/collections",
    "/products/collections/new",
    "/content/menus",
    "/content/menus/new",
    "/content/categories",
    "/content/landing-page",
    "/content/styles",
    "/content/pages",
    "/content/blog-posts",
    "/content/flows",
    "/content/metaobjects",
    "/content/compliance-review",
    "/content/compliance-profiles",
    "/content/payout-risk",
    "/affiliate-admin",
    "/analytics/live-view",
    "/orders/abandoned-checkouts",
    "/customers-menu",
    "/customers",
    "/customers/reviews",
    "/customers/newsletter",
    "/marketing/automations",
    "/marketing/seo",
    "/settings/checkout",
  ]);
  const isSellerBlockedPath = (path) => {
    if (!path) return false;
    if (SELLER_BLOCKED_ROUTES.has(path)) return true;
    // Customer detail / nested customer routes
    if (path === "/customers" || path.startsWith("/customers/")) return true;
    return false;
  };

  useEffect(() => {
    if (pathname === "/login" || pathname === "/register") return;
    const loggedIn = localStorage.getItem("sellerLoggedIn");
    if (!loggedIn) {
      router.push("/login");
    } else {
      const superuser = localStorage.getItem("sellerIsSuperuser") === "true";
      setIsAuthenticated(true);
      setIsSuperuser(superuser);
      // Load permissions from profile (cache in localStorage)
      const cachedPerms = localStorage.getItem("sellerPermissions");
      if (cachedPerms) {
        try { setUserPermissions(JSON.parse(cachedPerms)); } catch { setUserPermissions(null); }
      }
      // Fetch fresh profile to get latest permissions + authoritative role/seller_id
      getMedusaAdminClient().getSellerProfile().then((d) => {
        const perms = d?.user?.permissions || null;
        localStorage.setItem("sellerPermissions", perms ? JSON.stringify(perms) : "null");
        setUserPermissions(perms);
      }).catch(() => {});
      getMedusaAdminClient().getSellerAccount().then((d) => {
        const status = String(d?.user?.approval_status || "").toLowerCase();
        if (status) localStorage.setItem("sellerApprovalStatus", status);
        setApprovalStatus(status);
        const accountSuper = d?.user?.is_superuser === true;
        localStorage.setItem("sellerIsSuperuser", accountSuper ? "true" : "false");
        setIsSuperuser(accountSuper);
        const accountSellerId = String(d?.user?.seller_id || d?.user?.effective_seller_id || "").trim();
        if (accountSellerId) localStorage.setItem("sellerId", accountSellerId);
        if (!accountSuper && isSellerBlockedPath(pathname)) {
          router.replace("/dashboard");
        }
      }).catch(() => {});
      // Redirect non-superusers away from blocked routes (cached role; account fetch re-checks)
      if (!superuser && isSellerBlockedPath(pathname)) {
        router.replace("/dashboard");
        return;
      }
      getMedusaAdminClient().getSellerSettings().then((data) => {
        if (data?.store_name) {
          localStorage.setItem("storeName", data.store_name);
          setStoreName(data.store_name);
        }
      }).catch(() => {});
    }
  }, [pathname, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e) => {
      const name = e.detail?.storeName;
      if (name) setStoreName(name);
    };
    window.addEventListener("sellerStoreNameChanged", handler);
    return () => window.removeEventListener("sellerStoreNameChanged", handler);
  }, []);

  // Nav seçili öğe: sadece mevcut path vurgulansın (Home "/" başka sayfadayken vurgulu kalmasın)
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.setAttribute("data-pathname", pathname || "/");
    return () => {
      document.body.removeAttribute("data-pathname");
    };
  }, [pathname]);

  const handleLogout = useCallback(async () => {
    localStorage.removeItem("sellerLoggedIn");
    localStorage.removeItem("sellerEmail");
    localStorage.removeItem("sellerId");
    localStorage.removeItem("storeName");
    localStorage.removeItem("sellerToken");
    localStorage.removeItem("sellerIsSuperuser");
    localStorage.removeItem("sellerPermissions");
    localStorage.removeItem("sellerApprovalStatus");
    try {
      sessionStorage.removeItem("andertal_seller_impersonation_v1");
    } catch {
      /* ignore */
    }
    localStorage.removeItem("andertal_su_auth_backup");
    // Clear httpOnly session cookie
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    router.push("/login");
  }, [router]);

  const userMenuActions = [
    {
      items: [
        { content: tCommon("settings"), url: "/settings" },
        { content: tCommon("logout"), onAction: () => handleLogout() },
      ],
    },
  ];

  const getUserInitials = () => {
    if (storeName && storeName !== "Seller Account") {
      return storeName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .substring(0, 2);
    }
    return "S";
  };

  if (pathname === "/login" || pathname === "/register") {
    return <>{children}</>;
  }

  if (!isAuthenticated) {
    return null;
  }

  const localeLabel =
    LOCALES.find((l) => l.code === locale)?.label ?? String(locale || "").toUpperCase();

  const notifUnread = notifData
    ? (notifData.orders || 0) +
      (notifData.returns || 0) +
      (notifData.verifications || 0) +
      (notifData.change_requests || 0) +
      (notifData.campaigns || 0) +
      (notifData.seller_errors || 0) +
      (notifData.seller_listings_pending || 0) +
      (notifData.brand_authorizations_pending || 0) +
      (notifData.flow_failures || 0) +
      (notifData.support_cases || 0) +
      (notifData.eu_origin_pending || 0)
    : 0;

  const topBarIconStyle = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 36, height: 36, borderRadius: 8, background: "rgba(255,255,255,0.1)",
    border: "none", cursor: "pointer", color: "#fff", flexShrink: 0,
    position: "relative",
  };

  const langSelector = (
    <Popover
      active={langDropdownOpen}
      autofocusTarget="first-node"
      preferredAlignment="right"
      preferredPosition="below"
      onClose={() => setLangDropdownOpen(false)}
      activator={
        <Button
          variant="plain"
          onClick={() => setLangDropdownOpen((v) => !v)}
          accessibilityLabel={`Language / Dil — ${localeLabel}`}
          size="slim"
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#fff", height: 36, padding: "0 6px" }}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" width="20" height="20" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.04em", lineHeight: 1 }}>
              {localeLabel}
            </span>
          </span>
        </Button>
      }
    >
      <ActionList
        items={LOCALES.map(({ code, label }) => ({
          content: label,
          active: locale === code,
          onAction: () => {
            router.replace(pathname, { locale: code });
            setLangDropdownOpen(false);
          },
        }))}
      />
    </Popover>
  );

  const frameLogoUrl = normalizeSellerCentralLogoUrl(platformBranding.sellercentral_logo_url);
  const topBarLogoMaxH = Math.min(Math.max(platformBranding.sellercentral_logo_height || 30, 16), 44);

  /** Polaris Frame `logo` makes TopBar + Navigation render Image with `topBarSource || ''` (empty src warning). Use contextControl on both instead. */
  const polarisLogoContextControl = frameLogoUrl ? (
    <div style={{
      display: "flex",
      alignItems: "center",
      paddingTop: platformBranding.logo_pt || undefined,
      paddingRight: platformBranding.logo_pr || undefined,
      paddingBottom: platformBranding.logo_pb || undefined,
      paddingLeft: platformBranding.logo_pl || undefined,
    }}>
      <UnstyledLink url="/dashboard" style={{ display: "block", lineHeight: 0 }}>
        <img
          src={frameLogoUrl}
          alt="Sellercentral"
          style={{
            display: "block",
            width: "auto",
            maxWidth: 200,
            height: topBarLogoMaxH,
            objectFit: "contain",
          }}
        />
      </UnstyledLink>
    </div>
  ) : undefined;

  const topBarMarkup = (
    <TopBar
      showNavigationToggle
      onNavigationToggle={() => setShowMobileNav((v) => !v)}
      contextControl={polarisLogoContextControl}
      userMenu={
        <div style={{ display: "flex", alignItems: "center", gap: 4, height: 56 }}>
          {/* Language selector */}
          {langSelector}

          {/* Mail / Inbox */}
          <Link href="/inbox" style={{ ...topBarIconStyle, textDecoration: "none" }} title={notifCopy.messagesTitle}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" width="20" height="20" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
            </svg>
            {msgUnread > 0 && (
              <span style={{ position: "absolute", top: 4, right: 4, background: "#ef4444", color: "#fff", borderRadius: "50%", fontSize: 9, fontWeight: 800, width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                {msgUnread > 9 ? "9+" : msgUnread}
              </span>
            )}
          </Link>

          {/* Bell / Notifications */}
          <div ref={notifRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={async () => {
                setNotifOpen((v) => !v);
                if (!notifOpen) {
                  try {
                    await getMedusaAdminClient().markNotificationsSeen();
                    await refreshNotifications();
                  } catch {
                    // ignore
                  }
                }
              }}
              style={{ ...topBarIconStyle }}
              title={notifCopy.title}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" width="20" height="20" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
              </svg>
              {notifUnread > 0 && (
                <span style={{ position: "absolute", top: 4, right: 4, background: "#ef4444", color: "#fff", borderRadius: "50%", fontSize: 9, fontWeight: 800, width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                  {notifUnread > 9 ? "9+" : notifUnread}
                </span>
              )}
            </button>
            {notifOpen && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 400, maxWidth: "calc(100vw - 24px)", background: "#fff", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.15)", border: "1px solid #e5e7eb", zIndex: 9999 }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6", fontSize: 13, fontWeight: 700, color: "#111827" }}>{notifCopy.title}</div>
                <div style={{ maxHeight: 420, overflowY: "auto" }}>
                  {(!notifData?.recent_orders?.length &&
                    !notifData?.recent_returns?.length &&
                    !notifData?.recent_verifications?.length &&
                    !notifData?.recent_product_change_requests?.length &&
                    !notifData?.recent_campaigns_submitted?.length &&
                    !notifData?.recent_seller_errors?.length &&
                    !notifData?.recent_support_cases?.length &&
                    !notifData?.recent_seller_listings_pending?.length &&
                    !notifData?.recent_eu_origin_pending?.length) ? (
                    <div style={{ padding: "24px 16px", textAlign: "center", color: "#9ca3af", fontSize: 13 }}>{notifCopy.empty}</div>
                  ) : (
                    <>
                      {(notifData?.recent_support_cases || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.supportCases}
                        </div>
                      )}
                      {(notifData?.recent_support_cases || []).map((c) => (
                        <Link
                          key={c.id}
                          href={`/inbox?case=${encodeURIComponent(c.reference_id || "")}`}
                          onClick={() => setNotifOpen(false)}
                          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>💬</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{c.title || notifCopy.newSupportCase}</div>
                            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.35, marginTop: 2, whiteSpace: "pre-line", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                              {String(c.body || "").split("\n")[0]}
                            </div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_seller_errors || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.sellerErrors}
                        </div>
                      )}
                      {(notifData?.recent_seller_errors || []).map((e) => (
                        <Link
                          key={e.id}
                          href="/sellers/errors"
                          onClick={() => setNotifOpen(false)}
                          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>⚠️</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                              {notifCopy.sellerErrorTitle(e.store_name || e.seller_email || e.seller_id || "—")}
                            </div>
                            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.35, marginTop: 2 }}>
                              {e.error_code ? `[${e.error_code}] ` : ""}{String(e.error_message || "").slice(0, 120)}
                            </div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_campaigns_submitted || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.campaigns}
                        </div>
                      )}
                      {(notifData?.recent_campaigns_submitted || []).map((c) => (
                        <Link
                          key={c.id}
                          href={c.reference_id ? `/marketing/campaigns/${c.reference_id}` : "/marketing/campaigns"}
                          onClick={() => setNotifOpen(false)}
                          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>📣</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{c.title || notifCopy.newCampaign}</div>
                            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.35, marginTop: 2 }}>{c.body || ""}</div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_verifications || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.verifications}
                        </div>
                      )}
                      {(notifData?.recent_verifications || []).map((v) => (
                        <Link key={v.id} href={v.reference_id || v.seller_id ? `/sellers/${v.reference_id || v.seller_id}` : "/sellers"} onClick={() => setNotifOpen(false)} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}>
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>{v.type === "seller_registered" ? "🆕" : "📋"}</span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{v.title || (v.type === "seller_registered" ? notifCopy.sellerRegistered : notifCopy.docSubmitted)}</div>
                            <div style={{ fontSize: 11, color: "#6b7280" }}>{v.body || (v.type === "seller_registered" ? "" : notifCopy.docSubmittedBody)}</div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_eu_origin_pending || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.euOrigin}
                        </div>
                      )}
                      {(notifData?.recent_eu_origin_pending || []).map((e) => (
                        <Link
                          key={e.id}
                          href={e.product_id ? `/products/${e.product_id}` : "/products/inventory"}
                          onClick={() => setNotifOpen(false)}
                          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}
                        >
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>🇪🇺</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{notifCopy.euOriginPending}</div>
                            <div style={{ fontSize: 11, color: "#6b7280" }}>{e.product_title || e.registry_id || e.country || ""}</div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_product_change_requests || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.productChanges}
                        </div>
                      )}
                      {(notifData?.recent_product_change_requests || []).map((cr) => {
                        const isSellerInfo = !cr.product_id && (cr.title || cr.reference_id);
                        const href = cr.product_id
                          ? `/products/${cr.product_id}`
                          : (cr.reference_id || cr.seller_id ? `/sellers/${cr.reference_id || cr.seller_id}` : "/products/inventory");
                        return (
                        <Link
                          key={cr.id}
                          href={href}
                          onClick={() => setNotifOpen(false)}
                          style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              marginTop: 1,
                              width: 32,
                              height: 32,
                              borderRadius: 8,
                              background: "var(--p-color-bg-fill-secondary)",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "var(--p-color-icon)",
                            }}
                            aria-hidden
                          >
                            <Icon source={EditIcon} tone="subdued" />
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--p-color-text)" }}>
                              {isSellerInfo ? (cr.title || notifCopy.productChangePending) : notifCopy.productChangePending}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--p-color-text-secondary)", lineHeight: 1.35, marginTop: 2 }}>
                              {isSellerInfo
                                ? (cr.body || "")
                                : `${cr.product_title || notifCopy.productFallback} · ${fieldNameDisplayLabel(cr.field_name, locale)}`}
                            </div>
                          </div>
                        </Link>
                        );
                      })}
                      {(notifData?.recent_orders || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.orders}
                        </div>
                      )}
                      {(notifData?.recent_orders || []).map((o) => (
                        <Link key={o.id} href={`/orders/${o.id}`} onClick={() => setNotifOpen(false)} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}>
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>📦</span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{notifCopy.newOrder(o.order_number || "—")}</div>
                            <div style={{ fontSize: 11, color: "#6b7280" }}>{o.first_name} {o.last_name} · {o.total_cents ? (o.total_cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 }) + " €" : ""}</div>
                          </div>
                        </Link>
                      ))}
                      {(notifData?.recent_returns || []).length > 0 && (
                        <div style={{ padding: "8px 16px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                          {notifCopy.returns}
                        </div>
                      )}
                      {(notifData?.recent_returns || []).map((r) => (
                        <Link key={r.id} href="/orders/returns" onClick={() => setNotifOpen(false)} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f9fafb", textDecoration: "none" }}>
                          <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>↩️</span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{notifCopy.returnRequest(r.return_number || "—")}</div>
                            <div style={{ fontSize: 11, color: "#6b7280" }}>{notifCopy.orderRef(r.order_number || "—")} · {localizeStatus(locale, r.status)}</div>
                          </div>
                        </Link>
                      ))}
                    </>
                  )}
                </div>
                <div style={{ padding: "10px 16px", borderTop: "1px solid #f3f4f6" }}>
                  <Link href="/notifications" onClick={() => setNotifOpen(false)} style={{ fontSize: 12, color: "#0284c7", textDecoration: "none", fontWeight: 600 }}>
                    {notifCopy.viewAll} →
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Profile */}
          <TopBar.UserMenu
            name={storeName}
            detail={isSuperuser ? "⚡ Superuser" : "Seller"}
            initials={getUserInitials()}
            actions={userMenuActions}
            open={userMenuOpen}
            onToggle={() => setUserMenuOpen((v) => !v)}
          />
        </div>
      }
      searchField={
        <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", maxWidth: "100%" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <GroupedDropdownSearch placeholder="Search products, orders, customers..." />
          </div>
          {unsaved?.isDirty && (
            <>
              <style>{discardBtnStyles}</style>
              <div className="andertal-discard-topbar-btn">
                <Button
                  size="slim"
                  variant="tertiary"
                  onClick={() => unsaved.runDiscard()}
                  style={{
                    background: "#4d4d4d",
                    color: "#ffffff",
                    border: "1px solid #5c5c5c",
                  }}
                >
                  Discard
                </Button>
              </div>
              <Button
                size="medium"
                variant="secondary"
                onClick={() => unsaved.runSave()}
                style={{
                  background: "#fff",
                  color: "#202223",
                  border: "2px solid #202223",
                  fontWeight: 600,
                  minWidth: 80,
                }}
              >
                Save
              </Button>
            </>
          )}
        </div>
      }
    />
  );

  // Filter nav items based on role
  const SELLER_BLOCKED_NAV = new Set([
    "/products/collections",
    "/content/menus",
    "/content/categories",
    "/content/landing-page",
    "/content/styles",
    "/content/pages",
    "/content/blog-posts",
    "/content/flows",
    "/content/metaobjects",
    "/content/compliance-review",
    "/content/compliance-profiles",
    "/content/payout-risk",
    "/affiliate-admin",
    "/analytics/live-view",
    "/orders/abandoned-checkouts",
    "/customers-menu",
    "/customers",
    "/customers/reviews",
    "/customers/newsletter",
    "/marketing/automations",
    "/marketing/seo",
    "/sellers",
    "/sellers/errors",
  ]);

  const filterNavForRole = (items) => {
    if (isSuperuser) return items;
    // Custom permissions are an allow-list, but never grant superuser-only routes.
    const isAllowed = (url) => {
      if (SELLER_BLOCKED_NAV.has(url) || SUPERUSER_NAV_HREF_FRAGMENTS.some((frag) => url === frag || url.startsWith(frag + "/"))) {
        return false;
      }
      if (userPermissions) return userPermissions.some((p) => url === p || url.startsWith(p + "/"));
      return true;
    };
    return items
      .filter((item) => isAllowed(item.url) || item.subNavigationItems?.some((s) => isAllowed(s.url)))
      .map((item) => {
        if (!item.subNavigationItems) return item;
        return { ...item, subNavigationItems: item.subNavigationItems.filter((s) => isAllowed(s.url)) };
      });
  };

  const menuMain = sanitizePolarisNavItems(
    filterNavForRole(stripSuperuserOnlyNav(getMenuItemsMain(t, isSuperuser), isSuperuser)),
  );
  const menuSettings = getMenuItemsSettings(t, isSuperuser);
  const navLocation = pathname && pathname !== "" ? pathname : "/";

  const navMarkup = (
    <Navigation
      location={navLocation}
      onDismiss={() => setShowMobileNav(false)}
      contextControl={polarisLogoContextControl}
    >
      <Navigation.Section
        items={finalizePolarisSectionItems(menuMain).map((item) => {
          const hasSub = item.subNavigationItems?.length > 0;
          const shouldToggleOnly = hasSub && PARENT_NAV_URLS.has(item.url);
          // A parent is "selected" (expanded) if we manually toggled it OR a child matches current path
          const parentTargetUrl = shouldToggleOnly && item.subNavigationItems?.[0]?.url ? item.subNavigationItems[0].url : item.url;
          const parentIsActive = !!parentTargetUrl && (navLocation === parentTargetUrl || navLocation.startsWith(`${parentTargetUrl}/`));
          const childIsActive = hasSub && item.subNavigationItems.some((s) => s.url !== item.url && navLocation.startsWith(s.url));
          const isSelected = hasSub
            ? ((shouldToggleOnly && expandedNavKey === item.url) || parentIsActive || childIsActive)
            : undefined;
          return {
            url: item.url,
            label: item.label,
            icon: item.icon,
            subNavigationItems: item.subNavigationItems,
            selected: isSelected,
            onClick: shouldToggleOnly
              ? () => setExpandedNavKey((prev) => prev === item.url ? null : item.url)
              : undefined,
          };
        })}
      />
      <Navigation.Section
        fill
        separator
        items={finalizePolarisSectionItems(menuSettings).map((item) => {
          const hasSub = item.subNavigationItems?.length > 0;
          const shouldToggleOnly = hasSub && PARENT_NAV_URLS.has(item.url);
          const parentIsActive = navLocation === item.url || navLocation.startsWith(item.url + "/");
          const childIsActive = hasSub && item.subNavigationItems.some((s) => navLocation.startsWith(s.url));
          const isSelected = hasSub ? (shouldToggleOnly && expandedNavKey === item.url) || parentIsActive || childIsActive : undefined;
          return {
            url: item.url,
            label: item.label,
            icon: item.icon,
            subNavigationItems: item.subNavigationItems,
            selected: isSelected,
            onClick: shouldToggleOnly
              ? () => setExpandedNavKey((prev) => prev === item.url ? null : item.url)
              : undefined,
          };
        })}
      />
    </Navigation>
  );

  const linkComponent = unsaved ? UnsavedAwareLink : NextLink;
  const bannerI18n = getApprovalBannerCopy(locale);
  const approvalBanner = !isSuperuser ? (() => {
    const status = String(approvalStatus || "").toLowerCase();
    if (!status) return null;
    if (status === "registered") {
      return {
        background: "#f59e0b",
        color: "#111827",
        text: bannerI18n.completeVerification,
        actionLabel: bannerI18n.goVerification,
        actionHref: "/settings/verification",
      };
    }
    if (status === "approved" || status === "active") return null;
    if (status === "suspended") {
      return {
        background: "#dc2626",
        color: "#fff",
        text: bannerI18n.suspended,
      };
    }
    if (status === "rejected") {
      return {
        background: "#ef4444",
        color: "#fff",
        text: bannerI18n.rejected,
      };
    }
    if (status === "documents_submitted") {
      return {
        background: "#d97706",
        color: "#fff",
        text: bannerI18n.docsSubmitted,
      };
    }
    if (status === "pending_approval" || status === "pending") {
      return {
        background: "#2563eb",
        color: "#fff",
        text: bannerI18n.pending,
      };
    }
    return {
      background: "#4b5563",
      color: "#fff",
      text: bannerI18n.accountStatus(status),
    };
  })() : null;

  return (
    <AppProvider i18n={polarisI18nFor(locale)} linkComponent={linkComponent}>
      <Frame
        navigation={navMarkup}
        topBar={topBarMarkup}
        showMobileNavigation={showMobileNav}
        onNavigationDismiss={() => setShowMobileNav(false)}
        toastMarkup={(
          <>
            {orderToast ? <Toast content={orderToast} onDismiss={() => setOrderToast(null)} duration={6000} /> : null}
            {pageToast ? <Toast key={pageToast.key} content={pageToast.message} error={pageToast.error} duration={pageToast.duration} onDismiss={() => setPageToast(null)} /> : null}
          </>
        )}
      >
        {isSuperuser ? <style>{SUPERUSER_NAV_ACCENT_CSS}</style> : null}
        {approvalBanner && (
          <div
            style={{
              background: approvalBanner.background,
              color: approvalBanner.color,
              textAlign: "center",
              fontSize: 13,
              fontWeight: 600,
              padding: "10px 16px",
            }}
          >
            <span>{approvalBanner.text}</span>
            {approvalBanner.actionHref && (
              <button
                type="button"
                onClick={() => router.push(approvalBanner.actionHref)}
                style={{
                  marginLeft: 12,
                  border: "none",
                  background: "transparent",
                  color: approvalBanner.color,
                  cursor: "pointer",
                  fontWeight: 700,
                  textDecoration: "underline",
                }}
              >
                {approvalBanner.actionLabel} {"\u2192"}
              </button>
            )}
          </div>
        )}
        {unsaved?.showNavigateConfirm && (
          <Modal
            open={true}
            onClose={() => unsaved.setShowNavigateConfirm(false)}
            title="Unsaved changes"
            primaryAction={{
              content: "Save",
              onAction: () => unsaved.runSave(),
            }}
            secondaryActions={[
              {
                content: "Discard",
                destructive: true,
                onAction: () => unsaved.runDiscard(),
              },
            ]}
          >
            <Modal.Section>
              <Text as="p">You have unsaved changes. Save or discard before leaving.</Text>
            </Modal.Section>
          </Modal>
        )}
        {/* Delete confirmation modal */}
        {confirmDeleteState.open && (
          <Modal
            open
            onClose={() => __resolveConfirmModal(false)}
            title={confirmDeleteLabels.title}
            primaryAction={{
              content: confirmDeleteLabels.confirm,
              destructive: true,
              onAction: () => __resolveConfirmModal(true),
            }}
            secondaryActions={[
              { content: confirmDeleteLabels.cancel, onAction: () => __resolveConfirmModal(false) },
            ]}
          >
            <Modal.Section>
              <Text as="p">{confirmDeleteState.message}</Text>
            </Modal.Section>
          </Modal>
        )}

        <div className="andertal-scroll-wrapper" key={impersonation?.expandedId || "superuser"}>
          <div className="andertal-page-content andertal-page-content-transition">
            {children}
          </div>
        </div>
      </Frame>
      {/* Seller impersonation bottom tab bar */}
      <SellerImperBar />
    </AppProvider>
  );
}
