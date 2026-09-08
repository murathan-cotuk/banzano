import { NextResponse } from "next/server";
import { parseProductUrlHandle } from "@/lib/product-url-handle";

const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

async function fetchFromBackend(base, handle) {
  const res = await fetch(`${base}/store/products/${encodeURIComponent(handle)}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  return res;
}

export async function GET(request, context) {
  const params = await Promise.resolve(context.params || {});
  const handle = params.handle;
  if (!handle) {
    return NextResponse.json({ product: null }, { status: 400 });
  }
  try {
    const base = getBackendUrl();
    const parsed = parseProductUrlHandle(handle);
    let res = await fetchFromBackend(base, handle);

    // If not found, try stripping the 8-char short-code suffix (legacy backends).
    if (res.status === 404 && parsed.base && parsed.base !== handle) {
      res = await fetchFromBackend(base, parsed.base);
    }

    if (res.status === 404) {
      return NextResponse.json({ product: null }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json({ product: null }, { status: res.status });
    }
    const data = await res.json();
    const product = data?.product || null;
    const sid = String(product?.seller_id || "").trim();
    if (sid && sid !== "default") {
      const approvedRes = await fetch(`${base}/store/approved-seller-ids`, { cache: "no-store" }).catch(() => null);
      const approvedData = approvedRes && approvedRes.ok ? await approvedRes.json().catch(() => ({ seller_ids: [] })) : { seller_ids: [] };
      const approved = new Set((approvedData?.seller_ids || []).map((s) => String(s || "").trim()).filter(Boolean));
      if (!approved.has(sid)) {
        return NextResponse.json({ product: null }, { status: 404 });
      }
    }
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ product: null }, { status: 500 });
  }
}
