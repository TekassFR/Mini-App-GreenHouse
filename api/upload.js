/**
 * Vercel Serverless Function: /api/upload
 * Receives a file (multipart OR base64 JSON body) and uploads it to catbox.moe.
 * Returns a public URL. Works for images AND videos.
 *
 * Request body (JSON):
 *   { "data": "<base64 data URI>", "tg_username": "...", "filename": "photo.jpg" }
 *
 * Response:
 *   { "success": true, "url": "https://files.catbox.moe/xxxx.jpg" }
 */

const https = require('https');
const http = require('http');
const { Readable } = require('stream');

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) reject(new Error('Fichier trop lourd (max 50Mo)'));
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); }
        });
        req.on('error', reject);
    });
}

// Upload to catbox.moe via multipart/form-data
function uploadToCatbox(filename, mimeType, fileBuffer) {
    return new Promise((resolve, reject) => {
        const boundary = `----FormBoundary${Date.now()}`;
        const filenameEnc = encodeURIComponent(filename);

        // Build multipart body
        const partHeader = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="userhash"\r\n\r\n\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filenameEnc}"\r\nContent-Type: ${mimeType}\r\n\r\n`
        );
        const partFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([partHeader, fileBuffer, partFooter]);

        const options = {
            hostname: 'catbox.moe',
            path: '/user.php',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
                'User-Agent': 'WillyWoka-Bot/1.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (data && data.startsWith('https://')) {
                    resolve(data.trim());
                } else {
                    reject(new Error(`Catbox error: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Upload timeout')); });
        req.write(body);
        req.end();
    });
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method !== 'POST') {
        return json(res, { error: 'POST uniquement' }, 405);
    }

    try {
        const payload = await readBody(req);
        const dataUri = String(payload.data || '').trim();
        let filename = String(payload.filename || 'upload').trim();

        if (!dataUri.startsWith('data:')) {
            return json(res, { error: 'data manquant (data URI attendu)' }, 400);
        }

        // Parse data URI: data:<mime>;base64,<data>
        const semicolon = dataUri.indexOf(';');
        const comma = dataUri.indexOf(',');
        if (semicolon < 0 || comma < 0) {
            return json(res, { error: 'data URI invalide' }, 400);
        }

        let mimeType = dataUri.slice(5, semicolon).toLowerCase().trim();
        const base64Data = dataUri.slice(comma + 1);

        // Normalize MIME types
        if (mimeType === 'application/octet-stream' || mimeType === '') mimeType = 'image/jpeg';
        if (mimeType === 'video/quicktime') mimeType = 'video/mp4'; // catbox accepts this

        // Determine extension
        const extMap = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
            'image/webp': 'webp', 'image/heic': 'jpg', 'image/heif': 'jpg',
            'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogg',
            'video/quicktime': 'mp4'
        };
        const ext = extMap[mimeType] || (mimeType.startsWith('video/') ? 'mp4' : 'jpg');

        // Force .jpg for HEIC (catbox may reject heic)
        if (mimeType === 'image/heic' || mimeType === 'image/heif') mimeType = 'image/jpeg';

        // Ensure filename has correct extension
        if (!filename.includes('.')) filename = `${filename}.${ext}`;
        else {
            const base = filename.replace(/\.[^.]+$/, '');
            filename = `${base}.${ext}`;
        }

        const fileBuffer = Buffer.from(base64Data, 'base64');

        if (fileBuffer.length > 50 * 1024 * 1024) {
            return json(res, { error: 'Fichier trop lourd (max 50Mo)' }, 413);
        }

        const url = await uploadToCatbox(filename, mimeType, fileBuffer);
        return json(res, { success: true, url });

    } catch (err) {
        console.error('Upload error:', err.message);
        return json(res, { error: err.message || 'Erreur upload' }, 500);
    }
};
