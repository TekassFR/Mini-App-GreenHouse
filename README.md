# GreenHouse 68 — Mini-App Telegram

Boutique Telegram de GreenHouse 68 : catalogue photo et vidéo, panier, commande envoyée à l'admin par message Telegram, avis clients, et gestion de la boutique directement dans la mini-app.

```
Client Telegram ──▶ Vercel (ce dépôt) ──▶ tunnel Cloudflare ──▶ willy.py (VPS Windows) ──▶ Neon (PostgreSQL)
                         │                                                                  ▲
                         └──────────── secours : api/config.js et api/proxy.js ─────────────┘
```

- **Ce dépôt** contient le site, servi par Vercel, et des fonctions serverless de secours.
- **`willy.py`** n'est pas dans ce dépôt. Il tourne sur le VPS (port 4001) et fait trois choses : bot Telegram, API, et service des photos et vidéos (`/uploads/`).
- Au démarrage, le bot ouvre un tunnel Cloudflare et publie son adresse dans la base (`api_base`). La mini-app lit cette adresse et parle directement au VPS.
- Si le VPS ne répond pas, les fonctions Vercel lisent et écrivent directement dans Neon. L'envoi et l'affichage des photos et vidéos passent toujours par le VPS.

## Contenu du dépôt

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `script.js` | Le site : boutique et gestion |
| `api/config.js` | `/config` de secours : catalogue lu directement dans Neon |
| `api/proxy.js` | Secours des autres routes (avis, commandes, gestion) et relais de `/uploads/` vers le VPS |
| `vercel.json` | Redirige `/config`, `/reviews`, `/save-*`, `/admin/*` et `/uploads/*` vers les fonctions |
| `config.json`, `reviews.json` | Copies statiques, dernier recours si ni le VPS ni Neon ne répondent |
| `manifest.json`, `logo.png`, `background.png` | Icône et visuels |

Ces fichiers restent **uniquement sur le VPS** et ne vont jamais sur GitHub (`.gitignore` et exclusions locales) : `willy.py`, `.env`, `CONFIG_CLIENT.json`, `setup.py`, `setup.bat`, `start.bat`, `bot_users.json`, `uploads/` et `bot.log`.

## Variables d'environnement Vercel

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | URL de la base Neon, la même que celle du bot |
| `TELEGRAM_BOT_TOKEN` | Token du bot, qui sert à vérifier la signature Telegram (initData) des commandes, des avis et des actions de gestion |

## Mettre à jour le site

1. Créer une branche et ouvrir une pull request. Pas de push direct sur `main`.
2. Vercel déploie une prévisualisation de la PR. Au merge, `main` part en production.
3. Les fichiers du VPS (`willy.py`, `.env`…) ne passent pas par GitHub. On les modifie sur place, puis on redémarre le bot.

## Côté VPS

- **Service** : le bot tourne en tâche planifiée Windows `MiniApp-GreenHouse68`, gérée par `bots.ps1` (`-Action status`, `start`, `stop` ou `restart`). Il faut le lancer en PowerShell administrateur.
- **Tunnel** : un chien de garde vérifie le tunnel toutes les 60 s, le relance s'il tombe et republie son adresse. Le journal est dans `bot.log`.
- **Redémarrer depuis le téléphone** : Gestion → Réglages → Bot → « Redémarrer le bot ».
- **Configuration** : `willy.py` lit `.env` (token du bot, URL Neon, port, admins). Ce fichier est généré par `setup.bat` à partir de `CONFIG_CLIENT.json`.
- **Commandes du bot** :
  - `/start` : message et photo d'accueil, avec le bouton de la boutique ;
  - `/menu` : bouton de la boutique ;
  - pour les admins listés dans `ADMIN_IDS` : `/broadcast <message>` envoie un message à tous les clients, et `/security` affiche les compteurs anti-abus.

## Gestion dans la mini-app

La gestion est ouverte aux pseudos Telegram listés dans Réglages → « Accès à la gestion ». À la première connexion vérifiée, le compte Telegram est lié à son pseudo. La liste indique pour chaque pseudo s'il est déjà « lié » ou « en attente de première connexion ».

| Onglet | Contenu |
|---|---|
| Avis | Avis clients en attente et publiés |
| Commandes | Commandes enregistrées (type, total, détail, client) |
| Produits | Ajout et modification. La photo et la vidéo s'envoient depuis le téléphone (95 Mo max, vidéos converties en H.264 sur le VPS). « Prix par quantité » définit des paliers : `5: 70` veut dire 5G pour 70 € |
| Catégories | Nom et emoji des catégories |
| Réglages | Boutique (nom, sous-titre, devise, commande min., livraison), Telegram (pseudo de contact, lien du canal), banderole défilante, accueil du bot (`/start`), musique, accès à la gestion, redémarrage du bot |

## Panier et commandes

- Le panier et l'historique sont gardés sur le téléphone du client (localStorage, par compte Telegram).
- Un produit à paliers donne une ligne par palier, par exemple « Produit (5G) », comptée au prix du palier. Le + et le − changent le nombre de sachets.
- Un produit sans palier se vend à l'unité : aucun poids n'est affiché sur la fiche, dans le message d'ajout ni dans le panier.
- « Commander » fait deux choses :
  - il ouvre une conversation Telegram avec l'admin, avec le message déjà rempli (détail et total) ;
  - il enregistre la commande (`/save-order`), qui apparaît dans Gestion → Commandes.

## Dépannage

| Symptôme | Piste |
|---|---|
| Boutique vide ou « Impossible de charger la boutique » | `bots.ps1 -Action status`, puis `bot.log` |
| Photos ou vidéos qui ne s'affichent plus | Elles sont servies par le VPS : vérifier que le bot et le tunnel tournent |
| « Session expirée » dans la gestion | La signature Telegram dure 1 h : fermer puis rouvrir la mini-app |
| Envoi de vidéo refusé | 95 Mo maximum (le tunnel Cloudflare coupe à 100 Mo) |
| Un second bot s'arrête au lancement (code 3) | Une instance tourne déjà sur le port 4001 |
