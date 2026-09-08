"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "@/i18n/navigation";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

const NAV_ITEMS = [
  { category: "Navigation", label: "Home", url: "/", keywords: "home dashboard" },
  { category: "Orders", label: "Orders", url: "/orders", keywords: "orders" },
  { category: "Orders", label: "Drafts", url: "/orders/drafts", keywords: "drafts" },
  { category: "Orders", label: "Abandoned checkouts", url: "/orders/abandoned-checkouts", keywords: "abandoned checkout" },
  { category: "Orders", label: "Returns", url: "/orders/returns", keywords: "returns" },
  { category: "Products", label: "Collections", url: "/products/collections", keywords: "collections" },
  { category: "Products", label: "Inventory", url: "/products/inventory", keywords: "products inventory" },
  { category: "Products", label: "Gift Cards", url: "/products/gift-cards", keywords: "gift cards" },
  { category: "Products", label: "Bulk upload", url: "/products/bulk-upload", keywords: "bulk upload" },
  { category: "Products", label: "Single upload", url: "/products/single-upload", keywords: "add product" },
  { category: "Customers", label: "Customers", url: "/customers", keywords: "customers" },
  { category: "Marketing", label: "Campaigns", url: "/marketing/campaigns", keywords: "campaigns" },
  { category: "Marketing", label: "Attribution", url: "/marketing/attribution", keywords: "attribution" },
  { category: "Marketing", label: "SEO", url: "/marketing/seo", keywords: "seo meta search engine" },
  { category: "Marketing", label: "Automations", url: "/marketing/automations", keywords: "automations" },
  { category: "Navigation", label: "Discounts", url: "/discounts", keywords: "discounts" },
  { category: "Content", label: "Categories", url: "/content/categories", keywords: "categories" },
  { category: "Content", label: "Media", url: "/content/media", keywords: "media library upload" },
  { category: "Content", label: "Pages", url: "/content/pages", keywords: "pages cms" },
  { category: "Content", label: "Menus", url: "/content/menus", keywords: "menus" },
  { category: "Content", label: "Brands", url: "/content/brands", keywords: "brands" },
  { category: "Analytics", label: "Reports", url: "/analytics/reports", keywords: "reports analytics" },
  { category: "Analytics", label: "Ranking", url: "/analytics/ranking", keywords: "ranking produkt product score" },
  { category: "Analytics", label: "Live View", url: "/analytics/live-view", keywords: "live" },
  { category: "Navigation", label: "Import/Export", url: "/import-export", keywords: "import export bulk" },
  { category: "Settings", label: "Settings", url: "/settings", keywords: "settings" },
  { category: "Settings", label: "Shipping", url: "/settings/shipping", keywords: "shipping" },
  { category: "Settings", label: "Payments", url: "/settings/payments", keywords: "payments" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenMetaValues(meta) {
  if (!meta || typeof meta !== "object") return "";
  return Object.values(meta)
    .filter((v) => v != null && typeof v !== "object" && typeof v !== "boolean")
    .join(" ")
    .toLowerCase();
}

function productSearchText(p) {
  const meta = p.metadata || {};
  const parts = [
    p.title,
    p.handle,
    p.sku,
    p.description,
    meta.ean,
    meta.brand,
    meta.brand_name,
    flattenMetaValues(meta),
  ];
  // Variants: EAN, SKU, option_values
  if (Array.isArray(p.variants)) {
    for (const v of p.variants) {
      parts.push(v.ean, v.sku, v.title);
      if (Array.isArray(v.option_values)) parts.push(...v.option_values);
      const vm = v.metadata || {};
      parts.push(vm.ean, vm.sku, flattenMetaValues(vm));
    }
  }
  // Variation groups option values
  if (Array.isArray(p.variation_groups)) {
    for (const g of p.variation_groups) {
      if (Array.isArray(g.options)) {
        for (const o of g.options) {
          parts.push(o.value, o.label);
          if (o.labels && typeof o.labels === "object") parts.push(...Object.values(o.labels));
        }
      }
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function orderSearchText(o) {
  const addr = o.billing_address || o.shipping_address || {};
  const name = [addr.first_name, addr.last_name, o.customer_name, o.customer_email].filter(Boolean).join(" ");
  return [
    o.id,
    o.display_id != null ? `#${o.display_id}` : "",
    o.order_number != null ? `#${o.order_number}` : "",
    o.email,
    name,
  ].filter(Boolean).join(" ").toLowerCase();
}

function customerSearchText(c) {
  return [c.id, c.email, c.first_name, c.last_name, `${c.first_name || ""} ${c.last_name || ""}`.trim()]
    .filter(Boolean).join(" ").toLowerCase();
}

function matchQ(text, q) {
  return q.split(/\s+/).filter(Boolean).every((token) => text.includes(token));
}

// ── Component ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 250;
const MAX_PER_SECTION = 5;

export default function GroupedDropdownSearch({ placeholder = "Search products, orders, customers…" }) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [products, setProducts] = useState(null); // null = not loaded yet
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);
  const debounceRef = useRef(null);
  const loadedRef = useRef(false); // products fetched at least once

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Debounced search: fetch products once, orders+customers on every query
  const doSearch = useCallback(async (q) => {
    if (!q.trim()) { setIsOpen(false); return; }
    const client = getMedusaAdminClient();

    // Fetch products once and cache
    if (!loadedRef.current) {
      loadedRef.current = true;
      setLoading(true);
      try {
        const data = await client.getAdminHubProducts();
        setProducts(data.products || []);
      } catch (_) {
        setProducts([]);
      }
      setLoading(false);
    }

    // Fetch orders and customers with query (parallel)
    try {
      const [ordersRes, customersRes] = await Promise.allSettled([
        client.getOrders({ q, limit: 10 }),
        client.getCustomers({ q, limit: 10 }),
      ]);
      setOrders(ordersRes.status === "fulfilled" ? (ordersRes.value?.orders || []) : []);
      setCustomers(customersRes.status === "fulfilled" ? (customersRes.value?.customers || []) : []);
    } catch (_) {}

    setIsOpen(true);
  }, []);

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(debounceRef.current);
    if (!q.trim()) { setIsOpen(false); return; }
    debounceRef.current = setTimeout(() => doSearch(q), DEBOUNCE_MS);
  };

  const close = () => { setQuery(""); setIsOpen(false); };

  const q = query.trim().toLowerCase();

  // ── Filter nav items ──
  const navHits = q
    ? NAV_ITEMS.filter((item) =>
        matchQ(`${item.label} ${item.keywords}`.toLowerCase(), q)
      ).slice(0, MAX_PER_SECTION)
    : [];

  // ── Filter products client-side ──
  const productHits = q && products
    ? products.filter((p) => matchQ(productSearchText(p), q)).slice(0, MAX_PER_SECTION)
    : [];

  // ── Filter orders client-side (from fetched) ──
  const orderHits = q
    ? orders.filter((o) => matchQ(orderSearchText(o), q)).slice(0, MAX_PER_SECTION)
    : [];

  // ── Filter customers client-side (from fetched) ──
  const customerHits = q
    ? customers.filter((c) => matchQ(customerSearchText(c), q)).slice(0, MAX_PER_SECTION)
    : [];

  const hasAny = navHits.length > 0 || productHits.length > 0 || orderHits.length > 0 || customerHits.length > 0;

  return (
    <div ref={wrapRef} className="andertal-search-wrap">
      <input
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={handleChange}
        onFocus={() => q && setIsOpen(true)}
        aria-expanded={isOpen}
        className="andertal-search-input"
      />
      {isOpen && q && (
        <div className="andertal-search-dropdown" role="listbox">
          {loading && (
            <div className="andertal-search-empty" style={{ fontStyle: "italic" }}>Searching…</div>
          )}

          {!loading && !hasAny && (
            <div className="andertal-search-empty">No results for &quot;{query}&quot;</div>
          )}

          {/* Products */}
          {productHits.length > 0 && (
            <div>
              <div className="andertal-search-category">
                Products <span className="andertal-search-category-count">{productHits.length}</span>
              </div>
              {productHits.map((p) => {
                const meta = p.metadata || {};
                const sku = p.sku || p.variants?.[0]?.sku;
                const ean = meta.ean || p.variants?.[0]?.ean;
                const sub = [sku && `SKU: ${sku}`, ean && `EAN: ${ean}`].filter(Boolean).join(" · ");
                return (
                  <Link key={p.id} href={`/products/${p.id}`} className="andertal-search-hit" onClick={close}>
                    <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span>{p.title || p.handle}</span>
                      {sub && <span style={{ fontSize: 11, opacity: 0.65 }}>{sub}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Orders */}
          {orderHits.length > 0 && (
            <div>
              <div className="andertal-search-category">
                Orders <span className="andertal-search-category-count">{orderHits.length}</span>
              </div>
              {orderHits.map((o) => {
                const num = o.display_id != null ? `#${o.display_id}` : (o.order_number != null ? `#${o.order_number}` : o.id?.slice(0, 8));
                const addr = o.billing_address || o.shipping_address || {};
                const customerName = [addr.first_name, addr.last_name].filter(Boolean).join(" ") || o.customer_name || o.email || "";
                return (
                  <Link key={o.id} href={`/orders/${o.id}`} className="andertal-search-hit" onClick={close}>
                    <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span>{num} {customerName && `· ${customerName}`}</span>
                      {o.email && <span style={{ fontSize: 11, opacity: 0.65 }}>{o.email}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Customers */}
          {customerHits.length > 0 && (
            <div>
              <div className="andertal-search-category">
                Customers <span className="andertal-search-category-count">{customerHits.length}</span>
              </div>
              {customerHits.map((c) => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email;
                return (
                  <Link key={c.id} href={`/customers/${c.id}`} className="andertal-search-hit" onClick={close}>
                    <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span>{name}</span>
                      {c.email && name !== c.email && <span style={{ fontSize: 11, opacity: 0.65 }}>{c.email}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Navigation */}
          {navHits.length > 0 && (
            <div>
              <div className="andertal-search-category">
                Navigation <span className="andertal-search-category-count">{navHits.length}</span>
              </div>
              {navHits.map((item) => (
                <Link key={item.url} href={item.url} className="andertal-search-hit" onClick={close}>
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
