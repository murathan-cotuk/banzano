'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'
import { api } from '../../../lib/api'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 900, margin: '0 auto', padding: '36px 24px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 24px' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 28 },
  stat: { background: '#fff', borderRadius: 10, padding: '20px 22px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  statVal: { fontSize: 28, fontWeight: 700, color: '#111', lineHeight: 1.1 },
  statLabel: { fontSize: 13, color: '#888', marginTop: 4 },
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' },
  td: { padding: '12px 16px', borderTop: '1px solid #f1f1f1' },
  empty: { padding: '48px 16px', textAlign: 'center', color: '#888', fontSize: 14 },
  badge: (bg, fg) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg }),
}

const STATUS_STYLE = {
  pending: ['#fffbeb', '#92400e'],
  processing: ['#eff6ff', '#1d4ed8'],
  paid: ['#f0fdf4', '#15803d'],
  failed: ['#fef2f2', '#991b1b'],
}

const TEXTS = {
  de: { title: 'Auszahlungen', sub: 'Auszahlungen erfolgen automatisch am 1. jedes Monats, sobald der Mindestbetrag (50 €) erreicht ist.', nextEstimate: 'Geschätzter nächster Betrag', colDate: 'Datum', colAmount: 'Betrag', colStatus: 'Status', colPeriod: 'Zeitraum', empty: 'Noch keine Auszahlungen.', loading: 'Lädt…', pending: 'Ausstehend', processing: 'In Bearbeitung', paid: 'Ausgezahlt', failed: 'Fehlgeschlagen' },
  tr: { title: 'Ödemeler', sub: "Ödemeler, asgari tutara (50 €) ulaşıldığında her ayın 1'inde otomatik yapılır.", nextEstimate: 'Tahmini bir sonraki tutar', colDate: 'Tarih', colAmount: 'Tutar', colStatus: 'Durum', colPeriod: 'Dönem', empty: 'Henüz ödeme yok.', loading: 'Yükleniyor…', pending: 'Beklemede', processing: 'İşleniyor', paid: 'Ödendi', failed: 'Başarısız' },
  en: { title: 'Payouts', sub: 'Payouts run automatically on the 1st of each month once you reach the minimum amount (€50).', nextEstimate: 'Estimated next amount', colDate: 'Date', colAmount: 'Amount', colStatus: 'Status', colPeriod: 'Period', empty: 'No payouts yet.', loading: 'Loading…', pending: 'Pending', processing: 'Processing', paid: 'Paid', failed: 'Failed' },
  fr: { title: 'Paiements', sub: "Les paiements sont effectués automatiquement le 1er de chaque mois une fois le montant minimum (50 €) atteint.", nextEstimate: 'Montant estimé du prochain paiement', colDate: 'Date', colAmount: 'Montant', colStatus: 'Statut', colPeriod: 'Période', empty: 'Aucun paiement pour le moment.', loading: 'Chargement…', pending: 'En attente', processing: 'En cours', paid: 'Payé', failed: 'Échoué' },
  es: { title: 'Pagos', sub: 'Los pagos se realizan automáticamente el día 1 de cada mes al alcanzar el importe mínimo (50 €).', nextEstimate: 'Importe estimado del próximo pago', colDate: 'Fecha', colAmount: 'Importe', colStatus: 'Estado', colPeriod: 'Periodo', empty: 'Aún no hay pagos.', loading: 'Cargando…', pending: 'Pendiente', processing: 'Procesando', paid: 'Pagado', failed: 'Fallido' },
  it: { title: 'Pagamenti', sub: "I pagamenti vengono effettuati automaticamente il 1° di ogni mese al raggiungimento dell'importo minimo (50 €).", nextEstimate: 'Importo stimato del prossimo pagamento', colDate: 'Data', colAmount: 'Importo', colStatus: 'Stato', colPeriod: 'Periodo', empty: 'Nessun pagamento ancora.', loading: 'Caricamento…', pending: 'In attesa', processing: 'In elaborazione', paid: 'Pagato', failed: 'Non riuscito' },
}

function fmtEur(cents) {
  return ((cents || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}
function fmtDate(d, locale) {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString(locale === 'en' ? 'en-GB' : `${locale}-${locale.toUpperCase()}`, { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '—' }
}

export default function PayoutsPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de
  const [data, setData] = useState(null)

  useEffect(() => {
    api.listPayouts().then(setData).catch(() => setData({ payouts: [], next_estimated_cents: 0 }))
  }, [])

  const rows = data?.payouts || null

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.stats}>
            <div style={S.stat}>
              <div style={S.statVal}>{data ? fmtEur(data.next_estimated_cents) : '—'}</div>
              <div style={S.statLabel}>{t.nextEstimate}</div>
            </div>
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
                    <th style={S.th}>{t.colPeriod}</th>
                    <th style={S.th}>{t.colAmount}</th>
                    <th style={S.th}>{t.colStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const [bg, fg] = STATUS_STYLE[p.status] || ['#f3f4f6', '#4b5563']
                    return (
                      <tr key={p.id}>
                        <td style={S.td}>{fmtDate(p.created_at, locale)}</td>
                        <td style={S.td}>{p.period_start ? `${fmtDate(p.period_start, locale)} – ${fmtDate(p.period_end, locale)}` : '—'}</td>
                        <td style={{ ...S.td, fontWeight: 700 }}>{fmtEur(p.amount_cents)}</td>
                        <td style={S.td}><span style={S.badge(bg, fg)}>{t[p.status] || p.status}</span></td>
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
