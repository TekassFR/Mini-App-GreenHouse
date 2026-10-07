/**
 * Vercel Serverless Function: /api/config
 * Queries Neon Postgres directly and returns the live config.
 * Acts as a fallback when the VPS/ngrok is unreachable.
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 4000
});

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
};

module.exports = async function handler(req, res) {
    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    try {
        const client = await pool.connect();
        try {
            // Restaurant settings
            const restaurantRows = await client.query('SELECT key, value FROM restaurant');
            const restaurant = {};
            for (const r of restaurantRows.rows) {
                try { restaurant[r.key] = JSON.parse(r.value); } catch (_) { restaurant[r.key] = r.value; }
            }

            // Admin settings
            const adminRows = await client.query('SELECT key, value FROM admin_settings');
            const admin = {};
            for (const r of adminRows.rows) admin[r.key] = r.value;
            const wlRows = await client.query('SELECT username FROM admin_whitelist');
            admin.whitelist = wlRows.rows.map(r => r.username);

            // Categories
            const catRows = await client.query('SELECT cat_key, name, emoji, description FROM categories ORDER BY sort_order, cat_key');
            const categories = {};
            for (const r of catRows.rows) {
                categories[r.cat_key] = { name: r.name, emoji: r.emoji, description: r.description };
            }

            // Products
            const prodRows = await client.query('SELECT * FROM products ORDER BY cat_key, sort_order, id');
            const products = {};
            for (const key of Object.keys(categories)) products[key] = [];

            for (const r of prodRows.rows) {
                let cp = {};
                try {
                    cp = typeof r.custom_prices === 'string' ? JSON.parse(r.custom_prices) : (r.custom_prices || {});
                } catch (_) {}

                const p = {
                    id: r.id,
                    name: r.name,
                    description: r.description,
                    price: parseFloat(r.price),
                    emoji: r.emoji,
                    image: r.image,
                    video: r.video,
                    category: r.cat_key,
                    isNew: Boolean(r.is_new),
                    isPromo: Boolean(r.is_promo),
                    customPrices: cp
                };
                if (!products[r.cat_key]) products[r.cat_key] = [];
                products[r.cat_key].push(p);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ restaurant, admin, categories, products }));
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Config API error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
};
