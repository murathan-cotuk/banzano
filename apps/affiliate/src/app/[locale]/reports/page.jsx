'use client'
import { useState, useEffect, useMemo } from 'react'
import { useLocale } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'
import { api } from '../../../lib/api'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 1000, margin: '0 auto', padding: '36px 24px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 24px' },
  toolbar: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' },
  select: { padding: '8px 12px', borderRadius: 8, border: '1.5px solid #e0e0e0', fontSize: 14, background: '#fff' },
  btn: { padding: '9px 16px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' },
  td: { padding: '12px 16px', borderTop: '1px solid #f1f1f1' },
  empty: { padding: '48px 16px', textAlign: 'center', color: '#888', fontSize: 14 },
  badge: (bg, fg) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg }),
}

const STATUS_STYLE = {
  pending: ['#fffbeb', '#92400e'],
  confirmed: ['#eff6ff', '#1d4ed8'],
  paid: ['#f0fdf4', '#15803d'],
  clawed_back: ['#fef2f2', '#991b1b'],
  forfeited: ['#f3f4f6', '#4b5563'],
}

const TEXTS = {
  de: { title: 'Berichte', sub: 'Deine Provisionen im Detail — nach Status filterbar.', all: 'Alle Status', export: 'CSV exportieren', colDate: 'Datum', colType: 'Typ', colGross: 'Basisbetrag', colRate: 'Satz', colCommission: 'Provision', colStatus: 'Status', empty: 'Noch keine Provisionen.', loading: 'Lädt…', typeSellerReferral: 'Seller-Empfehlung', typeProductSale: 'Produktverkauf', pending: 'Ausstehend', confirmed: 'Bestätigt', paid: 'Ausgezahlt', clawed_back: 'Storniert', forfeited: 'Verfallen' },
  tr: { title: 'Raporlar', sub: 'Komisyonlarının detayı — duruma göre filtrelenebilir.', all: 'Tüm durumlar', export: 'CSV olarak indir', colDate: 'Tarih', colType: 'Tip', colGross: 'Taban tutar', colRate: 'Oran', colCommission: 'Komisyon', colStatus: 'Durum', empty: 'Henüz komisyon yok.', loading: 'Yükleniyor…', typeSellerReferral: 'Satıcı yönlendirmesi', typeProductSale: 'Ürün satışı', pending: 'Beklemede', confirmed: 'Onaylandı', paid: 'Ödendi', clawed_back: 'İptal edildi', forfeited: 'Düştü' },
  en: { title: 'Reports', sub: 'Your commissions in detail — filterable by status.', all: 'All statuses', export: 'Export CSV', colDate: 'Date', colType: 'Type', colGross: 'Basis amount', colRate: 'Rate', colCommission: 'Commission', colStatus: 'Status', empty: 'No commissions yet.', loading: 'Loading…', typeSellerReferral: 'Seller referral', typeProductSale: 'Product sale', pending: 'Pending', confirmed: 'Confirmed', paid: 'Paid', clawed_back: 'Clawed back', forfeited: 'Forfeited' },
  fr: { title: 'Rapports', sub: 'Le détail de vos commissions — filtrable par statut.', all: 'Tous les statuts', export: 'Exporter en CSV', colDate: 'Date', colType: 'Type', colGross: 'Montant de base', colRate: 'Taux', colCommission: 'Commission', colStatus: 'Statut', empty: 'Aucune commission pour le moment.', loading: 'Chargement…', typeSellerReferral: 'Parrainage vendeur', typeProductSale: 'Vente produit', pending: 'En attente', confirmed: 'Confirmée', paid: 'Payée', clawed_back: 'Annulée', forfeited: 'Perdue' },
  es: { title: 'Informes', sub: 'El detalle de tus comisiones — filtrable por estado.', all: 'Todos los estados', export: 'Exportar CSV', colDate: 'Fecha', colType: 'Tipo', colGross: 'Importe base', colRate: 'Tasa', colCommission: 'Comisión', colStatus: 'Estado', empty: 'Aún no hay comisiones.', loading: 'Cargando…', typeSellerReferral: 'Referido de vendedor', typeProductSale: 'Venta de producto', pending: 'Pendiente', confirmed: 'Confirmada', paid: 'Pagada', clawed_back: 'Revertida', forfeited: 'Perdida' },
  it: { title: 'Report', sub: 'Il dettaglio delle tue commissioni — filtrabile per stato.', all: 'Tutti gli stati', export: 'Esporta CSV', colDate: 'Data', colType: 'Tipo', colGross: 'Importo base', colRate: 'Tasso', colCommission: 'Commissione', colStatus: 'Stato', empty: 'Nessuna commissione ancora.', loading: 'Caricamento…', typeSellerReferral: 'Referral venditore', typeProductSale: 'Vendita prodotto', pending: 'In attesa', confirmed: 'Confermata', paid: 'Pagata', clawed_back: 'Stornata', forfeited: 'Persa' },
}

