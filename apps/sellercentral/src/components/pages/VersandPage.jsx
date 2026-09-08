"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { Button, InlineStack, BlockStack } from "@shopify/polaris";
import { useLocale } from "next-intl";
import { fmtMoney } from "@/lib/locale-text";
import { getShipStrings } from "@/lib/ship-i18n";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import ShipLabelModal, { carrierBadge } from "@/components/orders/ShipLabelModal";
import { detectCarrierFromTrackingNumber } from "@/lib/carrier-detect";

export default function VersandPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const s = useMemo(() => getShipStrings(locale), [locale]);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSuperuser, setIsSuperuser] = useState(false);
  useEffect(() => { setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true"); }, []);
  const [scannedQty, setScannedQty] = useState({});
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scanError, setScanError] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [trackings, setTrackings] = useState({});
  const [manualCarrierOverride, setManualCarrierOverride] = useState({});
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState("scan");
  const barcodeRef = useRef(null);
  const [scannerConfig, setScannerConfig] = useState({ enabled: true, auto_focus: true, auto_submit: true, min_length: 3 });

  useEffect(() => {
    getMedusaAdminClient().getSellerSettings().then((d) => {
      if (d?.barcode_scanner_config && typeof d.barcode_scanner_config === "object") {
        setScannerConfig((prev) => ({ ...prev, ...d.barcode_scanner_config }));
      }
    }).catch(() => {});
  }, []);

  // Carrier is derived, never chosen up front: a Sendcloud-purchased label already carries
  // its own carrier_name; a manually typed tracking number gets a best-effort carrier guess
  // from its shape (see carrier-detect.js) — the seller can still override per order if wrong.
  const resolveOrderCarrierName = (order) => {
    if (manualCarrierOverride[order.id]) return manualCarrierOverride[order.id];
    if (order.carrier_name) return order.carrier_name;
    const detected = detectCarrierFromTrackingNumber(trackings[order.id]);
    return detected ? carrierBadge(detected).label : "";
  };

  // Order ids come from the URL (?ids=100006,100007), not sessionStorage — loadItemsForOrders
  // always re-fetches full detail per id from the backend, so the id list alone is enough and
  // survives a refresh or the link being reopened, unlike a one-shot sessionStorage read.
  useEffect(() => {
    const idsParam = searchParams.get("ids");
    if (idsParam) {
      const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean);
      if (ids.length) {
        loadItemsForOrders(ids.map((id) => ({ id })));
        return;
      }
    }
    fetchPendingOrders();
  }, [searchParams]);

  const fetchPendingOrders = async () => {
    setLoading(true);
    try {
      const client = getMedusaAdminClient();
      const data = await client.getOrders({ delivery_status: "offen", limit: 50 });
      const ordersData = data.orders || [];
      await loadItemsForOrders(ordersData);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const loadItemsForOrders = async (ordersData) => {
    const client = getMedusaAdminClient();
    // Always re-fetch order detail so items are seller-filtered + enriched (sku/ean)
    // from the backend — never trust a stale _items snapshot from the orders table.
    const enriched = await Promise.all(ordersData.map(async (o) => {
      try {
        const detail = await client.getOrder(o.id);
        const ord = detail.order || {};
        return {
          ...o,
          ...ord,
          _items: ord.items || [],
          total_cents: ord.total_cents ?? o.total_cents,
          subtotal_cents: ord.subtotal_cents ?? o.subtotal_cents,
        };
      } catch {
        return { ...o, _items: [] };
      }
    }));
    setOrders(enriched);
    const init = {};
    for (const o of enriched) init[o.id] = {};
    setScannedQty(init);
    setLoading(false);
  };

  const currentOrder = orders[currentIndex];
  const items = currentOrder?._items || [];

  const itemKeyOf = (it) => String(it.id || it.variant_id || it.product_id || it.title || "");
  const itemMaxQty = (it) => Math.max(1, Number(it.quantity || 1));

  const getQtyMap = (orderId) => scannedQty[orderId] || {};
  const getUnitScanned = (orderId, key) => Number(getQtyMap(orderId)[key] || 0);
  const isItemDone = (it) => currentOrder ? getUnitScanned(currentOrder.id, itemKeyOf(it)) >= itemMaxQty(it) : false;
  const orderScannedUnitsTotal = (orderId) => Object.values(getQtyMap(orderId)).reduce((sum, n) => sum + Number(n || 0), 0);
  const orderTotalUnits = (orderList) => orderList.reduce((sum, it) => sum + itemMaxQty(it), 0);

  const allItemsScanned = currentOrder
    ? items.every((it) => isItemDone(it))
    : false;

  const normalizeEan = (v) => String(v || "").replace(/\D/g, "");
  const norm = (v) => String(v || "").trim().toLowerCase();

  const findExactScanMatch = (raw) => {
    const val = String(raw || "").trim();
    if (!val) return null;
    const valNorm = norm(val);
    const valEan = normalizeEan(val);
    return items.find((it) => {
      const sku = norm(it.sku);
      const ean = normalizeEan(it.ean);
      const handle = norm(it.product_handle);
      if (sku && sku === valNorm) return true;
      if (ean && valEan && ean === valEan && valEan.length >= 8) return true;
      if (handle && handle === valNorm) return true;
      // Full title equality only (no substring — typing "a" must not match)
      if (norm(it.title) && norm(it.title) === valNorm) return true;
      return false;
    }) || null;
  };

  const scanSuggestions = useMemo(() => {
    const q = barcodeInput.trim();
    if (!q || !currentOrder) return [];
    const qNorm = norm(q);
    const qEan = normalizeEan(q);
    return items
      .filter((it) => {
        if (isItemDone(it)) return false;
        const title = norm(it.title);
        const sku = norm(it.sku);
        const ean = normalizeEan(it.ean);
        const handle = norm(it.product_handle);
        if (sku && sku.includes(qNorm)) return true;
        if (ean && qEan && ean.includes(qEan)) return true;
        if (handle && handle.includes(qNorm)) return true;
        // Name search only after 2+ chars to avoid "a" matching everything
        if (qNorm.length >= 2 && title.includes(qNorm)) return true;
        return false;
      })
      .slice(0, 8);
  }, [barcodeInput, items, scannedQty, currentOrder]);

  // Order status moves offen → in_bearbeitung the moment a seller starts picking
  // an order (first item scanned/marked here), not at order placement. Fire
  // once per order per page visit — the backend PATCH is idempotent (only
  // dispatches the "order_processing" flow email on an actual offen→in_bearbeitung
  // transition), this ref just avoids redundant requests on every scan.
  const processingNotifiedRef = useRef(new Set());
  const notifyOrderProcessingStarted = (orderId) => {
    if (!orderId || processingNotifiedRef.current.has(orderId)) return;
    processingNotifiedRef.current.add(orderId);
    getMedusaAdminClient().updateOrder(orderId, { order_status: "in_bearbeitung" }).catch(() => {});
  };

  const markItemScanned = (match) => {
    if (!currentOrder || !match) return;
    const key = itemKeyOf(match);
    const max = itemMaxQty(match);
    const cur = getUnitScanned(currentOrder.id, key);
    if (cur >= max) {
      setScanError(s.alreadyScanned);
      return;
    }
    if (orderScannedUnitsTotal(currentOrder.id) === 0) notifyOrderProcessingStarted(currentOrder.id);
    setScannedQty((prev) => {
      const orderMap = { ...(prev[currentOrder.id] || {}) };
      orderMap[key] = Math.min(max, cur + 1);
      return { ...prev, [currentOrder.id]: orderMap };
    });
    setBarcodeInput("");
    setSuggestOpen(false);
    setScanError("");
    setHighlightIdx(0);
    barcodeRef.current?.focus();
  };

  const handleBarcodeSubmit = (e) => {
    e.preventDefault();
    if (!currentOrder || !barcodeInput.trim()) return;
    const val = barcodeInput.trim();
    const minLen = Math.max(1, Number(scannerConfig.min_length) || 1);
    if (val.length < minLen) {
      setScanError(s.searchMinChars);
      return;
    }
    setScanError("");

    // Prefer highlighted suggestion when dropdown is open
    if (suggestOpen && scanSuggestions.length > 0) {
      const pick = scanSuggestions[Math.min(highlightIdx, scanSuggestions.length - 1)];
      if (pick) {
        markItemScanned(pick);
        return;
      }
    }

    const exact = findExactScanMatch(val);
    if (exact) {
      markItemScanned(exact);
      return;
    }

    // Ambiguous name fragment with multiple hits → force pick from list
    if (scanSuggestions.length === 1 && norm(val).length >= 2) {
      markItemScanned(scanSuggestions[0]);
      return;
    }
    if (scanSuggestions.length > 1) {
      setSuggestOpen(true);
      setScanError(s.pickFromSuggestions);
      return;
    }

    setScanError(s.itemNotFound(val));
    setBarcodeInput("");
    setSuggestOpen(false);
  };

  const markItemManually = (item) => {
    if (!currentOrder) return;
    const itemKey = itemKeyOf(item);
    const max = itemMaxQty(item);
    const cur = getUnitScanned(currentOrder.id, itemKey);
    if (cur >= max) return;
    if (orderScannedUnitsTotal(currentOrder.id) === 0) notifyOrderProcessingStarted(currentOrder.id);
    setScannedQty((prev) => {
      const orderMap = { ...(prev[currentOrder.id] || {}) };
      orderMap[itemKey] = cur + 1;
      return { ...prev, [currentOrder.id]: orderMap };
    });
  };

  const adjustItemQty = (item, delta) => {
    if (!currentOrder) return;
    const itemKey = itemKeyOf(item);
    const max = itemMaxQty(item);
    const cur = getUnitScanned(currentOrder.id, itemKey);
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) return;
    setScannedQty((prev) => {
      const orderMap = { ...(prev[currentOrder.id] || {}) };
      orderMap[itemKey] = next;
      return { ...prev, [currentOrder.id]: orderMap };
    });
  };

  const goNext = () => {
    if (currentIndex < orders.length - 1) {
      setCurrentIndex((i) => i + 1);
      setScanError("");
      setBarcodeInput("");
      setTimeout(() => barcodeRef.current?.focus(), 100);
    } else {
      setPhase("ship");
    }
  };

  // An order can only be marked shipped once it has either a purchased Sendcloud label or a
  // manually entered tracking number — otherwise handleSaveAll silently skips it while the UI
  // still moved on to the "done" screen, which looked like everything shipped when it hadn't.
  const incompleteOrders = useMemo(
    () =>
      orders.filter(
        (o) => !o.sendcloud_label_url && !o.tracking_number && !String(trackings[o.id] || "").trim(),
      ),
    [orders, trackings],
  );

  const handleSaveAll = async () => {
    setSaving(true);
    const shippedAt = new Date().toISOString();
    try {
      const client = getMedusaAdminClient();
      for (const o of orders) {
        // Never clobber an order that already has a Sendcloud-purchased label — only apply
        // the manually typed tracking number/carrier to orders shipped without buying a label here.
        if (o.sendcloud_label_url || o.tracking_number) continue;
        const manualTracking = trackings[o.id] != null ? String(trackings[o.id]).trim() : "";
        if (!manualTracking) continue;
        await client.updateOrder(o.id, {
          delivery_status: "versendet",
          carrier_name: resolveOrderCarrierName(o) || s.other,
          tracking_number: manualTracking,
          shipped_at: shippedAt,
        });
      }
      setPhase("done");
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handlePrintLieferscheinAll = async () => {
    // Print the same backend PDF template as order detail (Rechnung parity), not the old HTML stub.
    // Open each Lieferschein as an authenticated blob; pass local carrier/tracking when not yet saved.
    const client = getMedusaAdminClient();
    const objectUrls = [];
    try {
      for (const o of orders) {
        const carrier = resolveOrderCarrierName(o) || "";
        const tracking =
          (trackings[o.id] != null ? String(trackings[o.id]).trim() : "") ||
          String(o.tracking_number || "").trim();
        const blob = await client.downloadOrderPdf(o.id, "lieferschein", locale, {
          carrier: carrier || undefined,
          tracking: tracking || undefined,
        });
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const win = window.open(url, "_blank");
        if (win) {
          // Best-effort auto-print once the PDF viewer loads
          try {
            win.addEventListener?.("load", () => {
              try { win.print(); } catch { /* ignore */ }
            });
          } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore — popup blocked or network error */
    }
    // Revoke after a delay so the browser has time to load the blobs
    setTimeout(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)), 60_000);
  };

  const progress = orders.length > 0 ? Math.round((currentIndex / orders.length) * 100) : 0;
  const pendingCount = currentOrder ? orderTotalUnits(items) - orderScannedUnitsTotal(currentOrder.id) : 0;

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#9ca3af" }}>{s.loadingOrders}</div>
    );
  }

  if (orders.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>{s.noOrdersToPack}</h2>
        <p style={{ color: "#6b7280", fontSize: 14 }}>{s.noOrdersHint}</p>
        <button onClick={() => router.push("/orders")} style={{ marginTop: 16, padding: "9px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600 }}>
          {s.backToOrders}
        </button>
      </div>
    );
  }

  if (phase === "ship" || phase === "done") {
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          <Button onClick={() => setPhase("scan")}>{s.back}</Button>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{s.shipTitle(orders.length)}</h1>
        </div>

        {phase === "done" && (
          <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", borderRadius: 10, padding: "16px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 24 }}>✅</span>
            <div>
              <div style={{ fontWeight: 700, color: "#065f46" }}>{s.allShipped}</div>
              <div style={{ fontSize: 13, color: "#047857", marginTop: 2 }}>{s.trackingSavedHint}</div>
            </div>
          </div>
        )}

        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#1e40af" }}>
          {s.labelStepHint}
        </div>

        {orders.map((o) => (
          <div key={o.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>#{o.order_number || "—"}</div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                  {[o.first_name, o.last_name].filter(Boolean).join(" ") || (isSuperuser ? o.email : null) || "—"}
                </div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  {[o.address_line1, [o.postal_code, o.city].filter(Boolean).join(" "), o.country].filter(Boolean).join(", ")}
                </div>
              </div>
              {(o.sendcloud_label_url || o.tracking_number) && (
                <div style={{ fontSize: 12, color: "#15803d", fontWeight: 600, textAlign: "right" }}>
                  {o.tracking_number ? `${s.trackingNumber}: ${o.tracking_number}` : s.labelReady}
                  {o.sendcloud_label_url && (
                    <div>
                      <a href={o.sendcloud_label_url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563eb" }}>
                        {s.openLabelPdf}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            <ShipLabelModal
              order={o}
              locale={locale}
              embedded
              onClose={() => {}}
            />

            <details style={{ marginTop: 18, borderTop: "1px solid #f3f4f6", paddingTop: 14 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#6b7280" }}>
                {s.manualShipToggle}
              </summary>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 4 }}>{s.trackingNumber}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    value={trackings[o.id] || ""}
                    onChange={(e) => setTrackings((t) => ({ ...t, [o.id]: e.target.value }))}
                    placeholder={s.trackingEnter}
                    style={{ flex: 1, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
                  />
                  {(() => {
                    const detectedName = resolveOrderCarrierName(o);
                    const badge = detectedName ? carrierBadge(detectedName) : null;
                    return badge ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 6, background: badge.color, color: badge.text, fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                        {badge.label}
                      </span>
                    ) : null;
                  })()}
                </div>
                {trackings[o.id] && !resolveOrderCarrierName(o) && (
                  <input
                    value={manualCarrierOverride[o.id] || ""}
                    onChange={(e) => setManualCarrierOverride((m) => ({ ...m, [o.id]: e.target.value }))}
                    placeholder={s.carrierPlaceholder}
                    style={{ marginTop: 8, padding: "7px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" }}
                  />
                )}
              </div>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 8 }}>{s.manualShipHint}</p>
            </details>
          </div>
        ))}

        <BlockStack gap="300">
          {phase !== "done" && incompleteOrders.length > 0 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#92400e" }}>
              {s.missingLabelOrTrackingWarning(incompleteOrders.length)}
            </div>
          )}
          <InlineStack gap="200" wrap>
            <Button onClick={handlePrintLieferscheinAll}>{s.printDeliveryNote}</Button>
          </InlineStack>
          <InlineStack gap="200" wrap>
            {phase !== "done" && (
              <Button variant="primary" onClick={handleSaveAll} disabled={saving || incompleteOrders.length > 0} loading={saving}>
                {s.saveManualShip}
              </Button>
            )}
            <Button
              onClick={() =>
                router.push(
                  orders.length === 1 ? `/${locale}/orders/${orders[0].id}` : `/${locale}/orders`,
                )
              }
            >
              {orders.length === 1 ? s.backToOrder : s.backToOrders}
            </Button>
          </InlineStack>
        </BlockStack>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => router.push("/orders")} style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 7, padding: "6px 14px", fontSize: 13, cursor: "pointer" }}>{s.back}</button>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{s.packingCenter}</h1>
        </div>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          {s.orderOf(currentIndex + 1, orders.length)}
        </div>
      </div>

      <div style={{ height: 6, background: "#e5e7eb", borderRadius: 4, marginBottom: 24, overflow: "hidden" }}>
        <div style={{ height: "100%", background: "#008060", borderRadius: 4, width: `${progress}%`, transition: "width 0.3s" }} />
      </div>

      {currentOrder && (
        <>
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{s.order} #{currentOrder.order_number || "—"}</div>
                <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
                  {[currentOrder.first_name, currentOrder.last_name].filter(Boolean).join(" ") || "—"}{isSuperuser && currentOrder.email ? ` · ${currentOrder.email}` : ""}
                </div>
                <div style={{ fontSize: 13, color: "#6b7280" }}>
                  {[currentOrder.address_line1, currentOrder.city, currentOrder.country].filter(Boolean).join(", ")}
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: 18, fontWeight: 700 }}>
                {fmtMoney(
                  currentOrder.seller_items_subtotal_cents != null
                    ? currentOrder.seller_items_subtotal_cents
                    : currentOrder.total_cents,
                  locale,
                )}
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
                {s.itemsScanned(orderScannedUnitsTotal(currentOrder.id), orderTotalUnits(items))}
              </div>
              {items.map((it, i) => {
                const key = itemKeyOf(it);
                const max = itemMaxQty(it);
                const cur = getUnitScanned(currentOrder.id, key);
                const done = cur >= max;
                return (
                  <div
                    key={key || i}
                    style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderRadius: 8, background: done ? "#f0fdf4" : "#fff", border: `1px solid ${done ? "#86efac" : "#e5e7eb"}`, marginBottom: 8, transition: "all 0.15s" }}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: done ? "#16a34a" : "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {done ? <span style={{ color: "#fff", fontSize: 14 }}>✓</span> : <span style={{ color: "#9ca3af", fontSize: 14 }}>○</span>}
                    </div>
                    {it.thumbnail && <img src={it.thumbnail} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: done ? 600 : 400, color: done ? "#15803d" : "#111827", textDecoration: done ? "line-through" : "none", opacity: done ? 0.7 : 1 }}>{it.title}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {s.qty} {cur}/{max}
                        {it.sku ? ` · SKU ${it.sku}` : ""}
                        {it.ean ? ` · EAN ${it.ean}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => adjustItemQty(it, -1)}
                        disabled={cur <= 0}
                        style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid #e5e7eb", background: "#fff", cursor: cur <= 0 ? "default" : "pointer", color: cur <= 0 ? "#d1d5db" : "#374151", fontSize: 15, lineHeight: 1 }}
                      >
                        −
                      </button>
                      <span style={{ minWidth: 32, textAlign: "center", fontSize: 13, fontWeight: 700 }}>{cur}/{max}</span>
                      <button
                        type="button"
                        onClick={() => adjustItemQty(it, 1)}
                        disabled={cur >= max}
                        style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid #e5e7eb", background: cur >= max ? "#fff" : "#111827", cursor: cur >= max ? "default" : "pointer", color: cur >= max ? "#d1d5db" : "#fff", fontSize: 15, lineHeight: 1 }}
                      >
                        +
                      </button>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, minWidth: 64, textAlign: "right" }}>{fmtMoney(it.unit_price_cents, locale)}</div>
                  </div>
                );
              })}
            </div>

            {scannerConfig.enabled === false ? null : (
            <form onSubmit={handleBarcodeSubmit} style={{ position: "relative" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  ref={barcodeRef}
                  value={barcodeInput}
                  onChange={(e) => {
                    setBarcodeInput(e.target.value);
                    setScanError("");
                    setSuggestOpen(true);
                    setHighlightIdx(0);
                  }}
                  onFocus={() => setSuggestOpen(true)}
                  onBlur={() => {
                    // Allow click on suggestion before closing
                    window.setTimeout(() => setSuggestOpen(false), 150);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && scannerConfig.auto_submit === false) {
                      // Auto-submit disabled: Enter only confirms a highlighted suggestion,
                      // otherwise the seller must click "Add" explicitly.
                      if (!(suggestOpen && scanSuggestions.length > 0)) e.preventDefault();
                      return;
                    }
                    if (!suggestOpen || scanSuggestions.length === 0) return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHighlightIdx((i) => Math.min(i + 1, scanSuggestions.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlightIdx((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Escape") {
                      setSuggestOpen(false);
                    }
                  }}
                  placeholder={s.barcodePlaceholder}
                  autoFocus={scannerConfig.auto_focus !== false}
                  autoComplete="off"
                  style={{ flex: 1, padding: "10px 14px", border: `1px solid ${scanError ? "#ef4444" : "#e5e7eb"}`, borderRadius: 8, fontSize: 14 }}
                />
                <Button submit variant="primary">
                  {s.add}
                </Button>
              </div>
              {suggestOpen && scanSuggestions.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 72,
                    top: "100%",
                    marginTop: 4,
                    background: "#fff",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
                    zIndex: 20,
                    overflow: "hidden",
                  }}
                >
                  {scanSuggestions.map((it, idx) => (
                    <button
                      key={itemKeyOf(it)}
                      type="button"
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        markItemScanned(it);
                      }}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      style={{
                        display: "flex",
                        width: "100%",
                        textAlign: "left",
                        gap: 10,
                        alignItems: "center",
                        padding: "10px 12px",
                        border: "none",
                        background: idx === highlightIdx ? "#f3f4f6" : "#fff",
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      {it.thumbnail && <img src={it.thumbnail} alt="" style={{ width: 28, height: 28, borderRadius: 4, objectFit: "cover" }} />}
                      <span style={{ flex: 1, fontWeight: 500 }}>{it.title}</span>
                      <span style={{ color: "#6b7280", fontSize: 11 }}>
                        {[it.sku && `SKU ${it.sku}`, it.ean && `EAN ${it.ean}`].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {scanError && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 6 }}>{scanError}</div>}
            </form>
            )}
          </div>

          <InlineStack gap="300" wrap blockAlign="center">
            {currentIndex > 0 && (
              <Button onClick={() => { setCurrentIndex((i) => i - 1); setScanError(""); setBarcodeInput(""); }}>
                {s.previous}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!allItemsScanned}
              onClick={goNext}
            >
              {!allItemsScanned
                ? s.itemsPending(pendingCount)
                : currentIndex === orders.length - 1
                  ? s.allPackedContinue
                  : s.nextOrder}
            </Button>
          </InlineStack>
          {!allItemsScanned && (
            <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", marginTop: 8 }}>
              {s.scanHint}
            </p>
          )}
        </>
      )}
    </div>
  );
}
