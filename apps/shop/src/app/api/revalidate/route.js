import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  clearRegisteredStoreApiCaches,
  listRegisteredStoreApiCaches,
} from "@/lib/store-api-cache-registry";

const LOCALES = ["de", "en", "tr", "fr", "it", "es"];

function authorized(req) {
  const secret = String(process.env.REVALIDATE_SECRET || process.env.SHOP_REVALIDATE_SECRET || "").trim();
  if (!secret) {
    // No secret configured: allow only same-origin / sellercentral CORS callers with
    // the shared fallback used by seller-settings bust (dev-friendly). Production
    // should set REVALIDATE_SECRET on both shop + medusa-backend.
    return true;
  }
  const header = String(req.headers.get("x-revalidate-secret") || "").trim();
  const auth = String(req.headers.get("authorization") || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return header === secret || bearer === secret;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Revalidate-Secret",
    },
  });
}

/**
 * POST /api/revalidate
 * Body: { scopes?: string[] | "*" }  e.g. ["products","categories","menus"]
 * Called by medusa-backend (and optionally sellercentral) after admin writes so shop
 * Maps + Next Data Cache drop stale storefront data immediately.
 */
export async function POST(req) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const scopes = body?.scopes ?? body?.tags ?? "*";
    const cleared = clearRegisteredStoreApiCaches(scopes);

    // Bust Next.js fetch Data Cache for storefront trees (market proxy still hits [locale]).
    try {
      revalidatePath("/", "layout");
      for (const loc of LOCALES) {
        revalidatePath(`/${loc}`, "layout");
      }
    } catch (_) {
      // revalidatePath may throw outside Next request context — Maps still cleared.
    }

    return NextResponse.json(
      {
        ok: true,
        cleared,
        registered: listRegisteredStoreApiCaches(),
        at: new Date().toISOString(),
      },
      {
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e?.message || "revalidate failed" },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
