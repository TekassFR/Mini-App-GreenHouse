import logging
import hashlib
import hmac
import time
import json
import os
from collections import defaultdict
from functools import wraps
from telegram import Update, WebAppInfo, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes
from aiohttp import web
import aiohttp

# Configuration sécurisée
BOT_TOKEN = "8969010663:AAFLclDLxMpjtXQZtRgLfwkZxXcyNyGnaMM" # Remplacez par votre token réel
WEB_APP_URL = "https://mini-app-green-house.vercel.app/"  # Remplacez par l'URL réelle de votre Mini-App

# Variables de sécurité intégrées
SECURITY_CONFIG = {
    'MAX_REQUESTS_PER_HOUR': 100,
    'RATE_LIMIT_WINDOW': 3600,
    'MAX_MESSAGE_LENGTH': 1000,
    'ALLOWED_DOMAINS': ['telegram.org', 't.me', 'vercel.app'],
    'BLOCKED_KEYWORDS': ['script', 'javascript', 'eval', 'function', 'alert']
}

# Admins autorisés à utiliser les commandes sensibles
ADMIN_IDS = [123456789]  # Remplacez par votre ID Telegram réel

# Fichier local de persistance des utilisateurs ayant lancé /start
USERS_FILE = "bot_users.json"
REVIEWS_FILE = "reviews.json"
ORDERS_FILE = "orders.json"

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
}

# Stockage en mémoire pour rate limiting
user_requests = defaultdict(list)
blocked_users = set()

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)


def api_json_response(payload, status=200):
    """Réponse JSON avec entêtes CORS pour l'API locale."""
    return web.json_response(payload, status=status, headers=CORS_HEADERS)


