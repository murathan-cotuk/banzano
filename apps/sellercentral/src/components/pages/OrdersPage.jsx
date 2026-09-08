"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { statusLabel } from "@/lib/status-labels";
import styled from "styled-components";
import { Card } from "@andertal/ui";
import {
  Button,
  InlineStack,
  BlockStack,
  Text,
  TextField,
  Select,
  Popover,
  ActionList,
  Modal,
  Banner,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { getOrderPdfDownloadUrl } from "@/lib/order-pdf-url";
import CustomCheckbox from "@/components/ui/CustomCheckbox";
import { confirmDelete } from "@/lib/confirm-delete";
import { getUI } from "@/lib/ui-strings";
import { lt } from "@/lib/locale-text";

/* ── Helpers ─────────────────────────────────────────────────── */
function fmtCents(c) {
  return (Number(c || 0) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 }) + " €";
}
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  const date = dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = dt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
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

const ORDER_STATUS_OPTIONS = ["offen", "in_bearbeitung", "abgeschlossen", "retoure_anfrage", "retoure", "refunded", "storniert"];
const PAYMENT_STATUS_OPTIONS = ["offen", "bezahlt", "teil_erstattet", "erstattet"];
const DELIVERY_STATUS_OPTIONS = ["offen", "versendet", "zugestellt"];

const COUNTRY_VAT = {
  DE: { rate: 19, label: "MwSt." }, AT: { rate: 20, label: "MwSt." },
  CH: { rate: 8.1, label: "MWST" }, FR: { rate: 20, label: "TVA" },
  BE: { rate: 21, label: "TVA" }, NL: { rate: 21, label: "BTW" },
  IT: { rate: 22, label: "IVA" }, ES: { rate: 21, label: "IVA" },
  PL: { rate: 23, label: "VAT" }, PT: { rate: 23, label: "IVA" },
  IE: { rate: 23, label: "VAT" }, LU: { rate: 17, label: "TVA" },
  TR: { rate: 20, label: "KDV" }, GB: { rate: 20, label: "VAT" }, US: { rate: 0, label: "Tax" },
};
function getVatInfo(country) {
  if (!country) return { rate: 19, label: "MwSt." };
  const c = String(country).toUpperCase().trim().slice(0, 2);
  return COUNTRY_VAT[c] || { rate: 19, label: "MwSt." };
}

function orderMerchantSellerIds(order) {
  const fromItems = Array.isArray(order?.item_seller_ids)
    ? order.item_seller_ids.map((s) => String(s || "").trim()).filter((s) => s && s !== "default")
    : [];
  if (fromItems.length) return [...new Set(fromItems)];
  const header = String(order?.seller_id || "").trim();
  if (header && header !== "default") return [header];
  return [];
}

const STATUS_COLORS = {
  offen: { bg: "#fff7ed", color: "#c2410c" },
  in_bearbeitung: { bg: "#eff6ff", color: "#1d4ed8" },
  abgeschlossen: { bg: "#f0fdf4", color: "#15803d" },
  retoure: { bg: "#fef2f2", color: "#b91c1c" },
  retoure_anfrage: { bg: "#fffbeb", color: "#b45309" },
  refunded: { bg: "#eff6ff", color: "#1d4ed8" },
  storniert: { bg: "#fef2f2", color: "#b91c1c" },
  bezahlt: { bg: "#f0fdf4", color: "#15803d" },
  teil_erstattet: { bg: "#fffbeb", color: "#b45309" },
  erstattet: { bg: "#fef2f2", color: "#b91c1c" },
  versendet: { bg: "#eff6ff", color: "#1d4ed8" },
  zugestellt: { bg: "#f0fdf4", color: "#15803d" },
};

function StatusBadge({ value }) {
  const locale = useLocale();
  const s = STATUS_COLORS[value] || { bg: "#f3f4f6", color: "#6b7280" };
  return (
    <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, lineHeight: 1.3, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>
      {value ? statusLabel(locale, value) : "—"}
    </span>
  );
}

function fmtAddressOneLine(order) {
  const parts = [
    order.address_line1,
    [order.postal_code, order.city].filter(Boolean).join(" "),
    order.country,
  ].filter(Boolean);
  return parts.join(" · ");
}

const CELL = { padding: "2px 8px", borderRight: "1px solid #e5e7eb", verticalAlign: "middle", fontSize: 12, lineHeight: 1.25, whiteSpace: "nowrap" };

/* ── Layout ───────── */
const PageContainer = styled.div`
  width: 100%;
  max-width: 100%;
  margin: 0;
  padding: 4px 0 16px;
  min-height: 100%;
  background: transparent;
`;

const PageHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
`;

const PageTitle = styled.h1`
  font-size: 18px;
  font-weight: 650;
  margin: 0;
  color: #111827;
`;

const HeaderMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
`;

const FilterBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  margin-bottom: 8px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
`;

const FilterInput = styled.input`
  flex: 1 1 160px;
  min-width: 140px;
  max-width: 260px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  color: #1f2937;
  background: #fff;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
  }
  &::placeholder {
    color: #9ca3af;
  }
`;

const FilterSelect = styled.select`
  height: 28px;
  max-width: 150px;
  padding: 0 6px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 12px;
  color: #1f2937;
  background: #fff;
  cursor: pointer;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
  }
`;

const TableCard = styled(Card)`
  padding: 0;
  margin-bottom: 8px;
  overflow: clip;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
`;

const BulkBar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 5px 10px;
  margin-bottom: 8px;
  background: #f8fafc;
  border: 1px solid #dbeafe;
  border-radius: 8px;
`;

const SuperuserSectionLabel = styled.td`
  padding: 4px 10px !important;
  background: #eff6ff !important;
  border-bottom: 1px solid #bfdbfe !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  color: #1e40af !important;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const SellerOrdersSectionLabel = styled.td`
  padding: 4px 10px !important;
  background: #f3f4f6 !important;
  border-bottom: 1px solid #e5e7eb !important;
  font-weight: 700 !important;
  font-size: 11px !important;
  color: #374151 !important;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const SellerGroupHeader = styled.td`
  padding: 0 !important;
  background: #f9fafb !important;
  border-bottom: 1px solid #e5e7eb !important;
`;


function fmtCentsWithSymbol(c, symbol = "€") {
  const val = (Number(c || 0) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 });
  return symbol === "€" ? val + " €" : symbol + " " + val;
}

/** Öffentliche Sendungsverfolgung (Carrier-Heuristik, gleiche Logik wie Backend-Defaults) */
function buildCarrierTrackingUrl(carrierName, trackingNumber) {
  const raw = String(trackingNumber || "").trim();
  if (!raw) return null;
  const tn = encodeURIComponent(raw);
  const c = String(carrierName || "").toLowerCase().trim();
  if (c.includes("dhl")) return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?lang=de&idc=${tn}`;
  if (c.includes("dpd")) return `https://tracking.dpd.de/status/de_DE/parcel/${tn}`;
  if (c.includes("gls")) return `https://gls-group.com/track/${tn}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${tn}&loc=de_DE`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
  if (c.includes("hermes")) return `https://www.myhermes.de/empfangen/sendungsverfolgung/#/search?trackNumber=${tn}`;
  if (c.includes("go") && c.includes("express")) return `https://www.general-overnight.com/sendungsverfolgung/?tracking=${tn}`;
  return `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?lang=de&idc=${tn}`;
}

