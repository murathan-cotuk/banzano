"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { useLt } from "@/lib/use-locale-text";
import { dateLocaleFor } from "@/lib/locale-text";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import DashboardLayout from "@/components/DashboardLayout";

const selStyle = {
  padding: "7px 10px",
  border: "1px solid #e5e7eb",
  borderRadius: 7,
  fontSize: 13,
  background: "#fff",
  color: "#374151",
  cursor: "pointer",
};

function Stars({ rating }) {
  const n = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return (
    <span style={{ fontSize: 14, letterSpacing: 1 }}>
      <span style={{ color: "#f59e0b" }}>{"★".repeat(n)}</span>
      <span style={{ color: "#d1d5db" }}>{"★".repeat(5 - n)}</span>
    </span>
  );
}

function CustomerReviewsPage() {
  const params = useParams();
  const router = useRouter();
  const locale = useLocale();
  const lt = useLt();
  const routeLocale = params?.locale || locale;

  const fmtDate = (d) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString(dateLocaleFor(locale), { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  const [reviews, setReviews] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterRating, setFilterRating] = useState("");
  const [sort, setSort] = useState({ col: "created_at", dir: "desc" });
  const [isSuperuser, setIsSuperuser] = useState(false);
  useEffect(() => { setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true"); }, []);
  const [mySellerId, setMySellerId] = useState("");
  useEffect(() => { setMySellerId(localStorage.getItem("sellerId") || ""); }, []);
  const [sellerSectionOpen, setSellerSectionOpen] = useState({});

  useEffect(() => {
    getMedusaAdminClient()
      .request("/admin-hub/reviews")
      .then((d) => { setReviews(d?.reviews || []); setStats(d?.stats || null); })
      .catch(() => setReviews([]))
      .finally(() => setLoading(false));
  }, []);

  const handleSort = (col) => {
    setSort((s) => ({ col, dir: s.col === col && s.dir === "asc" ? "desc" : "asc" }));
  };

  const sortIcon = (col) => {
    if (sort.col !== col) return <span style={{ opacity: 0.3, marginLeft: 3 }}>↕</span>;
    return <span style={{ marginLeft: 3 }}>{sort.dir === "asc" ? "↑" : "↓"}</span>;
  };

  const filtered = useMemo(() => {
    let list = [...reviews];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          (r.customer_name || (isSuperuser ? r.customer_email : "") || "").toLowerCase().includes(q) ||
          (r.customer_number || "").toLowerCase().includes(q) ||
          (r.product_sku || "").toLowerCase().includes(q) ||
          (r.product_title || "").toLowerCase().includes(q) ||
          (r.comment || "").toLowerCase().includes(q),
      );
    }
    if (filterRating) list = list.filter((r) => String(r.rating) === filterRating);

    list.sort((a, b) => {
      let va = a[sort.col] ?? "";
      let vb = b[sort.col] ?? "";
      if (sort.col === "rating") { va = Number(va); vb = Number(vb); }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return sort.dir === "asc" ? -1 : 1;
      if (va > vb) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [reviews, search, filterRating, sort, isSuperuser]);

  // Superuser view: platform's own reviews (unassigned / own account) always on top,
  // followed by each other seller's reviews grouped into collapsible sections.
  const isOwnSellerReview = (r, sid) => {
    const s = String(r?.seller_id ?? "default").trim();
    if (!s || s === "default") return true;
    return s === String(sid || "").trim();
  };
  const { ownReviews, sellerReviewGroups } = useMemo(() => {
    if (!isSuperuser) return { ownReviews: filtered, sellerReviewGroups: [] };
    const own = [];
    const g = new Map();
    for (const r of filtered) {
      if (isOwnSellerReview(r, mySellerId)) own.push(r);
      else {
        const sid = String(r.seller_id || "unknown");
        if (!g.has(sid)) g.set(sid, []);
        g.get(sid).push(r);
      }
    }
    const keys = [...g.keys()].sort((a, b) => {
      const la = g.get(a)[0]?.seller_store_name || a;
      const lb = g.get(b)[0]?.seller_store_name || b;
      return String(la).localeCompare(String(lb), undefined, { sensitivity: "base" });
    });
    return { ownReviews: own, sellerReviewGroups: keys.map((k) => ({ sellerId: k, items: g.get(k) })) };
  }, [filtered, isSuperuser, mySellerId]);

  const avgRating = stats?.avg != null ? Number(stats.avg).toFixed(1) : (reviews.length ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1) : "—");

  const ratingDist = [5, 4, 3, 2, 1].map((n) => {
    const cnt = stats?.distribution?.[n] ?? reviews.filter((r) => r.rating === n).length;
    const total = stats?.total ?? reviews.length;
    return { n, cnt, pct: total ? Math.round((cnt / total) * 100) : 0 };
  });

  const reviewCountLabel = (n) => lt(
    `${n} review${n !== 1 ? "s" : ""}`,
    `${n} değerlendirme`,
    `${n} avis`,
    `${n} reseña${n !== 1 ? "s" : ""}`,
    `${n} recensione${n !== 1 ? "i" : ""}`,
    `${n} Bewertung${n !== 1 ? "en" : ""}`,
  );

  const columns = [
    { label: lt("Customer", "Müşteri", "Client", "Cliente", "Cliente", "Kunde"), col: "customer_name" },
    { label: lt("SKU / Product", "SKU / Ürün", "SKU / Produit", "SKU / Producto", "SKU / Prodotto", "SKU / Produkt"), col: "product_sku" },
    ...(isSuperuser ? [{ label: lt("Seller", "Satıcı", "Vendeur", "Vendedor", "Venditore", "Verkäufer"), col: "seller_store_name" }] : []),
    { label: lt("Rating", "Puan", "Note", "Valoración", "Valutazione", "Bewertung"), col: "rating" },
    { label: lt("Comment", "Yorum", "Commentaire", "Comentario", "Commento", "Kommentar"), col: "comment" },
    { label: lt("Date", "Tarih", "Date", "Fecha", "Data", "Datum"), col: "created_at" },
  ];

  const renderReviewRow = (r, key) => (
    <tr
      key={key}
      style={{ borderBottom: "1px solid #f3f4f6" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#fafafa")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
    >
      <td style={{ padding: "10px 12px", minWidth: 180 }}>
        {r.customer_id ? (
          <button
            onClick={() => router.push(`/customers/${r.customer_id}`)}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            {r.customer_number && (
              <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600 }}>#{r.customer_number}</div>
            )}
            <div style={{ fontWeight: 600, color: "#111827", textDecoration: "underline", fontSize: 13 }}>
              {r.customer_name || (isSuperuser ? r.customer_email : null) || "—"}
            </div>
          </button>
        ) : (
          <div>
            <div style={{ fontWeight: 600, color: "#111827" }}>{r.customer_name || (isSuperuser ? r.customer_email : null) || "—"}</div>
          </div>
        )}
      </td>

      <td style={{ padding: "10px 12px", minWidth: 160 }}>
        {r.product_sku && (
          <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "ui-monospace, monospace", marginBottom: 2 }}>{r.product_sku}</div>
        )}
        <div style={{ color: "#374151" }}>{r.product_title || r.product_id || "—"}</div>
      </td>

      {isSuperuser && (
        <td style={{ padding: "10px 12px", minWidth: 120 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>{r.seller_store_name || r.seller_id || "—"}</span>
        </td>
      )}

      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <Stars rating={r.rating} />
      </td>

      <td style={{ padding: "10px 12px", color: "#6b7280", maxWidth: 400 }}>
        {r.comment || <span style={{ color: "#d1d5db" }}>—</span>}
      </td>

      <td style={{ padding: "10px 12px", color: "#6b7280", fontSize: 12, whiteSpace: "nowrap" }}>
        {fmtDate(r.created_at)}
      </td>
    </tr>
  );

  return (
    <div style={{ padding: 24, background: "#fff", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
          {lt("Customer reviews", "Müşteri değerlendirmeleri", "Avis clients", "Reseñas de clientes", "Recensioni clienti", "Kundenbewertungen")}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {!loading && (
            <>
              <span style={{ fontSize: 13, color: "#6b7280" }}>{reviewCountLabel(filtered.length)}</span>
              {reviews.length > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", background: "#fef3c7", color: "#92400e", borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
                  <span style={{ color: "#f59e0b" }}>★</span> {avgRating} Ø
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {!loading && reviews.length > 0 && (
        <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "20px 28px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 120 }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: "#92400e", lineHeight: 1 }}>{avgRating}</div>
            <div style={{ fontSize: 20, color: "#f59e0b", letterSpacing: 2, margin: "4px 0" }}>
              {[1, 2, 3, 4, 5].map((n) => <span key={n} style={{ color: Number(avgRating) >= n ? "#f59e0b" : "#d1d5db" }}>★</span>)}
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{reviewCountLabel(reviews.length)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 200, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 20px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 5 }}>
            {ratingDist.map(({ n, cnt, pct }) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ minWidth: 10, color: "#374151", fontWeight: 600 }}>{n}</span>
                <span style={{ color: "#f59e0b", fontSize: 11 }}>★</span>
                <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "#f59e0b", borderRadius: 99, transition: "width 0.4s" }} />
                </div>
                <span style={{ minWidth: 28, color: "#6b7280", textAlign: "right" }}>{cnt}</span>
              </div>
            ))}
          </div>
          <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 20px", display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
            {[
              { label: lt("Positive (4–5★)", "Olumlu (4–5★)", "Positif (4–5★)", "Positivo (4–5★)", "Positivo (4–5★)", "Positiv (4-5★)"), val: reviews.filter((r) => r.rating >= 4).length, color: "#059669" },
              { label: lt("Neutral (3★)", "Nötr (3★)", "Neutre (3★)", "Neutral (3★)", "Neutro (3★)", "Neutral (3★)"), val: reviews.filter((r) => r.rating === 3).length, color: "#d97706" },
              { label: lt("Negative (1–2★)", "Olumsuz (1–2★)", "Négatif (1–2★)", "Negativo (1–2★)", "Negativo (1–2★)", "Negativ (1-2★)"), val: reviews.filter((r) => r.rating <= 2).length, color: "#dc2626" },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>{label}</span>
                <span style={{ fontWeight: 700, color }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          placeholder={lt("Search customer, SKU, comment…", "Müşteri, SKU, yorum ara…", "Rechercher client, SKU, commentaire…", "Buscar cliente, SKU, comentario…", "Cerca cliente, SKU, commento…", "Suche nach Kunde, SKU, Kommentar…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220, padding: "7px 12px", border: "1px solid #e5e7eb", borderRadius: 7, fontSize: 13 }}
        />
        <select value={filterRating} onChange={(e) => setFilterRating(e.target.value)} style={selStyle}>
          <option value="">{lt("All stars", "Tüm yıldızlar", "Toutes les étoiles", "Todas las estrellas", "Tutte le stelle", "Alle Sterne")}</option>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {"★".repeat(n)}{"☆".repeat(5 - n)} — {reviews.filter((r) => r.rating === n).length}×
            </option>
          ))}
        </select>
      </div>

      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
              {columns.map(({ label, col }) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{
                    padding: "10px 12px",
                    textAlign: "left",
                    fontWeight: 600,
                    fontSize: 11,
                    color: "#374151",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {label}{sortIcon(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={isSuperuser ? 6 : 5} style={{ padding: 40, textAlign: "center", color: "#9ca3af" }}>
                  {lt("Loading…", "Yükleniyor…", "Chargement…", "Cargando…", "Caricamento…", "Laden…")}
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={isSuperuser ? 6 : 5} style={{ padding: 40, textAlign: "center", color: "#9ca3af" }}>
                  {lt("No reviews found", "Değerlendirme bulunamadı", "Aucun avis trouvé", "No se encontraron reseñas", "Nessuna recensione trovata", "Keine Bewertungen gefunden")}
                </td>
              </tr>
            )}
            {isSuperuser && (
              <tr>
                <td colSpan={columns.length} style={{ padding: "10px 20px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", fontWeight: 700, fontSize: 12, color: "#1e40af", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {lt("Your superuser area — own account reviews and unassigned", "Süper kullanıcı alanınız — kendi hesap değerlendirmeleri ve atanmamış", "Votre espace superutilisateur — avis du compte propre et non attribués", "Su área de superusuario — reseñas de la cuenta propia y sin asignar", "La tua area superuser — recensioni dell'account proprio e non assegnate", "Ihr Superuser-Bereich — eigene Konto-Bewertungen und ohne Verkäufer-Zuordnung")} ({ownReviews.length})
                </td>
              </tr>
            )}
            {(isSuperuser ? ownReviews : filtered).map((r, i) => renderReviewRow(r, i))}
            {isSuperuser && (
              <>
                <tr>
                  <td colSpan={columns.length} style={{ padding: "10px 20px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb", borderTop: "1px solid #e5e7eb", fontWeight: 700, fontSize: 12, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {lt("Seller reviews", "Satıcı değerlendirmeleri", "Avis des vendeurs", "Reseñas de vendedores", "Recensioni dei venditori", "Verkäufer-Bewertungen")}
                  </td>
                </tr>
                {sellerReviewGroups.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} style={{ padding: "16px 20px", color: "#9ca3af", fontSize: 13 }}>
                      {lt("No seller reviews", "Satıcı değerlendirmesi yok", "Aucun avis de vendeur", "Sin reseñas de vendedores", "Nessuna recensione dei venditori", "Keine Verkäufer-Bewertungen")}
                    </td>
                  </tr>
                ) : (
                  sellerReviewGroups.flatMap(({ sellerId, items }) => {
                    const label = items[0]?.seller_store_name || sellerId;
                    const open = sellerSectionOpen[sellerId] !== false;
                    const headerRow = (
                      <tr key={`h-${sellerId}`}>
                        <td colSpan={columns.length} style={{ padding: 0, background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                          <button
                            type="button"
                            onClick={() => setSellerSectionOpen((prev) => ({ ...prev, [sellerId]: !open }))}
                            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", background: "none", border: "none", cursor: "pointer", font: "inherit", textAlign: "left" }}
                          >
                            <span style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{label}</span>
                            <span style={{ fontSize: 13, color: "#6b7280" }}>{open ? "▾" : "▸"} {reviewCountLabel(items.length)}</span>
                          </button>
                        </td>
                      </tr>
                    );
                    return open ? [headerRow, ...items.map((r, i) => renderReviewRow(r, `${sellerId}-${i}`))] : [headerRow];
                  })
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CustomerReviewsPageWrapper() {
  return (
    <DashboardLayout>
      <CustomerReviewsPage />
    </DashboardLayout>
  );
}
