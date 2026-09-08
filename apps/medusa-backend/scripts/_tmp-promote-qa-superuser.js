require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/i.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const r = await client.query(`UPDATE seller_users SET is_superuser = true, approval_status = 'approved' WHERE email = $1 RETURNING id, email, is_superuser, approval_status`, ['qa-nav-devcheck@andertal.com']);
  console.log(r.rows);
  await client.end();
})();
