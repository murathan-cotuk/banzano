import { NextResponse } from "next/server";
import { registerStoreApiCache } from "@/lib/store-api-cache-registry";

// Cache branding per seller — short TTL so logo/branding changes appear quickly
const settingsCache = new Map();
const SETTINGS_TTL = 8 * 1000; // 8 seconds

registerStoreApiCache("seller-settings", () => settingsCache.clear());

const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const sellerId = url.searchParams.get("seller_id") || "default";
    const now = Date.now();
    const cached = settingsCache.get(sellerId);
    if (cached && cached.expiresAt > now) {
      return NextResponse.json(cached.data);
    }
    const base = getBackendUrl();
    const r = await fetch(
      `${base}/store/seller-settings?seller_id=${encodeURIComponent(sellerId)}`,
      { cache: "no-store" }
    );
    const data = await r.json().catch(() => ({}));
    const result = {
      store_name: data?.store_name || "",
      free_shipping_threshold_cents: data?.free_shipping_threshold_cents ?? null,
      free_shipping_thresholds: data?.free_shipping_thresholds ?? null,
      shop_logo_url: data?.shop_logo_url || "",
      shop_favicon_url: data?.shop_favicon_url || "",
      sellercentral_logo_url: data?.sellercentral_logo_url || "",
      sellercentral_favicon_url: data?.sellercentral_favicon_url || "",
      shop_logo_height: data?.shop_logo_height != null ? Number(data.shop_logo_height) : 34,
      sellercentral_logo_height: data?.sellercentral_logo_height != null ? Number(data.sellercentral_logo_height) : 30,
      announcement_bar_items: Array.isArray(data?.announcement_bar_items) ? data.announcement_bar_items : [],
      logo_config: data?.logo_config || null,
      enabled_shop_locales: Array.isArray(data?.enabled_shop_locales) ? data.enabled_shop_locales : null,
      maintenance_mode_enabled: data?.maintenance_mode_enabled === true,
      maintenance_mode_image_url: data?.maintenance_mode_image_url || "",
    };
    settingsCache.set(sellerId, { data: result, expiresAt: now + SETTINGS_TTL });
    return NextResponse.json(result, { status: r.ok ? 200 : r.status });
  } catch (e) {
    return NextResponse.json({ store_name: "", shop_logo_url: "", shop_favicon_url: "", sellercentral_logo_url: "", sellercentral_favicon_url: "", shop_logo_height: 34, sellercentral_logo_height: 30 }, { status: 200 });
  }
}

// Preflight for cross-origin cache-bust from sellercentral
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// Called by sellercentral after saving branding to bust the cache
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const sellerId = body?.seller_id || "default";
    settingsCache.delete(sellerId);
    settingsCache.delete("default");
    return NextResponse.json({ ok: true }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch {
    return NextResponse.json({ ok: true }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}

