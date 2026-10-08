/**
 * Vercel Serverless Function: /api/proxy
 * Handles ALL admin write operations directly via Neon Postgres.
 * Acts as a full fallback when the VPS/ngrok is unreachable.
 *
 * Routes handled (mapped from request URL):
 *   GET  /api/proxy/config
 *   GET  /api/proxy/reviews
 *   POST /api/proxy/save-review
 *   POST /api/proxy/save-order
 *   GET  /api/proxy/admin/config
 *   POST /api/proxy/admin/products/save
 *   POST /api/proxy/admin/products/delete
 *   POST /api/proxy/admin/products/reorder
 *   POST /api/proxy/admin/categories/save
 *   POST /api/proxy/admin/categories/delete
 *   POST /api/proxy/admin/settings/save
 *   POST /api/proxy/admin/whitelist/save
 *   POST /api/proxy/admin/contact/save
 *   GET  /api/proxy/admin/reviews/pending
 *   POST /api/proxy/admin/reviews/approve
 *   POST /api/proxy/admin/reviews/reject
 *   POST /api/proxy/admin/reviews/delete-approved
 *   GET  /api/proxy/admin/orders
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 8000,
    connectionTimeoutMillis: 5000
});

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store'
};

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 100 * 1024 * 1024) reject(new Error('Body too large')); });
        req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
        req.on('error', reject);
    });
}

async function isAdmin(client, username) {
    if (!username) return false;
    const u = String(username).replace(/^@/, '').toLowerCase().trim();
    if (!u) return false;
    const r = await client.query('SELECT 1 FROM admin_whitelist WHERE username=$1', [u]);
    return r.rows.length > 0;
}

async function buildConfig(client) {
    const restaurant = {};
    const restRows = await client.query('SELECT key, value FROM restaurant');
    for (const r of restRows.rows) {
        try { restaurant[r.key] = JSON.parse(r.value); } catch (_) { restaurant[r.key] = r.value; }
    }

    const admin = {};
    const adminRows = await client.query('SELECT key, value FROM admin_settings');
    for (const r of adminRows.rows) admin[r.key] = r.value;
    const wlRows = await client.query('SELECT username FROM admin_whitelist');
    admin.whitelist = wlRows.rows.map(r => r.username);

    const categories = {};
    const catRows = await client.query('SELECT cat_key, name, emoji, description FROM categories ORDER BY sort_order, cat_key');
    for (const r of catRows.rows) categories[r.cat_key] = { name: r.name, emoji: r.emoji, description: r.description };

    const products = {};
    for (const k of Object.keys(categories)) products[k] = [];
    const prodRows = await client.query('SELECT * FROM products ORDER BY cat_key, sort_order, id');
    for (const r of prodRows.rows) {
        let cp = {};
        try { cp = typeof r.custom_prices === 'string' ? JSON.parse(r.custom_prices) : (r.custom_prices || {}); } catch (_) {}
        const p = { id: r.id, name: r.name, description: r.description, price: parseFloat(r.price), emoji: r.emoji, image: r.image, video: r.video, category: r.cat_key, isNew: Boolean(r.is_new), isPromo: Boolean(r.is_promo), customPrices: cp };
        if (!products[r.cat_key]) products[r.cat_key] = [];
        products[r.cat_key].push(p);
    }

    return { restaurant, admin, categories, products };
}

function fixMime(image, video) {
    if (image && image.startsWith('data:application/octet-stream')) image = image.replace('data:application/octet-stream', 'data:image/jpeg');
    if (video && (video.startsWith('data:application/octet-stream') || video.startsWith('data:video/quicktime'))) {
        video = video.replace('data:application/octet-stream', 'data:video/mp4').replace('data:video/quicktime', 'data:video/mp4');
    }
    return { image: image || '', video: video || '' };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    // Extract route: strip /api/proxy prefix
    // Vercel rewrites: the original path is preserved in x-matched-path or x-invoke-path
    // When called directly as /api/proxy/..., req.url = /api/proxy/...
    // When rewritten from /admin/... → /api/proxy, Vercel sets x-matched-path to the original
    const rawUrl = req.headers['x-matched-path'] || req.headers['x-invoke-path'] || req.url || '/';
    const route = rawUrl.replace(/^\/api\/proxy/, '').replace(/\?.*$/, '') || '/';

    // ── Proxy /uploads/:filename directly from VPS (bypasses ngrok warning) ──
    if (route.startsWith('/uploads/') && req.method === 'GET') {
        const filename = route.replace('/uploads/', '');
        const ngrokBase = process.env.NGROK_URL || 'https://wieldable-blah-fineness.ngrok-free.dev';
        const vpsUrl = `${ngrokBase}/uploads/${filename}`;
        const https = require('https');
        return new Promise((resolve) => {
            https.get(vpsUrl, {
                headers: { 'ngrok-skip-browser-warning': 'true', 'User-Agent': 'Vercel-Media-Proxy/1.0' }
            }, (upstream) => {
                const contentType = upstream.headers['content-type'] || 'application/octet-stream';
                res.writeHead(upstream.statusCode, {
                    ...CORS,
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
                });
                upstream.pipe(res);
                upstream.on('end', resolve);
            }).on('error', (err) => {
                json(res, { error: 'Upload proxy failed: ' + err.message }, 502);
                resolve();
            });
        });
    }

    let client;
    try {
        client = await pool.connect();

        // ── GET /config ──────────────────────────────────────────────────
        if (route === '/config' && req.method === 'GET') {
            const cfg = await buildConfig(client);
            return json(res, cfg);
        }

        // ── GET /admin/config ─────────────────────────────────────────────
        if (route === '/admin/config' && req.method === 'GET') {
            const username = (req.url.split('tg_username=')[1] || '').split('&')[0];
            if (!await isAdmin(client, username)) return json(res, { error: 'Forbidden' }, 403);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── GET /reviews ──────────────────────────────────────────────────
        if (route === '/reviews' && req.method === 'GET') {
            const rows = await client.query("SELECT * FROM reviews WHERE status='approved' ORDER BY timestamp DESC LIMIT 200");
            return json(res, { success: true, reviews: rows.rows, count: rows.rows.length });
        }

        // ── POST /save-review ─────────────────────────────────────────────
        if (route === '/save-review' && req.method === 'POST') {
            const p = await readBody(req);
            const author = String(p.author || '').trim().slice(0, 64);
            const message = String(p.message || '').trim().slice(0, 1000);
            if (!author || !message) return json(res, { error: 'Payload invalide' }, 400);
            const stars = Math.max(1, Math.min(5, parseInt(p.stars) || 5));
            const ts = parseInt(p.timestamp) || Date.now();
            await client.query("INSERT INTO reviews (author, stars, message, timestamp, telegram_user_id, telegram_username, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')",
                [author, stars, message, ts, p.telegramUserId || null, String(p.telegramUsername || '').slice(0, 64) || null]);
            return json(res, { success: true, status: 'pending' });
        }

        // ── POST /save-order ──────────────────────────────────────────────
        if (route === '/save-order' && req.method === 'POST') {
            const p = await readBody(req);
            const type = String(p.type || '').slice(0, 20);
            const total = parseFloat(p.total) || 0;
            if (!type || total <= 0) return json(res, { error: 'Invalid order' }, 400);
            await client.query("INSERT INTO orders (type, total, summary, timestamp, telegram_user_id, telegram_username) VALUES ($1,$2,$3,$4,$5,$6)",
                [type, total, String(p.summary || '').slice(0, 500), parseInt(p.timestamp) || Date.now(), p.telegramUserId || null, String(p.telegramUsername || '').slice(0, 64) || null]);
            return json(res, { success: true });
        }

        // ── GET /admin/orders ─────────────────────────────────────────────
        if (route === '/admin/orders' && req.method === 'GET') {
            const username = (req.url.split('tg_username=')[1] || '').split('&')[0];
            if (!await isAdmin(client, username)) return json(res, { error: 'Forbidden' }, 403);
            const rows = await client.query('SELECT * FROM orders ORDER BY timestamp DESC LIMIT 200');
            return json(res, { success: true, orders: rows.rows });
        }

        // ── POST /admin/products/save ─────────────────────────────────────
        if (route === '/admin/products/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const p = payload.product || {};
            const cat_key = String(p.category || '').trim();
            const name = String(p.name || '').trim().slice(0, 100);
            if (!cat_key || !name) return json(res, { error: 'Catégorie ou nom manquant' }, 400);
            const price = parseFloat(p.price) || 0;
            const cp = JSON.stringify(typeof p.customPrices === 'object' && p.customPrices ? p.customPrices : {});
            const { image, video } = fixMime(String(p.image || '').trim(), String(p.video || '').trim());
            const desc = String(p.description || '').trim().slice(0, 500);
            const emoji = String(p.emoji || '📦').trim().slice(0, 10);
            const is_new = Boolean(p.isNew);
            const is_promo = Boolean(p.isPromo);
            let product_id = p.id ? parseInt(p.id) : null;

            if (product_id) {
                const ex = await client.query('SELECT sort_order FROM products WHERE id=$1', [product_id]);
                const sort_ord = ex.rows[0] ? ex.rows[0].sort_order : 0;
                await client.query(`INSERT INTO products (id,cat_key,name,description,price,emoji,image,video,is_new,is_promo,custom_prices,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
                    ON CONFLICT (id) DO UPDATE SET cat_key=EXCLUDED.cat_key,name=EXCLUDED.name,description=EXCLUDED.description,price=EXCLUDED.price,emoji=EXCLUDED.emoji,image=EXCLUDED.image,video=EXCLUDED.video,is_new=EXCLUDED.is_new,is_promo=EXCLUDED.is_promo,custom_prices=EXCLUDED.custom_prices,sort_order=EXCLUDED.sort_order`,
                    [product_id, cat_key, name, desc, price, emoji, image, video, is_new, is_promo, cp, sort_ord]);
            } else {
                const maxOrd = await client.query('SELECT COALESCE(MAX(sort_order),-1) as mo FROM products WHERE cat_key=$1', [cat_key]);
                const newOrd = (maxOrd.rows[0].mo || -1) + 1;
                const r = await client.query(`INSERT INTO products (cat_key,name,description,price,emoji,image,video,is_new,is_promo,custom_prices,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
                    [cat_key, name, desc, price, emoji, image, video, is_new, is_promo, cp, newOrd]);
                product_id = r.rows[0].id;
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, product_id, config: cfg });
        }

        // ── POST /admin/products/delete ───────────────────────────────────
        if (route === '/admin/products/delete' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const pid = parseInt(payload.product_id);
            if (!pid) return json(res, { error: 'product_id manquant' }, 400);
            await client.query('DELETE FROM products WHERE id=$1', [pid]);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/products/reorder ──────────────────────────────────
        if (route === '/admin/products/reorder' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const { category, product_id, direction } = payload;
            const rows = await client.query('SELECT id, sort_order FROM products WHERE cat_key=$1 ORDER BY sort_order, id', [category]);
            const prods = rows.rows;
            const idx = prods.findIndex(p => String(p.id) === String(product_id));
            if (idx < 0) return json(res, { error: 'Produit introuvable' }, 404);
            const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
            if (swapIdx < 0 || swapIdx >= prods.length) return json(res, { error: 'Déjà en limite' }, 400);
            const a = prods[idx], b = prods[swapIdx];
            await client.query('UPDATE products SET sort_order=$1 WHERE id=$2', [b.sort_order, a.id]);
            await client.query('UPDATE products SET sort_order=$1 WHERE id=$2', [a.sort_order, b.id]);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/categories/save ───────────────────────────────────
        if (route === '/admin/categories/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const c = payload.category || payload || {};
            const cat_key = String(c.key || c.cat_key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
            const cat_name = String(c.name || '').trim().slice(0, 60);
            if (!cat_key || !cat_name) return json(res, { error: 'Clé ou nom manquant' }, 400);
            const maxOrd = await client.query('SELECT COALESCE(MAX(sort_order),-1) as mo FROM categories');
            const sort_order = c.sort_order !== undefined ? parseInt(c.sort_order) : (maxOrd.rows[0].mo + 1);
            await client.query(`INSERT INTO categories (cat_key,name,emoji,description,sort_order) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (cat_key) DO UPDATE SET name=EXCLUDED.name,emoji=EXCLUDED.emoji,description=EXCLUDED.description,sort_order=EXCLUDED.sort_order`,
                [cat_key, cat_name, String(c.emoji || '📦').slice(0, 10), String(c.description || '').slice(0, 200), sort_order]);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/categories/delete ─────────────────────────────────
        if (route === '/admin/categories/delete' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const cat_key = String(payload.cat_key || payload.key || '').trim();
            if (!cat_key) return json(res, { error: 'cat_key manquant' }, 400);
            await client.query('DELETE FROM products WHERE cat_key=$1', [cat_key]);
            await client.query('DELETE FROM categories WHERE cat_key=$1', [cat_key]);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/settings/save ─────────────────────────────────────
        if (route === '/admin/settings/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const settings = payload.settings || {};
            for (const [k, v] of Object.entries(settings)) {
                await client.query(`INSERT INTO admin_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(k).slice(0,60), String(v).slice(0,500)]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/whitelist/save ────────────────────────────────────
        if (route === '/admin/whitelist/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const whitelist = Array.isArray(payload.whitelist) ? payload.whitelist : [];
            await client.query('DELETE FROM admin_whitelist');
            for (const u of whitelist) {
                const uname = String(u).replace(/^@/, '').toLowerCase().trim();
                if (uname) await client.query('INSERT INTO admin_whitelist (username) VALUES ($1) ON CONFLICT DO NOTHING', [uname]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/contact/save ──────────────────────────────────────
        if (route === '/admin/contact/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            const contact = payload.contact || {};
            for (const [k, v] of Object.entries(contact)) {
                await client.query(`INSERT INTO admin_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(k).slice(0,60), String(v).slice(0,500)]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── GET /admin/reviews/pending ────────────────────────────────────
        if (route === '/admin/reviews/pending' && req.method === 'GET') {
            const username = (req.url.split('tg_username=')[1] || '').split('&')[0];
            if (!await isAdmin(client, username)) return json(res, { error: 'Forbidden' }, 403);
            const rows = await client.query("SELECT * FROM reviews WHERE status='pending' ORDER BY timestamp ASC");
            return json(res, { success: true, reviews: rows.rows, count: rows.rows.length });
        }

        // ── POST /admin/reviews/approve ───────────────────────────────────
        if (route === '/admin/reviews/approve' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            await client.query("UPDATE reviews SET status='approved' WHERE id=$1", [parseInt(payload.review_id)]);
            return json(res, { success: true });
        }

        // ── POST /admin/reviews/reject ────────────────────────────────────
        if (route === '/admin/reviews/reject' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            await client.query("UPDATE reviews SET status='rejected' WHERE id=$1", [parseInt(payload.review_id)]);
            return json(res, { success: true });
        }

        // ── POST /admin/reviews/delete-approved ───────────────────────────
        if (route === '/admin/reviews/delete-approved' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.tg_username)) return json(res, { error: 'Forbidden' }, 403);
            await client.query("DELETE FROM reviews WHERE id=$1", [parseInt(payload.review_id)]);
            return json(res, { success: true });
        }

        return json(res, { error: `Route inconnue: ${route}` }, 404);

    } catch (err) {
        console.error('Proxy API error:', route, err.message);
        return json(res, { error: err.message }, 500);
    } finally {
        if (client) client.release();
    }
};