def load_saved_users():
    """Charge la liste des users enregistrés depuis le fichier local."""
    if not os.path.exists(USERS_FILE):
        return {}
    try:
        with open(USERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception as e:
        logging.error(f"Erreur chargement users: {e}")
    return {}


def save_users_map(users_map):
    """Sauvegarde la liste des users enregistrés dans le fichier local."""
    try:
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(users_map, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logging.error(f"Erreur sauvegarde users: {e}")


def register_started_user(user):
    """Ajoute/met à jour un utilisateur ayant lancé /start."""
    if not user:
        return
    users_map = load_saved_users()
    user_id = str(user.id)
    users_map[user_id] = {
        "id": user.id,
        "username": user.username or "",
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "is_bot": bool(user.is_bot),
        "updated_at": int(time.time())
    }
    save_users_map(users_map)


def load_reviews_data():
    """Charge les avis au format {pending, approved}. Migre l'ancien format flat."""
    if not os.path.exists(REVIEWS_FILE):
        return {'pending': [], 'approved': []}
    try:
        with open(REVIEWS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            return {'pending': [], 'approved': data}
        if isinstance(data, dict):
            data.setdefault('pending', [])
            data.setdefault('approved', [])
            return data
    except Exception as e:
        logging.error(f"Erreur chargement avis: {e}")
    return {'pending': [], 'approved': []}


def save_reviews_data(data):
    """Sauvegarde les avis au format {pending, approved}."""
    try:
        with open(REVIEWS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logging.error(f"Erreur sauvegarde avis: {e}")


def load_saved_reviews():
    """Retourne uniquement les avis approuvés (compatibilité frontend)."""
    return load_reviews_data().get('approved', [])


def save_reviews_list(reviews):
    """Compatibilité : remplace la liste approuvée."""
    data = load_reviews_data()
    data['approved'] = reviews
    save_reviews_data(data)


def load_all_orders():
    """Charge toutes les commandes sauvegardées."""
    if not os.path.exists(ORDERS_FILE):
        return []
    try:
        with open(ORDERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        logging.error(f"Erreur chargement commandes: {e}")
    return []


def save_all_orders(orders):
    """Sauvegarde la liste des commandes."""
    try:
        with open(ORDERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(orders, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logging.error(f"Erreur sauvegarde commandes: {e}")


def load_admin_whitelist():
    """Retourne l'ensemble des usernames admin depuis config.json."""
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        whitelist = cfg.get('admin', {}).get('whitelist', [])
        return {str(u).lstrip('@').lower() for u in whitelist}
    except Exception:
        return set()


def is_admin_user(username):
    """Vérifie si un username Telegram est admin."""
    if not username:
        return False
    return str(username).lstrip('@').lower() in load_admin_whitelist()


def normalize_review_payload(payload):
    """Valide et normalise le payload d'un avis entrant."""
    if not isinstance(payload, dict):
        return None

    author = str(payload.get('author', '')).strip()[:64]
    message = str(payload.get('message', '')).strip()[:1000]
    if not author or not message:
        return None

    try:
        stars = int(payload.get('stars', 5))
    except (TypeError, ValueError):
        stars = 5
    stars = max(1, min(5, stars))

    ts_raw = payload.get('timestamp')
    try:
        timestamp = int(ts_raw)
    except (TypeError, ValueError):
        timestamp = int(time.time() * 1000)

    user_id_raw = payload.get('telegramUserId')
    try:
        telegram_user_id = int(user_id_raw) if user_id_raw is not None else None
    except (TypeError, ValueError):
        telegram_user_id = None

    username = payload.get('telegramUsername')
    telegram_username = str(username).strip()[:64] if username else None

    return {
        'author': author,
        'stars': stars,
        'message': message,
        'timestamp': timestamp,
        'telegramUserId': telegram_user_id,
        'telegramUsername': telegram_username
    }

def validate_telegram_data(data, bot_token):
    """Valide l'authenticité des données Telegram"""
    try:
        auth_date = int(data.get('auth_date', 0))
        if time.time() - auth_date > 3600:  # Données trop anciennes
            return False
            
        check_hash = data.pop('hash', '')
        data_check_string = '\n'.join([f"{k}={v}" for k, v in sorted(data.items())])
        secret_key = hashlib.sha256(bot_token.encode()).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        
        return calculated_hash == check_hash
    except Exception as e:
        logging.error(f"Erreur validation Telegram: {e}")
        return False

def rate_limit_check(user_id):
    """Vérifie le rate limiting pour un utilisateur"""
    if user_id in blocked_users:
        return False
        
    now = time.time()
    user_reqs = user_requests[user_id]
    
    # Nettoyer les anciennes requêtes
    user_reqs[:] = [req_time for req_time in user_reqs if now - req_time < SECURITY_CONFIG['RATE_LIMIT_WINDOW']]
    
    if len(user_reqs) >= SECURITY_CONFIG['MAX_REQUESTS_PER_HOUR']:
        blocked_users.add(user_id)
        logging.warning(f"Utilisateur {user_id} bloqué pour trop de requêtes")
        return False
        
    user_reqs.append(now)
    return True

def sanitize_input(text):
    """Nettoie et valide les entrées utilisateur"""
    if not text or len(text) > SECURITY_CONFIG['MAX_MESSAGE_LENGTH']:
        return None
        
    # Vérifier les mots-clés suspects
    text_lower = text.lower()
    for keyword in SECURITY_CONFIG['BLOCKED_KEYWORDS']:
        if keyword in text_lower:
            logging.warning(f"Mot-clé suspect détecté: {keyword}")
            return None
            
    return text.strip()

def security_middleware(func):
    """Décorateur de sécurité pour toutes les fonctions"""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user = update.effective_user
        user_id = user.id if user else None
        
        # Log de sécurité
        logging.info(f"Requête de {user_id} ({user.username if user else 'Inconnu'})")
        
        # Vérifier rate limiting
        if not rate_limit_check(user_id):
            await update.message.reply_text(
                "⚠️ Trop de requêtes. Veuillez patienter avant de réessayer."
            )
            return
            
        # Valider le message
        if update.message and update.message.text:
            sanitized = sanitize_input(update.message.text)
            if sanitized is None:
                await update.message.reply_text(
                    "⚠️ Message non valide détecté."
                )
                return
                
        try:
            return await func(update, context)
        except Exception as e:
            logging.error(f"Erreur dans {func.__name__}: {e}")
            await update.message.reply_text(
                "❌ Une erreur s'est produite. Veuillez réessayer."
            )
            
    return wrapper

@security_middleware
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Commande /start sécurisée qui lance la Mini-App avec options multiples"""
    # Enregistre l'utilisateur pour les diffusions futures.
    register_started_user(update.effective_user)

    web_app = WebAppInfo(url=WEB_APP_URL)
    
    # Créer un clavier inline avec plusieurs options - Canal et Contact en haut, Carte mise en valeur en bas
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("📢 Canal Officiel", url="https://t.me/+my0XrYsNth80OGE0"), 
         InlineKeyboardButton("💬 Nous contacter", url="https://t.me/GreenHouse682")],
        [InlineKeyboardButton("📖 VOIR LA CARTE 📖", web_app=web_app)]
    ])
    
    # Message d'accueil avec image et texte simplifié
    await update.message.reply_photo(
        photo="https://i.ibb.co/s90Zz4K9/background-2.png",
        caption="*🕵🏻 Bienvenue chez GreenHouse !*\n\nSi vous souhaitez faire une commande ou nous contacter, utilisez les options ci-dessous.",
        parse_mode="Markdown",
        reply_markup=keyboard
    )

@security_middleware
async def menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Commande /menu sécurisée pour accéder directement au menu"""
    web_app = WebAppInfo(url=WEB_APP_URL)
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("🍕 Voir le Menu", web_app=web_app)]
    ])
    
    await update.message.reply_text(
        "🍽️ Consultez notre menu :",
        reply_markup=keyboard
    )

@security_middleware
async def security_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Commande pour vérifier le statut de sécurité (admin uniquement)"""
    user_id = update.effective_user.id
    
    if user_id not in ADMIN_IDS:
        await update.message.reply_text("❌ Accès refusé.")
        return
        
    total_requests = sum(len(reqs) for reqs in user_requests.values())
    blocked_count = len(blocked_users)
    
    status_msg = f"""🛡️ **Statut de Sécurité**
    
📊 Requêtes totales: {total_requests}
🚫 Utilisateurs bloqués: {blocked_count}
⏰ Fenêtre de limitation: {SECURITY_CONFIG['RATE_LIMIT_WINDOW']}s
🔢 Max requêtes/heure: {SECURITY_CONFIG['MAX_REQUESTS_PER_HOUR']}
    """
    
    await update.message.reply_text(status_msg, parse_mode='Markdown')


@security_middleware
async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Envoie un message à tous les users ayant utilisé /start."""
    user_id = update.effective_user.id if update.effective_user else None
    if user_id not in ADMIN_IDS:
        await update.message.reply_text("❌ Accès refusé.")
        return

    message = " ".join(context.args).strip() if context.args else ""
    if not message:
        await update.message.reply_text("Usage: /broadcast Votre message")
        return

    users_map = load_saved_users()
    if not users_map:
        await update.message.reply_text("Aucun utilisateur enregistré.")
        return

    sent = 0
    failed = 0

    for user_key, user_data in list(users_map.items()):
        target_id = user_data.get("id")
        if not target_id:
            failed += 1
            continue
        try:
            await context.bot.send_message(chat_id=target_id, text=message)
            sent += 1
        except Exception as e:
            failed += 1
            logging.warning(f"Broadcast impossible vers {target_id}: {e}")

    await update.message.reply_text(
        f"Broadcast terminé. Envoyés: {sent} | Échecs: {failed}"
    )

async def save_config_api(request):
    """Endpoint API pour sauvegarder config.json localement"""
    try:
        # Vérifier la méthode
        if request.method != 'POST':
            return api_json_response({'error': 'Method not allowed'}, status=405)
        
        # Lire les données JSON
        data = await request.json()
        
        # Valider que c'est bien une configuration valide
        required_keys = ['restaurant', 'categories', 'products', 'admin']
        if not all(key in data for key in required_keys):
            return api_json_response({'error': 'Invalid configuration format'}, status=400)
        
        # Sauvegarder dans config.json localement
        config_path = 'config.json'
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        logging.info(f"✅ Configuration sauvegardée localement dans {config_path}")
        
        return api_json_response({
            'success': True, 
            'persisted': True,
            'message': 'Configuration sauvegardée avec succès'
        })
        
    except Exception as e:
        logging.error(f"Erreur lors de la sauvegarde: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def get_reviews_api(request):
    """Retourne uniquement les avis approuvés pour le frontend."""
    try:
        approved = load_reviews_data().get('approved', [])
        return api_json_response({
            'success': True,
            'reviews': approved,
            'count': len(approved)
        })
    except Exception as e:
        logging.error(f"Erreur lecture avis: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def save_review_api(request):
    """Sauvegarde un avis en attente de validation admin."""
    try:
        if request.method != 'POST':
            return api_json_response({'error': 'Method not allowed'}, status=405)

        payload = await request.json()
        review = normalize_review_payload(payload)
        if review is None:
            return api_json_response({'error': 'Invalid review payload'}, status=400)

        data = load_reviews_data()
        data['pending'].append(review)
        if len(data['pending']) > 500:
            data['pending'] = data['pending'][-500:]
        save_reviews_data(data)

        return api_json_response({'success': True, 'saved': True, 'status': 'pending'})
    except Exception as e:
        logging.error(f"Erreur sauvegarde avis: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def admin_pending_reviews_api(request):
    """Retourne les avis en attente (admin uniquement)."""
    try:
        username = request.rel_url.query.get('tg_username', '')
        if not is_admin_user(username):
            return api_json_response({'error': 'Forbidden'}, status=403)
        data = load_reviews_data()
        return api_json_response({'success': True, 'pending': data.get('pending', [])})
    except Exception as e:
        logging.error(f"Erreur admin avis: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def admin_approve_review_api(request):
    """Approuve un avis en attente."""
    if request.method != 'POST':
        return api_json_response({'error': 'Method not allowed'}, status=405)
    try:
        payload = await request.json()
        if not is_admin_user(payload.get('tg_username', '')):
            return api_json_response({'error': 'Forbidden'}, status=403)
        ts = payload.get('timestamp')
        if ts is None:
            return api_json_response({'error': 'Missing timestamp'}, status=400)
        data = load_reviews_data()
        match = next((r for r in data['pending'] if r.get('timestamp') == ts), None)
        if not match:
            return api_json_response({'error': 'Review not found'}, status=404)
        data['pending'].remove(match)
        data['approved'].append(match)
        if len(data['approved']) > 1000:
            data['approved'] = data['approved'][-1000:]
        save_reviews_data(data)
        return api_json_response({'success': True})
    except Exception as e:
        logging.error(f"Erreur approbation avis: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def admin_reject_review_api(request):
    """Rejette (supprime) un avis en attente."""
    if request.method != 'POST':
        return api_json_response({'error': 'Method not allowed'}, status=405)
    try:
        payload = await request.json()
        if not is_admin_user(payload.get('tg_username', '')):
            return api_json_response({'error': 'Forbidden'}, status=403)
        ts = payload.get('timestamp')
        if ts is None:
            return api_json_response({'error': 'Missing timestamp'}, status=400)
        data = load_reviews_data()
        data['pending'] = [r for r in data['pending'] if r.get('timestamp') != ts]
        save_reviews_data(data)
        return api_json_response({'success': True})
    except Exception as e:
        logging.error(f"Erreur rejet avis: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def save_order_api(request):
    """Sauvegarde une commande depuis le frontend."""
    if request.method != 'POST':
        return api_json_response({'error': 'Method not allowed'}, status=405)
    try:
        payload = await request.json()
        order_type = str(payload.get('type', '')).strip()[:20]
        total_raw = payload.get('total', 0)
        total = float(total_raw) if isinstance(total_raw, (int, float)) else 0.0
        summary = str(payload.get('summary', '')).strip()[:500]
        ts_raw = payload.get('timestamp')
        timestamp = int(ts_raw) if ts_raw else int(time.time() * 1000)
        tg_id = payload.get('telegramUserId')
        tg_user = str(payload.get('telegramUsername', '')).strip()[:64] if payload.get('telegramUsername') else None
        if not order_type or total <= 0:
            return api_json_response({'error': 'Invalid order'}, status=400)
        orders = load_all_orders()
        orders.append({
            'id': int(payload.get('id', len(orders) + 1)),
            'type': order_type,
            'total': total,
            'summary': summary,
            'timestamp': timestamp,
            'telegramUserId': int(tg_id) if tg_id is not None else None,
            'telegramUsername': tg_user
        })
        if len(orders) > 5000:
            orders = orders[-5000:]
        save_all_orders(orders)
        return api_json_response({'success': True})
    except Exception as e:
        logging.error(f"Erreur sauvegarde commande: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def admin_orders_api(request):
    """Retourne les dernières commandes (admin uniquement)."""
    try:
        username = request.rel_url.query.get('tg_username', '')
        if not is_admin_user(username):
            return api_json_response({'error': 'Forbidden'}, status=403)
        orders = load_all_orders()
        return api_json_response({'success': True, 'orders': list(reversed(orders[-200:]))})
    except Exception as e:
        logging.error(f"Erreur admin commandes: {e}")
        return api_json_response({'error': str(e)}, status=500)


async def options_handler(request):
    """Réponse CORS aux requêtes preflight OPTIONS."""
    return web.Response(status=204, headers=CORS_HEADERS)

async def post_init(application: Application):
    """Fonction exécutée après l'initialisation du bot"""
    # Simuler l'exécution de la commande security au démarrage
    # Créer un faux update pour appeler la fonction security_status
    logging.info("Exécution automatique de la commande security au démarrage...")
    
    # Récupérer les statistiques de sécurité
    total_requests = sum(len(reqs) for reqs in user_requests.values())
    blocked_count = len(blocked_users)
    
    status_msg = f"""🛡️ **Statut de Sécurité au démarrage**
    
📊 Requêtes totales: {total_requests}
🚫 Utilisateurs bloqués: {blocked_count}
⏰ Fenêtre de limitation: {SECURITY_CONFIG['RATE_LIMIT_WINDOW']}s
🔢 Max requêtes/heure: {SECURITY_CONFIG['MAX_REQUESTS_PER_HOUR']}
    """
    
    logging.info(status_msg)
    
    # Démarrer le serveur API pour sauvegarder config.json
    app = web.Application()
    app.router.add_route('OPTIONS', '/{tail:.*}', options_handler)
    app.router.add_post('/save-config', save_config_api)
    app.router.add_get('/reviews', get_reviews_api)
    app.router.add_post('/save-review', save_review_api)
    app.router.add_get('/admin/reviews/pending', admin_pending_reviews_api)
    app.router.add_post('/admin/reviews/approve', admin_approve_review_api)
    app.router.add_post('/admin/reviews/reject', admin_reject_review_api)
    app.router.add_post('/save-order', save_order_api)
    app.router.add_get('/admin/orders', admin_orders_api)
    
    # Démarrer le serveur sur un port différent (par exemple 8080)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', 3000)
    await site.start()
    logging.info("API locale démarrée sur http://localhost:3000 (save-config, reviews, save-review)")

def main():
    """Fonction principale avec gestion d'erreurs renforcée"""
    try:
        # Créer l'application sans utiliser directement l'Updater
        builder = Application.builder()
        application = builder.token(BOT_TOKEN).post_init(post_init).build()
        
        # Handlers sécurisés
        application.add_handler(CommandHandler("start", start))
        application.add_handler(CommandHandler("menu", menu))
        application.add_handler(CommandHandler("security", security_status))
        application.add_handler(CommandHandler("broadcast", broadcast))
        
        logging.info("🛡️ Bot GreenHouse démarré avec sécurité renforcée")
        
        # Démarrer le bot avec des paramètres explicites
        application.run_polling(allowed_updates=["message", "callback_query"])
        
    except Exception as e:
        logging.critical(f"Erreur critique au démarrage: {e}")
        raise

if __name__ == '__main__':
    main()