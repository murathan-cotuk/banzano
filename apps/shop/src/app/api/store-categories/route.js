import { NextResponse } from "next/server";
import { registerStoreApiCache } from "@/lib/store-api-cache-registry";

const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

const categoriesCache = new Map();
/** Keep short — admin writes also POST /api/revalidate to clear this Map immediately. */
const CACHE_TTL_MS = 15 * 1000;

registerStoreApiCache("categories", () => categoriesCache.clear());

function emptyCategoriesResponse() {
  return NextResponse.json({ categories: [], tree: [], count: 0 }, { status: 200 });
}

export async function GET(request) {
  const base = getBackendUrl();
  const isDev = process.env.NODE_ENV === "development";

  try {
    const { searchParams } = new URL(request.url);
    const qs = searchParams.toString();
    /* `locale` is sent for future auto-translated names but the backend (api/store/categories/
       route.ts, tree AND slug branches) never reads it today — content is identical regardless
       of locale. Drop it from the cache key (not from the outbound request) so requests for the
       same tree/slug from different locale pages share one cache entry instead of fragmenting
       into up to 6 (one per locale), each a separate round trip to the — now Redis-shared —
       backend cache. */
    const cacheKeyParams = new URLSearchParams(searchParams);
    cacheKeyParams.delete("locale");
    const cacheKey = cacheKeyParams.toString() || "__root__";
    const now = Date.now();

    /* Dev: bypass cache — easier to spot after starting medusa or fixing DATABASE_URL */
    if (!isDev) {
      const cached = categoriesCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return NextResponse.json(cached.data, {
          headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
        });
      }
    }

    const fetchOpts =
      isDev
        ? { cache: "no-store" }
        : { next: { revalidate: 15 } };

    const res = await fetch(`${base}/store/categories${qs ? `?${qs}` : ""}`, {
      headers: { "Content-Type": "application/json" },
      ...fetchOpts,
    });

    if (!res.ok) {
      if (isDev) {
        console.warn(
          `\n[shop/api/store-categories] Backend answered ${res.status} for GET ${base}/store/categories\n` +
          "  → Kategoriler sessizce boş döner (sidebar/menu boş). Kontrol:\n" +
          "  • apps/medusa-backend çalışıyor mu? (genelde localhost:9000)\n" +
          "  • apps/shop/.env.local içinde NEXT_PUBLIC_MEDUSA_BACKEND_URL doğru mu?\n",
        );
      }
      return emptyCategoriesResponse();
    }

    const data = await res.json();
    const treeLen = Array.isArray(data?.tree) ? data.tree.length : 0;
    const count = typeof data?.count === "number" ? data.count : treeLen;

    if (isDev && count === 0 && treeLen === 0) {
      console.warn(
        `[shop/api/store-categories] Backend OK ama tree boş (count=${count}). ` +
        "Yerel Postgres’te admin_hub_categories ve yayınlı ürün/kategori bağları var mı?",
      );
    }

    if (!isDev) {
      categoriesCache.set(cacheKey, { data, expiresAt: now + CACHE_TTL_MS });
    }
    return NextResponse.json(
      data,
      isDev ? undefined : { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" } },
    );
  } catch (e) {
    if (isDev) {
      const msg = e?.code === "ECONNREFUSED" || /fetch failed/i.test(String(e?.message || ""))
        ? "Bağlantı reddedildi (Medusa kapalı olabilir)"
        : (e?.message || e);
      console.warn(
        `\n[shop/api/store-categories] ${msg}\n` +
        `  Hedef backend: ${base}\n` +
        "  Medusa’yı başlatın: apps/medusa-backend → npm komutu (çoğu kurulumda port 9000).\n",
      );
    }
    return emptyCategoriesResponse();
  }
}
