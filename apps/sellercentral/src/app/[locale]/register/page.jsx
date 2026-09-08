"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { useTranslations, useLocale } from "next-intl";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { resolveImageUrl } from "@/lib/image-url";
import { applyDocumentFavicon } from "@/lib/apply-document-favicon";
import CustomCheckbox from "@/components/ui/CustomCheckbox";

const LOCALES = [
  { code: "en", label: "EN" }, { code: "de", label: "DE" }, { code: "tr", label: "TR" },
  { code: "fr", label: "FR" }, { code: "it", label: "IT" }, { code: "es", label: "ES" },
];

function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "#374151", fontSize: 13, fontWeight: 600 }}
      >
        {current.label}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 50, minWidth: 80 }}>
          {LOCALES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => { router.replace(pathname, { locale: l.code }); setOpen(false); }}
              style={{ display: "block", width: "100%", padding: "8px 14px", background: l.code === locale ? "#f3f4f6" : "transparent", border: "none", cursor: "pointer", fontSize: 13, fontWeight: l.code === locale ? 700 : 400, textAlign: "left", color: "#111827" }}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RegisterForm() {
  const router = useRouter();
  const t = useTranslations("auth.register");
  const searchParams = useSearchParams();
  const [storeName, setStoreName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [isInvited, setIsInvited] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [branding, setBranding] = useState({ logo: "", favicon: "", logoHeight: 30 });

  useEffect(() => {
    const inviteEmail = searchParams?.get("email");
    const token = searchParams?.get("invite");
    if (inviteEmail) { setEmail(inviteEmail); setIsInvited(true); }
    if (token) setInviteToken(token);
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    getMedusaAdminClient().getSellerSettings("default")
      .then((d) => {
        if (cancelled) return;
        setBranding({
          logo: resolveImageUrl(d?.sellercentral_logo_url || ""),
          favicon: resolveImageUrl(d?.sellercentral_favicon_url || ""),
          logoHeight: d?.sellercentral_logo_height != null ? Number(d.sellercentral_logo_height) : 30,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    applyDocumentFavicon("/api/brand-favicon?app=sellercentral");
  }, [branding.favicon]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    let viewport = document.querySelector('meta[name="viewport"]');
    const previous = viewport?.getAttribute("content") || "";
    if (!viewport) {
      viewport = document.createElement("meta");
      viewport.setAttribute("name", "viewport");
      document.head.appendChild(viewport);
    }
    viewport.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
    );
    return () => {
      if (!viewport) return;
      if (previous) viewport.setAttribute("content", previous);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setSuccess("");
    if (!email || !password) { setError(t("errorRequired")); return; }
    if (!isInvited && !storeName) { setError(t("errorStoreName")); return; }
    if (isInvited && (!firstName || !lastName)) { setError(t("errorName")); return; }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) { setError(t("errorPasswordLength")); return; }
    if (!agreementAccepted) { setError(t("errorTerms")); return; }
    setLoading(true);
    try {
      const extra = {
        ...(inviteToken ? { invite_token: inviteToken, first_name: firstName, last_name: lastName } : {}),
        agreement_accepted: true,
        agreement_version: "1.0",
      };
      const data = await getMedusaAdminClient().registerSeller(
        email.trim().toLowerCase(), password, isInvited ? null : storeName.trim(), extra
      );
      if (!data?.token) throw new Error("Registration failed");
      localStorage.setItem("sellerToken", data.token);
      localStorage.setItem("sellerEmail", data.user.email);
      localStorage.setItem("sellerId", data.user.seller_id);
      localStorage.setItem("storeName", data.user.store_name || storeName || `${firstName} ${lastName}`);
      localStorage.setItem("sellerIsSuperuser", data.user.is_superuser ? "true" : "false");
      localStorage.setItem("sellerLoggedIn", "true");
      setSuccess(t("success"));
      setTimeout(() => router.push("/dashboard"), 1200);
    } catch (err) {
      setError(err?.message || t("errorFailed"));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = { width: "100%", padding: "10px 14px", border: "1.5px solid #d1d5db", borderRadius: 8, fontSize: 15, outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f3f4f6", overflowX: "hidden", overflowY: "auto", touchAction: "pan-y", overscrollBehaviorX: "none", WebkitOverflowScrolling: "touch", padding: "16px", boxSizing: "border-box" }}>
      <div style={{ position: "fixed", top: 16, right: 16, zIndex: 100 }}><LocaleSwitcher /></div>
      <div style={{ width: "100%", maxWidth: 440, boxSizing: "border-box" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          {branding.logo ? (
            <img
              src={branding.logo}
              alt="Andertal"
              style={{ height: Math.min(Math.max(branding.logoHeight || 30, 18), 52), width: "auto", maxWidth: 260, objectFit: "contain", display: "inline-block" }}
            />
          ) : (
            <span style={{ fontSize: 32, fontWeight: 900, letterSpacing: "0.18em", color: "#111827" }}>ANDERTAL</span>
          )}
        </div>
        <div style={{ background: "#fff", borderRadius: 12, padding: "clamp(20px, 5vw, 40px) clamp(16px, 4vw, 36px)", boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: "#111827", margin: "0 0 6px" }}>{isInvited ? t("titleInvited") : t("title")}</h1>
            <p style={{ color: "#6b7280", fontSize: 15, margin: 0 }}>{isInvited ? t("subtitleInvited") : t("subtitle")}</p>
          </div>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {isInvited ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <div>
                  <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{t("firstName")} *</label>
                  <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required style={inputStyle} placeholder={t("firstNamePlaceholder")} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{t("lastName")} *</label>
                  <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required style={inputStyle} placeholder={t("lastNamePlaceholder")} />
                </div>
              </div>
            ) : (
              <div>
                <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{t("storeName")} *</label>
                <input type="text" value={storeName} onChange={(e) => setStoreName(e.target.value)} required style={inputStyle} placeholder={t("storeNamePlaceholder")} />
              </div>
            )}
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{t("email")} *</label>
              <input
                type="email" value={email}
                onChange={(e) => !isInvited && setEmail(e.target.value)}
                required readOnly={isInvited}
                style={{ ...inputStyle, background: isInvited ? "#f9fafb" : "#fff" }}
                placeholder={t("emailPlaceholder")}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#374151", marginBottom: 6 }}>{t("password")} *</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"} value={password}
                  onChange={(e) => setPassword(e.target.value)} required
                  style={{ ...inputStyle, padding: "10px 44px 10px 14px" }}
                  placeholder={t("passwordPlaceholder")}
                />
                <button type="button" onPointerDown={(e) => {
                  e.preventDefault();
                  setShowPassword((v) => !v);
                }}
                  style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#6b7280", padding: 0, display: "flex", alignItems: "center", zIndex: 2, touchAction: "manipulation" }}
                  tabIndex={-1}>
                  {showPassword ? (
                    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0 1 12 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 0 1 1.563-3.029m5.858.908a3 3 0 1 1 4.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88 6.59 6.59m7.532 7.532 3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0 1 12 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 0 1-4.132 5.411m0 0L21 21" /></svg>
                  ) : (
                    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
                  )}
                </button>
              </div>
            </div>
            <div
              role="checkbox"
              aria-checked={agreementAccepted}
              tabIndex={0}
              onClick={() => setAgreementAccepted((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setAgreementAccepted((v) => !v);
                }
              }}
              style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", fontSize: 14, color: "#374151" }}
            >
              {/* CustomCheckbox already renders its own <label> around a hidden native
                  checkbox — wrapping it in ANOTHER <label> here (as before) is invalid nested
                  HTML and made browsers require two clicks to toggle it (confirmed live: first
                  click was silently swallowed, second click toggled). This div takes over the
                  click-to-toggle responsibility directly instead of relying on label nesting;
                  CustomCheckbox's onChange is now unreachable via its own label click, so we
                  no-op it and drive `checked` purely from this wrapper's onClick. */}
              <CustomCheckbox
                checked={agreementAccepted}
                onChange={() => {}}
                size={18}
                style={{ marginTop: 2, flexShrink: 0, pointerEvents: "none" }}
              />
              <span>
                {t.rich("agreeText", {
                  terms: (chunks) => (
                    <a href="/terms" target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#1f2937", textDecoration: "underline" }}>{chunks}</a>
                  ),
                  privacy: (chunks) => (
                    <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#1f2937", textDecoration: "underline" }}>{chunks}</a>
                  ),
                })} *
              </span>
            </div>
            {error && (
              <div style={{ background: "#fee2e2", border: "1px solid #ef4444", borderRadius: 8, padding: "12px 14px", color: "#991b1b", fontSize: 14 }}>{error}</div>
            )}
            {success && (
              <div style={{ background: "#d1fae5", border: "1px solid #10b981", borderRadius: 8, padding: "12px 14px", color: "#065f46", fontSize: 14 }}>{success}</div>
            )}
            <button type="submit" disabled={loading}
              style={{ padding: "12px", background: loading ? "#9ca3af" : "#1f2937", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer" }}>
              {loading ? t("submitting") : (isInvited ? t("submitInvited") : t("submit"))}
            </button>
          </form>
          <p style={{ textAlign: "center", marginTop: 20, fontSize: 14, color: "#6b7280" }}>
            <Link href="/login" style={{ color: "#1f2937", fontWeight: 600, textDecoration: "none" }}>{t("alreadyHaveAccount")}</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Register() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>Loading…</div>}>
      <RegisterForm />
    </Suspense>
  );
}
