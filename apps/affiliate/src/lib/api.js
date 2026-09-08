'use client'

const BASE = (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || 'http://localhost:9000') + '/affiliate-api/v1'

function getToken() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('aff_token')
}

export function saveToken(token) {
  localStorage.setItem('aff_token', token)
}

export function clearToken() {
  localStorage.removeItem('aff_token')
}

export async function apiFetch(path, opts = {}) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(BASE + path, { ...opts, headers })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json.message || 'Error'), { status: res.status, body: json })
  return json
}

export const api = {
  login: (email, password) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signup: (data) => apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify(data) }),
  me: () => apiFetch('/auth/me'),

  dashboard: () => apiFetch('/dashboard'),
  listLinks: () => apiFetch('/links'),
  createLink: (data) => apiFetch('/links', { method: 'POST', body: JSON.stringify(data) }),
  listCommissions: (status) => apiFetch(`/commissions${status ? `?status=${encodeURIComponent(status)}` : ''}`),

  listReferrals: () => apiFetch('/referrals'),
  listPayouts: () => apiFetch('/payouts'),

  stripeConnectOnboard: () => apiFetch('/stripe-connect/onboard', { method: 'POST' }),
  stripeConnectStatus: () => apiFetch('/stripe-connect/status'),
  stripeConnectDashboardLink: () => apiFetch('/stripe-connect/dashboard-link'),
}
