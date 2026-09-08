import { NextResponse } from "next/server";
import { registerStoreApiCache } from "@/lib/store-api-cache-registry";

const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

const menusCache = new Map(); // locale -> { data, expiresAt }
const MENUS_TTL = 15 * 1000;

registerStoreApiCache("menus", () => menusCache.clear());

export async function GET(request) {
  const locale = new URL(request.url).searchParams.get("locale") || "";
  try {
    const skipCache = process.env.NODE_ENV === "development";
    const now = Date.now();
    const cached = menusCache.get(locale);
    if (!skipCache && cached && cached.expiresAt > now) {
      return NextResponse.json(cached.data, {
        headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
      });
    }
    const base = getBackendUrl();
    const qs = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    const res = await fetch(`${base}/store/menus${qs}`, {
      headers: { "Content-Type": "application/json" },
      ...(skipCache ? { cache: "no-store" } : { next: { revalidate: 15 } }),
    });
    if (!res.ok) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          `[shop/api/store-menus] ${res.status} from ${base}/store/menus — sidebar menü boş kalabilir.`,
        );
      }
      return NextResponse.json({ menus: [], count: 0 }, { status: 200 });
    }
    const data = await res.json();
    if (!skipCache) {
      menusCache.set(locale, { data, expiresAt: now + MENUS_TTL });
    }
    return NextResponse.json(
      data,
      skipCache ? undefined : { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" } },
    );
  } catch (e) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[shop/api/store-menus] ${e?.message || e} — backend: ${getBackendUrl()}`);
    }
    return NextResponse.json({ menus: [], count: 0 }, { status: 200 });
  }
}
