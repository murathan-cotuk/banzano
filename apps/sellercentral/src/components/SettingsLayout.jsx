"use client";

import React, { useEffect, useState } from "react";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { getUI } from "@/lib/ui-strings";

/* ── Icons (inline SVG, no extra dep) ─────────────────────────────── */
const Icon = ({ d, size = 16, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d={d} fill={color} fillRule="evenodd" clipRule="evenodd" />
  </svg>
);

const ICONS = {
  general:      "M10 2a8 8 0 100 16A8 8 0 0010 2zm0 3a1 1 0 110 2 1 1 0 010-2zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V10a1 1 0 011-1z",
  verification: "M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z",
  billing:      "M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4zm14 5H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM7 13a1 1 0 100-2 1 1 0 000 2zm3-1a1 1 0 112 0 1 1 0 01-2 0z",
  users:        "M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z",
  payments:     "M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4zm14 5H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM7 13a1 1 0 100-2 1 1 0 000 2z",
  security:     "M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z",
  checkout:     "M3 1a1 1 0 000 2h1.22l.305 1.222a.997.997 0 00.01.042l1.358 5.43-.893.892C4.77 11.155 5.5 13 7 13h9a1 1 0 100-2H7l1-1h7.5a1 1 0 00.894-.553l2-4a1 1 0 00-.894-1.447H7.764l-.37-1.48A1 1 0 006.433 3H3zm9 13.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm3.5 1.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  shipping:     "M8 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM15 16.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM3 4a1 1 0 00-1 1v7a1 1 0 001 1h.07A1.5 1.5 0 016 12.07V13h5v-.07A1.5 1.5 0 0113 11.93V11h1.268a1 1 0 00.894-.553l1.5-3A1 1 0 0015.768 6H13V5a1 1 0 00-1-1H3z",
  integrations: "M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM6.343 5.657a1 1 0 00-1.414-1.414L3.515 5.657a1 1 0 001.414 1.414l1.414-1.414zM14.071 4.243a1 1 0 00-1.414 1.414l1.414 1.414a1 1 0 001.414-1.414l-1.414-1.414zM4 10a1 1 0 01-1 1H2a1 1 0 110-2h1a1 1 0 011 1zm15 0a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zm-8.071 4.071a1 1 0 00-1.414 1.414l1.414 1.414a1 1 0 001.414-1.414l-1.414-1.414zM5.757 14.243a1 1 0 00-1.414-1.414L2.929 14.243a1 1 0 101.414 1.414l1.414-1.414zM10 14a4 4 0 100-8 4 4 0 000 8z",
  taxes:        "M9 2a1 1 0 000 2h2a1 1 0 100-2H9zM4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z",
  dac7:         "M9 2a1 1 0 000 2h2a1 1 0 100-2H9zM4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm5 5a1 1 0 011 1v3a1 1 0 11-2 0v-3a1 1 0 011-1z",
  locations:    "M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z",
  notifications:"M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z",
  bonus:        "M10 2a1 1 0 01.894.553l1.545 3.09 3.41.495a1 1 0 01.554 1.706l-2.468 2.406.583 3.397a1 1 0 01-1.451 1.054L10 13.09l-3.067 1.611a1 1 0 01-1.451-1.054l.583-3.397-2.468-2.406a1 1 0 01.554-1.706l3.41-.495 1.545-3.09A1 1 0 0110 2z",
};

export default function SettingsLayout({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const ui = getUI(locale);
  const [isSuperuser, setIsSuperuser] = useState(false);

  useEffect(() => {
    setIsSuperuser(
      typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true",
    );
  }, []);

  // Build groups dynamically using ui strings so they update on locale change
  const GROUPS = [
    {
      label: ui.settingsGroupAccount,
      items: [
        { href: "/settings/general",          label: ui.settingsGeneral,       icon: "general" },
        { href: "/settings/verification",      label: ui.settingsVerification,  icon: "verification", sellerOnly: true },
        { href: "/settings/billing",           label: ui.settingsBilling,       icon: "billing" },
        { href: "/settings/security",          label: ui.settingsSecurity,      icon: "security" },
      ],
    },
    {
      label: ui.settingsGroupTeam,
      items: [
        { href: "/settings/users-permissions", label: ui.settingsUsers,         icon: "users" },
      ],
    },
    {
      label: ui.settingsGroupShop,
      items: [
        { href: "/settings/payments",          label: ui.settingsPayments,      icon: "payments" },
        { href: "/settings/checkout",          label: ui.settingsCheckout,      icon: "checkout",     superuserOnly: true },
        { href: "/settings/shipping",          label: ui.settingsShipping,      icon: "shipping" },
        { href: "/settings/locations",         label: ui.settingsLocations,     icon: "locations" },
      ],
    },
    {
      label: ui.settingsGroupSystem,
      items: [
        { href: "/settings/integrations",      label: ui.settingsIntegrations,  icon: "integrations" },
        { href: "/notifications",               label: ui.settingsNotifications, icon: "notifications" },
        { href: "/settings/dac7",              label: "DAC7 / PStTG",           icon: "dac7", superuserOnly: true },
        { href: "/settings/bonus-points",      label: "Bonus puan takibi",      icon: "bonus", superuserOnly: true },
      ],
    },
  ];

  const currentPath = String(pathname || "");
  const isActive = (href) => !!(href && (currentPath === href || currentPath.endsWith(href)));

  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => {
      if (item.superuserOnly && !isSuperuser) return false;
      if (item.sellerOnly && isSuperuser) return false;
      return true;
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Back button */}
      <div style={{ padding: "16px 0 12px" }}>
        <button
          onClick={() => router.push("/")}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: "none", border: "none", cursor: "pointer",
            fontSize: 13, color: "#6b7280", fontWeight: 500, padding: "4px 0",
          }}
        >
          <svg width={16} height={16} viewBox="0 0 20 20" fill="none">
            <path d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" fill="currentColor" />
          </svg>
          {ui.settingsBack}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24, alignItems: "start" }}>

        {/* ── Sidebar ─────────────────────────────────────────────── */}
        <div style={{ position: "sticky", top: 20 }}>
          {/* Header */}
          <div style={{
            background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
            borderRadius: "14px 14px 0 0",
            padding: "20px 20px 18px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "rgba(255,255,255,0.12)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width={18} height={18} viewBox="0 0 20 20" fill="none">
                <path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z" fill="white" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em" }}>{ui.settingsTitle}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>{ui.settingsSubtitle}</div>
            </div>
          </div>

          {/* Nav groups */}
          <div style={{
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderTop: "none",
            borderRadius: "0 0 14px 14px",
            overflow: "hidden",
            boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
          }}>
            {visibleGroups.map((group, gi) => (
              <div key={group.label}>
                {gi > 0 && <div style={{ height: 1, background: "#f1f5f9", margin: "0 16px" }} />}
                {/* Group label */}
                <div style={{ padding: "12px 20px 4px", fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  {group.label}
                </div>
                {/* Items */}
                {group.items.map((item) => {
                  const active = isActive(item.href);
                  const isSU = item.superuserOnly;
                  const accentColor = isSU ? "#dc2626" : "#008060";
                  return (
                    <Link key={item.href} href={item.href} style={{ textDecoration: "none", display: "block" }}>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "9px 20px 9px 16px",
                        margin: "2px 8px",
                        borderRadius: 8,
                        background: active ? (isSU ? "rgba(220,38,38,0.08)" : "rgba(0,128,96,0.08)") : "transparent",
                        borderLeft: active ? `3px solid ${accentColor}` : "3px solid transparent",
                        transition: "all 0.15s ease",
                        cursor: "pointer",
                      }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#f8fafc"; }}
                        onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                      >
                        {/* Icon */}
                        <div style={{
                          width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                          background: active ? (isSU ? "rgba(220,38,38,0.12)" : "rgba(0,128,96,0.1)") : (isSU ? "rgba(220,38,38,0.08)" : "#f1f5f9"),
                          display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "all 0.15s",
                        }}>
                          <Icon
                            d={ICONS[item.icon] || ICONS.general}
                            size={14}
                            color={active ? accentColor : (isSU ? "#dc2626" : "#64748b")}
                          />
                        </div>
                        {/* Label */}
                        <span style={{
                          fontSize: 13,
                          fontWeight: active ? 600 : 400,
                          color: active ? (isSU ? "#991b1b" : "#065f46") : (isSU ? "#dc2626" : "#374151"),
                          flex: 1,
                          letterSpacing: active ? "-0.01em" : "normal",
                        }}>
                          {item.label}
                        </span>
                        {/* Active dot */}
                        {active && (
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: accentColor, flexShrink: 0 }} />
                        )}
                      </div>
                    </Link>
                  );
                })}
                {gi === visibleGroups.length - 1 && <div style={{ height: 10 }} />}
              </div>
            ))}
          </div>
        </div>

        {/* ── Content ─────────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
