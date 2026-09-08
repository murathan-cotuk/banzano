"use client";

import React from "react";
import { Link } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineGrid,
  Icon,
} from "@shopify/polaris";
import { ProfileIcon, CreditCardIcon, NotificationIcon, LockIcon, ReceiptIcon } from "@shopify/polaris-icons";
import { lt } from "@/lib/locale-text";

export default function SettingsPage() {
  const locale = useLocale();
  const t = (en, tr, fr, es, it, de) => lt(locale, en, tr, fr, es, it, de);
  const settingsItems = [
    { href: "/settings/account", icon: ProfileIcon, title: t("Account", "Hesap", "Compte", "Cuenta", "Account", "Konto"), description: t("Manage your account and preferences", "Hesabinizi ve tercihlerinizi yonetin", "Gerez votre compte et vos preferences", "Gestiona tu cuenta y preferencias", "Gestisci account e preferenze", "Konto und Einstellungen verwalten") },
    { href: "/settings/payments", icon: CreditCardIcon, title: t("Payments & IBAN", "Odeme ve IBAN", "Paiements et IBAN", "Pagos e IBAN", "Pagamenti e IBAN", "Zahlungen & IBAN"), description: t("IBAN for payouts and transaction overview", "Odeme IBAN bilgisi ve islem ozeti", "IBAN pour les paiements et apercu des transactions", "IBAN para pagos y resumen de transacciones", "IBAN per pagamenti e panoramica transazioni", "IBAN fur Auszahlungen und Transaktionsubersicht") },
    { href: "/settings/users-permissions", icon: ProfileIcon, title: t("Users & permissions", "Kullanicilar ve yetkiler", "Utilisateurs et permissions", "Usuarios y permisos", "Utenti e permessi", "Benutzer und Rechte"), description: t("Invite and manage seller accounts", "Satici hesaplarini davet edin ve yonetin", "Inviter et gerer les comptes vendeurs", "Invitar y gestionar cuentas de vendedor", "Invita e gestisci account venditore", "Seller-Konten einladen und verwalten") },
    { href: "/settings/notifications", icon: NotificationIcon, title: t("Notifications", "Bildirimler", "Notifications", "Notificaciones", "Notifiche", "Benachrichtigungen"), description: t("Configure notification preferences", "Bildirim tercihlerini ayarlayin", "Configurer les preferences de notification", "Configura las preferencias de notificacion", "Configura le preferenze di notifica", "Benachrichtigungseinstellungen konfigurieren") },
    { href: "/settings/security", icon: LockIcon, title: t("Security", "Guvenlik", "Securite", "Seguridad", "Sicurezza", "Sicherheit"), description: t("Password and security settings", "Sifre ve guvenlik ayarlari", "Parametres de mot de passe et securite", "Configuracion de contrasena y seguridad", "Impostazioni password e sicurezza", "Passwort- und Sicherheitseinstellungen") },
    { href: "/settings/billing", icon: ReceiptIcon, title: t("Billing", "Faturalandirma", "Facturation", "Facturacion", "Fatturazione", "Abrechnung"), description: t("Invoices and billing history", "Faturalar ve gecmis", "Factures et historique de facturation", "Facturas e historial de cobro", "Fatture e storico addebiti", "Rechnungen und Abrechnungshistorie") },
  ];
  return (
    <Page
      title={t("Settings", "Ayarlar", "Parametres", "Configuracion", "Impostazioni", "Einstellungen")}
      subtitle={t("Manage your account settings and preferences", "Hesap ayarlarinizi ve tercihlerinizi yonetin", "Gerez les parametres et preferences de votre compte", "Gestiona los ajustes y preferencias de tu cuenta", "Gestisci impostazioni e preferenze del tuo account", "Verwalten Sie Ihre Konto-Einstellungen und Prferenzen")}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {t("General settings", "Genel ayarlar", "Parametres generaux", "Ajustes generales", "Impostazioni generali", "Allgemeine Einstellungen")}
              </Text>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                {settingsItems.map((item) => (
                  <Link key={item.href} href={item.href} style={{ textDecoration: "none", color: "inherit" }}>
                    <Card padding="400">
                      <BlockStack gap="300">
                        <Icon source={item.icon} tone="base" />
                        <Text as="h3" variant="headingSm">
                          {item.title}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {item.description}
                        </Text>
                      </BlockStack>
                    </Card>
                  </Link>
                ))}
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
