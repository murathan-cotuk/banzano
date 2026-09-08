"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import {
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  Badge,
  Divider,
} from "@shopify/polaris";
import { useLocale } from "next-intl";
import { getUI } from "@/lib/ui-strings";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

function formatJoined(d, locale) {
  if (!d) return "—";
  try {
    const loc = locale === "en" ? "en-GB" : locale === "tr" ? "tr-TR" : "de-DE";
    return new Date(d).toLocaleDateString(loc, {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatSessionDate(d, locale) {
  if (!d) return "—";
  try {
    const loc = locale === "en" ? "en-GB" : locale === "tr" ? "tr-TR" : "de-DE";
    return new Date(d).toLocaleString(loc, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function DevicesCard({ locale }) {
  const router = useRouter();
  const [sessions, setSessions] = useState(null); // null = loading
  const [sessionTracking, setSessionTracking] = useState(true);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);

  const load = useCallback(async () => {
    try {
      const d = await getMedusaAdminClient().getSellerSessions();
      setSessions(Array.isArray(d?.sessions) ? d.sessions : []);
      setSessionTracking(d?.session_tracking !== false);
    } catch (e) {
      setSessions([]);
      setSessionTracking(true);
      setErr(e?.message || t("Could not load devices.", "Cihazlar yüklenemedi.", "Geräte konnten nicht geladen werden."));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const localLogout = () => {
    ["sellerLoggedIn", "sellerEmail", "sellerId", "storeName", "sellerToken", "sellerIsSuperuser", "sellerPermissions", "sellerApprovalStatus", "andertal_su_auth_backup"]
      .forEach((k) => localStorage.removeItem(k));
    try {
      sessionStorage.removeItem("andertal_seller_impersonation_v1");
    } catch {
      /* ignore */
    }
    fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    router.push("/login");
  };

  const revokeOne = async (session) => {
    setErr("");
    setBusyId(session.id);
    try {
      await getMedusaAdminClient().revokeSellerSession(session.id);
      if (session.is_current) {
        localLogout();
        return;
      }
      setSessions((list) => (list || []).filter((s) => s.id !== session.id));
    } catch (e) {
      setErr(e?.message || t("Could not end this session.", "Bu oturum sonlandırılamadı.", "Sitzung konnte nicht beendet werden."));
    }
    setBusyId(null);
  };

  const revokeAllOthers = async () => {
    setErr("");
    setRevokingAll(true);
    try {
      await getMedusaAdminClient().revokeAllSellerSessions({ includeCurrent: false });
      await load();
    } catch (e) {
      setErr(e?.message || t("Could not end other sessions.", "Diğer oturumlar sonlandırılamadı.", "Andere Sitzungen konnten nicht beendet werden."));
    }
    setRevokingAll(false);
  };

  const emptyHint = !sessionTracking
    ? t(
        "This login is not device-tracked yet. Sign out and sign in once — then this device will appear here.",
        "Bu oturum henüz cihaz olarak izlenmiyor. Bir kez çıkış yapıp tekrar giriş yapın — cihazınız burada görünecek.",
        "Diese Anmeldung wird noch nicht als Gerät erfasst. Melden Sie sich einmal ab und wieder an — danach erscheint dieses Gerät hier.",
      )
    : t(
        "No other tracked devices right now.",
        "Şu anda başka takip edilen cihaz yok.",
        "Derzeit keine weiteren erfassten Geräte.",
      );

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text variant="headingMd" as="h2">
            {t("Devices", "Cihazlar", "Geräte")}
          </Text>
          {sessions && sessions.length > 1 && (
            <Button tone="critical" onClick={revokeAllOthers} loading={revokingAll} size="slim">
              {t("Log out other devices", "Diğer cihazlardan çıkış yap", "Andere Geräte abmelden")}
            </Button>
          )}
        </InlineStack>
        <Text as="p" tone="subdued">
          {t(
            "Every device currently logged into your account. If you don't recognize one, end it.",
            "Hesabınızda şu anda oturum açık olan tüm cihazlar. Tanımadığınız biri varsa oturumunu sonlandırın.",
            "Alle Geräte, die aktuell in Ihrem Konto angemeldet sind. Erkennen Sie eines nicht, beenden Sie es.",
          )}
        </Text>

        {err ? (
          <Banner tone="critical" onDismiss={() => setErr("")}>
            <Text as="p">{err}</Text>
          </Banner>
        ) : null}

        {!sessionTracking && sessions !== null ? (
          <Banner tone="warning">
            <Text as="p">{emptyHint}</Text>
          </Banner>
        ) : null}

        {sessions === null ? (
          <Text as="p" tone="subdued">{t("Loading…", "Yükleniyor…", "Wird geladen…")}</Text>
        ) : sessions.length === 0 ? (
          sessionTracking ? (
            <Text as="p" tone="subdued">{emptyHint}</Text>
          ) : null
        ) : (
          <BlockStack gap="200">
            {sessions.map((s) => (
              <Box key={s.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="150" blockAlign="center">
                      <Text variant="bodyMd" fontWeight="semibold">{s.device_label}</Text>
                      {s.is_current && (
                        <Badge tone="success">{t("This device", "Bu cihaz", "Dieses Gerät")}</Badge>
                      )}
                    </InlineStack>
                    <Text variant="bodySm" tone="subdued">
                      {t("Last active", "Son aktif", "Zuletzt aktiv")}: {formatSessionDate(s.last_seen_at, locale)}
                      {s.ip_address ? ` · ${s.ip_address}` : ""}
                    </Text>
                  </BlockStack>
                  <Button
                    tone="critical"
                    variant="plain"
                    size="slim"
                    loading={busyId === s.id}
                    onClick={() => revokeOne(s)}
                  >
                    {s.is_current
                      ? t("Log out", "Çıkış yap", "Abmelden")
                      : t("End session", "Oturumu sonlandır", "Sitzung beenden")}
                  </Button>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function TotpSetupCard({ onStatusChange, locale }) {
  const ui = getUI(locale);
  const [step, setStep] = useState("idle"); // idle | loading | qr | verifying | done
  const [qrCode, setQrCode] = useState(null);
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [disableCode, setDisableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const load = useCallback(async () => {
    setStep("loading");
    try {
      const d = await getMedusaAdminClient().get2faStatus();
      setEnabled(d?.totp_enabled || false);
      setStep("idle");
    } catch {
      setStep("idle");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startSetup = async () => {
    setErr("");
    setOk("");
    setStep("loading");
    try {
      const d = await getMedusaAdminClient().setup2fa();
      setQrCode(d?.qr_code || null);
      setSecret(d?.secret || null);
      setCode("");
      setStep("qr");
    } catch (e) {
      setErr(e?.message || (locale === "en" ? "Setup failed." : locale === "tr" ? "Kurulum başarısız." : "Setup fehlgeschlagen."));
      setStep("idle");
    }
  };

  const verifyCode = async () => {
    if (!code) {
      setErr(locale === "en" ? "Please enter the code." : locale === "tr" ? "Lütfen kodu girin." : "Bitte Code eingeben.");
      return;
    }
    setErr("");
    setStep("verifying");
    try {
      await getMedusaAdminClient().verify2fa(code);
      setEnabled(true);
      setStep("done");
      setOk(locale === "en" ? "2FA successfully activated!" : locale === "tr" ? "2FA başarıyla etkinleştirildi!" : "2FA erfolgreich aktiviert!");
      onStatusChange?.(true);
    } catch (e) {
      setErr(e?.message || (locale === "en" ? "Invalid code." : locale === "tr" ? "Geçersiz kod." : "Ungültiger Code."));
      setStep("qr");
    }
  };

  const disable2fa = async () => {
    if (!disableCode && !disablePassword) {
      setErr(locale === "en" ? "Please enter your current code or password." : locale === "tr" ? "Lütfen mevcut kodunuzu veya şifrenizi girin." : "Bitte aktuellen Code oder Passwort eingeben.");
      return;
    }
    setErr("");
    setDisabling(true);
    try {
      await getMedusaAdminClient().disable2fa({ code: disableCode, password: disablePassword });
      setEnabled(false);
      setDisableCode("");
      setDisablePassword("");
      setOk(locale === "en" ? "2FA has been disabled." : locale === "tr" ? "2FA devre dışı bırakıldı." : "2FA wurde deaktiviert.");
      onStatusChange?.(false);
    } catch (e) {
      setErr(e?.message || (locale === "en" ? "Deactivation failed." : locale === "tr" ? "Devre dışı bırakma başarısız." : "Deaktivierung fehlgeschlagen."));
    } finally {
      setDisabling(false);
    }
  };

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text variant="headingMd" as="h2">
            {locale === "en" ? "Two-factor authentication (2FA)" : locale === "tr" ? "İki faktörlü kimlik doğrulama (2FA)" : "Zwei-Faktor-Authentifizierung (2FA)"}
          </Text>
          <Badge tone={enabled ? "success" : "attention"}>
            {enabled ? (locale === "en" ? "Enabled" : locale === "tr" ? "Etkin" : "Aktiviert") : (locale === "en" ? "Not enabled" : locale === "tr" ? "Etkin değil" : "Nicht aktiviert")}
          </Badge>
        </InlineStack>
        <Text as="p" tone="subdued">
          {locale === "en"
            ? "An authenticator app (e.g. Google Authenticator, Authy) is used to request an additional one-time code at login. This protects your account even if your password is stolen."
            : locale === "tr"
            ? "Giriş sırasında ek bir tek kullanımlık kod istemek için bir kimlik doğrulayıcı uygulama (ör. Google Authenticator, Authy) kullanılır. Bu, şifreniz çalınsa bile hesabınızı korur."
            : "Mit einem Authenticator-App (z. B. Google Authenticator, Authy) wird beim Anmelden ein zusätzlicher einmaliger Code abgefragt. Dadurch ist Ihr Konto auch bei gestohlenen Passwörtern geschützt."}
        </Text>

        {err ? (
          <Banner tone="critical" onDismiss={() => setErr("")}>
            <Text as="p">{err}</Text>
          </Banner>
        ) : null}
        {ok ? (
          <Banner tone="success" onDismiss={() => setOk("")}>
            <Text as="p">{ok}</Text>
          </Banner>
        ) : null}

        {!enabled && step === "idle" && (
          <Button variant="primary" onClick={startSetup}>
            {locale === "en" ? "Set up 2FA" : locale === "tr" ? "2FA'yı kur" : "2FA einrichten"}
          </Button>
        )}

        {step === "loading" && (
          <Text as="p" tone="subdued">{ui.loading}</Text>
        )}

        {step === "qr" && qrCode && (
          <BlockStack gap="400">
            <Text as="p" fontWeight="semibold">
              {locale === "en" ? "Step 1: Scan QR code" : locale === "tr" ? "Adım 1: QR kodu tara" : "Schritt 1: QR-Code scannen"}
            </Text>
            <Text as="p" tone="subdued">
              {locale === "en"
                ? "Open your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.) and scan this QR code:"
                : locale === "tr"
                ? "Kimlik doğrulayıcı uygulamanızı (Google Authenticator, Authy, Microsoft Authenticator vb.) açın ve bu QR kodunu tarayın:"
                : "Öffnen Sie Ihre Authenticator-App (Google Authenticator, Authy, Microsoft Authenticator usw.) und scannen Sie diesen QR-Code:"}
            </Text>
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div
                style={{
                  background: "#fff",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  display: "inline-block",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
                }}
              >
                <img src={qrCode} alt="2FA QR Code" width={200} height={200} style={{ display: "block" }} />
              </div>
            </div>
            {secret && (
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">
                    {locale === "en" ? "QR code not readable? Enter the secret key manually:" : locale === "tr" ? "QR kod okunamıyor mu? Gizli anahtarı manuel girin:" : "QR-Code nicht lesbar? Geheimschlüssel manuell eingeben:"}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Text variant="bodyMd" fontWeight="semibold">
                      <span style={{ fontFamily: "monospace", letterSpacing: 2, fontSize: 13 }}>
                        {showSecret ? secret : "••••••••••••••••••••"}
                      </span>
                    </Text>
                    <Button
                      variant="plain"
                      size="slim"
                      onClick={() => setShowSecret((v) => !v)}
                    >
                      {showSecret ? (locale === "en" ? "Hide" : locale === "tr" ? "Gizle" : "Verbergen") : (locale === "en" ? "Show" : locale === "tr" ? "Göster" : "Anzeigen")}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            )}
            <Divider />
            <Text as="p" fontWeight="semibold">
              {locale === "en" ? "Step 2: Confirm code" : locale === "tr" ? "Adım 2: Kodu onayla" : "Schritt 2: Code bestätigen"}
            </Text>
            <Text as="p" tone="subdued">
              {locale === "en" ? "Enter the 6-digit code from your app to activate 2FA:" : locale === "tr" ? "2FA'yı etkinleştirmek için uygulamanızdaki 6 haneli kodu girin:" : "Geben Sie den 6-stelligen Code aus Ihrer App ein, um 2FA zu aktivieren:"}
            </Text>
            <div style={{ maxWidth: 200 }}>
              <TextField
                label={locale === "en" ? "6-digit code" : locale === "tr" ? "6 haneli kod" : "6-stelliger Code"}
                value={code}
                onChange={setCode}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
              />
            </div>
            <InlineStack gap="300">
              <Button variant="primary" onClick={verifyCode} loading={step === "verifying"}>
                {locale === "en" ? "Confirm code & activate" : locale === "tr" ? "Kodu onayla & etkinleştir" : "Code bestätigen & aktivieren"}
              </Button>
              <Button variant="plain" onClick={() => { setStep("idle"); setQrCode(null); setSecret(null); }}>
                {ui.cancel}
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {step === "done" && enabled && (
          <Banner tone="success">
            <Text as="p">{locale === "en" ? "2FA is now active. You will be asked for a code at next login." : locale === "tr" ? "2FA artık aktif. Bir sonraki girişte kod istenecek." : "2FA ist jetzt aktiv. Beim nächsten Login wird ein Code abgefragt."}</Text>
          </Banner>
        )}

        {enabled && step !== "qr" && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text variant="headingSm" as="h3">{locale === "en" ? "Disable 2FA" : locale === "tr" ? "2FA'yı devre dışı bırak" : "2FA deaktivieren"}</Text>
              <Text as="p" tone="subdued">
                {locale === "en" ? "To confirm, enter either your current authenticator code or your password:" : locale === "tr" ? "Onaylamak için mevcut kimlik doğrulayıcı kodunuzu veya şifrenizi girin:" : "Zur Bestätigung geben Sie entweder Ihren aktuellen Authenticator-Code oder Ihr Passwort ein:"}
              </Text>
              <div style={{ maxWidth: 240 }}>
                <TextField
                  label={locale === "en" ? "Current authenticator code" : locale === "tr" ? "Mevcut kimlik doğrulayıcı kodu" : "Aktueller Authenticator-Code"}
                  value={disableCode}
                  onChange={setDisableCode}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                />
              </div>
              <Text as="p" tone="subdued" variant="bodySm">{locale === "en" ? "or" : locale === "tr" ? "veya" : "oder"}</Text>
              <div style={{ maxWidth: 240 }}>
                <TextField
                  label={locale === "en" ? "Your password" : locale === "tr" ? "Şifreniz" : "Ihr Passwort"}
                  type="password"
                  value={disablePassword}
                  onChange={setDisablePassword}
                  autoComplete="current-password"
                />
              </div>
              <InlineStack gap="300">
                <Button tone="critical" onClick={disable2fa} loading={disabling}>
                  {locale === "en" ? "Disable 2FA" : locale === "tr" ? "2FA'yı devre dışı bırak" : "2FA deaktivieren"}
                </Button>
              </InlineStack>
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

export default function SecuritySettingsPage() {
  const locale = useLocale();
  const ui = getUI(locale);

  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const data = await getMedusaAdminClient().getSellerAccount();
      setAccount(data?.user || null);
    } catch (e) {
      setAccount(null);
      setErr(e?.message || (locale === "en" ? "Could not load profile." : locale === "tr" ? "Profil yüklenemedi." : "Profil konnte nicht geladen werden."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const displayName = (() => {
    const fn = (account?.first_name || "").trim();
    const ln = (account?.last_name || "").trim();
    if (fn || ln) return [fn, ln].filter(Boolean).join(" ");
    return (account?.store_name || "").trim() || (account?.email || "").split("@")[0] || "—";
  })();

  const roleLabel = account?.is_superuser
    ? (locale === "en" ? "Platform superuser" : locale === "tr" ? "Platform süper kullanıcısı" : "Plattform-Superuser")
    : account?.is_team_member
      ? (locale === "en" ? "Team access" : locale === "tr" ? "Takım erişimi" : "Team-Zugang")
      : (locale === "en" ? "Seller account" : locale === "tr" ? "Satıcı hesabı" : "Verkäufer-Konto");

  const roleTone = account?.is_superuser ? "info" : account?.is_team_member ? "attention" : "success";

  const submitPassword = async (e) => {
    e.preventDefault();
    setErr("");
    setOk("");
    if (newPw !== confirmPw) {
      setErr(locale === "en" ? "The new passwords do not match." : locale === "tr" ? "Yeni şifreler eşleşmiyor." : "Die neuen Passwörter stimmen nicht überein.");
      return;
    }
    if (newPw.length < 8 || !/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
      setErr(locale === "en" ? "New password must be at least 8 characters and contain a letter and a number." : locale === "tr" ? "Yeni şifre en az 8 karakter, bir harf ve bir rakam içermelidir." : "Neues Passwort muss mindestens 8 Zeichen, einen Buchstaben und eine Zahl enthalten.");
      return;
    }
    setSaving(true);
    try {
      await getMedusaAdminClient().changeSellerPassword({
        current_password: currentPw,
        new_password: newPw,
      });
      setOk(locale === "en" ? "Password changed." : locale === "tr" ? "Şifre değiştirildi." : "Passwort wurde geändert.");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (e) {
      setErr(e?.message || (locale === "en" ? "Could not change password." : locale === "tr" ? "Şifre değiştirilemedi." : "Passwort konnte nicht geändert werden."));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <Box padding="400">
          <Text as="p" tone="subdued">
            {locale === "en" ? "Loading security settings…" : locale === "tr" ? "Güvenlik ayarları yükleniyor…" : "Sicherheitseinstellungen werden geladen…"}
          </Text>
        </Box>
      </Card>
    );
  }

  return (
    <BlockStack gap="500">
      <Text as="p" tone="subdued">
        {locale === "en"
          ? "These details and password apply only to your own login account — not to other users of your seller profile."
          : locale === "tr"
          ? "Bu bilgiler ve şifre yalnızca kendi giriş hesabınız için geçerlidir — satıcı profilinizin diğer kullanıcıları için değil."
          : "Diese Angaben und das Passwort gelten nur für Ihr eigenes Anmeldekonto — nicht für andere Benutzer Ihres Verkäuferprofils."}
      </Text>

      {err ? (
        <Banner tone="critical" onDismiss={() => setErr("")}>
          <Text as="p">{err}</Text>
        </Banner>
      ) : null}
      {ok ? (
        <Banner tone="success" onDismiss={() => setOk("")}>
          <Text as="p">{ok}</Text>
        </Banner>
      ) : null}

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text variant="headingMd" as="h2">
              {locale === "en" ? "Your account" : locale === "tr" ? "Hesabınız" : "Ihr Konto"}
            </Text>
            <Badge tone={roleTone}>{roleLabel}</Badge>
          </InlineStack>
          <Divider />
          <BlockStack gap="200">
            <div>
              <Text variant="bodySm" tone="subdued">
                {locale === "en" ? "Name" : locale === "tr" ? "Ad" : "Name"}
              </Text>
              <Text variant="bodyMd" as="p" fontWeight="semibold">
                {displayName}
              </Text>
            </div>
            <div>
              <Text variant="bodySm" tone="subdued">
                {locale === "en" ? "Email (login)" : locale === "tr" ? "E-posta (giriş)" : "E-Mail (Anmeldung)"}
              </Text>
              <Text variant="bodyMd" as="p" fontWeight="semibold">
                {account?.email || "—"}
              </Text>
            </div>
            {account?.store_name ? (
              <div>
                <Text variant="bodySm" tone="subdued">
                  {locale === "en" ? "Shop / Display name" : locale === "tr" ? "Mağaza / Görünen ad" : "Shop / Anzeigename"}
                </Text>
                <Text variant="bodyMd" as="p">
                  {account.store_name}
                </Text>
              </div>
            ) : null}
            <div>
              <Text variant="bodySm" tone="subdued">
                {locale === "en" ? "Seller ID" : locale === "tr" ? "Satıcı kimliği" : "Verkäufer-ID"}
              </Text>
              <Text variant="bodyMd" as="p">
                <span style={{ fontFamily: "monospace", fontSize: 13 }}>{account?.seller_id || "—"}</span>
              </Text>
            </div>
            <div>
              <Text variant="bodySm" tone="subdued">
                {locale === "en" ? "Account since" : locale === "tr" ? "Hesap tarihi" : "Konto seit"}
              </Text>
              <Text variant="bodyMd" as="p">
                {formatJoined(account?.created_at, locale)}
              </Text>
            </div>
          </BlockStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text variant="headingMd" as="h2">
            {locale === "en" ? "Change password" : locale === "tr" ? "Şifre değiştir" : "Passwort ändern"}
          </Text>
          <Text as="p" tone="subdued">
            {locale === "en" ? "Choose a secure password that you do not use anywhere else." : locale === "tr" ? "Başka hiçbir yerde kullanmadığınız güvenli bir şifre seçin." : "Wählen Sie ein sicheres Passwort, das Sie nirgendwo woanders verwenden."}
          </Text>
          <form onSubmit={submitPassword}>
            <BlockStack gap="300">
              <TextField
                label={locale === "en" ? "Current password" : locale === "tr" ? "Mevcut şifre" : "Aktuelles Passwort"}
                type="password"
                value={currentPw}
                onChange={setCurrentPw}
                autoComplete="current-password"
              />
              <TextField
                label={locale === "en" ? "New password" : locale === "tr" ? "Yeni şifre" : "Neues Passwort"}
                type={showNewPw ? "text" : "password"}
                value={newPw}
                onChange={setNewPw}
                autoComplete="new-password"
                helpText={locale === "en" ? "At least 8 characters, one letter and one number" : locale === "tr" ? "En az 8 karakter, bir harf ve bir rakam" : "Mindestens 8 Zeichen, ein Buchstabe und eine Zahl"}
                suffix={
                  <Button variant="plain" size="slim" onClick={() => setShowNewPw((v) => !v)}>
                    {showNewPw ? (locale === "en" ? "Hide" : locale === "tr" ? "Gizle" : "Verbergen") : (locale === "en" ? "Show" : locale === "tr" ? "Göster" : "Anzeigen")}
                  </Button>
                }
              />
              <TextField
                label={locale === "en" ? "Confirm new password" : locale === "tr" ? "Yeni şifreyi onayla" : "Neues Passwort bestätigen"}
                type={showConfirmPw ? "text" : "password"}
                value={confirmPw}
                onChange={setConfirmPw}
                autoComplete="new-password"
                suffix={
                  <Button variant="plain" size="slim" onClick={() => setShowConfirmPw((v) => !v)}>
                    {showConfirmPw ? (locale === "en" ? "Hide" : locale === "tr" ? "Gizle" : "Verbergen") : (locale === "en" ? "Show" : locale === "tr" ? "Göster" : "Anzeigen")}
                  </Button>
                }
              />
              <InlineStack gap="300">
                <Button variant="primary" submit loading={saving}>
                  {locale === "en" ? "Save password" : locale === "tr" ? "Şifreyi kaydet" : "Passwort speichern"}
                </Button>
              </InlineStack>
            </BlockStack>
          </form>
        </BlockStack>
      </Card>

      <DevicesCard locale={locale} />

      <TotpSetupCard locale={locale} />
    </BlockStack>
  );
}
