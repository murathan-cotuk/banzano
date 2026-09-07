"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Spinner, Box } from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Read-only affiliate summary for a seller's own products (docs/affiliate.md PR 5). No
// "add to affiliate program" / enrollment UI on purpose — every catalog product is already
// linkable by any affiliate (Model 2), there is nothing for a seller to opt into or manage here.
function fmtEur(cents) {
  return ((cents || 0) / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString("de-DE");
}

const copy = (locale) => {
  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);
  return {
    title: t("Affiliate", "Affiliate", "Affiliate"),
    subtitle: t(
      "Every product in your catalog is automatically visible to Andertal's affiliate partners — commission is paid entirely from Andertal's own treasury, nothing is deducted from your sales. There's nothing to enable or approve here; this page just shows what's happening.",
      "Kataloğunuzdaki her ürün Andertal'ın affiliate ortaklarına otomatik olarak açıktır — komisyon tamamen Andertal'ın kendi kasasından ödenir, satışlarınızdan hiçbir kesinti yapılmaz. Burada açmanız/onaylamanız gereken bir şey yok; bu sayfa sadece neler olduğunu gösterir.",
      "Jedes Produkt in Ihrem Katalog ist automatisch für Andertals Affiliate-Partner sichtbar — die Provision wird vollständig aus Andertals eigener Kasse gezahlt, von Ihren Verkäufen wird nichts abgezogen. Hier gibt es nichts zu aktivieren oder freizugeben; diese Seite zeigt nur, was passiert.",
    ),
    kpiClicks: t("Affiliate clicks (30d)", "Affiliate tıklamaları (30g)", "Affiliate-Klicks (30 Tage)"),
    kpiSales: t("Attributed sales (30d)", "Atfedilen satışlar (30g)", "Zugeordnete Verkäufe (30 Tage)"),
    kpiCommission: t(
      "Paid to affiliates by Andertal (30d, informational)",
      "Andertal tarafından affiliate'lere ödenen (30g, bilgi amaçlı)",
      "Von Andertal an Affiliates gezahlt (30 Tage, informativ)",
    ),
    kpiCommissionHint: t(
      "Does not affect your payout — shown for transparency only.",
      "Ödemenizi etkilemez — sadece şeffaflık için gösterilir.",
      "Beeinflusst Ihre Auszahlung nicht — nur zur Transparenz.",
    ),
    colProduct: t("Product", "Ürün", "Produkt"),
    colSku: t("SKU", "SKU", "SKU"),
    colClicks: t("Clicks (30d)", "Tıklama (30g)", "Klicks (30 Tage)"),
    colSales: t("Attributed sales (30d)", "Atfedilen satış (30g)", "Zugeordnete Verkäufe (30 Tage)"),
    empty: t(
      "No affiliate activity on your products in the last 30 days.",
      "Son 30 günde ürünlerinizde affiliate hareketi yok.",
      "Keine Affiliate-Aktivität bei Ihren Produkten in den letzten 30 Tagen.",
    ),
    loadError: t("Could not load affiliate data.", "Affiliate verileri yüklenemedi.", "Affiliate-Daten konnten nicht geladen werden."),
  };
};

export default function AffiliateMarketingPage() {
  const locale = useLocale();
  const c = copy(locale);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getMedusaAdminClient().getAffiliateMarketingSummary()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) { setData({ products: [], totals: {} }); setError(c.loadError); } });
    return () => { cancelled = true; };
  }, []);

  const totals = data?.totals || {};
  const products = data?.products || [];

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{c.subtitle}</Text>
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}

        <InlineStack gap="300" wrap>
          <div style={{ flex: "1 1 200px", background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{c.kpiClicks}</div>
            <div style={{ fontSize: 28, fontWeight: 750, color: "#111827", marginTop: 6 }}>{data ? fmtInt(totals.clicks_30d) : "—"}</div>
          </div>
          <div style={{ flex: "1 1 200px", background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{c.kpiSales}</div>
            <div style={{ fontSize: 28, fontWeight: 750, color: "#111827", marginTop: 6 }}>{data ? fmtInt(totals.attributed_sales_30d) : "—"}</div>
          </div>
          <div style={{ flex: "1 1 240px", background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "16px 18px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{c.kpiCommission}</div>
            <div style={{ fontSize: 28, fontWeight: 750, color: "#111827", marginTop: 6 }}>{data ? fmtEur(totals.commission_paid_by_platform_cents_30d) : "—"}</div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{c.kpiCommissionHint}</div>
          </div>
        </InlineStack>

        <Card padding="0">
          {data === null ? (
            <Box padding="800"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
          ) : products.length === 0 ? (
            <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.empty}</Text></Box>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                  {[c.colProduct, c.colSku, c.colClicks, c.colSales].map((h) => (
                    <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                    <td style={{ padding: "12px 16px", fontWeight: 600, color: "#111827" }}>{p.title || "—"}</td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{p.sku || "—"}</td>
                    <td style={{ padding: "12px 16px" }}>{fmtInt(p.clicks_30d)}</td>
                    <td style={{ padding: "12px 16px" }}>{fmtInt(p.attributed_sales_30d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
