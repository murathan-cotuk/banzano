'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { api, saveToken } from '../../../../lib/api'

const LOCALES = [
  { code: 'en', label: 'EN' }, { code: 'de', label: 'DE' }, { code: 'tr', label: 'TR' },
  { code: 'fr', label: 'FR' }, { code: 'it', label: 'IT' }, { code: 'es', label: 'ES' },
]

function LocaleSwitcher() {
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0]

  function switchLocale(code) {
    const segments = window.location.pathname.split('/')
    segments[1] = code
    window.location.href = segments.join('/')
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#374151', fontSize: 13, fontWeight: 600 }}
      >
        {current.label}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', zIndex: 50, minWidth: 80 }}>
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => switchLocale(l.code)}
              style={{ display: 'block', width: '100%', padding: '8px 14px', background: l.code === locale ? '#f3f4f6' : 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: l.code === locale ? 700 : 400, textAlign: 'left', color: '#111827' }}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SignupPage() {
  const t = useTranslations('auth')
  const router = useRouter()
  const locale = useLocale()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [country, setCountry] = useState('')
  const [vatNumber, setVatNumber] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!fullName || !email || !password) { setError(t('requiredFields')); return }
    if (password.length < 8) { setError(t('passwordTooShort')); return }
    if (!country.trim()) { setError(t('requiredCountry')); return }
    if (!agreed) { setError(t('mustAgree')); return }
    setLoading(true)
    try {
      const data = await api.signup({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        password,
        company_name: companyName.trim() || undefined,
        country: country.trim().toUpperCase(),
        vat_number: vatNumber.trim() || undefined,
        terms_accepted: true,
      })
      if (data?.token) {
        saveToken(data.token)
        setSuccess(true)
        setTimeout(() => router.push(`/${locale}/dashboard`), 1200)
      }
    } catch (err) {
      setError(err?.message || t('signupError'))
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = { width: '100%', padding: '10px 14px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 15, outline: 'none', boxSizing: 'border-box' }
  const labelStyle = { display: 'block', fontSize: 14, fontWeight: 500, color: '#374151', marginBottom: 6 }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', overflowX: 'hidden', overflowY: 'auto', padding: '16px', boxSizing: 'border-box' }}>
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}><LocaleSwitcher /></div>
      <div style={{ width: '100%', maxWidth: 440, boxSizing: 'border-box' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: '0.18em', color: '#111827' }}>ANDERTAL</span>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4, fontWeight: 500, letterSpacing: '0.04em' }}>AFFILIATE PORTAL</div>
        </div>
        <div style={{ background: '#fff', borderRadius: 12, padding: 'clamp(20px, 5vw, 40px) clamp(16px, 4vw, 36px)', boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: '#111827', margin: '0 0 6px' }}>{t('signup')}</h1>
            <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>{t('signupSubtitle')}</p>
          </div>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={labelStyle}>{t('fullName')} *</label>
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus placeholder="Jane Doe" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('email')} *</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('password')} *</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" placeholder={t('passwordHint')} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('companyName')}</label>
              <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme GmbH" style={inputStyle} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>{t('country')} *</label>
                <input type="text" value={country} onChange={(e) => setCountry(e.target.value)} required placeholder="DE" maxLength={2} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>{t('vatNumber')}</label>
                <input type="text" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} placeholder="DE123456789" style={inputStyle} />
              </div>
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af', margin: '-8px 0 0' }}>{t('countryHint')}</p>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 14, color: '#374151', marginTop: 4 }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3, flexShrink: 0 }} />
              <span style={{ lineHeight: 1.5 }}>{t('agreeTerms')} *</span>
            </label>
            {error && (
              <div style={{ background: '#fee2e2', border: '1px solid #ef4444', borderRadius: 8, padding: '12px 14px', color: '#991b1b', fontSize: 14 }}>{error}</div>
            )}
            {success && (
              <div style={{ background: '#d1fae5', border: '1px solid #10b981', borderRadius: 8, padding: '12px 14px', color: '#065f46', fontSize: 14 }}>{t('signupSuccess')}</div>
            )}
            <button
              type="submit"
              disabled={loading || !agreed}
              style={{ padding: '12px', background: loading || !agreed ? '#9ca3af' : '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: loading || !agreed ? 'not-allowed' : 'pointer' }}
            >
              {loading ? t('loading') : t('signup')}
            </button>
          </form>
          <p style={{ textAlign: 'center', marginTop: 20, fontSize: 14, color: '#6b7280' }}>
            {t('alreadyHaveAccount')}{' '}
            <a href={`/${locale}/login`} style={{ color: '#111827', fontWeight: 600, textDecoration: 'none' }}>{t('login')}</a>
          </p>
        </div>
      </div>
    </div>
  )
}
