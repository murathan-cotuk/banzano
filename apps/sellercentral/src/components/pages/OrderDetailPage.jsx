"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { lt } from "@/lib/locale-text";
import { Button } from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { getOrderPdfDownloadUrl } from "@/lib/order-pdf-url";
import TrackingSection from "@/components/orders/TrackingSection";
import SearchableSelect from "@/components/inputs/SearchableSelect";
import { confirmDelete } from "@/lib/confirm-delete";
import { getUI } from "@/lib/ui-strings";
import { statusLabel } from "@/lib/status-labels";
import { userError } from "@/lib/api-error-messages";
import { getOrderDetailCopy } from "@/lib/order-detail-i18n";

function fmtCents(c, locale) {
  const loc = lt(locale, "en-GB", "tr-TR", "en-GB", "en-GB", "en-GB", "de-DE");
  return (Number(c || 0) / 100).toLocaleString(loc, { minimumFractionDigits: 2 }) + " €";
}
function fmtDate(d, locale) {
  if (!d) return "—";
  const loc = lt(locale, "en-GB", "tr-TR", "en-GB", "en-GB", "en-GB", "de-DE");
  const dt = new Date(d);
  const date = dt.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = dt.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${date} / ${time}`;
}
// Item title bakes the variant as a trailing "(...)" at checkout — split it back out so it can
// render as a smaller, muted note under the title instead of inline in parentheses.
function splitItemTitle(title) {
  const s = String(title || "").trim();
  const m = s.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m || !m[1].trim()) return { main: s, note: "" };
  return { main: m[1].trim(), note: m[2].trim() };
}

function formatPaymentMethod(pm) {
  const map = {
    visa: "Visa", mastercard: "Mastercard", amex: "American Express",
    paypal: "PayPal", klarna: "Klarna", sepa_debit: "SEPA Direct Debit",
    card: "Credit Card", apple_pay: "Apple Pay", google_pay: "Google Pay",
    giropay: "Giropay", sofort: "Sofort", ideal: "iDEAL",
  };
  return map[pm] || (pm ? pm.charAt(0).toUpperCase() + pm.slice(1).replace(/_/g, " ") : "—");
}

const STATUS_COLORS = {
  offen: { bg: "#fff7ed", color: "#c2410c" },
  in_bearbeitung: { bg: "#eff6ff", color: "#1d4ed8" },
  abgeschlossen: { bg: "#f0fdf4", color: "#15803d" },
  storniert: { bg: "#fef2f2", color: "#b91c1c" },
  bezahlt: { bg: "#f0fdf4", color: "#15803d" },
  teil_erstattet: { bg: "#fffbeb", color: "#b45309" },
  erstattet: { bg: "#fef2f2", color: "#b91c1c" },
  versendet: { bg: "#eff6ff", color: "#1d4ed8" },
  zugestellt: { bg: "#f0fdf4", color: "#15803d" },
};

function Badge({ value, locale }) {
  const s = STATUS_COLORS[value] || { bg: "#f3f4f6", color: "#6b7280" };
  return (
    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color }}>
      {value ? statusLabel(locale, value) : "—"}
    </span>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 20, marginBottom: 16 }}>
      {title && <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>{title}</h3>}
      {children}
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ fontWeight: 500, color: "#111827" }}>{value}</span>
    </div>
  );
}

function StatusSelect({ label, value, options, onChange, saving, locale }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <span style={{ fontSize: 13, color: "#6b7280", minWidth: 120 }}>{label}</span>
      <Badge value={value} locale={locale} />
      <select
        value={value || ""}
        onChange={e => onChange(e.target.value)}
        disabled={saving}
        style={{ padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 12, background: "#fff", cursor: "pointer" }}
      >
        {options.map(o => <option key={o} value={o}>{statusLabel(locale, o)}</option>)}
      </select>
    </div>
  );
}

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;
  const locale = useLocale();
  const ui = getUI(locale);
  const c = getOrderDetailCopy(locale);

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  useEffect(() => { setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true"); }, []);

  const [flowLogs, setFlowLogs] = useState(null); // null = not loaded yet
  const [flowLogsLoading, setFlowLogsLoading] = useState(false);
  useEffect(() => {
    if (!isSuperuser || !id) return;
    let cancelled = false;
    setFlowLogsLoading(true);
    getMedusaAdminClient().getOrderFlowLogs(id)
      .then((d) => { if (!cancelled) setFlowLogs(Array.isArray(d?.logs) ? d.logs : []); })
      .catch(() => { if (!cancelled) setFlowLogs([]); })
      .finally(() => { if (!cancelled) setFlowLogsLoading(false); });
    return () => { cancelled = true; };
  }, [isSuperuser, id]);

  const [orderStatus, setOrderStatus] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState("");

  // Add-product (TASK-5.2): only a real catalog match (title/SKU/EAN via SearchableSelect) can be
  // added — no free-text line items — the backend re-validates ownership + price regardless.
  const [products, setProducts] = useState([]);
  const [addProductId, setAddProductId] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [addingItem, setAddingItem] = useState(false);
  const [addItemError, setAddItemError] = useState("");

  useEffect(() => {
    getMedusaAdminClient().getAdminHubProducts().then((r) => {
      const list = (r.products || []).filter((p) => (p.status || "").toLowerCase() !== "draft");
      setProducts(list);
    }).catch(() => setProducts([]));
  }, []);

  const handleAddItem = async () => {
    if (!addProductId) { setAddItemError(c.selectProductFirst); return; }
    setAddingItem(true);
    setAddItemError("");
    try {
      const client = getMedusaAdminClient();
      const res = await client.addOrderItem(id, { product_id: addProductId, quantity: Math.max(1, Number(addQty) || 1) });
      if (res?.order) setOrder((o) => ({ ...o, ...res.order }));
      setAddProductId("");
      setAddQty(1);
    } catch (e) {
      setAddItemError(userError(e, locale, c.addProductFailed));
    }
    setAddingItem(false);
  };

  const loadOrder = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = getMedusaAdminClient();
      const data = await client.getOrder(id);
      const o = data?.order ?? data;
      setOrder(o || null);
      setOrderStatus(o?.order_status || "offen");
      setPaymentStatus(o?.payment_status || "bezahlt");
      setDeliveryStatus(o?.delivery_status || "offen");
    } catch (e) {
      setError(userError(e, locale, c.loadFailed));
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  const handleDeliveryChange = (val) => {
    setDeliveryStatus(val);
    if (val === "zugestellt" && paymentStatus === "bezahlt") setOrderStatus("abgeschlossen");
    else if (val !== "zugestellt" && orderStatus === "abgeschlossen") setOrderStatus("in_bearbeitung");
  };
  const handlePaymentChange = (val) => {
    setPaymentStatus(val);
    if (val === "bezahlt" && deliveryStatus === "zugestellt") setOrderStatus("abgeschlossen");
  };

  const handleSaveStatus = async () => {
    setSaving(true);
    try {
      const client = getMedusaAdminClient();
      const res = await client.updateOrder(id, { order_status: orderStatus, payment_status: paymentStatus, delivery_status: deliveryStatus });
      if (res?.order) {
        setOrder(o => ({ ...o, ...res.order }));
        if (res.order.order_status) setOrderStatus(res.order.order_status);
        if (res.order.payment_status) setPaymentStatus(res.order.payment_status);
        if (res.order.delivery_status) setDeliveryStatus(res.order.delivery_status);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(userError(e, locale, c.saveFailed));
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!(await confirmDelete(c.deleteConfirm))) return;
    try {
      const client = getMedusaAdminClient();
      await client.deleteOrder(id);
      router.push("/orders");
    } catch (e) {
      setError(userError(e, locale, c.deleteFailed));
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: "#9ca3af", textAlign: "center", marginTop: 60 }}>{ui.loading}</div>;
  }

  if (error && !order) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 16, color: "#b91c1c" }}>{error}</div>
        <button onClick={() => router.push("/orders")} style={btnStyle}>← {ui.orders}</button>
      </div>
    );
  }

  const items = order?.items || [];
  const total = Math.max(
    0,
    Number(order?.subtotal_cents || 0) +
      Number(order?.shipping_cents || 0) -
      Number(order?.coupon_discount_cents || 0),
  );
  const shippingCents = Number(order?.shipping_cents || 0);
  const discountCents = Number(order?.discount_cents || 0);
  const couponDisc = Number(order?.coupon_discount_cents || 0);
  const bonusDisc = Math.max(0, discountCents - couponDisc);

  // Billing address
  const billingSame = order?.billing_same_as_shipping !== false;
  const hasBillingAddr = !billingSame && order?.billing_address_line1;

  // Customer label — Kundennummer nur für Superuser
  const customerName = [order?.first_name, order?.last_name].filter(Boolean).join(" ") || "—";
  const customerLabel = isSuperuser
    ? order?.customer_number
      ? `${order.customer_number} – ${customerName}`
      : `${ui.guestBadge} – ${customerName}`
    : customerName;

  const goToCustomerProfile = async (e) => {
    e?.preventDefault?.();
    if (!isSuperuser || !order) return;
    if (order.customer_id) {
      router.push(`/customers/${order.customer_id}`);
      return;
    }
    const email = String(order.email || "").trim();
    if (!email) {
      router.push("/customers");
      return;
    }
    try {
      const client = getMedusaAdminClient();
      const data = await client.getCustomers({ email, limit: 1 });
      const found = data?.customers?.[0];
      if (found?.id) {
        router.push(`/customers/${found.id}`);
        return;
      }
    } catch (_) {}
    router.push("/customers");
  };

  return (
    <div style={{ padding: 24, background: "#fff", minHeight: "100%" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
          width: "100%",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
          <Button onClick={() => router.push("/orders")}>← {ui.orders}</Button>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            {c.orderTitle} #{order?.order_number || "—"}
          </h1>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>{fmtDate(order?.created_at)}</span>
        </div>
        {order?.id && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              justifyContent: "flex-end",
              flexShrink: 0,
            }}
          >
            <Button url={getOrderPdfDownloadUrl(order.id, "invoice", locale)} external variant="secondary">
              {ui.invoice}
            </Button>
            <Button url={getOrderPdfDownloadUrl(order.id, "lieferschein", locale)} external variant="secondary">
              {ui.deliveryNote}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 12, color: "#b91c1c", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 16, alignItems: "start" }}>
        {/* Left column */}
        <div>
          {/* Order items */}
          <Section title={ui.items}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e5e7eb", color: "#6b7280", fontSize: 11, textTransform: "uppercase" }}>
                  <th style={{ textAlign: "left", padding: "4px 0 8px" }}>{ui.colProduct}</th>
                  <th style={{ textAlign: "right", padding: "4px 0 8px" }}>{ui.qty}</th>
                  <th style={{ textAlign: "right", padding: "4px 0 8px" }}>{ui.unitPrice}</th>
                  <th style={{ textAlign: "right", padding: "4px 0 8px" }}>{ui.colTotal}</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: "20px 0", color: "#9ca3af", textAlign: "center" }}>{ui.noItems}</td></tr>
                )}
                {items.map((it, i) => {
                  const productUrl = it.product_id
                    ? `/${locale}/products/${it.product_id}`
                    : it.product_handle
                    ? `/${locale}/products?search=${encodeURIComponent(it.product_handle)}`
                    : null;
                  const { main: itemMain, note: itemNote } = splitItemTitle(it.title);
                  return (
                  <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "10px 0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {it.thumbnail && (
                          <img src={it.thumbnail} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }} />
                        )}
                        <div>
                          {productUrl ? (
                            <a href={productUrl} style={{ fontWeight: 500, color: "#111827", textDecoration: "underline", textDecorationColor: "#d1d5db" }}>
                              {itemMain || "—"}
                            </a>
                          ) : (
                            <div style={{ fontWeight: 500 }}>{itemMain || "—"}</div>
                          )}
                          {itemNote && <div style={{ fontSize: 11, color: "#9ca3af" }}>{itemNote}</div>}
                          {it.product_handle && <div style={{ fontSize: 11, color: "#9ca3af" }}>{it.product_handle}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", padding: "10px 0", color: "#374151" }}>{it.quantity}</td>
                    <td style={{ textAlign: "right", padding: "10px 0", color: "#374151" }}>{fmtCents(it.unit_price_cents, locale)}</td>
                    <td style={{ textAlign: "right", padding: "10px 0", fontWeight: 600 }}>{fmtCents((it.unit_price_cents || 0) * (it.quantity || 1), locale)}</td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ textAlign: "right", padding: "8px 0 4px", color: "#6b7280", fontSize: 12 }}>{ui.shipping}</td>
                  <td style={{ textAlign: "right", padding: "8px 0 4px", fontSize: 12 }}>
                    {shippingCents > 0 ? fmtCents(shippingCents, locale) : ui.shippingFree}
                  </td>
                </tr>
                {couponDisc > 0 && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: "right", padding: "4px 0", color: "#6b7280", fontSize: 12 }}>
                      {c.coupon}{order?.coupon_code ? ` (${order.coupon_code})` : ""}
                    </td>
                    <td style={{ textAlign: "right", padding: "4px 0", fontSize: 12, color: "#15803d" }}>−{fmtCents(couponDisc, locale)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} style={{ textAlign: "right", padding: "4px 0", fontWeight: 700, borderTop: "2px solid #e5e7eb", paddingTop: 10 }}>{ui.grandTotal}</td>
                  <td style={{ textAlign: "right", padding: "4px 0", fontWeight: 700, borderTop: "2px solid #e5e7eb", paddingTop: 10, fontSize: 15 }}>{fmtCents(total, locale)}</td>
                </tr>
              </tfoot>
            </table>

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f3f4f6", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ minWidth: 260, flex: 1 }}>
                <SearchableSelect
                  label={c.addProduct}
                  options={products.map((p) => ({ label: p.title || p.handle, value: p.id, sublabel: p.metadata?.ean || p.sku || "" }))}
                  value={addProductId}
                  onChange={setAddProductId}
                  placeholder={c.addProductSearchPlaceholder}
                />
              </div>
              <div style={{ width: 80 }}>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{c.qty}</label>
                <input
                  type="number"
                  min="1"
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: "1px solid #e5e7eb", borderRadius: 6, fontSize: 13 }}
                />
              </div>
              <Button onClick={handleAddItem} loading={addingItem} disabled={addingItem}>
                {c.add}
              </Button>
            </div>
            {addItemError && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#b91c1c" }}>{addItemError}</div>
            )}
          </Section>

          {/* Status management */}
          <Section title={c.manageStatus}>
            <StatusSelect label={ui.orderStatus} value={orderStatus} options={["offen", "in_bearbeitung", "abgeschlossen", "storniert"]} onChange={setOrderStatus} saving={saving} locale={locale} />
            <StatusSelect label={ui.paymentStatus} value={paymentStatus} options={["offen", "bezahlt", "teil_erstattet", "erstattet"]} onChange={handlePaymentChange} saving={saving} locale={locale} />
            <StatusSelect label={ui.deliveryStatus} value={deliveryStatus} options={["offen", "versendet", "zugestellt"]} onChange={handleDeliveryChange} saving={saving} locale={locale} />
            <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
              <Button variant="primary" onClick={handleSaveStatus} disabled={saving} loading={saving}>
                {c.saveStatus}
              </Button>
              {saved && <span style={{ fontSize: 12, color: "#15803d" }}>✓ {ui.saved}</span>}
            </div>
          </Section>

          <TrackingSection
            orderId={id}
            order={order}
            onOrderStatusChanged={loadOrder}
          />

          {/* Payment info */}
          <Section title={c.paymentInfo}>
            <InfoRow label={ui.paymentMethod} value={formatPaymentMethod(order?.payment_method)} />
          </Section>

          {/* Flows — superuser only: did the automation emails for this order actually send? */}
          {isSuperuser && (
            <Section title={c.flows}>
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>{c.flowsSub}</p>
              {flowLogsLoading ? (
                <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>{c.flowsLoading}</p>
              ) : !flowLogs || flowLogs.length === 0 ? (
                <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>{c.flowsEmpty}</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e5e7eb", color: "#6b7280", fontSize: 11, textTransform: "uppercase" }}>
                      <th style={{ textAlign: "left", padding: "4px 8px 8px 0" }}>{c.flows}</th>
                      <th style={{ textAlign: "left", padding: "4px 8px 8px" }}>{c.flowRecipient}</th>
                      <th style={{ textAlign: "left", padding: "4px 8px 8px" }}>{ui.colDate}</th>
                      <th style={{ textAlign: "right", padding: "4px 0 8px 8px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {flowLogs.map((log) => {
                      const badge =
                        log.status === "sent"
                          ? { bg: "#f0fdf4", color: "#15803d", label: c.flowStatusSent }
                          : log.status === "failed"
                          ? { bg: "#fef2f2", color: "#b91c1c", label: c.flowStatusFailed }
                          : log.status === "skipped"
                          ? { bg: "#f3f4f6", color: "#6b7280", label: c.flowStatusSkipped }
                          : { bg: "#fff7ed", color: "#c2410c", label: c.flowStatusPending };
                      const audienceLabel = log.audience === "seller" ? c.flowAudienceSeller : c.flowAudienceCustomer;
                      return (
                        <tr key={log.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "8px 8px 8px 0" }}>
                            <div style={{ fontWeight: 500 }}>{log.flow_name || log.trigger_key}</div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>{log.trigger_key} · {audienceLabel}</div>
                            {log.status === "failed" && log.error_message && (
                              <div style={{ fontSize: 11, color: "#b91c1c", marginTop: 2 }}>{log.error_message}</div>
                            )}
                          </td>
                          <td style={{ padding: "8px", color: "#374151" }}>{log.recipient_email || "—"}</td>
                          <td style={{ padding: "8px", color: "#6b7280", fontSize: 12 }}>{fmtDate(log.sent_at || log.created_at, locale)}</td>
                          <td style={{ padding: "8px 0 8px 8px", textAlign: "right" }}>
                            <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: badge.bg, color: badge.color }}>
                              {badge.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          )}
        </div>

        {/* Right column */}
        <div>
          {/* Customer */}
          <Section title={ui.customer}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
              {isSuperuser ? (
                <a
                  href={order?.customer_id ? `/${locale}/customers/${order.customer_id}` : `/${locale}/customers`}
                  onClick={goToCustomerProfile}
                  style={{ color: "#202223", textDecoration: "underline" }}
                >
                  {customerLabel}
                </a>
              ) : (
                <span style={{ color: "#202223" }}>{customerLabel}</span>
              )}
            </div>
            {isSuperuser && order?.email && (
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 2 }}>
                <a href={`mailto:${order.email}`} style={{ color: "#1d4ed8" }}>{order.email}</a>
              </div>
            )}
            {isSuperuser && order?.phone && (
              <div style={{ fontSize: 13, color: "#6b7280" }}>{order.phone}</div>
            )}
          </Section>

          {/* Customer info — nur Superuser */}
          {isSuperuser && (
          <Section title={c.customerInfo}>
            <InfoRow label={ui.accountType} value={order?.is_guest !== false ? ui.guestCustomer : c.registeredCustomer} />
            <InfoRow label={c.firstOrder} value={order?.is_first_order ? ui.yes : ui.no} />
            <InfoRow label={c.newsletter} value={order?.newsletter_opted_in ? ui.yes : ui.no} />
          </Section>
          )}

          {/* Shipping address */}
          <Section title={c.shippingAddress}>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: "#374151" }}>
              {[order?.first_name, order?.last_name].filter(Boolean).join(" ")}<br />
              {order?.address_line1 && <>{order.address_line1}<br /></>}
              {order?.address_line2 && <>{order.address_line2}<br /></>}
              {[order?.postal_code, order?.city].filter(Boolean).join(" ") || ""}<br />
              {order?.country || ""}
            </div>
          </Section>

          {/* Billing address */}
          <Section title={c.billingAddress}>
            {billingSame ? (
              <div style={{ fontSize: 13, color: "#6b7280", fontStyle: "italic" }}>{c.sameAsShipping}</div>
            ) : hasBillingAddr ? (
              <div style={{ fontSize: 13, lineHeight: 1.7, color: "#374151" }}>
                {[order?.first_name, order?.last_name].filter(Boolean).join(" ")}<br />
                {order.billing_address_line1}<br />
                {order?.billing_address_line2 && <>{order.billing_address_line2}<br /></>}
                {[order?.billing_postal_code, order?.billing_city].filter(Boolean).join(" ") || ""}<br />
                {order?.billing_country || ""}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#6b7280", fontStyle: "italic" }}>{c.sameAsShipping}</div>
            )}
          </Section>

          {/* Summary */}
          <Section title={c.summary}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>{ui.orderNumber}</span>
              <span style={{ fontWeight: 600 }}>#{order?.order_number || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>{ui.colDate}</span>
              <span>{fmtDate(order?.created_at, locale)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>{ui.orderStatus}</span>
              <Badge value={order?.order_status} locale={locale} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>{ui.paymentStatus}</span>
              <Badge value={order?.payment_status} locale={locale} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "#6b7280" }}>{ui.deliveryStatus}</span>
              <Badge value={order?.delivery_status} locale={locale} />
            </div>
          </Section>

          {/* Danger zone — nur Superuser */}
          {isSuperuser && (
          <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 10, padding: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#b91c1c" }}>{ui.deleteOrder}</h3>
            <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 12px" }}>{c.dangerText}</p>
            <button onClick={handleDelete} style={{ padding: "7px 14px", background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              {ui.deleteOrder}
            </button>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

const btnStyle = { marginTop: 16, padding: "8px 16px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 7, cursor: "pointer", fontSize: 13 };
