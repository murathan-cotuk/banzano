import { NextResponse } from "next/server";
import { registerStoreApiCache } from "@/lib/store-api-cache-registry";

const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

// Cache approved seller IDs — changes rarely, no need to re-fetch every product request
const approvedCache = { ids: null, expiresAt: 0 };
const APPROVED_TTL = 60 * 1000; // 1 minute (also cleared via /api/revalidate)

registerStoreApiCache("products", () => {
  approvedCache.ids = null;
  approvedCache.expiresAt = 0;
});

async function getApprovedSellerIds(base) {
  const now = Date.now();
  if (approvedCache.ids && approvedCache.expiresAt > now) return approvedCache.ids;
  try {
    const res = await fetch(`${base}/store/approved-seller-ids`, { next: { revalidate: 60 } });
    if (!res.ok) throw new Error("not ok");
    const data = await res.json();
    const ids = new Set((data?.seller_ids || []).map((s) => String(s || "").trim()).filter(Boolean));
    approvedCache.ids = ids;
    approvedCache.expiresAt = now + APPROVED_TTL;
    return ids;
  } catch {
    return approvedCache.ids || new Set();
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const qs = searchParams.toString();
    const base = getBackendUrl();
    const url = qs ? `${base}/store/products?${qs}` : `${base}/store/products`;
    // Fetch products and approved seller IDs in parallel
    const [res, approved] = await Promise.all([
      fetch(url, { headers: { "Content-Type": "application/json" }, next: { revalidate: 15 } }),
      getApprovedSellerIds(base),
    ]);
    if (!res.ok) return NextResponse.json({ products: [], count: 0 }, { status: 200 });
    const data = await res.json();
    const list = Array.isArray(data?.products) ? data.products : [];
    const filtered = approved.size === 0 ? list : list.filter((p) => {
      const sid = String(p?.seller_id || "").trim();
      if (!sid || sid === "default") return true;
      return approved.has(sid);
    });
    return NextResponse.json(
      { ...data, products: filtered, count: filtered.length },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=180" } },
    );
  } catch {
    return NextResponse.json({ products: [], count: 0 }, { status: 200 });
  }
}
