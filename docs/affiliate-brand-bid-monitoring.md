# Affiliate brand-bid monitoring (manual process)

docs/affiliate.md's fraud-detection section lists "brand bidding" (an affiliate running paid
search ads on Andertal's own brand terms, pocketing traffic that would have converted for free)
as a violation to watch for. There is no Google/Bing Ads API integration in this codebase, so this
is not automated — it's a periodic manual check a superuser runs and logs in SellerCentral.

## Who / how often

A superuser, roughly every 2–4 weeks (more often around promo periods, when brand-bidding payoffs
are highest for a bad-faith affiliate).

## What to check

1. Search the brand's own name and close variants on Google and Bing, from a logged-out / private
   browsing window (so results aren't personalized by your own account history):
   - `andertal`
   - `andertal shop` / `andertal kaufen` / `andertal gutschein` / `andertal rabatt`
   - `andertal coupon` / `andertal discount code`
2. Look at the paid ad slots (top of results, marked "Anzeige" / "Ad" / "Sponsored") — not the
   organic results.
3. For any paid ad that isn't Andertal's own (check the display URL / advertiser name), click
   through **once** and check the landing URL:
   - If it redirects through `/r/<code>` or lands with a `?ref=AFF_...` query param, that's an
     affiliate driving paid traffic on the brand name.
4. Note the affiliate code from the `ref`/`r/` URL. If you can't tell which affiliate it is from
   the URL alone, look it up in SellerCentral → Marketing → **Affiliate admin** → search the code
   against the active affiliate list, or ask engineering to check `affiliate_links.short_code`.

## What to do if you find one

Most affiliate programs (and this one, per docs/affiliate.md) prohibit bidding on the brand's own
trademarked terms in paid search — it's traffic the brand would have gotten for free, now paid for
twice. If you find a live example:

1. Screenshot the ad (advertiser name, ad copy, display URL) and the landing page before it
   disappears — ad rotations can hide it minutes later.
2. Go to SellerCentral → Marketing → **Affiliate admin** → **Fraud queue** tab → use the
   "Log a manual monitoring finding" form:
   - Affiliate code: the code you found.
   - Type: **Brand-bid (paid search)**.
   - Severity: typically **high** for a confirmed live ad; **medium** if you're not fully certain
     it's the same affiliate; **low** for a borderline case (e.g. a generic "coupon site" ad that
     happens to also carry your ref param, not clearly bidding on your exact brand term).
   - Notes: paste the search term used, ad copy, and landing URL.
3. Submitting the form creates an `affiliate_fraud_flags` row (`flag_type = 'brand_bid'`) exactly
   like an automated check would — it feeds the same auto-suspend threshold
   (`FRAUD_FLAGS_AUTO_SUSPEND_THRESHOLD` in `affiliate-platform/config.js`) as the self-referral
   check, and shows up for any other superuser reviewing the fraud queue.
4. From the fraud queue you can resolve / suspend / ban directly once you (or another superuser)
   have made a decision — this is a manual judgment call, not an auto-ban, since a single ad
   sighting can sometimes be a network mistargeting issue rather than deliberate brand-bidding.

## Why this isn't automated

Automating this would mean querying Google/Bing Ads directly (their own advertiser data, not
public) or scraping search result pages, which either requires API access this project doesn't
have or risks violating those platforms' terms of service. A short manual search is the practical,
low-effort substitute until/unless the business decides to invest in a real ad-intelligence tool
(e.g. SEMrush/SpyFu-style API) — at which point this doc should be replaced with an automated
worker that posts findings through the same `POST /admin-hub/v1/affiliate-admin/fraud` endpoint.
