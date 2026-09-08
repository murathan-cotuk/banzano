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
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', textAlign: 'left', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' },
  td: { padding: '12px 16px', borderTop: '1px solid #f1f1f1' },
  empty: { padding: '48px 16px', textAlign: 'center', color: '#888', fontSize: 14 },
  badge: (bg, fg) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg }),
}

const TEXTS = {
  de: { title: 'Empfehlungen', sub: 'Seller, die du geworben hast — feste Provision von 5% der Andertal-Plattformgebühr, solange die Empfehlung aktiv ist.', colSeller: 'Seller', colSince: 'Geworben seit', colRate: 'Satz', colMonth: 'Diesen Monat', colLifetime: 'Insgesamt', colStatus: 'Status', active: 'Aktiv', inactive: 'Inaktiv', empty: 'Noch keine geworbenen Seller. Teile deinen Signup-Link, um hier Empfehlungen zu sehen.', loading: 'Lädt…' },
  tr: { title: 'Yönlendirmeler', sub: "Kayıt olmasını sağladığın satıcılar — yönlendirme aktif olduğu sürece Andertal platform komisyonunun sabit %5'i.", colSeller: 'Satıcı', colSince: 'Yönlendirme tarihi', colRate: 'Oran', colMonth: 'Bu ay', colLifetime: 'Toplam', colStatus: 'Durum', active: 'Aktif', inactive: 'Pasif', empty: 'Henüz yönlendirdiğin satıcı yok. Kayıt linkini paylaş.', loading: 'Yükleniyor…' },
  en: { title: 'Referrals', sub: "Sellers you referred — a fixed 5% of the Andertal platform commission for as long as the referral stays active.", colSeller: 'Seller', colSince: 'Referred since', colRate: 'Rate', colMonth: 'This month', colLifetime: 'Lifetime', colStatus: 'Status', active: 'Active', inactive: 'Inactive', empty: 'No referred sellers yet. Share your signup link to see referrals here.', loading: 'Loading…' },
  fr: { title: 'Parrainages', sub: "Vendeurs que vous avez parrainés — 5% fixe de la commission de la plateforme Andertal tant que le parrainage reste actif.", colSeller: 'Vendeur', colSince: 'Parrainé depuis', colRate: 'Taux', colMonth: 'Ce mois-ci', colLifetime: 'Total', colStatus: 'Statut', active: 'Actif', inactive: 'Inactif', empty: 'Aucun vendeur parrainé pour le moment. Partagez votre lien d\'inscription.', loading: 'Chargement…' },
  es: { title: 'Referidos', sub: 'Vendedores que has referido — un 5% fijo de la comisión de la plataforma Andertal mientras el referido siga activo.', colSeller: 'Vendedor', colSince: 'Referido desde', colRate: 'Tasa', colMonth: 'Este mes', colLifetime: 'Total', colStatus: 'Estado', active: 'Activo', inactive: 'Inactivo', empty: 'Aún no hay vendedores referidos. Comparte tu enlace de registro.', loading: 'Cargando…' },
  it: { title: 'Referral', sub: 'Venditori che hai referenziato — 5% fisso della commissione della piattaforma Andertal finché il referral resta attivo.', colSeller: 'Venditore', colSince: 'Referenziato dal', colRate: 'Tasso', colMonth: 'Questo mese', colLifetime: 'Totale', colStatus: 'Stato', active: 'Attivo', inactive: 'Inattivo', empty: 'Nessun venditore referenziato ancora. Condividi il tuo link di registrazione.', loading: 'Caricamento…' },
}

function fmtEur(cents) {
  return ((cents || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}
function fmtDate(d, locale) {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString(locale === 'en' ? 'en-GB' : `${locale}-${locale.toUpperCase()}`, { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '—' }
}

export default function ReferralsPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de
  const [rows, setRows] = useState(null)

  useEffect(() => {
    api.listReferrals().then((r) => setRows(r.referrals || [])).catch(() => setRows([]))
  }, [])

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.card}>
            {rows === null ? (
              <div style={S.empty}>{t.loading}</div>
            ) : rows.length === 0 ? (
              <div style={S.empty}>{t.empty}</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>{t.colSeller}</th>
                    <th style={S.th}>{t.colSince}</th>
                    <th style={S.th}>{t.colRate}</th>
                    <th style={S.th}>{t.colMonth}</th>
                    <th style={S.th}>{t.colLifetime}</th>
                    <th style={S.th}>{t.colStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ ...S.td, fontWeight: 600 }}>{r.label}</td>
                      <td style={S.td}>{fmtDate(r.referred_at, locale)}</td>
                      <td style={S.td}>{r.rate_pct}%</td>
                      <td style={S.td}>{fmtEur(r.this_month_cents)}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{fmtEur(r.lifetime_cents)}</td>
                      <td style={S.td}>
                        <span style={r.active ? S.badge('#f0fdf4', '#15803d') : S.badge('#f3f4f6', '#4b5563')}>
                          {r.active ? t.active : t.inactive}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
