import { headers } from "next/headers";
import SeoJsonLd from "@/components/SeoJsonLd";
import { parseProductUrlHandle } from "@/lib/product-url-handle";
import {
  buildPageMetadata,
  buildProductJsonLd,
  fetchStoreCategoryBySlug,
  fetchStoreCollection,
  fetchStorePage,
  fetchStoreProduct,
  localizedCmsField,
  marketFromHeader,
  productHandleForLocale,
  productImageUrls,
  productSeoFallback,
  categorySeoFallback,
  stripHtml,
  absolutePublicUrl,
} from "@/lib/seo";

const RESERVED = new Set([
  "search",
  "login",
  "register",
  "account",
  "bestsellers",
  "recommended",
  "category",
  "pages",
  "collections",
  "produkt",
  "kollektion",
  "product",
  "merkzettel",
  "wishlist",
  "favorites",
  "brand",
  "seller",
  "neuheiten",
  "sales",
  "brands",
  "cart",
  "checkout",
]);

async function resolveHandleEntity(handle, locale) {
  const h = String(handle || "").trim();
  if (!h || RESERVED.has(h.toLowerCase())) return { kind: "none" };

  const parsed = parseProductUrlHandle(h);
  if (parsed.shortCode) {
    const product = await fetchStoreProduct(h);
    if (product?.id) return { kind: "product", product };
  }

  const [category, collection] = await Promise.all([
    fetchStoreCategoryBySlug(h),
    fetchStoreCollection(h),
  ]);
  if (category?.id || category?.slug) {
    return { kind: "category", category };
  }
  if (collection?.id || collection?.handle) {
    return { kind: "collection", collection };
  }

  const page = await fetchStorePage(h);
  if (page?.id) {
    return { kind: "cms", page };
  }

  const product = await fetchStoreProduct(h);
  if (product?.id) {
    return { kind: "product", product };
  }

  return { kind: "none" };
}

export async function generateMetadata({ params }) {
  const { handle, locale } = await params;
  const h = await headers();
  const market = marketFromHeader(h.get("x-andertal-market-prefix"), locale);

  if (!handle || RESERVED.has(String(handle).toLowerCase())) {
    return { title: "Andertal" };
  }

  const entity = await resolveHandleEntity(handle, locale);

  if (entity.kind === "product") {
    const product = entity.product;
    const seo = productSeoFallback(product, locale);
    const title = (seo.title || handle).trim() || "Andertal";
    const description = seo.description || undefined;
    return buildPageMetadata({
      title,
      description,
      market,
      locale,
      pathForLocale: (loc) => productHandleForLocale(product, loc),
      images: productImageUrls(product),
      type: "website",
    });
  }

  if (entity.kind === "collection") {
    const c = entity.collection;
    const title = (c.meta_title || c.display_title || c.title || handle).trim() || "Andertal";
    const description =
      stripHtml(c.meta_description || c.description || c.richtext || "", 160) || undefined;
    return buildPageMetadata({
      title,
      description,
      market,
      locale,
      path: c.handle || handle,
      images: c.banner_image || c.image ? [c.banner_image || c.image] : [],
    });
  }

  if (entity.kind === "category") {
    const c = entity.category;
    const seo = categorySeoFallback(c, locale);
    const m = c.metadata && typeof c.metadata === "object" ? c.metadata : {};
    const seoLoc =
      locale && locale !== "de" && m.seo_i18n && typeof m.seo_i18n === "object"
        ? m.seo_i18n[locale]
        : null;
    const title = (seo.title || handle).trim() || "Andertal";
    const description = seo.description || undefined;
    const keywords =
      (
        (seoLoc && (seoLoc.meta_keywords || seoLoc.keywords)) ||
        m.keywords ||
        m.meta_keywords ||
        ""
      )
        .toString()
        .trim() || undefined;
    const slug = c.slug || handle;
    return buildPageMetadata({
      title,
      description,
      keywords,
      market,
      locale,
      path: slug,
    });
  }

  if (entity.kind === "cms") {
    const page = entity.page;
    const title = (
      localizedCmsField(page, "meta_title", locale) ||
      localizedCmsField(page, "title", locale) ||
      "Andertal"
    ).trim();
    const description =
      localizedCmsField(page, "meta_description", locale) ||
      stripHtml(localizedCmsField(page, "body", locale), 160) ||
      undefined;
    // Prefer /pages/{slug} as the canonical CMS URL (matches sitemap).
    return buildPageMetadata({
      title,
      description,
      market,
      locale,
      path: `pages/${page.slug || handle}`,
    });
  }

  return { title: "Andertal" };
}

export default async function HandleLayout({ children, params }) {
  const { handle, locale } = await params;
  const h = await headers();
  const market = marketFromHeader(h.get("x-andertal-market-prefix"), locale);

  let jsonLd = null;
  if (handle && !RESERVED.has(String(handle).toLowerCase())) {
    const product = await fetchStoreProduct(handle);
    if (product?.id) {
      const meta = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
      const enriched = {
        ...product,
        metadata: {
          ...meta,
          seller_name:
            meta.seller_name ||
            meta.shop_name ||
            meta.store_name ||
            product.store_name ||
            product.seller_store_name,
          brand_name: meta.brand_name || meta.brand,
          review_count: meta.review_count ?? product.review_count,
          review_avg: meta.review_avg ?? product.review_avg ?? product.average_rating,
        },
      };
      const canonicalUrl = absolutePublicUrl(
        market,
        locale,
        productHandleForLocale(enriched, locale),
      );
      jsonLd = buildProductJsonLd(enriched, { locale, market, canonicalUrl });
    }
  }

  return (
    <>
      <SeoJsonLd data={jsonLd} />
      {children}
    </>
  );
}
