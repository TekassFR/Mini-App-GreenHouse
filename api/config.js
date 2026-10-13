/**
 * Vercel Serverless Function: /api/config
 * Queries Neon Postgres directly and returns the live config.
 * Acts as a fallback when the VPS/ngrok is unreachable.
 * Sans contrôle par client possible ici : si un contrôle d'accès est actif, catalogue caché (access.allowed false).
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

// Réglages secrets : jamais renvoyés (token du bot backup et empreinte d'un token refusé, id du groupe de modération)
const SECRET_ADMIN_KEYS = ['backup_bot_token', 'moderation_chat_id', 'backup_bot_token_refused'];
SECRET_ADMIN_KEYS.push('support_chat_id', 'support_chat_title'); // messages : groupe de support SAV (willy.py)
// Contrôles d'accès réglés dans la gestion : seul willy.py peut les appliquer client par client
// (initData, canal, vérification…). Si l'un est actif, le secours ne montre jamais le catalogue.
const ACCESS_CONTROL_KEYS = ['closed_mode_enabled', 'closed_schedule_enabled', 'mobile_only', 'vpn_required',
    'backup_bot_enabled', 'channel_mandatory', 'cni_required', 'approval_required'];

// Interrupteur lu en base : true, "true", 1 ou "1" (comme isOn côté site et is_on dans willy.py)
function isOn(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

const ACCESS_ALLOWED = { allowed: true, admin: false, bypassed: [], gate: null };
const ACCESS_REFUSED = {
    allowed: false,
    admin: false,
    bypassed: [],
    gate: {
        code: 'telegram_required',
        title: 'Boutique momentanément indisponible',
        message: 'Le serveur de la boutique ne répond pas : ferme et rouvre la boutique depuis Telegram dans une minute.'
    }
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
            for (const r of adminRows.rows) {
                if (!SECRET_ADMIN_KEYS.includes(r.key)) admin[r.key] = r.value;
            }

            // Contrôle d'accès actif : catalogue caché, le site affiche l'écran « accès » (telegram_required)
            if (ACCESS_CONTROL_KEYS.some(k => isOn(admin[k]))) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ restaurant, admin, categories: {}, products: {}, access: ACCESS_REFUSED }));
                return;
            }

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
                    inStock: r.in_stock !== false, // colonne ajoutée par willy.py (absente = en stock)
                    customPrices: cp
                };
                if (!products[r.cat_key]) products[r.cat_key] = [];
                products[r.cat_key].push(p);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ restaurant, admin, categories, products, access: ACCESS_ALLOWED }));
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Config API error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
};
