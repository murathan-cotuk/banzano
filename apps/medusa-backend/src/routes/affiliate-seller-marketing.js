'use strict'

/**
 * SellerCentral /marketing/affiliate — read-only summary for the LOGGED-IN seller
 * (docs/affiliate.md PR 5). No enrollment, no "add product to affiliate program": every seller's
 * catalog is already linkable by any affiliate (Model 2), so there's nothing to opt into and
 * nothing to manage here — just visibility into what's happening.
 *
 * Mounted under /admin-hub, so server.js's existing ADMIN_HUB_PUBLIC_PATTERNS gatekeeper already
 * requires a seller bearer token for it — no auth middleware needed in this file.
 */
const { Router } = require('express')
const { ensureAffiliateTables } = require('../modules/affiliate-platform/schema')

const getDbClient = () => require('../db-pool').getPooledClient()

module.exports = function createAffiliateSellerMarketingRouter() {
  const router = Router()

  router.get('/admin-hub/v1/affiliate-marketing/summary', async (req, res) => {
    const sellerId = req.sellerUser?.seller_id
    if (!sellerId) return res.status(403).json({ message: 'Seller account required' })

    const client = getDbClient()
    if (!client) return res.status(503).json({ message: 'Database unavailable' })
    try {
      await client.connect()
      await ensureAffiliateTables(client)

      const productsRes = await client.query(
        `SELECT p.id, p.title, p.handle, p.sku,
                COALESCE(clicks.n, 0)::int AS clicks_30d,
                COALESCE(sales.n, 0)::int AS attributed_sales_30d
           FROM admin_hub_products p
           LEFT JOIN (
             SELECT l.product_id, COUNT(*) AS n
               FROM affiliate_clicks c
               JOIN affiliate_links l ON l.id = c.link_id
              WHERE l.type = 'product' AND c.clicked_at >= now() - interval '30 days'
              GROUP BY l.product_id
           ) clicks ON clicks.product_id = p.id
           LEFT JOIN (
             SELECT product_id, COUNT(*) AS n
               FROM affiliate_commissions
              WHERE source_type = 'product_sale' AND earned_at >= now() - interval '30 days'
              GROUP BY product_id
           ) sales ON sales.product_id = p.id
          WHERE p.seller_id = $1
            AND (COALESCE(clicks.n, 0) > 0 OR COALESCE(sales.n, 0) > 0)
          ORDER BY clicks_30d DESC, attributed_sales_30d DESC
          LIMIT 200`,
        [sellerId],
      )

      const totalsRes = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM affiliate_clicks c JOIN affiliate_links l ON l.id = c.link_id
             WHERE l.type = 'product' AND l.product_id IN (SELECT id FROM admin_hub_products WHERE seller_id = $1)
               AND c.clicked_at >= now() - interval '30 days')::int AS clicks_30d,
           (SELECT COUNT(*) FROM affiliate_commissions
             WHERE seller_id = $1 AND source_type = 'product_sale' AND earned_at >= now() - interval '30 days')::int AS attributed_sales_30d,
           (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_commissions
             WHERE seller_id = $1 AND source_type = 'product_sale' AND earned_at >= now() - interval '30 days')::int AS commission_paid_by_platform_cents_30d
        `,
        [sellerId],
      )

      res.json({
        products: productsRes.rows,
        totals: totalsRes.rows[0],
      })
    } catch (e) {
      console.error('affiliate-seller-marketing summary:', e)
      res.status(500).json({ message: e?.message || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  return router
}