function fmtEur(cents, currency) {
  return ((cents || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: currency || 'EUR' })
}
function fmtDate(d, locale) {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString(locale === 'en' ? 'en-GB' : `${locale}-${locale.toUpperCase()}`, { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '—' }
}

function toCsv(rows, t) {
  const header = ['date', 'type', 'gross_amount', 'rate_pct', 'commission', 'currency', 'status']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      new Date(r.earned_at).toISOString().slice(0, 10),
      r.source_type,
      (r.gross_amount_cents / 100).toFixed(2),
      r.rate_pct,
      (r.commission_cents / 100).toFixed(2),
      r.currency,
      r.status,
    ].join(','))
  }
  return lines.join('\n')
}

export default function ReportsPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState(null)
  const [currency, setCurrency] = useState('EUR')

  useEffect(() => {
    setRows(null)
    api.listCommissions(status || undefined)
      .then((r) => { setRows(r.commissions || []); setCurrency(r.currency || 'EUR') })
      .catch(() => setRows([]))
  }, [status])

  const exportCsv = () => {
    if (!rows || !rows.length) return
    const blob = new Blob([toCsv(rows, t)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `andertal-affiliate-commissions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const typeLabel = (v) => (v === 'seller_referral' ? t.typeSellerReferral : t.typeProductSale)
  const statusLabel = (v) => t[v] || v

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.toolbar}>
            <select style={S.select} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t.all}</option>
              {['pending', 'confirmed', 'paid', 'clawed_back', 'forfeited'].map((s) => (
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </select>
            <button style={S.btn} onClick={exportCsv} disabled={!rows || !rows.length}>{t.export}</button>
          </div>

          <div style={S.card}>
            {rows === null ? (
              <div style={S.empty}>{t.loading}</div>
            ) : rows.length === 0 ? (
              <div style={S.empty}>{t.empty}</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>{t.colDate}</th>
                    <th style={S.th}>{t.colType}</th>
                    <th style={S.th}>{t.colGross}</th>
                    <th style={S.th}>{t.colRate}</th>
                    <th style={S.th}>{t.colCommission}</th>
                    <th style={S.th}>{t.colStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const [bg, fg] = STATUS_STYLE[r.status] || ['#f3f4f6', '#4b5563']
                    return (
                      <tr key={r.id}>
                        <td style={S.td}>{fmtDate(r.earned_at, locale)}</td>
                        <td style={S.td}>{typeLabel(r.source_type)}</td>
                        <td style={S.td}>{fmtEur(r.gross_amount_cents, currency)}</td>
                        <td style={S.td}>{r.rate_pct}%</td>
                        <td style={{ ...S.td, fontWeight: 700 }}>{fmtEur(r.commission_cents, currency)}</td>
                        <td style={S.td}><span style={S.badge(bg, fg)}>{statusLabel(r.status)}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
