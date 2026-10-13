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
 *   GET  /api/proxy/admin/users
 *   POST /api/proxy/admin/whitelist/save
 *   POST /api/proxy/admin/contact/save
 *   GET  /api/proxy/admin/reviews/pending
 *   POST /api/proxy/admin/reviews/approve
 *   POST /api/proxy/admin/reviews/reject
 *   POST /api/proxy/admin/reviews/delete-approved
 *   GET  /api/proxy/admin/orders
 */

const { Pool } = require('pg');
const crypto = require('crypto');

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

// initData signée par le bot principal (TELEGRAM_BOT_TOKEN) ou par l'un des tokens en plus (bot backup)
function telegramUserFromInitData(initData, maxAge = 86400, extraTokens = []) {
    const tokens = [process.env.TELEGRAM_BOT_TOKEN, ...extraTokens].filter(Boolean);
    if (!initData || !tokens.length) return null;
    const fields = new Map(new URLSearchParams(String(initData)));
    const received = fields.get('hash') || '';
    fields.delete('hash');
    const check = [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const signed = tokens.some(botToken => {
        const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
        return Buffer.byteLength(received) === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
    });
    if (!signed) return null;
    if (Date.now() / 1000 - Number(fields.get('auth_date') || 0) > maxAge) return null;
    try { return JSON.parse(fields.get('user') || '{}'); } catch (_) { return null; }
}

let whitelistUserIdReady = false;

// Empreinte d'un token, comme token_fingerprint dans willy.py
function tokenFingerprint(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function isAdmin(client, initData) {
    // la gestion peut être ouverte depuis le bot backup après une bascule : son token est en base.
    // Refusé par Telegram (révoqué), willy.py en a enregistré l'empreinte : il ne signe plus rien d'accepté
    const backup = await client.query("SELECT key, value FROM admin_settings WHERE key = ANY($1::text[])",
        [['backup_bot_token', 'backup_bot_token_refused']]);
    const saved = Object.fromEntries(backup.rows.map(r => [r.key, r.value]));
    const backupToken = saved.backup_bot_token || '';
    const backupUsable = backupToken && saved.backup_bot_token_refused !== tokenFingerprint(backupToken);
    const user = telegramUserFromInitData(initData, 3600, backupUsable ? [backupToken] : []);
    const uid = user ? Number(user.id) : 0;
    if (!uid) return false;
    if (!whitelistUserIdReady) {
        await client.query('ALTER TABLE admin_whitelist ADD COLUMN IF NOT EXISTS user_id BIGINT');
        whitelistUserIdReady = true;
    }
    const byId = await client.query('SELECT 1 FROM admin_whitelist WHERE user_id=$1', [uid]);
    if (byId.rows.length) return true;
    const u = String(user.username || '').replace(/^@/, '').toLowerCase().trim();
    if (!u) return false;
    const bound = await client.query('UPDATE admin_whitelist SET user_id=$1 WHERE username=$2 AND user_id IS NULL RETURNING 1', [uid, u]);
    return bound.rows.length > 0;
}

async function buildConfig(client) {
    const restaurant = {};
    const restRows = await client.query('SELECT key, value FROM restaurant');
    for (const r of restRows.rows) {
        try { restaurant[r.key] = JSON.parse(r.value); } catch (_) { restaurant[r.key] = r.value; }
    }

    const admin = {};
    const adminRows = await client.query('SELECT key, value FROM admin_settings');
    for (const r of adminRows.rows) {
        if (!SECRET_ADMIN_KEYS.includes(r.key)) admin[r.key] = r.value;
    }
    const wlRows = await client.query('SELECT username, user_id IS NOT NULL AS linked FROM admin_whitelist');
    admin.whitelist = wlRows.rows.map(r => r.username);
    // lié = compte Telegram rattaché à la première connexion vérifiée ; l'id lui-même n'est jamais renvoyé
    admin.whitelist_linked = Object.fromEntries(wlRows.rows.map(r => [r.username, Boolean(r.linked)]));

    const categories = {};
    const catRows = await client.query('SELECT cat_key, name, emoji, description FROM categories ORDER BY sort_order, cat_key');
    for (const r of catRows.rows) categories[r.cat_key] = { name: r.name, emoji: r.emoji, description: r.description };

    const products = {};
    for (const k of Object.keys(categories)) products[k] = [];
    const prodRows = await client.query('SELECT * FROM products ORDER BY cat_key, sort_order, id');
    for (const r of prodRows.rows) {
        let cp = {};
        try { cp = typeof r.custom_prices === 'string' ? JSON.parse(r.custom_prices) : (r.custom_prices || {}); } catch (_) {}
        const p = { id: r.id, name: r.name, description: r.description, price: parseFloat(r.price), emoji: r.emoji, image: r.image, video: r.video, category: r.cat_key, isNew: Boolean(r.is_new), isPromo: Boolean(r.is_promo), inStock: r.in_stock !== false, customPrices: cp };
        if (!products[r.cat_key]) products[r.cat_key] = [];
        products[r.cat_key].push(p);
    }

    return { restaurant, admin, categories, products };
}

// Réglages secrets : jamais renvoyés, ni par /config ni par /admin/config (buildConfig les écarte)
const SECRET_ADMIN_KEYS = ['backup_bot_token', 'moderation_chat_id', 'backup_bot_token_refused'];
SECRET_ADMIN_KEYS.push('support_chat_id'); // messages : groupe de support SAV (willy.py)
// Clés de la config réservées à la gestion : jamais dans /config public
const PRIVATE_ADMIN_KEYS = ['whitelist', 'whitelist_linked', ...SECRET_ADMIN_KEYS];
PRIVATE_ADMIN_KEYS.push('support_chat_title'); // messages : nom du groupe de support, gestion seulement

// Contrôles d'accès réglés dans la gestion : seul willy.py peut les appliquer client par client (initData,
// canal, vérification…). Si l'un est actif, ce secours ne montre pas le catalogue et refuse commandes et avis.
const ACCESS_CONTROL_KEYS = ['closed_mode_enabled', 'closed_schedule_enabled', 'mobile_only', 'vpn_required',
    'backup_bot_enabled', 'channel_mandatory', 'cni_required', 'approval_required'];
const ACCESS_ALLOWED = { allowed: true, admin: false, bypassed: [], gate: null };
const FALLBACK_GATE = {
    code: 'telegram_required',
    title: 'Boutique momentanément indisponible',
    message: 'Le serveur de la boutique ne répond pas : ferme et rouvre la boutique depuis Telegram dans une minute.'
};
const ACCESS_REFUSED = { allowed: false, admin: false, bypassed: [], gate: FALLBACK_GATE };

async function accessControlsActive(client) {
    const rows = await client.query('SELECT value FROM admin_settings WHERE key = ANY($1::text[])', [ACCESS_CONTROL_KEYS]);
    return rows.rows.some(r => isOn(r.value));
}

// fidelite : réglages des avis (reviews_enabled, reviews_order_required, reviews_delay_hours), mêmes règles que
// fidelite_review_check dans willy.py (sans photo : elles ne passent que par willy.py)
async function fideliteReviewRefusal(client, userId) {
    const rows = await client.query('SELECT key, value FROM admin_settings WHERE key = ANY($1::text[])',
        [['reviews_enabled', 'reviews_order_required', 'reviews_delay_hours']]);
    const s = {};
    for (const r of rows.rows) s[r.key] = r.value;
    if (s.reviews_enabled !== undefined && s.reviews_enabled !== '' && !isOn(s.reviews_enabled)) return 'Les avis sont désactivés pour le moment.';
    if (!isOn(s.reviews_order_required)) return '';
    const o = await client.query('SELECT COUNT(*)::int AS n, MAX(timestamp) AS last FROM orders WHERE telegram_user_id = $1', [userId]);
    if (!o.rows[0] || !o.rows[0].n) return 'Tu pourras laisser un avis après ta première commande.';
    const delay = parseInt(s.reviews_delay_hours, 10) || 0;
    const last = Math.min(Number(o.rows[0].last) || 0, Date.now());
    if (delay > 0 && Date.now() - last < delay * 3600000) return 'Tu pourras laisser un avis un peu plus tard (délai après ta dernière commande).';
    return '';
}

// Un avis se cible par son id SQL : le timestamp est choisi par le client à l'envoi,
// un avis forgé avec le même timestamp serait publié ou supprimé en même temps.
const REVIEW_ACTIONS = new Map([
    ['/admin/reviews/approve', "UPDATE reviews SET status='approved' WHERE id=$1 AND status='pending' RETURNING id"],
    ['/admin/reviews/reject', "DELETE FROM reviews WHERE id=$1 AND status='pending' RETURNING id"],
    ['/admin/reviews/delete-approved', "DELETE FROM reviews WHERE id=$1 AND status='approved' RETURNING id"]
]);

// Id SQL d'un avis (entier > 0) ; null s'il manque ou n'est pas valide, sans repli sur le timestamp
function reviewIdFrom(payload) {
    const raw = payload ? payload.review_id : undefined;
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const id = Number(s);
    return id > 0 && id < 2 ** 31 ? id : null;
}

const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|heic|heif|mp4|mov|avi|webm|m4v|mkv|3gp|mp3|m4a|aac|wav|ogg)$/i;

// '' ou /uploads/<fichier> ; null pour tout le reste (data: URL stockée dans Neon, lien externe)
function uploadedMediaPath(value) {
    const v = String(value || '').trim().replace(/^https?:\/\/[^\/]*(?:ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i, '/uploads/');
    return !v || UPLOAD_PATH_RE.test(v) ? v : null;
}

// Fichier envoyé au VPS ou lien https ; jamais une data: URL
function mediaLinkOk(value) {
    const v = String(value || '').trim();
    return !v || v.startsWith('/uploads/') || /^https?:\/\//i.test(v);
}

function contactMediaOk(contact) {
    if (!mediaLinkOk(contact.welcome_photo)) return false;
    if (!('music_playlist' in contact)) return true;
    let tracks;
    try { tracks = JSON.parse(contact.music_playlist || '[]'); } catch (_) { return false; }
    return Array.isArray(tracks) && tracks.every(t => t && typeof t === 'object' && String(t.url || '').trim() && mediaLinkOk(t.url));
}

// Erreur de saisie : renvoyée telle quelle à l'admin en 400 (même règles que willy.py)
class InvalidInput extends Error {}
// Réglage que seul le bot sait vérifier (ex. bot administrateur du canal) : refusé en 503 tant qu'il est injoignable
class NeedsBot extends Error {}

// Interrupteur envoyé par la gestion : true, "true", 1 ou "1" (comme isOn côté site)
function isOn(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

const RESTAURANT_TEXT_LIMITS = new Map([['name', 100], ['slogan', 200], ['currency', 8]]);
const RESTAURANT_AMOUNT_KEYS = ['minOrder', 'deliveryFee', 'delivery_fee', 'min_order'];
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
// Réglages que settings/save ignore : ils ont leur propre route validée (contact/save, whitelist/save, backup/token,
// /moderation dans le groupe) ou seul le bot les écrit (api_base, l'adresse du tunnel ; backup_active passe par
// backup/switch). Les champs dérivés de /admin/config ne s'enregistrent pas non plus. Mêmes règles que willy.py.
const PROTECTED_SETTING_KEYS = new Set(['api_base', 'whitelist', 'whitelist_linked', 'welcome_message', 'welcome_photo',
    'music_playlist', 'start_buttons', 'ticker_text', 'channel_link', 'telegram_username',
    'backup_bot_token', 'backup_bot_username', 'backup_bot_id', 'backup_active', 'moderation_chat_id', 'moderation_chat_title',
    'backup_bot_token_refused', 'backup_bot_token_set', 'backup_bot_running', 'backup_users_count', 'moderation_chat_set', 'closed_now',
    'closed_reopen_at', 'verifications_pending', 'main_bot_username']);
['support_chat_id', 'support_chat_title'].forEach((k) => PROTECTED_SETTING_KEYS.add(k)); // messages : route /support du bot
const MEDIA_SETTING_KEYS = ['background_image', 'logo_url', 'cni_sample_image'];
const STYLE_SETTING_KEYS = ['loader_style', 'animated_bg']; // deviennent des classes CSS dans le site
const SETTING_MAX_CHARS = 4000;
// Interrupteurs des contrôles d'accès, des réseaux et de la fermeture : stockés "true"/"false", rien d'autre
const STRICT_BOOL_SETTING_KEYS = new Set(['contact_tab_enabled', 'closed_mode_enabled', 'closed_schedule_enabled',
    'mobile_only', 'vpn_required', 'channel_mandatory', 'backup_bot_enabled', 'cni_required', 'approval_required']);
const TEXT_SETTING_LIMITS = { contact_text: 2000, closed_mode_title: 80, closed_mode_reason: 500, cni_instructions: 500 };
const SCHEDULE_SETTING_KEYS = ['closed_schedule_open', 'closed_schedule_close'];
const SOCIAL_LINK_MAX = 512;
// Liens des réseaux : https uniquement, sans espace ni guillemet
const SOCIAL_LINK_RULES = {
    signal: [/^https:\/\/signal\.me\/[^\s<>"']+$/i, 'Lien Signal refusé : il doit commencer par https://signal.me/'],
    snapchat: [/^https:\/\/(?:www\.|t\.)?snapchat\.com\/[^\s<>"']+$/i, 'Lien Snapchat refusé : il doit commencer par https://snapchat.com/ (ou www. / t.snapchat.com)'],
    instagram: [/^https:\/\/(?:www\.)?instagram\.com\/[^\s<>"']+$/i, 'Lien Instagram refusé : il doit commencer par https://instagram.com/'],
    potato: [/^https:\/\/[^\s<>"']+$/i, 'Lien Potato refusé : il doit commencer par https://'],
    luffa: [/^https:\/\/[^\s<>"']+$/i, 'Lien Luffa refusé : il doit commencer par https://']
};
const HHMM_RE = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
const CHANNEL_USERNAME = '[A-Za-z][A-Za-z0-9_]{3,31}';

// bot : mêmes règles que willy.py pour les réglages de l'équipe BOT. Interrupteurs "true"/"false" ; profil du bot
// (appliqué sur Telegram par le bot seul) et images de fond par source : routes dédiées de willy.py, ignorés ici
['crm_enabled', 'music_enabled', 'background_hide_desktop', 'tg_logs_enabled'].forEach((k) => STRICT_BOOL_SETTING_KEYS.add(k));
['bot_profile_name', 'bot_description', 'bot_start_description', 'background_targets'].forEach((k) => PROTECTED_SETTING_KEYS.add(k));
const CRM_DISABLED_ERROR = 'CRM désactivé : réactive-le dans Réglages › CRM pour voir les utilisateurs.';

// CRM coupé dans la gestion (clé absente = actif, comme willy.py)
async function crmDisabled(client) {
    const r = await client.query("SELECT value FROM admin_settings WHERE key = 'crm_enabled'");
    return r.rows.length > 0 && ['false', '0'].includes(String(r.rows[0].value || ''));
}

// Numéro WhatsApp au format international « +33612345678 » (8 à 15 chiffres), '' si vide
function normalizeWhatsapp(value) {
    let v = String(value || '').trim();
    if (!v) return '';
    const link = /^(?:https?:\/\/)?(?:api\.)?wa\.me\/\+?([0-9]+)\/?$/i.exec(v);
    if (link) v = '+' + link[1];
    let compact = v.replace(/[\s.\-()/]/g, '');
    if (compact.startsWith('00')) compact = '+' + compact.slice(2);
    else if (/^0[1-9][0-9]{8}$/.test(compact)) compact = '+33' + compact.slice(1); // numéro français sans indicatif
    const digits = compact.startsWith('+') ? compact.slice(1) : compact;
    if (!/^[0-9]{8,15}$/.test(digits) || digits.startsWith('0')) {
        throw new InvalidInput('Numéro WhatsApp refusé : format international attendu, ex. +33612345678 (8 à 15 chiffres).');
    }
    return '+' + digits;
}

// Minutes depuis minuit d'une heure « HH:MM » ; null si absente ou invalide
function parseHhmm(value) {
    const m = HHMM_RE.exec(String(value || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Canal obligatoire : https://t.me/<pseudo>, @pseudo ou -100… (un lien d'invitation privé ne permet pas de vérifier)
function checkChannelLink(link) {
    const v = String(link || '').trim();
    if (/^-100[0-9]{5,16}$/.test(v) || new RegExp(`^@${CHANNEL_USERNAME}$`).test(v)) return;
    if (/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(v)) {
        throw new InvalidInput("Lien d'invitation privé (t.me/+…) : il ne permet pas de vérifier les membres. Mets le lien public https://t.me/<pseudo>, @pseudo ou l'identifiant -100… du canal.");
    }
    if (new RegExp(`^https://(?:www\\.)?(?:t|telegram)\\.me/(?:s/)?${CHANNEL_USERNAME}/?$`, 'i').test(v)) return;
    throw new InvalidInput("Lien du canal obligatoire refusé : mets https://t.me/<pseudo du canal>, @pseudo ou l'identifiant -100… du canal.");
}

// Contrôles entre réglages (enregistrés un par un : on complète avec la base), comme validate_settings_combination
async function validateSettingsCombination(client, values) {
    const scheduleKeys = ['closed_schedule_enabled', ...SCHEDULE_SETTING_KEYS];
    const channelKeys = ['channel_mandatory', 'mandatory_channel_link'];
    // Bot backup obligatoire : sans token enregistré, willy.py ne l'appliquerait à personne (même règle que willy.py)
    if (isOn(values.backup_bot_enabled)) {
        const token = await client.query("SELECT 1 FROM admin_settings WHERE key = 'backup_bot_token' AND COALESCE(value, '') <> ''");
        if (!token.rows.length) throw new InvalidInput("Bot backup obligatoire : ajoute d'abord le token de ton bot backup (bouton « Vérifier »).");
    }
    if (![...scheduleKeys, ...channelKeys].some(k => k in values)) return;
    const rows = await client.query('SELECT key, value FROM admin_settings WHERE key = ANY($1::text[])', [[...scheduleKeys, ...channelKeys]]);
    const merged = {};
    for (const r of rows.rows) merged[r.key] = r.value;
    Object.assign(merged, values);
    if (scheduleKeys.some(k => k in values)) {
        const opening = parseHhmm(merged.closed_schedule_open);
        const closing = parseHhmm(merged.closed_schedule_close);
        if (isOn(merged.closed_schedule_enabled) && (opening === null || closing === null)) {
            throw new InvalidInput("Fermeture programmée : choisis d'abord l'heure d'ouverture et l'heure de fermeture (HH:MM).");
        }
        if (opening !== null && opening === closing) {
            throw new InvalidInput("Fermeture programmée : l'heure d'ouverture et l'heure de fermeture doivent être différentes.");
        }
    }
    // Le bot doit vérifier qu'il est administrateur du canal : impossible d'ici
    if (channelKeys.some(k => k in values) && isOn(merged.channel_mandatory)) {
        throw new NeedsBot('Le serveur du bot est injoignable : le canal obligatoire se règle quand il est revenu (il doit vérifier qu\'il est administrateur du canal).');
    }
}

function restaurantValue(key, value) {
    if (RESTAURANT_TEXT_LIMITS.has(key)) {
        if (typeof value !== 'string') throw new InvalidInput(`Valeur invalide pour « ${key} ».`);
        const v = value.trim();
        const limit = RESTAURANT_TEXT_LIMITS.get(key);
        if (!v && key !== 'slogan') throw new InvalidInput('Le nom de la boutique et la devise ne peuvent pas être vides.');
        if (v.length > limit) throw new InvalidInput(`« ${key} » trop long (${limit} caractères max).`);
        return v;
    }
    const amount = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new InvalidInput(`Montant invalide pour « ${key} » (entre 0 et 100000).`);
    return Number.isInteger(amount) ? amount : Math.round(amount * 100) / 100;
}

// Texte stocké dans admin_settings ; les interrupteurs sont stockés "true"/"false"
function settingValue(key, value) {
    let v;
    if (typeof value === 'boolean') v = value ? 'true' : 'false';
    else if (value === null || value === undefined) v = '';
    else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new InvalidInput(`Valeur invalide pour « ${key} ».`);
        v = String(value);
    } else if (typeof value === 'string') v = value.trim();
    else if (typeof value === 'object') v = JSON.stringify(value);
    else throw new InvalidInput(`Valeur invalide pour « ${key} ».`);
    if (v.length > SETTING_MAX_CHARS) throw new InvalidInput(`Réglage « ${key} » trop long (${SETTING_MAX_CHARS} caractères max).`);
    if (STRICT_BOOL_SETTING_KEYS.has(key)) {
        if (!['true', 'false', '1', '0', ''].includes(v)) throw new InvalidInput(`Valeur invalide pour « ${key} » (activé ou désactivé attendu).`);
        return v === 'true' || v === '1' ? 'true' : 'false';
    }
    if (key in TEXT_SETTING_LIMITS) {
        if (v.length > TEXT_SETTING_LIMITS[key]) throw new InvalidInput(`Réglage « ${key} » trop long (${TEXT_SETTING_LIMITS[key]} caractères max).`);
        return v;
    }
    if (key === 'whatsapp') return normalizeWhatsapp(v);
    if (key in SOCIAL_LINK_RULES) {
        const [pattern, error] = SOCIAL_LINK_RULES[key];
        if (v && (v.length > SOCIAL_LINK_MAX || !pattern.test(v))) throw new InvalidInput(error);
        return v;
    }
    if (SCHEDULE_SETTING_KEYS.includes(key)) {
        const minutes = parseHhmm(v);
        if (v && minutes === null) throw new InvalidInput('Heure refusée : format HH:MM attendu (ex. 12:00).');
        return v ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : '';
    }
    if (key === 'moderation_target') {
        if (!['dm', 'group', ''].includes(v)) throw new InvalidInput('Destination des vérifications refusée : « dm » (messages privés) ou « group ».');
        return v || 'dm';
    }
    if (key === 'mandatory_channel_link') {
        if (v) checkChannelLink(v);
        return v.replace(/\/+$/, '');
    }
    if (MEDIA_SETTING_KEYS.includes(key)) {
        const path = uploadedMediaPath(v);
        if (path === null) throw new InvalidInput('Image refusée : envoie le fichier avec le bouton « Choisir… » (les liens ne sont pas acceptés).');
        return path;
    }
    if (key === 'theme_color') {
        if (v && !/^#[0-9a-f]{6}$/i.test(v)) throw new InvalidInput('Couleur refusée : format #rrggbb attendu.');
        return v.toLowerCase();
    }
    if (STYLE_SETTING_KEYS.includes(key) && v && !/^[a-z0-9_-]{1,40}$/.test(v)) throw new InvalidInput(`Style inconnu pour « ${key} ».`);
    return v;
}

const START_BUTTONS_MAX = 6;

// Boutons-liens de /start [{text, url}] depuis le JSON enregistré (ou une liste)
function parseStartButtons(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return [];
    let list = value;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch (_) { throw new InvalidInput('Boutons de /start illisibles : réenregistre-les.'); }
    }
    if (!Array.isArray(list)) throw new InvalidInput('Boutons de /start illisibles : réenregistre-les.');
    if (list.length > START_BUTTONS_MAX) throw new InvalidInput(`${START_BUTTONS_MAX} boutons maximum sous /start.`);
    return list.map(b => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new InvalidInput('Boutons de /start illisibles : réenregistre-les.');
        const text = String(b.text || '').trim();
        const url = String(b.url || '').trim();
        if (text.length < 1 || text.length > 64) throw new InvalidInput("Chaque bouton de /start a besoin d'un texte de 1 à 64 caractères.");
        if (url.length > 512 || !/^(?:https|tg):\/\/\S+$/i.test(url)) throw new InvalidInput(`Lien du bouton « ${text} » refusé : il doit commencer par https:// ou tg://`);
        return { text, url };
    });
}

// api_base n'en fait pas partie : seul le bot écrit l'adresse du tunnel (publish_api_base de willy.py)
const CONTACT_KEYS = ['telegram_username', 'channel_link', 'welcome_message', 'welcome_photo', 'ticker_text', 'music_playlist', 'start_buttons'];
// Ces valeurs partent dans chaque /config public : taille bornée (refus, pas de coupure)
const CONTACT_MAX_CHARS = { channel_link: 512, welcome_photo: 512, ticker_text: 1000, music_playlist: 16000 };
const MUSIC_TRACKS_MAX = 50;

// Valeurs à écrire pour les seules clés envoyées (mise à jour partielle)
function contactValues(contact) {
    const values = {};
    for (const k of CONTACT_KEYS) {
        if (!(k in contact)) continue;
        if (k === 'start_buttons') { values[k] = JSON.stringify(parseStartButtons(contact[k])); continue; }
        let v = contact[k] === null || contact[k] === undefined ? '' : String(contact[k]).trim();
        if (k === 'welcome_message') v = v.slice(0, 1000);
        else if (k === 'telegram_username') {
            // pseudo de contact du bouton « Nous contacter » de /start (pas un lien de canal)
            v = v.replace(/^@+/, '');
            if (v && !/^[A-Za-z0-9_]{4,32}$/.test(v)) throw new InvalidInput('Pseudo Telegram refusé : 4 à 32 lettres, chiffres ou _, sans lien.');
        } else if (k === 'channel_link' && v && !/^https?:\/\/\S+$/.test(v)) throw new InvalidInput('Lien du canal refusé : il doit commencer par https://');
        const limit = CONTACT_MAX_CHARS[k];
        if (limit && v.length > limit) throw new InvalidInput(`Réglage « ${k} » trop long (${limit} caractères max).`);
        if (k === 'music_playlist' && v && JSON.parse(v).length > MUSIC_TRACKS_MAX) throw new InvalidInput(`${MUSIC_TRACKS_MAX} sons maximum dans la playlist.`);
        values[k] = v;
    }
    return values;
}

let productsInStockReady = false;

async function ensureInStockColumn(client) {
    if (productsInStockReady) return;
    await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS in_stock BOOLEAN NOT NULL DEFAULT TRUE');
    productsInStockReady = true;
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

    // Les photos et vidéos ne passent jamais par ici : relayées par une fonction Vercel, chaque lecture
    // comptait dans le quota « Fast Origin Transfer » et a fait suspendre le compte (octobre 2026).
    // Elles sont servies par le PC (willy.py) à la même adresse que le site.

    let client;
    try {
        client = await pool.connect();

        // ── GET /config ──────────────────────────────────────────────────
        if (route === '/config' && req.method === 'GET') {
            const cfg = await buildConfig(client);
            for (const k of PRIVATE_ADMIN_KEYS) delete cfg.admin[k];
            // Contrôle d'accès actif : catalogue caché, le site affiche l'écran « accès » (telegram_required)
            if (ACCESS_CONTROL_KEYS.some(k => isOn(cfg.admin[k]))) {
                cfg.categories = {};
                cfg.products = {};
                cfg.access = ACCESS_REFUSED;
            } else {
                cfg.access = ACCESS_ALLOWED;
            }
            return json(res, cfg);
        }

        // ── GET /admin/config ─────────────────────────────────────────────
        if (route === '/admin/config' && req.method === 'GET') {
            if (!await isAdmin(client, req.headers['x-telegram-init-data'])) return json(res, { error: 'Forbidden' }, 403);
            const cfg = await buildConfig(client);
            // Secrets jamais renvoyés : seulement s'ils sont réglés. Les bots tournent avec willy.py, injoignable ici.
            const secrets = await client.query("SELECT key FROM admin_settings WHERE key = ANY($1::text[]) AND value <> ''", [SECRET_ADMIN_KEYS]);
            const setKeys = new Set(secrets.rows.map(r => r.key));
            cfg.admin.backup_bot_token_set = setKeys.has('backup_bot_token');
            cfg.admin.moderation_chat_set = setKeys.has('moderation_chat_id');
            cfg.admin.backup_bot_running = false;
            return json(res, { success: true, config: cfg });
        }

        // ── GET /reviews ──────────────────────────────────────────────────
        if (route === '/reviews' && req.method === 'GET') {
            // Colonnes publiques seulement : l'id Telegram et le pseudo de l'auteur restent côté gestion
            const rows = await client.query("SELECT id, author, stars, message, timestamp FROM reviews WHERE status='approved' ORDER BY timestamp DESC LIMIT 200");
            return json(res, { success: true, reviews: rows.rows, count: rows.rows.length });
        }

        // ── POST /save-review ─────────────────────────────────────────────
        if (route === '/save-review' && req.method === 'POST') {
            const p = await readBody(req);
            if (await accessControlsActive(client)) return json(res, { error: FALLBACK_GATE.message, gate: FALLBACK_GATE }, 403);
            const user = telegramUserFromInitData(p.init_data);
            if (!user) return json(res, { error: 'Forbidden' }, 403);
            const reviewRefusal = await fideliteReviewRefusal(client, user.id); // fidelite : avis coupés / commande requise
            if (reviewRefusal) return json(res, { error: reviewRefusal }, 403);
            const author = String(p.author || '').trim().slice(0, 64);
            const message = String(p.message || '').trim().slice(0, 1000);
            if (!author || !message) return json(res, { error: 'Payload invalide' }, 400);
            const stars = Math.max(1, Math.min(5, parseInt(p.stars) || 5));
            const ts = parseInt(p.timestamp) || Date.now();
            await client.query("INSERT INTO reviews (author, stars, message, timestamp, telegram_user_id, telegram_username, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')",
                [author, stars, message, ts, user.id || null, String(user.username || '').slice(0, 64) || null]);
            return json(res, { success: true, status: 'pending' });
        }

        // ── POST /save-order ──────────────────────────────────────────────
        if (route === '/save-order' && req.method === 'POST') {
            const p = await readBody(req);
            if (await accessControlsActive(client)) return json(res, { error: FALLBACK_GATE.message, gate: FALLBACK_GATE }, 403);
            const user = telegramUserFromInitData(p.init_data);
            if (!user) return json(res, { error: 'Forbidden' }, 403);
            // Commandes › « Commandes activées » coupé dans la gestion (même règle que willy.py)
            const enabled = await client.query("SELECT value FROM admin_settings WHERE key = 'orders_enabled'");
            if (enabled.rows.length && !isOn(enabled.rows[0].value)) {
                return json(res, { error: 'Les commandes sont fermées pour le moment.', orders_closed: true }, 403);
            }
            // fidelite : points et codes gagnés ne sont vérifiés que par willy.py : jamais de réduction par le secours
            if (Number(p.points_used) > 0 || p.promo_code) return json(res, { error: 'Avantages fidélité indisponibles : le serveur de la boutique ne répond pas, réessaie dans un instant.', fidelite: true }, 503);
            // catalogue : prix, promo, frais, ville et paiement ne sont recalculés que par willy.py (build_catalogue_order) :
            // le secours n'enregistre jamais un total choisi par le client (même règle que les avantages fidélité ci-dessus)
            return json(res, { error: 'Commandes momentanément indisponibles : le serveur de la boutique ne répond pas, réessaie dans un instant.' }, 503);
        }

        // ── GET /admin/orders ─────────────────────────────────────────────
        if (route === '/admin/orders' && req.method === 'GET') {
            if (!await isAdmin(client, req.headers['x-telegram-init-data'])) return json(res, { error: 'Forbidden' }, 403);
            // ?user_id=…&username=… : commandes d'un seul client (fiche client), comme willy.py
            const query = new URL(req.url || '/', 'http://local').searchParams;
            const uid = String(query.get('user_id') || '').trim();
            if (uid && !/^\d{1,20}$/.test(uid)) return json(res, { error: 'Identifiant client invalide' }, 400);
            const uname = String(query.get('username') || '').trim().replace(/^@+/, '').toLowerCase().slice(0, 64);
            const rows = uid
                ? await client.query("SELECT * FROM orders WHERE telegram_user_id = $1 OR ($2 <> '' AND LOWER(telegram_username) = $2) ORDER BY timestamp DESC LIMIT 1000", [uid, uname])
                : await client.query('SELECT * FROM orders ORDER BY timestamp DESC LIMIT 200');
            return json(res, { success: true, orders: rows.rows });
        }

        // ── POST /admin/products/save ─────────────────────────────────────
        if (route === '/admin/products/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const p = payload.product || {};
            const cat_key = String(p.category || '').trim();
            const name = String(p.name || '').trim().slice(0, 100);
            if (!cat_key || !name) return json(res, { error: 'Catégorie ou nom manquant' }, 400);
            const price = parseFloat(p.price) || 0;
            const cp = JSON.stringify(typeof p.customPrices === 'object' && p.customPrices ? p.customPrices : {});
            const image = uploadedMediaPath(p.image);
            const video = uploadedMediaPath(p.video);
            if (image === null || video === null) return json(res, { error: 'Photo ou vidéo refusée : envoie le fichier avec le bouton « Choisir… » (les liens ne sont pas acceptés).' }, 400);
            const desc = String(p.description || '').trim().slice(0, 500);
            const emoji = String(p.emoji || '📦').trim().slice(0, 10);
            const is_new = Boolean(p.isNew);
            const is_promo = Boolean(p.isPromo);
            // en stock : absent d'une modification = inchangé, absent d'un ajout = en stock
            let in_stock = 'inStock' in p ? isOn(p.inStock) : null;
            let product_id = p.id ? parseInt(p.id) : null;
            await ensureInStockColumn(client);

            if (product_id) {
                const ex = await client.query('SELECT sort_order, in_stock FROM products WHERE id=$1', [product_id]);
                const sort_ord = ex.rows[0] ? ex.rows[0].sort_order : 0;
                if (in_stock === null) in_stock = ex.rows[0] ? ex.rows[0].in_stock !== false : true;
                await client.query(`INSERT INTO products (id,cat_key,name,description,price,emoji,image,video,is_new,is_promo,custom_prices,sort_order,in_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
                    ON CONFLICT (id) DO UPDATE SET cat_key=EXCLUDED.cat_key,name=EXCLUDED.name,description=EXCLUDED.description,price=EXCLUDED.price,emoji=EXCLUDED.emoji,image=EXCLUDED.image,video=EXCLUDED.video,is_new=EXCLUDED.is_new,is_promo=EXCLUDED.is_promo,custom_prices=EXCLUDED.custom_prices,sort_order=EXCLUDED.sort_order,in_stock=EXCLUDED.in_stock`,
                    [product_id, cat_key, name, desc, price, emoji, image, video, is_new, is_promo, cp, sort_ord, in_stock]);
            } else {
                const maxOrd = await client.query('SELECT COALESCE(MAX(sort_order),-1) as mo FROM products WHERE cat_key=$1', [cat_key]);
                const newOrd = (maxOrd.rows[0].mo || -1) + 1;
                const r = await client.query(`INSERT INTO products (cat_key,name,description,price,emoji,image,video,is_new,is_promo,custom_prices,sort_order,in_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id`,
                    [cat_key, name, desc, price, emoji, image, video, is_new, is_promo, cp, newOrd, in_stock === null ? true : in_stock]);
                product_id = r.rows[0].id;
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, product_id, config: cfg });
        }

        // ── POST /admin/products/delete ───────────────────────────────────
        if (route === '/admin/products/delete' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const pid = parseInt(payload.product_id);
            if (!pid) return json(res, { error: 'product_id manquant' }, 400);
            await client.query('DELETE FROM products WHERE id=$1', [pid]);
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/products/reorder ──────────────────────────────────
        if (route === '/admin/products/reorder' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
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
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
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
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
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
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const settings = payload.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return json(res, { error: 'Réglages invalides' }, 400);
            // Mise à jour PARTIELLE, mêmes règles que willy.py : tout est validé avant la première écriture
            const restaurant = {}, adminValues = {}, ignored = [];
            try {
                for (const [k, v] of Object.entries(settings)) {
                    if (RESTAURANT_TEXT_LIMITS.has(k) || RESTAURANT_AMOUNT_KEYS.includes(k)) restaurant[k] = restaurantValue(k, v);
                    else if (PROTECTED_SETTING_KEYS.has(k)) ignored.push(k);
                    else if (!SETTING_KEY_RE.test(k)) throw new InvalidInput(`Réglage inconnu : « ${k.slice(0, 64)} ».`);
                    else adminValues[k] = settingValue(k, v);
                }
                await validateSettingsCombination(client, adminValues);
            } catch (err) {
                if (err instanceof InvalidInput) return json(res, { error: err.message }, 400);
                if (err instanceof NeedsBot) return json(res, { error: err.message }, 503);
                throw err;
            }
            // Même stockage que willy.py : table restaurant, valeurs en JSON (le front lit restaurant.slogan, etc.)
            for (const [k, v] of Object.entries(restaurant)) {
                await client.query(`INSERT INTO restaurant (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]);
            }
            for (const [k, v] of Object.entries(adminValues)) {
                await client.query(`INSERT INTO admin_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, v]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg, ignored });
        }

        // ── GET /admin/users ──────────────────────────────────────────────
        if (route === '/admin/users' && req.method === 'GET') {
            if (!await isAdmin(client, req.headers['x-telegram-init-data'])) return json(res, { error: 'Forbidden' }, 403);
            if (await crmDisabled(client)) return json(res, { error: CRM_DISABLED_ERROR, crm_disabled: true }, 403);  // bot
            // Même format que willy.py (sans bot_users.json, qui n'existe que sur le PC)
            const uRows = await client.query('SELECT user_id, username, first_name, last_name, updated_at FROM bot_users ORDER BY updated_at DESC');
            const users = uRows.rows.map(r => ({
                user_id: Number(r.user_id),
                username: String(r.username || '').trim().replace(/^@+/, ''),
                first_name: String(r.first_name || '').trim(),
                last_name: String(r.last_name || '').trim(),
                updated_at: Number(r.updated_at) || 0
            }));
            return json(res, { success: true, users, count: users.length });
        }

        // ── POST /admin/whitelist/save ────────────────────────────────────
        if (route === '/admin/whitelist/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const whitelist = (Array.isArray(payload.whitelist) ? payload.whitelist : [])
                .map(u => String(u).replace(/^@/, '').toLowerCase().trim())
                .filter(Boolean);
            await client.query('DELETE FROM admin_whitelist WHERE NOT (username = ANY($1::text[]))', [whitelist]);
            for (const uname of whitelist) {
                await client.query('INSERT INTO admin_whitelist (username) VALUES ($1) ON CONFLICT DO NOTHING', [uname]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── POST /admin/contact/save ──────────────────────────────────────
        if (route === '/admin/contact/save' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const contact = payload.contact;
            if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return json(res, { error: 'Contacts invalides' }, 400);
            if (!contactMediaOk(contact)) return json(res, { error: 'Photo ou son refusé : envoie le fichier avec le bouton « Choisir… » ou colle un lien https.' }, 400);
            let values;
            try {
                values = contactValues(contact);
            } catch (err) {
                if (err instanceof InvalidInput) return json(res, { error: err.message }, 400);
                throw err;
            }
            // Seules les clés envoyées sont écrites (mise à jour partielle)
            for (const [k, v] of Object.entries(values)) {
                await client.query(`INSERT INTO admin_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, v]);
            }
            const cfg = await buildConfig(client);
            return json(res, { success: true, config: cfg });
        }

        // ── GET /admin/reviews/pending ────────────────────────────────────
        if (route === '/admin/reviews/pending' && req.method === 'GET') {
            if (!await isAdmin(client, req.headers['x-telegram-init-data'])) return json(res, { error: 'Forbidden' }, 403);
            // Même réponse que willy.py : clé « pending », plus récents d'abord
            const rows = await client.query("SELECT * FROM reviews WHERE status='pending' ORDER BY timestamp DESC");
            return json(res, { success: true, pending: rows.rows });
        }

        // ── POST /admin/reviews/approve | reject | delete-approved ────────
        if (REVIEW_ACTIONS.has(route) && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            const reviewId = reviewIdFrom(payload);
            if (!reviewId) return json(res, { error: "Identifiant d'avis manquant : actualise la liste des avis." }, 400);
            const done = await client.query(REVIEW_ACTIONS.get(route), [reviewId]);
            if (!done.rows.length) return json(res, { error: 'Avis introuvable ou déjà traité.' }, 404);
            return json(res, { success: true, review_id: reviewId });
        }

        // ── POST /admin/restart ───────────────────────────────────────────
        // Seul le VPS sait redémarrer le bot : on n'arrive ici que s'il est injoignable
        if (route === '/admin/restart' && req.method === 'POST') {
            const payload = await readBody(req);
            if (!await isAdmin(client, payload.init_data)) return json(res, { error: 'Forbidden' }, 403);
            return json(res, { error: 'Le serveur du bot est injoignable : il redémarre tout seul, réessaie dans une minute.' }, 503);
        }

        return json(res, { error: `Route inconnue: ${route}` }, 404);

    } catch (err) {
        console.error('Proxy API error:', route, err.message);
        return json(res, { error: err.message }, 500);
    } finally {
        if (client) client.release();
    }
};
