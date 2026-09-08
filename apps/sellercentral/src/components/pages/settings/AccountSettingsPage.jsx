"use client";

import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Select,
  Button,
  Banner,
  InlineStack,
} from "@shopify/polaris";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { getUI } from "@/lib/ui-strings";

const LOCALE_OPTIONS = [
  { label: "Deutsch", value: "de" },
  { label: "English", value: "en" },
  { label: "Türkçe", value: "tr" },
  { label: "Français", value: "fr" },
  { label: "Italiano", value: "it" },
  { label: "Español", value: "es" },
];

export default function AccountSettingsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale();
  const ui = getUI(currentLocale);

  const [locale, setLocale] = useState("de");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [initial, setInitial] = useState("de");

  useEffect(() => {
    // Derive current locale from URL prefix
    const seg = pathname?.split("/")?.[1];
    const match = LOCALE_OPTIONS.find((o) => o.value === seg);
    const cur = match ? seg : "de";
    setLocale(cur);
    setInitial(cur);
    // Persist to localStorage so other components can read it
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem("sellerLocale");
      if (stored && LOCALE_OPTIONS.some((o) => o.value === stored)) {
        setLocale(stored);
        setInitial(stored);
      }
    }
  }, [pathname]);

  const handleLocaleChange = (v) => {
    setLocale(v);
    setDirty(v !== initial);
    setSaved(false);
  };

  const save = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("sellerLocale", locale);
    }
    setInitial(locale);
    setDirty(false);
    setSaved(true);

    // Navigate to same page with new locale
    const segments = pathname?.split("/") || [];
    if (segments[1] && LOCALE_OPTIONS.some((o) => o.value === segments[1])) {
      segments[1] = locale;
    }
    router.push(segments.join("/") || `/${locale}/settings/account`);
  };

  const discard = () => {
    setLocale(initial);
    setDirty(false);
    setSaved(false);
  };

  const pageTitle = currentLocale === "en" ? "Account Settings" : currentLocale === "tr" ? "Hesap Ayarları" : "Konto-Einstellungen";
  const pageDesc = currentLocale === "en" ? "Personal settings for your Sellercentral account." : currentLocale === "tr" ? "Sellercentral hesabınız için kişisel ayarlar." : "Persönliche Einstellungen für Ihren Sellercentral-Account.";
  const savedMsg = currentLocale === "en" ? "Settings saved." : currentLocale === "tr" ? "Ayarlar kaydedildi." : "Einstellungen gespeichert.";
  const uiLangTitle = currentLocale === "en" ? "Interface language" : currentLocale === "tr" ? "Arayüz dili" : "Sprache der Benutzeroberfläche";
  const uiLangDesc = currentLocale === "en" ? "Choose the language in which Sellercentral should be displayed. The change takes effect immediately after saving." : currentLocale === "tr" ? "Sellercentral'ın hangi dilde görüntüleneceğini seçin. Değişiklik kaydetme sonrasında hemen geçerli olur." : "Wählen Sie die Sprache, in der Sellercentral angezeigt werden soll. Die Änderung tritt nach dem Speichern sofort in Kraft.";
  const langLabel = currentLocale === "en" ? "Language" : currentLocale === "tr" ? "Dil" : "Sprache";
  const discardLabel = currentLocale === "en" ? "Discard" : currentLocale === "tr" ? "Vazgeç" : "Verwerfen";

  return (
    <Page title={pageTitle}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              {pageDesc}
            </Text>

            {saved && (
              <Banner tone="success" onDismiss={() => setSaved(false)}>
                <Text as="p">{savedMsg}</Text>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  {uiLangTitle}
                </Text>
                <Text as="p" tone="subdued">
                  {uiLangDesc}
                </Text>
                <div style={{ maxWidth: 280 }}>
                  <Select
                    label={langLabel}
                    options={LOCALE_OPTIONS}
                    value={locale}
                    onChange={handleLocaleChange}
                  />
                </div>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={save} disabled={!dirty}>
                    {ui.save}
                  </Button>
                  {dirty && (
                    <Button variant="plain" onClick={discard}>
                      {discardLabel}
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