function ExpandedRow({ order, locale = "de", onSaveFields, colCount = 13, ui }) {
  ui = ui || getUI(locale);
  const items = order._items || [];
  const subtotal = items.reduce((s, it) => s + (Number(it.unit_price_cents || 0) * Number(it.quantity || 1)), 0);
  const total = subtotal || order.subtotal_cents || order.total_cents || 0;
  const vat = getVatInfo(order.country);
  const totalNetto = vat.rate > 0 ? Math.round(total / (1 + vat.rate / 100)) : total;
  const totalVat = total - totalNetto;

  const [trackDraft, setTrackDraft] = useState(order.tracking_number || "");
  const [savingTrack, setSavingTrack] = useState(false);
  useEffect(() => {
    setTrackDraft(order.tracking_number || "");
  }, [order.id, order.tracking_number]);

  const trackingUrl = buildCarrierTrackingUrl(order.carrier_name, order.tracking_number);

  return (
    <tr>
      <td colSpan={colCount} style={{ padding: 0, background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ padding: "16px 24px 20px" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <Button url={getOrderPdfDownloadUrl(order.id, "invoice", locale)} external variant="secondary" size="slim">
              {ui.invoice}
            </Button>
            <Button url={getOrderPdfDownloadUrl(order.id, "lieferschein", locale)} external variant="secondary" size="slim">
              {ui.deliveryNote}
            </Button>
            <Button url={`/inbox?order_id=${order.id}`} variant="secondary" size="slim">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" width="14" height="14"><path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" /></svg>
                {ui.message}
              </span>
            </Button>
          </div>
          <div
            style={{
              marginBottom: 16,
              padding: "16px 18px",
              background: "#fff",
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              fontSize: 13,
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ fontWeight: 700, color: "#374151", marginBottom: 8, fontSize: 14 }}>{ui.shippingTracking}</div>
            {order.carrier_name ? (
              <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 8 }}>{ui.carrier}: <strong style={{ color: "#111827" }}>{order.carrier_name}</strong></div>
            ) : (
              <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>{ui.noCarrier}</div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={trackDraft}
                onChange={(e) => setTrackDraft(e.target.value)}
                placeholder={ui.enterTrackingNumber}
                autoComplete="off"
                style={{
                  flex: "1 1 200px",
                  minWidth: 160,
                  maxWidth: 360,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 13,
                }}
              />
              <Button
                size="medium"
                variant="secondary"
                disabled={savingTrack || !onSaveFields}
                loading={savingTrack}
                onClick={async () => {
                  if (!onSaveFields) return;
                  setSavingTrack(true);
                  try {
                    await onSaveFields(order.id, { tracking_number: trackDraft.trim() || null });
                  } catch {
                    /* handleUpdate schluckt Fehler */
                  }
                  setSavingTrack(false);
                }}
              >
                {ui.save}
              </Button>
            </div>
            {order.tracking_number ? (
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <span style={{ color: "#6b7280", marginRight: 6 }}>{ui.savedTracking}</span>
                {trackingUrl ? (
                  <a
                    href={trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "#111827", textDecoration: "underline", textDecorationColor: "#9ca3af" }}
                  >
                    {order.tracking_number}
                  </a>
                ) : (
                  <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{order.tracking_number}</span>
                )}
                {trackingUrl ? (
                  <span style={{ color: "#9ca3af", marginLeft: 8 }}>{ui.clickTracking}</span>
                ) : null}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af" }}>{ui.noTrackingYet}</div>
            )}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff", borderRadius: 8, overflow: "hidden", border: "1px solid #e5e7eb" }}>
            <thead>
              <tr style={{ color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>{ui.product}</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>{ui.qty}</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>{ui.unitPrice}</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>{ui.total}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={4} style={{ padding: "8px", color: "#9ca3af", textAlign: "center" }}>{ui.noItems}</td></tr>
              )}
              {items.map((it, i) => {
                const itemBrutto = (it.unit_price_cents || 0) * (it.quantity || 1);
                const itemNetto = vat.rate > 0 ? Math.round(itemBrutto / (1 + vat.rate / 100)) : itemBrutto;
                const { main: itemMain, note: itemNote } = splitItemTitle(it.title);
                return (
                  <tr key={i} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: "6px 8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div
                          style={{
                            width: 40, height: 40, flexShrink: 0, borderRadius: 6, overflow: "hidden",
                            background: "#f4f4f5", border: "1px solid #e5e7eb",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {it.thumbnail ? (
                            <img
                              src={it.thumbnail}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                            />
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c1c1c6" strokeWidth="1.6" aria-hidden>
                              <rect x="3" y="3" width="18" height="18" rx="3" />
                              <circle cx="9" cy="9" r="1.6" fill="#c1c1c6" stroke="none" />
                              <path d="M21 15l-5-5-9 9" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        <div>
                          {it.product_id ? (
                            <a href={`/${locale}/products/${it.product_id}`} style={{ color: "#111827", textDecoration: "underline", textDecorationColor: "#d1d5db" }}>{itemMain || "—"}</a>
                          ) : (
                            <div>{itemMain || "—"}</div>
                          )}
                          {itemNote && (
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>{itemNote}</div>
                          )}
                          {vat.rate > 0 && (
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                              {ui.net}: {fmtCents(Math.round((it.unit_price_cents || 0) / (1 + vat.rate / 100)))} · +{vat.label} {vat.rate}%: {fmtCents(Math.round((it.unit_price_cents || 0) - (it.unit_price_cents || 0) / (1 + vat.rate / 100)))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", padding: "6px 8px" }}>{it.quantity}</td>
                    <td style={{ textAlign: "right", padding: "6px 8px" }}>{fmtCents(it.unit_price_cents)}</td>
                    <td style={{ textAlign: "right", padding: "6px 8px", fontWeight: 600 }}>{fmtCents(itemBrutto)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {/* 1. Netto */}
              <tr style={{ borderTop: "1px solid #e5e7eb" }}>
                <td colSpan={3} style={{ textAlign: "right", padding: "5px 8px", color: "#6b7280" }}>
                  {ui.net}{vat.rate > 0 ? ` (excl. ${vat.label})` : ""}
                </td>
                <td style={{ textAlign: "right", padding: "5px 8px" }}>{fmtCents(totalNetto)}</td>
              </tr>
              {/* 2. Vergi */}
              {vat.rate > 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: "right", padding: "5px 8px", color: "#6b7280" }}>
                    {vat.label} ({vat.rate}%)
                  </td>
                  <td style={{ textAlign: "right", padding: "5px 8px" }}>{fmtCents(totalVat)}</td>
                </tr>
              )}
              {/* 3. Brutto Zwischensumme (bold) */}
              <tr style={{ borderTop: "1px solid #e5e7eb" }}>
                <td colSpan={3} style={{ textAlign: "right", padding: "6px 8px", fontWeight: 700 }}>{ui.subtotal}</td>
                <td style={{ textAlign: "right", padding: "6px 8px", fontWeight: 700 }}>{fmtCents(subtotal)}</td>
              </tr>
              {/* 4. Versandkosten */}
              <tr>
                <td colSpan={3} style={{ textAlign: "right", padding: "5px 8px", color: "#6b7280" }}>{ui.shipping}</td>
                <td style={{ textAlign: "right", padding: "5px 8px" }}>{ui.shippingFree}</td>
              </tr>
              {/* 5. Gesamtkosten (bolder) */}
              <tr style={{ borderTop: "2px solid #e5e7eb" }}>
                <td colSpan={3} style={{ textAlign: "right", padding: "7px 8px", fontWeight: 800, fontSize: 13 }}>{ui.grandTotal}</td>
                <td style={{ textAlign: "right", padding: "7px 8px", fontWeight: 800, fontSize: 13 }}>{fmtCents(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </td>
    </tr>
  );
}

function CustomerCell({ order, locale, router, isSuperuser }) {
  const [navigating, setNavigating] = useState(false);
  const _ui = getUI(locale || "de");

  const handleClick = async (e) => {
    e.stopPropagation();
    if (!isSuperuser || navigating) return;
    if (order.customer_id) {
      router.push(`/customers/${order.customer_id}`);
      return;
    }
    if (!order.email) return;
    setNavigating(true);
    try {
      const client = getMedusaAdminClient();
      const data = await client.getCustomers({ search: order.email, limit: 1 });
      const found = data?.customers?.[0];
      if (found?.id) router.push(`/customers/${found.id}`);
    } catch { }
    setNavigating(false);
  };

  const name = [order.first_name, order.last_name].filter(Boolean).join(" ") || "—";
  const label = isSuperuser && order.customer_number ? `${order.customer_number} – ${name}` : name;

  return (
    <div
      title={[label, isSuperuser ? (order.email || "") : ""].filter(Boolean).join(" · ")}
      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, lineHeight: 1.25 }}
    >
      {isSuperuser ? (
        <button
          onClick={handleClick}
          style={{ background: "none", border: "none", padding: 0, cursor: navigating ? "wait" : "pointer", textAlign: "left", fontWeight: 600, fontSize: 12, color: navigating ? "#9ca3af" : "#111827", textDecoration: "underline", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </button>
      ) : (
        <span style={{ fontWeight: 600, fontSize: 12, color: "#111827" }}>{label}</span>
      )}
      {isSuperuser && order.is_guest && (
        <span style={{ fontSize: 9, padding: "0 4px", marginLeft: 4, borderRadius: 4, background: "#f3f4f6", color: "#6b7280", fontWeight: 600 }}>
          {_ui.guestBadge}
        </span>
      )}
    </div>
  );
}

function ActionMenu({ order, onUpdate, onDelete, onVersenden, isSuperuser, showShipInMenu = true }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const params = useParams();
  const locale = params?.locale || "de";
  const ui = getUI(locale);

  const items = [
    {
      content: ui.viewDetails,
      onAction: () => {
        setOpen(false);
        router.push(`/orders/${order.id}`);
      },
    },
    ...(showShipInMenu
      ? [
          {
            content: ui.ship,
            onAction: () => {
              setOpen(false);
              onVersenden?.();
            },
          },
        ]
      : []),
    {
      content: ui.cancelOrder,
      destructive: true,
      onAction: () => {
        setOpen(false);
        onUpdate(order.id, { order_status: "storniert" });
      },
    },
    ...(isSuperuser
      ? [
          {
            content: ui.deleteOrder,
            destructive: true,
            onAction: async () => {
              setOpen(false);
              if (await confirmDelete(ui.deleteOrder + "?")) onDelete(order.id);
            },
          },
        ]
      : []),
  ];

  return (
    <div
      style={{ display: "inline-flex", flexShrink: 0 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Popover
        active={open}
        preferredAlignment="right"
        autofocusTarget="first-node"
        onClose={() => setOpen(false)}
        activator={
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={ui.actions || "Actions"}
            style={{
              width: 22,
              height: 22,
              padding: 0,
              border: "1px solid #e5e7eb",
              borderRadius: 4,
              background: "#fff",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6b7280",
              fontSize: 14,
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            ⋯
          </button>
        }
      >
        <ActionList items={items} />
      </Popover>
    </div>
  );
}

const EMPTY_ORDER_FORM = {
  email: "", first_name: "", last_name: "", phone: "", country: "DE",
  address_line1: "", zip_code: "", city: "",
  order_status: "offen", payment_status: "offen", delivery_status: "offen",
  payment_method: "", currency: "EUR", notes: "",
  shipping_cents: "", discount_cents: "",
  items: [{ title: "", quantity: 1, unit_price_cents: "" }],
};

function ManualOrderModal({ onClose, onCreated, locale = "de" }) {
  const [form, setForm] = useState(EMPTY_ORDER_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const ui = getUI(locale);

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setItem = (i, k, v) =>
    setForm((f) => {
      const items = [...f.items];
      items[i] = { ...items[i], [k]: v };
      return { ...f, items };
    });
  const addItem = () =>
    setForm((f) => ({
      ...f,
      items: [...f.items, { title: "", quantity: 1, unit_price_cents: "" }],
    }));
  const removeItem = (i) =>
    setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));

  const itemsTotal = form.items.reduce(
    (s, it) => s + Number(it.unit_price_cents || 0) * Number(it.quantity || 1),
    0
  );
  const total =
    itemsTotal + Number(form.shipping_cents || 0) - Number(form.discount_cents || 0);

  const handleSave = async () => {
    if (!form.email) {
      setErr(ui.email + " required");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const client = getMedusaAdminClient();
      const payload = {
        ...form,
        items: form.items.filter((it) => it.title),
        shipping_cents: Number(form.shipping_cents || 0),
        discount_cents: Number(form.discount_cents || 0),
      };
      await client.createOrder(payload);
      onCreated();
      onClose();
    } catch (e) {
      setErr(e?.message || ui.error);
    }
    setSaving(false);
  };

  const orderStatusOptions = ["offen", "in_bearbeitung", "abgeschlossen", "storniert"].map(
    (s) => ({ label: statusLabel(locale, s), value: s })
  );
  const paymentStatusOptions = ["offen", "bezahlt", "teil_erstattet", "erstattet"].map(
    (s) => ({ label: statusLabel(locale, s), value: s })
  );
  const deliveryStatusOptions = ["offen", "versendet", "zugestellt"].map((s) => ({
    label: statusLabel(locale, s),
    value: s,
  }));
  const currencyOptions = ["EUR", "CHF", "USD", "GBP", "TRY"].map((c) => ({
    label: c,
    value: c,
  }));

  const money = (cents) =>
    (Number(cents) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 });

  return (
    <Modal
      open
      onClose={onClose}
      title={ui.manualOrder}
      size="large"
      primaryAction={{
        content: ui.createOrder,
        onAction: handleSave,
        loading: saving,
      }}
      secondaryActions={[{ content: ui.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {err ? <Banner tone="critical">{err}</Banner> : null}

          <Text as="h3" variant="headingSm">
            {ui.customerData}
          </Text>
          <TextField
            label={`${ui.email} *`}
            value={form.email}
            onChange={(v) => setF("email", v)}
            autoComplete="email"
          />
          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextField
                label={ui.firstName}
                value={form.first_name}
                onChange={(v) => setF("first_name", v)}
                autoComplete="given-name"
              />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextField
                label={ui.lastName}
                value={form.last_name}
                onChange={(v) => setF("last_name", v)}
                autoComplete="family-name"
              />
            </div>
          </InlineStack>
          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextField
                label={ui.phone}
                value={form.phone}
                onChange={(v) => setF("phone", v)}
                autoComplete="tel"
              />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextField
                label={ui.country}
                value={form.country}
                onChange={(v) => setF("country", v)}
                placeholder="DE"
                autoComplete="country"
              />
            </div>
          </InlineStack>
          <TextField
            label={ui.street}
            value={form.address_line1}
            onChange={(v) => setF("address_line1", v)}
            autoComplete="street-address"
          />
          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 120 }}>
              <TextField
                label={ui.postalCode}
                value={form.zip_code}
                onChange={(v) => setF("zip_code", v)}
                autoComplete="postal-code"
              />
            </div>
            <div style={{ flex: 2, minWidth: 180 }}>
              <TextField
                label={ui.city}
                value={form.city}
                onChange={(v) => setF("city", v)}
                autoComplete="address-level2"
              />
            </div>
          </InlineStack>

          <Text as="h3" variant="headingSm">
            {ui.items}
          </Text>
          {form.items.map((it, i) => (
            <InlineStack key={i} gap="200" wrap blockAlign="end">
              <div style={{ flex: 2, minWidth: 160 }}>
                <TextField
                  label={i === 0 ? ui.itemName : ""}
                  labelHidden={i > 0}
                  value={it.title}
                  onChange={(v) => setItem(i, "title", v)}
                  autoComplete="off"
                />
              </div>
              <div style={{ width: 88 }}>
                <TextField
                  label={i === 0 ? ui.itemQty : ""}
                  labelHidden={i > 0}
                  type="number"
                  min={1}
                  value={String(it.quantity)}
                  onChange={(v) => setItem(i, "quantity", v)}
                  autoComplete="off"
                />
              </div>
              <div style={{ width: 120 }}>
                <TextField
                  label={i === 0 ? ui.itemPrice : ""}
                  labelHidden={i > 0}
                  type="number"
                  value={String(it.unit_price_cents)}
                  onChange={(v) => setItem(i, "unit_price_cents", v)}
                  placeholder="1990"
                  autoComplete="off"
                />
              </div>
              <Button
                size="slim"
                tone="critical"
                onClick={() => removeItem(i)}
                accessibilityLabel="Remove item"
              >
                ×
              </Button>
            </InlineStack>
          ))}
          <Button variant="plain" onClick={addItem}>
            {ui.addItem}
          </Button>

          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 160 }}>
              <TextField
                label={ui.shippingCents}
                type="number"
                value={String(form.shipping_cents)}
                onChange={(v) => setF("shipping_cents", v)}
                placeholder="0"
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <TextField
                label={ui.discountCents}
                type="number"
                value={String(form.discount_cents)}
                onChange={(v) => setF("discount_cents", v)}
                placeholder="0"
                autoComplete="off"
              />
            </div>
          </InlineStack>

          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Select
                label={ui.orderStatusLabel}
                options={orderStatusOptions}
                value={form.order_status}
                onChange={(v) => setF("order_status", v)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Select
                label={ui.paymentStatusLabel}
                options={paymentStatusOptions}
                value={form.payment_status}
                onChange={(v) => setF("payment_status", v)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <Select
                label={ui.deliveryStatusLabel}
                options={deliveryStatusOptions}
                value={form.delivery_status}
                onChange={(v) => setF("delivery_status", v)}
              />
            </div>
          </InlineStack>

          <InlineStack gap="300" wrap>
            <div style={{ flex: 1, minWidth: 160 }}>
              <TextField
                label={ui.paymentMethod}
                value={form.payment_method}
                onChange={(v) => setF("payment_method", v)}
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <Select
                label={ui.currency}
                options={currencyOptions}
                value={form.currency}
                onChange={(v) => setF("currency", v)}
              />
            </div>
          </InlineStack>

          <TextField
            label={ui.notes}
            value={form.notes}
            onChange={(v) => setF("notes", v)}
            multiline={3}
            autoComplete="off"
          />

          <div
            style={{
              background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
              borderRadius: 8,
              padding: "12px 16px",
            }}
          >
            <BlockStack gap="100">
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">
                  {ui.summarySubtotal}
                </Text>
                <Text as="span" tone="subdued">
                  {money(itemsTotal)} {form.currency}
                </Text>
              </InlineStack>
              {Number(form.shipping_cents || 0) > 0 ? (
                <InlineStack align="space-between">
                  <Text as="span" tone="subdued">
                    {ui.summaryShipping}
                  </Text>
                  <Text as="span" tone="subdued">
                    +{money(form.shipping_cents)} {form.currency}
                  </Text>
                </InlineStack>
              ) : null}
              {Number(form.discount_cents || 0) > 0 ? (
                <InlineStack align="space-between">
                  <Text as="span" tone="success">
                    {ui.summaryDiscount}
                  </Text>
                  <Text as="span" tone="success">
                    −{money(form.discount_cents)} {form.currency}
                  </Text>
                </InlineStack>
              ) : null}
              <InlineStack align="space-between">
                <Text as="span" fontWeight="semibold">
                  {ui.summaryTotal}
                </Text>
                <Text as="span" fontWeight="semibold">
                  {money(total)} {form.currency}
                </Text>
              </InlineStack>
            </BlockStack>
          </div>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// COL_DEFS_BASE holds static keys; labels are resolved per-render from ui-strings
const COL_DEFS_BASE = [
  { key: "sel",             labelKey: "",                hideable: false, sortKey: null,           defaultWidth: 32,  align: "left"   },
  { key: "exp",             labelKey: "",                hideable: false, sortKey: null,           defaultWidth: 32,  align: "left"   },
  { key: "order_number",    labelKey: "colOrderNumber",  hideable: true,  sortKey: "order_number", defaultWidth: 120, align: "left"   },
  { key: "customer",        labelKey: "colCustomer",     hideable: true,  sortKey: "name",         defaultWidth: 240, align: "left"   },
  { key: "address",         labelKey: "colAddress",      hideable: true,  sortKey: null,           defaultWidth: 180, align: "left"   },
  { key: "amount",          labelKey: "colAmount",       hideable: true,  sortKey: "total",        defaultWidth: 120, align: "right"  },
  { key: "order_status",    labelKey: "colOrderStatus",  hideable: true,  sortKey: "status",       defaultWidth: 140, align: "center" },
  { key: "payment_status",  labelKey: "colPaymentStatus",hideable: true,  sortKey: null,           defaultWidth: 140, align: "center" },
  { key: "delivery_status", labelKey: "colDeliveryStatus",hideable: true, sortKey: null,           defaultWidth: 130, align: "center" },
  { key: "date",            labelKey: "colDate",         hideable: true,  sortKey: "created_at",   defaultWidth: 145, align: "left"   },
  { key: "country",         labelKey: "colCountry",      hideable: true,  sortKey: "country",      defaultWidth: 70,  align: "center" },
  { key: "review",          labelKey: "colReview",       hideable: true,  sortKey: null,           defaultWidth: 70,  align: "center" },
  { key: "actions",         labelKey: "",                hideable: false, sortKey: null,           defaultWidth: 148, align: "right"  },
];
// Kept for backward compat in column-width tracking
const COL_DEFS = COL_DEFS_BASE;

export default function OrdersPage() {
  const router = useRouter();
  const params = useParams();
  const localeFromIntl = useLocale();
  const locale = localeFromIntl || params?.locale || "de";
  const ui = getUI(locale);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterOrderStatus, setFilterOrderStatus] = useState("");
  const [isSuperuser, setIsSuperuser] = useState(false);
  useEffect(() => { setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true"); }, []);
  const [filterPayStatus, setFilterPayStatus] = useState("");
  const [filterDelivery, setFilterDelivery] = useState("");
  const [sort, setSort] = useState("created_at_desc");
  const [expanded, setExpanded] = useState({});
  const [loadingItems, setLoadingItems] = useState({});
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [allReviews, setAllReviews] = useState([]); // all product reviews
  const [reviewPopupOrderId, setReviewPopupOrderId] = useState(null);
  const [returnsMap, setReturnsMap] = useState({}); // order_id → has active return
  const [mySellerId, setMySellerId] = useState("");
  const [sellerLabelById, setSellerLabelById] = useState({});
  const [sellerSearchFilter, setSellerSearchFilter] = useState("");
  const [sellerGroupSort, setSellerGroupSort] = useState("created_at_desc");
  const [colWidths, setColWidths] = useState(() => COL_DEFS.map(c => c.defaultWidth));
  const [hiddenCols, setHiddenCols] = useState(new Set());
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef(null);
  const resizingRef = useRef(null);
  const colPrefsLoadedRef = useRef(false);

  // Column widths/visibility are per-browser preferences (Excel-like customization) —
  // persist them so a seller's layout survives a reload instead of resetting every visit.
  useEffect(() => {
    try {
      const savedWidths = JSON.parse(localStorage.getItem("sellercentral_orders_colWidths") || "null");
      if (Array.isArray(savedWidths) && savedWidths.length === COL_DEFS.length) {
        const next = savedWidths.map((w, i) => {
          const def = COL_DEFS[i];
          const n = Number(w);
          if (!Number.isFinite(n) || n <= 0) return def.defaultWidth;
          // Actions column used to be ~70px and clipped the ship button — bump stale prefs.
          if (def.key === "actions" && n < def.defaultWidth) return def.defaultWidth;
          return n;
        });
        setColWidths(next);
      }
      const savedHidden = JSON.parse(localStorage.getItem("sellercentral_orders_hiddenCols") || "null");
      if (Array.isArray(savedHidden)) setHiddenCols(new Set(savedHidden));
    } catch (_) { /* ignore malformed prefs */ }
    colPrefsLoadedRef.current = true;
  }, []);
  useEffect(() => {
    if (!colPrefsLoadedRef.current) return;
    localStorage.setItem("sellercentral_orders_colWidths", JSON.stringify(colWidths));
  }, [colWidths]);
  useEffect(() => {
    if (!colPrefsLoadedRef.current) return;
    localStorage.setItem("sellercentral_orders_hiddenCols", JSON.stringify([...hiddenCols]));
  }, [hiddenCols]);

  useEffect(() => {
    if (typeof window === "undefined" || !isSuperuser) return;
    setMySellerId(localStorage.getItem("sellerId") || "");
  }, [isSuperuser]);

  useEffect(() => {
    if (!isSuperuser) return;
    getMedusaAdminClient()
      .getSellers()
      .then((d) => {
        const m = {};
        for (const s of d.sellers || []) {
          if (s.seller_id) m[s.seller_id] = s.store_name || s.company_name || s.email || s.seller_id;
        }
        setSellerLabelById(m);
      })
      .catch(() => {});
  }, [isSuperuser]);

  const fetchReviews = useCallback(async () => {
    try {
      const client = getMedusaAdminClient();
      const data = await client.request("/admin-hub/reviews");
      setAllReviews(data?.reviews || []);
    } catch { setAllReviews([]); }
  }, []);

  const fetchReturns = useCallback(async () => {
    try {
      const client = getMedusaAdminClient();
      const data = await client.getReturns();
      const map = {};
      for (const r of (data?.returns || [])) {
        if (r.order_id && r.status !== "abgelehnt" && r.status !== "abgeschlossen") {
          map[r.order_id] = true;
        }
      }
      setReturnsMap(map);
    } catch { setReturnsMap({}); }
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const client = getMedusaAdminClient();
      const params = { sort };
      if (search) params.search = search;
      if (filterOrderStatus && filterOrderStatus !== "retoure") params.order_status = filterOrderStatus;
      if (filterPayStatus) params.payment_status = filterPayStatus;
      if (filterDelivery) params.delivery_status = filterDelivery;
      const data = await client.getOrders(params);
      setOrders(data.orders || []);
    } catch { setOrders([]); }
    setLoading(false);
  }, [search, filterOrderStatus, filterPayStatus, filterDelivery, sort]);

  useEffect(() => { fetchOrders(); fetchReviews(); fetchReturns(); }, [fetchOrders, fetchReviews, fetchReturns]);

  useEffect(() => {
    const onMove = (e) => {
      if (!resizingRef.current) return;
      const { colIdx, startX, startWidth } = resizingRef.current;
      const delta = e.clientX - startX;
      setColWidths(prev => { const n = [...prev]; n[colIdx] = Math.max(40, startWidth + delta); return n; });
    };
    const onUp = () => { resizingRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    if (!showColMenu) return;
    const handler = (e) => { if (colMenuRef.current && !colMenuRef.current.contains(e.target)) setShowColMenu(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColMenu]);

  const toggleColVisibility = (key) => setHiddenCols(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const toggleExpand = async (order) => {
    const id = order.id;
    if (expanded[id]) { setExpanded(e => ({ ...e, [id]: false })); return; }
    if (order._expanded) { setExpanded(e => ({ ...e, [id]: true })); return; }
    setLoadingItems(l => ({ ...l, [id]: true }));
    try {
      const client = getMedusaAdminClient();
      const data = await client.getOrder(id);
      const detail = data.order || {};
      setOrders(prev => prev.map(o => o.id === id ? {
        ...o,
        _items: detail.items || [],
        _customer_number: detail.customer_number || null,
        _is_guest: detail.is_guest !== false,
        _payment_method: detail.payment_method || null,
        _is_first_order: detail.is_first_order === true,
        _expanded: true,
        tracking_number: detail.tracking_number ?? o.tracking_number,
        carrier_name: detail.carrier_name ?? o.carrier_name,
        shipped_at: detail.shipped_at ?? o.shipped_at,
        delivery_status: detail.delivery_status ?? o.delivery_status,
      } : o));
    } catch { }
    setLoadingItems(l => ({ ...l, [id]: false }));
    setExpanded(e => ({ ...e, [id]: true }));
  };

  const handleUpdate = async (id, data) => {
    try {
      const client = getMedusaAdminClient();
      const res = await client.updateOrder(id, data);
      if (res?.order) setOrders(prev => prev.map(o => o.id === id ? { ...o, ...res.order } : o));
    } catch { }
  };


  const handleDelete = async (id) => {
    try {
      const client = getMedusaAdminClient();
      await client.deleteOrder(id);
      setOrders(prev => prev.filter(o => o.id !== id));
    } catch { }
  };

  // "Versenden" starts the packaging-center flow: scan items → package size → DHL label purchase.
  // Order ids travel in the URL (not sessionStorage) so a refresh or a link shared/reopened in
  // another tab still lands on the same order set — VersandPage re-fetches full detail per id anyway.
  const startPacking = (ordersToShip) => {
    const ids = ordersToShip.map((o) => o.id).filter(Boolean);
    router.push(`/shipping?ids=${encodeURIComponent(ids.join(","))}`);
  };

  const handleColSort = (sortKey) => {
    if (!sortKey) return;
    const isCurrentCol = sort.startsWith(sortKey + "_");
    const newDir = isCurrentCol && sort.endsWith("_asc") ? "desc" : "asc";
    setSort(`${sortKey}_${newDir}`);
  };

  const sortIcon = (sortKey) => {
    if (!sortKey) return null;
    if (sort.startsWith(sortKey + "_")) return sort.endsWith("_asc") ? " ↑" : " ↓";
    return " ⇅";
  };

  const visibleCols = COL_DEFS.filter(c => !c.hideable || !hiddenCols.has(c.key));
  const visibleColCount = visibleCols.length;

  const visibleOrders = useMemo(
    () => orders.filter((o) => filterOrderStatus !== "retoure" || returnsMap[o.id]),
    [orders, filterOrderStatus, returnsMap]
  );

  const { ownOrdersList, sellerOrderGroups } = useMemo(() => {
    const own = [];
    const g = new Map();
    const mine = String(mySellerId || "").trim();
    const mineIsReal = Boolean(mine && mine !== "default");
    for (const o of visibleOrders) {
      const ids = orderMerchantSellerIds(o);
      const otherSellers = ids.filter((id) => !mineIsReal || id !== mine);
      if (!ids.length || (mineIsReal && otherSellers.length === 0)) own.push(o);
      for (const sid of otherSellers) {
        if (!g.has(sid)) g.set(sid, []);
        g.get(sid).push(o);
      }
    }
    const keys = [...g.keys()].sort((a, b) =>
      (sellerLabelById[a] || a).localeCompare(sellerLabelById[b] || b, undefined, { sensitivity: "base" })
    );
    return { ownOrdersList: own, sellerOrderGroups: keys.map((k) => ({ sellerId: k, items: g.get(k) })) };
  }, [visibleOrders, mySellerId, sellerLabelById]);

  const filteredSellerOrderGroups = useMemo(() => {
    const q = sellerSearchFilter.trim().toLowerCase();
    if (!q) return sellerOrderGroups;
    return sellerOrderGroups.filter(({ sellerId }) => {
      const label = (sellerLabelById[sellerId] || sellerId || "").toLowerCase();
      return label.includes(q) || sellerId.toLowerCase().includes(q);
    });
  }, [sellerOrderGroups, sellerSearchFilter, sellerLabelById]);

  const sortOrdersClient = (list) => {
    const arr = [...(list || [])];
    if (sellerGroupSort === "created_at_asc") arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    else if (sellerGroupSort === "total_desc") arr.sort((a, b) => (b.total_cents || 0) - (a.total_cents || 0));
    else if (sellerGroupSort === "total_asc") arr.sort((a, b) => (a.total_cents || 0) - (b.total_cents || 0));
    else arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return arr;
  };

  const allSelected = orders.length > 0 && orders.every(o => selected.has(o.id));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(orders.map(o => o.id)));
  };
  const toggleOne = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedOrders = orders.filter(o => selected.has(o.id));

  const hc = hiddenCols;
  const renderOrderRows = (list) =>
    sortOrdersClient(list).map((order) => (
      <React.Fragment key={order.id}>
        <tr style={{ borderBottom: "1px solid #e5e7eb", cursor: "default", background: selected.has(order.id) ? "#eff6ff" : "#fff", height: 32 }}
          onMouseEnter={e => { if (!selected.has(order.id)) e.currentTarget.style.background = "#f9fafb"; }}
          onMouseLeave={e => { if (!selected.has(order.id)) e.currentTarget.style.background = "#fff"; }}
        >
          <td style={{ ...CELL, padding: "2px 6px 2px 8px", width: 28 }} onClick={e => e.stopPropagation()}>
            <CustomCheckbox checked={selected.has(order.id)} onChange={() => toggleOne(order.id)} size={14} />
          </td>
          <td style={{ ...CELL, padding: "2px 4px", width: 24, textAlign: "center" }}>
            <button onClick={() => toggleExpand(order)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#6b7280", padding: 0, lineHeight: 1 }}>
              {loadingItems[order.id] ? "…" : expanded[order.id] ? "▼" : "▶"}
            </button>
          </td>
          {!hc.has("order_number") && (
            <td style={{ ...CELL, fontWeight: 600 }}>
              <button
                onClick={(e) => { e.stopPropagation(); router.push(`/orders/${order.id}`); }}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 600, fontSize: 12, color: "#111827", textDecoration: "underline" }}
              >
                #{order.order_number || "—"}
              </button>
            </td>
          )}
          {!hc.has("customer") && (
            <td style={{ ...CELL, minWidth: 120, overflow: "hidden" }}>
              <CustomerCell order={order} locale={locale} router={router} isSuperuser={isSuperuser} />
            </td>
          )}
          {!hc.has("address") && (
            <td
              title={fmtAddressOneLine(order) || undefined}
              style={{ ...CELL, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {fmtAddressOneLine(order) || "—"}
            </td>
          )}
          {!hc.has("amount") && (
            <td
              style={{ ...CELL, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}
              title={(() => {
                const vat = getVatInfo(order.country);
                const brutto = order.total_cents || 0;
                const netto = vat.rate > 0 ? Math.round(brutto / (1 + vat.rate / 100)) : brutto;
                return vat.rate > 0 ? `${fmtCents(netto)} ${ui.net} · +${vat.rate}% ${vat.label}` : undefined;
              })()}
            >
              {fmtCents(order.total_cents || 0)}
            </td>
          )}
          {!hc.has("order_status") && (
            <td style={{ ...CELL, textAlign: "center" }}>
              {returnsMap[order.id] ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: "#fef2f2", color: "#b91c1c", whiteSpace: "nowrap" }}>
                  {ui.retoure}
                </span>
              ) : (
                <StatusBadge value={order.order_status} />
              )}
            </td>
          )}
          {!hc.has("payment_status") && (
            <td style={{ ...CELL, textAlign: "center" }}>
              <StatusBadge value={order.payment_status} />
            </td>
          )}
          {!hc.has("delivery_status") && (
            <td style={{ ...CELL, textAlign: "center" }}>
              <StatusBadge value={order.delivery_status} />
            </td>
          )}
          {!hc.has("date") && (
            <td style={{ ...CELL, color: "#6b7280", whiteSpace: "nowrap" }}>
              {fmtDate(order.created_at)}
            </td>
          )}
          {!hc.has("country") && (
            <td style={{ ...CELL, textAlign: "center", fontWeight: 500 }}>
              {order.country || "—"}
            </td>
          )}
          {!hc.has("review") && (
            <td style={{ ...CELL, textAlign: "center" }}>
              {(() => {
                const orderReviews = allReviews.filter((r) => r.order_id === order.id);
                if (orderReviews.length === 0) return <span style={{ color: "#d1d5db", fontSize: 11 }}>★★★★★</span>;
                const avg = orderReviews.reduce((s, r) => s + Number(r.rating || 0), 0) / orderReviews.length;
                return (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setReviewPopupOrderId(order.id); }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    title={lt(
                      locale,
                      `${orderReviews.length} review${orderReviews.length !== 1 ? "s" : ""}`,
                      `${orderReviews.length} yorum`,
                      `${orderReviews.length} avis`,
                      `${orderReviews.length} reseña${orderReviews.length !== 1 ? "s" : ""}`,
                      `${orderReviews.length} recensione${orderReviews.length !== 1 ? "i" : ""}`,
                      `${orderReviews.length} Bewertung${orderReviews.length !== 1 ? "en" : ""}`
                    )}
                  >
                    <MiniStars rating={avg} />
                  </button>
                );
              })()}
            </td>
          )}
          <td style={{ ...CELL, borderRight: "none", textAlign: "right", whiteSpace: "nowrap", overflow: "visible" }}>
            {(() => {
              const canShip = order.delivery_status !== "zugestellt" && order.delivery_status !== "versendet";
              return (
                <div style={{ display: "inline-flex", gap: 4, justifyContent: "flex-end", alignItems: "center", flexWrap: "nowrap" }}>
                  {canShip && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); startPacking([order]); }}
                      style={{ padding: "1px 6px", borderRadius: 4, border: "1px solid #2563eb", background: "#eff6ff", color: "#1d4ed8", fontSize: 10, fontWeight: 650, cursor: "pointer", whiteSpace: "nowrap", lineHeight: 1.3, flexShrink: 0 }}
                    >
                      {ui.ship}
                    </button>
                  )}
                  <ActionMenu
                    order={order}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                    onVersenden={() => startPacking([order])}
                    isSuperuser={isSuperuser}
                    showShipInMenu={!canShip}
                  />
                </div>
              );
            })()}
          </td>
        </tr>
        {expanded[order.id] && <ExpandedRow order={order} locale={locale} onSaveFields={handleUpdate} colCount={visibleColCount} ui={ui} />}
      </React.Fragment>
    ));

  return (
    <PageContainer>
      {showNewOrder && (
        <ManualOrderModal
          onClose={() => setShowNewOrder(false)}
          onCreated={() => fetchOrders()}
          locale={locale}
        />
      )}
      {reviewPopupOrderId && (
        <ReviewPopup
          reviews={allReviews.filter((r) => r.order_id === reviewPopupOrderId)}
          onClose={() => setReviewPopupOrderId(null)}
          locale={locale}
        />
      )}
      <PageHeader>
        <PageTitle>{ui.orders}</PageTitle>
        <HeaderMeta>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{orders.length} {ui.orders}</span>
          <div ref={colMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowColMenu(v => !v)}
              style={{ padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "#374151", lineHeight: 1, height: 28 }}
            >
              {ui.colColumns} {hiddenCols.size > 0 ? `(${COL_DEFS.filter(c => c.hideable).length - hiddenCols.size}/${COL_DEFS.filter(c => c.hideable).length})` : ""}
            </button>
            {showColMenu && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.1)", zIndex: 9999, minWidth: 190, padding: "6px 0" }}>
                {COL_DEFS.filter(c => c.hideable).map(col => (
                  <label
                    key={col.key}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", cursor: "pointer", fontSize: 13, color: "#111827", userSelect: "none" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#f9fafb"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    <input type="checkbox" checked={!hiddenCols.has(col.key)} onChange={() => toggleColVisibility(col.key)} style={{ accentColor: "#2563eb", width: 15, height: 15, cursor: "pointer" }} />
                    {col.labelKey ? (ui[col.labelKey] || col.labelKey) : col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button variant="primary" size="slim" onClick={() => setShowNewOrder(true)}>
            {ui.addOrder}
          </Button>
        </HeaderMeta>
      </PageHeader>

      {selected.size > 0 && (
        <BulkBar>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#1e3a8a" }}>{selected.size} {ui.selected}</span>
          <InlineStack gap="200" wrap blockAlign="center">
            <Button variant="primary" size="slim" onClick={() => startPacking(selectedOrders)}>
              {ui.bulkShip}
            </Button>
            <Button variant="plain" size="slim" onClick={() => setSelected(new Set())}>
              {ui.clearSelection}
            </Button>
          </InlineStack>
        </BulkBar>
      )}

      <FilterBar>
        <FilterInput
          placeholder={ui.searchPlaceholder || ui.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={ui.search}
        />
        <FilterSelect value={filterOrderStatus} onChange={(e) => setFilterOrderStatus(e.target.value)} aria-label={ui.orderStatus} title={ui.orderStatus}>
          <option value="">{ui.allStatuses}</option>
          <option value="retoure">{ui.activeReturn}</option>
          {ORDER_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect value={filterPayStatus} onChange={(e) => setFilterPayStatus(e.target.value)} aria-label={ui.paymentStatus} title={ui.paymentStatus}>
          <option value="">{ui.allPayments}</option>
          {PAYMENT_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect value={filterDelivery} onChange={(e) => setFilterDelivery(e.target.value)} aria-label={ui.deliveryStatus} title={ui.deliveryStatus}>
          <option value="">{ui.allDeliveries}</option>
          {DELIVERY_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </FilterSelect>
        {isSuperuser && (
          <>
            <FilterSelect value={sellerGroupSort} onChange={(e) => setSellerGroupSort(e.target.value)} aria-label={ui.sellerGroups} title={ui.sellerGroups}>
              <option value="created_at_desc">{ui.sortNewestFirst}</option>
              <option value="created_at_asc">{ui.sortOldestFirst}</option>
              <option value="total_desc">{ui.amountDesc}</option>
              <option value="total_asc">{ui.amountAsc}</option>
            </FilterSelect>
            <FilterInput
              placeholder={ui.searchSeller || lt(locale, "Name / ID…", "Ad / ID…", "Nom / ID…", "Nombre / ID…", "Nome / ID…", "Name / ID…")}
              value={sellerSearchFilter}
              onChange={(e) => setSellerSearchFilter(e.target.value)}
              aria-label={ui.searchSeller}
            />
          </>
        )}
      </FilterBar>

      <TableCard>
        <div style={{ overflowX: "auto", width: "100%" }}>
        <table style={{ width: "100%", minWidth: visibleCols.reduce((s, c) => s + colWidths[COL_DEFS.indexOf(c)], 0), borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
          <colgroup>
            {visibleCols.map(col => (
              <col key={col.key} style={{ width: colWidths[COL_DEFS.indexOf(col)] }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              {visibleCols.map((col) => {
                const colIdx = COL_DEFS.indexOf(col);
                const isSortable = !!col.sortKey;
                return (
                  <th
                    key={col.key}
                    onClick={isSortable ? () => handleColSort(col.sortKey) : undefined}
                    style={{
                      padding: "4px 8px",
                      textAlign: col.align,
                      fontWeight: 600,
                      fontSize: 11,
                      color: isSortable ? "#374151" : "#6b7280",
                      textTransform: "uppercase",
                      letterSpacing: "0.03em",
                      whiteSpace: "nowrap",
                      cursor: isSortable ? "pointer" : "default",
                      userSelect: "none",
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      background: "#f9fafb",
                      overflow: "hidden",
                      boxSizing: "border-box",
                      borderRight: "1px solid #d1d5db",
                    }}
                  >
                    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
                      {col.key === "sel" ? (
                        <CustomCheckbox checked={allSelected} onChange={toggleAll} size={14} />
                      ) : (
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {col.labelKey ? (ui[col.labelKey] || col.label || col.labelKey) : col.label}
                          {isSortable && (
                            <span style={{ fontSize: 10, marginLeft: 3, opacity: sort.startsWith(col.sortKey + "_") ? 1 : 0.35 }}>
                              {sortIcon(col.sortKey)}
                            </span>
                          )}
                        </span>
                      )}
                      {col.hideable && (
                        <div
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); resizingRef.current = { colIdx, startX: e.clientX, startWidth: colWidths[colIdx] }; }}
                          style={{ position: "absolute", right: -5, top: -10, bottom: -10, width: 8, cursor: "col-resize", zIndex: 1, borderRadius: 2 }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(148,163,184,0.55)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={visibleColCount} style={{ padding: 20, textAlign: "center", color: "#9ca3af", fontSize: 12 }}>{ui.loading}</td></tr>
            )}
            {!loading && orders.length === 0 && (
              <tr><td colSpan={visibleColCount} style={{ padding: 20, textAlign: "center", color: "#9ca3af", fontSize: 12 }}>{ui.noOrders}</td></tr>
            )}
            {!loading && orders.length > 0 && !isSuperuser && renderOrderRows(visibleOrders)}
            {!loading && orders.length > 0 && isSuperuser && (
              <>
                <tr>
                  <SuperuserSectionLabel colSpan={visibleColCount}>
                    {ui.superuserSection} ({ownOrdersList.length})
                  </SuperuserSectionLabel>
                </tr>
                {ownOrdersList.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColCount} style={{ padding: "8px 12px", color: "#9ca3af", fontSize: 12 }}>
                      {ui.noOrdersInSection}
                    </td>
                  </tr>
                ) : (
                  renderOrderRows(ownOrdersList)
                )}
                <tr>
                  <SellerOrdersSectionLabel colSpan={visibleColCount}>
                    {ui.sellerOrders}
                  </SellerOrdersSectionLabel>
                </tr>
                {filteredSellerOrderGroups.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColCount} style={{ padding: "8px 12px", color: "#9ca3af", fontSize: 12 }}>
                      {ui.noSellerOrders}{sellerSearchFilter.trim() ? lt(locale, " (filter)", " (filtre)", " (filtre)", " (filtro)", " (filtro)", " (Filter)") : ""}.
                    </td>
                  </tr>
                ) : (
                  filteredSellerOrderGroups.flatMap(({ sellerId, items }) => {
                    const label = sellerLabelById[sellerId] || sellerId;
                    const headerRow = (
                      <tr key={`h-${sellerId}`}>
                        <SellerGroupHeader colSpan={visibleColCount}>
                          <div
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "4px 10px",
                            }}
                          >
                            <span style={{ fontWeight: 600, fontSize: 12, color: "#111827" }}>{label}</span>
                            <span style={{ fontSize: 11, color: "#6b7280" }}>
                              {items.length} {ui.orders}
                            </span>
                          </div>
                        </SellerGroupHeader>
                      </tr>
                    );
                    return [headerRow, ...renderOrderRows(items)];
                  })
                )}
              </>
            )}
          </tbody>
        </table>
        </div>
      </TableCard>
    </PageContainer>
  );
}

const selStyle = { padding: "7px 10px", border: "1px solid #e5e7eb", borderRadius: 7, fontSize: 12, background: "#fff", cursor: "pointer" };

function MiniStars({ rating }) {
  const r = Math.round(Number(rating) || 0);
  return (
    <span style={{ fontSize: 11, letterSpacing: 0, lineHeight: 1 }}>
      {[1,2,3,4,5].map((n) => (
        <span key={n} style={{ color: r >= n ? "#f59e0b" : "#d1d5db" }}>★</span>
      ))}
    </span>
  );
}

function ReviewPopup({ reviews, onClose, locale }) {
  const _ui = getUI(locale || "de");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: 480, maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{_ui.reviewsTitle}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280" }}>×</button>
        </div>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {reviews.map((rv) => (
            <div key={rv.id} style={{ padding: "12px 16px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "#111827", display: "block" }}>
                    {rv.product_title || rv.product_id}
                  </span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>{rv.customer_name || "—"}</span>
                </div>
                <MiniStars rating={rv.rating} />
              </div>
              {rv.comment && <p style={{ margin: 0, fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{rv.comment}</p>}
            </div>
          ))}
          {reviews.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>{_ui.noReviews}</p>}
        </div>
      </div>
    </div>
  );
}
