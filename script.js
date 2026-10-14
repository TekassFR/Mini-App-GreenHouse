(function () {
    "use strict";

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    const introTitle = document.querySelector(".intro-card h1");
    // Déjà découpé par willy.py (index_with_appearance) : les lettres s'animent depuis le premier affichage, on n'y touche pas
    if (introTitle && !introTitle.classList.contains("split")) {
        // Nom de la boutique de la dernière visite (Réglages › Général, gardé par rememberIntroAppearance
        // sous la clé INTRO_STORAGE_KEY) : écrit avant le découpage en lettres
        try {
            const savedIntro = JSON.parse(localStorage.getItem("gh_intro_v1") || "null");
            const savedName = savedIntro && typeof savedIntro.name === "string" ? savedIntro.name.trim() : "";
            if (savedName) introTitle.textContent = savedName.slice(0, 60);
        } catch (_) { }
        const letters = [...introTitle.textContent.trim()].map((ch, i) => {
            const span = document.createElement("span");
            span.textContent = ch === " " ? " " : ch;
            span.style.setProperty("--i", i);
            return span;
        });
        introTitle.replaceChildren(...letters);
        introTitle.classList.add("split");
    }

    const THEME_COLOR_STORAGE_KEY = "gh_theme_color";

    // Couleur du thème (réglage theme_color, sinon la meta brand-color) : --accent et toutes les
    // variables qui en dérivent, pour la boutique comme pour le panel. Une valeur qui n'est pas #rrggbb est ignorée.
    function applyBrandColor(color) {
        const meta = document.querySelector('meta[name="brand-color"]');
        const wanted = String(color || "").trim();
        const hex = /^#[0-9a-f]{6}$/i.test(wanted) ? wanted : (meta ? meta.content.trim() : "");
        if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const [r, g, b] = rgb.map((v) => v / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
        }
        h = Math.round(h * 60 + 360) % 360;
        const root = document.documentElement.style;
        root.setProperty("--accent", hex);
        root.setProperty("--accent-rgb", rgb.join(", "));
        root.setProperty("--accent-2", `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(Math.max(l - 0.22, 0.15) * 100)}%)`);
        root.setProperty("--accent-ink", `hsl(${h}, 40%, 9%)`);
    }

    // Dernière couleur connue de ce navigateur, posée avant le chargement de la config (pas de flash de l'ancienne couleur)
    function storedThemeColor() {
        try {
            return localStorage.getItem(THEME_COLOR_STORAGE_KEY) || "";
        } catch (_) {
            return "";
        }
    }

    function rememberThemeColor(color) {
        try {
            if (/^#[0-9a-f]{6}$/i.test(String(color || ""))) localStorage.setItem(THEME_COLOR_STORAGE_KEY, color);
            else localStorage.removeItem(THEME_COLOR_STORAGE_KEY);
        } catch (_) { }
    }

    // Apparence actuelle écrite dans index.html par willy.py (index_with_appearance) : prime sur celle de la dernière
    // visite, que le localStorage perd à chaque nouvelle adresse du tunnel
    function pageAppearance() {
        const look = window.__SHOP_APPEARANCE__;
        return look && typeof look === "object" ? look : {};
    }

    applyBrandColor(pageAppearance().theme_color || storedThemeColor());

    function getHashParam(name) {
        const raw = String(window.location.hash || "").replace(/^#/, "");
        if (!raw) return "";
        const params = new URLSearchParams(raw);
        return String(params.get(name) || "").toLowerCase();
    }

    // Plateforme Telegram du client (android, ios, tdesktop, weba…), envoyée au serveur avec /config, /save-order
    // et /save-review : c'est lui seul qui décide du contrôle « mobile uniquement » (plus aucun blocage côté page)
    function telegramPlatform() {
        const platform = tg && typeof tg.platform === "string" ? tg.platform.trim().toLowerCase() : "";
        const value = platform && platform !== "unknown" ? platform : (getHashParam("tgWebAppPlatform") || platform);
        return /^[a-z0-9_]{1,32}$/.test(value) ? value : "";
    }

    const state = {
        config: null,
        products: [],
        categories: [],
        category: "all",
        cart: [],
        orderType: "delivery",
        selectedProduct: null,
        selectedQty: null,
        selectedWeight: null,
        selectedPrice: 0,
        detailMedia: "image",
        reviews: [],
        orders: [],
        language: "fr",
        storageScope: "guest",
        // access de la dernière config /config (null = pas encore lue) : jamais écrasé par la config admin
        access: null
    };

    // URL de repli locale (vide par défaut, la configuration Neon admin_settings.api_base prévaut)
    const LOCAL_API_BASE = "";

    function normalizeApiBase(base) {
        let raw = String(base || "").trim();
        if (!raw) return "";
        if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
        return raw.replace(/\/+$/, "");
    }

    // Seule une URL de tunnel Cloudflare (celle publiée par willy.py) est acceptée comme serveur :
    // une api_base détournée ne peut ni recevoir l'initData admin ni servir les médias.
    // (À adapter si un jour le tunnel utilise un nom de domaine fixe.)
    const TRUSTED_API_BASE_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;
    const API_BASE_STORAGE_KEY = "gh_write_api_base_v2";

    function trustedApiBase(base) {
        const normalized = normalizeApiBase(base);
        return TRUSTED_API_BASE_RE.test(normalized) ? normalized : "";
    }

    function getStoredWriteApiBase() {
        try {
            localStorage.removeItem("gh_write_api_base"); // ancienne clé, non vérifiée
            return trustedApiBase(localStorage.getItem(API_BASE_STORAGE_KEY) || "");
        } catch (_) {
            return "";
        }
    }

    function setStoredWriteApiBase(base) {
        try {
            const trusted = trustedApiBase(base);
            if (!trusted) localStorage.removeItem(API_BASE_STORAGE_KEY);
            else localStorage.setItem(API_BASE_STORAGE_KEY, trusted);
        } catch (_) { }
    }

    // Page servie par willy.py (tunnel ou poste local) : son origine EST le serveur, essayée en premier ;
    // l'api_base de la config et celle mémorisée ne sont alors que des replis (sinon : site statique)
    function getWriteApiBases() {
        const configuredBase = state && state.config && state.config.admin && state.config.admin.api_base
            ? trustedApiBase(state.config.admin.api_base)
            : "";
        const storedBase = getStoredWriteApiBase();
        const originBase = window.location && /^https?:/i.test(String(window.location.origin || ""))
            ? normalizeApiBase(window.location.origin)
            : "";
        const ordered = pageServesUploads() ? [originBase, configuredBase, storedBase] : [configuredBase, storedBase, originBase];

        return Array.from(new Set(ordered.filter(b => typeof b === "string" && b !== "" && !b.includes("ngrok"))));
    }

    async function readJsonIfAny(resp) {
        const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("application/json")) return null;
        try {
            return await resp.json();
        } catch (_) {
            return null;
        }
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const reqOpts = Object.assign({}, options || {});
        if (controller) reqOpts.signal = controller.signal;
        try {
            const response = await fetch(url, reqOpts);
            if (timer) clearTimeout(timer);
            return response;
        } catch (err) {
            if (timer) clearTimeout(timer);
            throw err;
        }
    }

    async function fetchWriteApi(path, options, timeoutMs = 6000) {
        const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
        const bases = getWriteApiBases();
        let lastError = null;

        for (const base of bases) {
            const url = `${base}${normalizedPath}`;
            try {
                const resp = await fetchWithTimeout(url, options, timeoutMs);
                if (resp.ok) return resp;

                // Si le serveur répond en JSON (même en erreur), on renvoie la réponse
                // pour afficher un message utile plutôt qu'un faux "serveur inaccessible".
                const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
                if (contentType.includes("application/json")) return resp;
                lastError = new Error(`HTTP ${resp.status}`);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("API d'écriture indisponible");
    }

    const els = {
        intro: document.getElementById("intro-screen"),
        introSub: document.getElementById("intro-sub"),
        brandSubtitle: document.getElementById("brand-subtitle"),
        tickerTexts: document.querySelectorAll(".ticker-text"),
        musicPlayer: document.getElementById("music-player"),
        musicToggle: document.getElementById("mp-toggle"),
        musicTitle: document.getElementById("mp-title"),
        musicPlay: document.getElementById("mp-play"),
        musicPrev: document.getElementById("mp-prev"),
        musicNext: document.getElementById("mp-next"),
        musicMute: document.getElementById("mp-mute"),
        musicVolume: document.getElementById("mp-volume"),
        userChip: document.getElementById("user-chip"),
        categoryTabs: document.getElementById("category-tabs"),
        productGrid: document.getElementById("product-grid"),
        pages: document.querySelectorAll(".page"),
        tabs: document.querySelectorAll(".tab-btn"),
        navProfileAvatar: document.getElementById("nav-profile-avatar"),
        navProfilePhoto: document.getElementById("nav-profile-photo"),
        navProfileLetter: document.getElementById("nav-profile-letter"),

        cartTitle: document.getElementById("cart-title"),
        cartDesc: document.getElementById("cart-desc"),
        cartEmptyState: document.getElementById("cart-empty-state"),
        cartContent: document.getElementById("cart-content"),
        cartItems: document.getElementById("cart-items"),
        cartTotalLabel: document.getElementById("cart-total-label"),
        cartTotal: document.getElementById("cart-total"),
        cartFeeLine: document.getElementById("cart-fee-line"),
        clearCartBtn: document.getElementById("clear-cart-btn"),
        checkoutBtn: document.getElementById("checkout-btn"),
        serviceDeliveryBtn: document.getElementById("service-delivery-btn"),
        servicePickupBtn: document.getElementById("service-pickup-btn"),
        deliveryLabel: document.getElementById("delivery-label"),
        pickupLabel: document.getElementById("pickup-label"),
        deliveryAddress: document.getElementById("delivery-address"),
        pickupTime: document.getElementById("pickup-time"),
        deliveryFieldGroup: document.getElementById("delivery-field-group"),
        pickupFieldGroup: document.getElementById("pickup-field-group"),
        serviceSwitch: document.getElementById("service-switch"),

        historyTitle: document.getElementById("history-title"),
        historyDesc: document.getElementById("history-desc"),
        historyList: document.getElementById("history-list"),
        reviewsTitle: document.getElementById("reviews-title"),
        reviewsDesc: document.getElementById("reviews-desc"),
        reviewList: document.getElementById("review-list"),
        reviewForm: document.getElementById("review-form"),
        reviewFormTitle: document.getElementById("review-form-title"),
        reviewAuthorLabel: document.getElementById("review-author-label"),
        reviewAuthor: document.getElementById("review-author"),
        reviewStarsLabel: document.getElementById("review-stars-label"),
        reviewStars: document.getElementById("review-stars"),
        reviewMessageLabel: document.getElementById("review-message-label"),
        reviewMessage: document.getElementById("review-message"),
        reviewSubmitBtn: document.getElementById("review-submit-btn"),
        reviewRating: document.getElementById("review-rating"),
        reviewCount: document.getElementById("review-count"),

        profileName: document.getElementById("profile-name"),
        profileAvatar: document.getElementById("profile-avatar"),
        profileUsername: document.getElementById("profile-username"),
        profileOrderCount: document.getElementById("profile-order-count"),
        profileTotalSpent: document.getElementById("profile-total-spent"),
        profileMemberFull: document.getElementById("profile-member-full"),
        profileMemberShort: document.getElementById("profile-member-short"),
        profileOrdersPreview: document.getElementById("profile-orders-preview"),
        profileOrdersRefresh: document.getElementById("profile-orders-refresh"),
        profileStatOrders: document.getElementById("profile-stat-orders"),
        profileStatSpent: document.getElementById("profile-stat-spent"),
        profileStatMember: document.getElementById("profile-stat-member"),
        profileOrdersTitle: document.getElementById("profile-orders-title"),
        shopLang: document.getElementById("shop-lang"),
        shopLangBtn: document.getElementById("shop-lang-btn"),
        shopLangFlag: document.getElementById("shop-lang-flag"),
        shopLangMenu: document.getElementById("shop-lang-menu"),
        profileAdminCard: document.getElementById("profile-admin-card"),
        adminPanelBtn: document.getElementById("admin-panel-btn"),
        adminOverlay: document.getElementById("admin-overlay"),
        adminCloseBtn: document.getElementById("admin-close-btn"),

        // Onglet Contact (page « info ») : bouton du canal, tuiles des réseaux, infos & conditions, « Signaler un problème »
        channelBtn: document.getElementById("channel-btn"),
        contactNetGrid: document.getElementById("contact-net-grid"),
        contactInfoList: document.getElementById("contact-info-list"),
        contactReportBtn: document.getElementById("contact-report-btn"),
        bottomNav: document.getElementById("bottom-nav"),

        accessScreen: document.getElementById("access-screen"),
        accessCard: document.getElementById("access-card"),
        accessStaffNote: document.getElementById("access-staff-note"),
        accessStaffNoteText: document.getElementById("access-staff-note-text"),
        accessStaffNoteClose: document.getElementById("access-staff-note-close"),

        detailOverlay: document.getElementById("detail-overlay"),
        detailCloseBtn: document.getElementById("detail-close-btn"),
        detailPanel: document.getElementById("detail-panel"),
        detailBrandImage: document.getElementById("detail-brand-image"),
        detailMediaWindow: document.getElementById("detail-media-window"),
        detailMediaTrack: document.getElementById("detail-media-track"),
        detailThumbs: document.getElementById("detail-thumbs"),
        detailPrevBtn: document.getElementById("detail-prev-btn"),
        detailNextBtn: document.getElementById("detail-next-btn"),
        detailSlideCount: document.getElementById("detail-slide-count"),
        detailName: document.getElementById("detail-name"),
        detailDescription: document.getElementById("detail-description"),
        detailCategoryChip: document.getElementById("detail-category-chip"),
        detailQtyGrid: document.getElementById("detail-qty-grid"),
        detailQtyTitle: document.getElementById("detail-qty-title"),
        detailSelectedPrice: document.getElementById("detail-selected-price"),
        detailAddBtn: document.getElementById("detail-add-btn"),
        detailMuteBtn: document.getElementById("detail-mute-btn"),
        detailFullscreenBtn: document.getElementById("detail-fullscreen-btn"),
        detailTeleBtn: document.getElementById("detail-tele-btn"),
        detailOrderLinks: document.getElementById("detail-order-links")
    };

    function getPrimaryTelegramUsername() {
        if (!state.config || !state.config.admin || !state.config.admin.telegram_username) {
            return "GreenHouse682"; // Valeur par défaut si la configuration n'est pas disponible
        }
        const parts = String(state.config.admin.telegram_username).split(/[\s,]+/).filter(Boolean);
        return parts[0] || "GreenHouse682";
    }

    let detailSlides = [];
    let detailSlideIndex = 0;
    let detailTouchStartX = 0;
    let detailTouchDeltaX = 0;

    const i18n = {
        fr: {
            introSub: "Chargement de la boutique...",
            brandSubtitle: "Menu premium 2026",
            greeting: "Salut {name}",
            heroKicker: "Boutique",
            heroTitle: "Produits classes, service rapide",
            navHome: "Accueil",
            navCart: "Panier",
            navHistory: "Historique",
            navReviews: "Avis",
            navProfile: "Profil",
            navInfo: "Contact",
            categoryAll: "Tous",
            categoryKeyLabel: "Categorie",
            categoryTypeLabel: "Type",
            badgeNew: "Nouveau",
            badgePromo: "Promo",
            badgeSoldOut: "Épuisé",
            soldOutToast: "Ce produit est épuisé pour le moment.",
            soldOutCartToast: "{name} est épuisé : retire-le du panier pour commander.",
            cardAddAria: "Ajouter {name} au panier",
            cartAdded: "{name} ajouté au panier ! 🛒",
            fromPrice: "Des {price}",
            view: "Voir",
            cartTitle: "Panier",
            cartDesc: "Finalise ta commande en quelques secondes.",
            cartEmpty: "Panier vide.",
            delivery: "Livraison",
            pickup: "Sur place",
            deliveryAddress: "Adresse de livraison",
            pickupTime: "Heure d'arrivee",
            deliveryPlaceholder: "Ex: 10 rue de la République, 68000 Colmar",
            total: "Total",
            clear: "Vider",
            checkout: "Commander",
            unitSuffix: " / unite",
            historyTitle: "Historique",
            historyDesc: "Retrouve toutes tes commandes.",
            noOrder: "Aucune commande pour le moment.",
            orderWord: "Commande",
            details: "Details",
            reviewsTitle: "Avis",
            reviewsDesc: "Ce que pensent les clients.",
            basedOn: "Base sur {count} avis",
            noReview: "Pas encore d'avis, sois le premier.",
            leaveReview: "Laisser un avis",
            name: "Nom",
            rating: "Note (1-5)",
            message: "Message",
            publish: "Publier",
            yourName: "Ton nom",
            yourFeedback: "Ton retour",
            profileLanguage: "Langue",
            langFr: "Français",
            langEn: "Anglais",
            langDe: "Allemand",
            profileOrders: "Mes Commandes",
            statOrders: "Commandes",
            statSpent: "Depense",
            statMember: "Membre depuis",
            memberSincePhrase: "Membre depuis {month} {year}",
            profileNoOrders: "Aucune commande pour le moment.",
            watchTitle: "Notifications",
            watchSubtitle: "Sois alerté en temps réel",
            watchNewTitle: "Nouveaux produits",
            watchNewDesc: "Quand un produit est ajouté",
            watchPromoTitle: "Promotions",
            watchPromoDesc: "Nouvelles promos et réductions",
            watchHint: "Les alertes arrivent en message privé du bot.",
            watchOn: "Alerte activée 🔔",
            watchOff: "Alerte désactivée",
            watchNeedBot: "Autorise le bot à t'écrire pour recevoir les alertes.",
            infoTitle: "Infos",
            infoDesc: "Horaires, contact et paiement.",
            deliveryTitle: "Livraison",
            hours: "Horaires:",
            delay: "Delai:",
            zone: "Zone:",
            contact: "Contact",
            contactBtn: "Contacter",
            channelBtn: "Rejoindre le canal",
            payment: "Paiement",
            cashOnly: "Paiement en especes uniquement.",
            detailBack: "← Retour",
            detailQty: "Selectionner la Quantite",
            unitLabel: "À l'unité",
            add: "Ajouter",
            slidePrev: "Media precedent",
            slideNext: "Media suivant",
            muteLabel: "Couper le son",
            unmuteLabel: "Activer le son",
            alertSelectQty: "Selectionne une quantite.",
            alertCartEmpty: "Panier vide.",
            alertAddress: "Adresse trop courte.",
            alertPickupTime: "Selectionne une heure d'arrivee.",
            alertPickupPast: "Cette heure est déjà passée : choisis une heure à venir.",
            ordersClosed: "Commandes fermées",
            ordersClosedToast: "Les commandes sont fermées pour le moment.",
            deliveryFeeLine: "Livraison : {fee}",
            deliveryFreeFrom: "offerte dès {amount}",
            deliveryFree: "Livraison offerte",
            orderNotSaved: "Commande transmise mais pas enregistrée sur le serveur : envoie bien le message Telegram.",
            alertReview: "Remplis le nom et le message.",
            askProduct: "Salut, je veux ce produit: {name}",
            orderText: "Nouvelle commande #{id}\nType: {type}\nDetails: {summary}\nTotal: {total}",
            orderOn: "Commander sur {name}",
            contactAlso: "Aussi sur",
            contactHeroTitle: "Contactez-nous",
            contactBubbleAsk: "Une question ?",
            contactBubbleReply: "Notre équipe te répond rapidement sur le réseau de ton choix.",
            contactWriteUs: "Nous écrire",
            contactReport: "Signaler un problème",
            contactInfoTitle: "Infos & conditions",
            contactMeetup: "Meetup possible",
            contactFree: "Gratuit",
            contactDeliveryFree: "Offerte",
            contactDelay: "Délai : {delay}",
            contactPostal: "Envoi postal sécurisé",
            contactMinOrder: "Commande min. : {amount}",
            contactCitiesOne: "1 ville desservie",
            contactCitiesMany: "{n} villes desservies",
            contactHours: "Horaires",
            contactZone: "Zone",
            gateRetry: "Réessayer",
            gateDone: "C'est fait, vérifier",
            gateClose: "Fermer",
            gateChecking: "Vérification…",
            gateStillBlocked: "Toujours bloqué pour le moment.",
            gateGranted: "Accès autorisé, bonne visite !",
            gateReopenLabel: "Réouverture à",
            gateTitleTelegram: "Ouvre la boutique depuis Telegram",
            gateTitleClosed: "Boutique fermée",
            gateTitleMobile: "Mobile uniquement",
            gateTitleVpn: "VPN détecté",
            gateTitleBackup: "Démarre notre bot backup",
            gateTitleChannel: "Rejoins notre canal",
            gateTitleVerification: "Vérification requise",
            gateTitleDefault: "Accès indisponible",
            gateStepReopen: "Ferme cette page, puis rouvre la boutique depuis le bot Telegram.",
            gateStepPhone: "Ouvre la boutique depuis l'app Telegram de ton téléphone.",
            gateStepVpn: "Coupe ton VPN ou ton proxy, puis réessaie.",
            gateStepStartBot: "Démarre le bot {bot}",
            gateStepJoin: "Rejoins le canal",
            gateStepBack: "Reviens ici : la boutique s'ouvre toute seule.",
            gateStepOpenBot: "Ouvre le bot {bot}",
            gateStepSendPhoto: "Envoie la photo demandée par le bot",
            gateStepWait: "Attends la validation d'un admin",
            gateStartBot: "Démarrer {bot}",
            gateJoinChannel: "Rejoindre le canal",
            gateOpenBot: "Ouvrir le bot",
            gatePending: "Vérification en cours",
            gatePendingHint: "Un admin vérifie ta demande. La boutique s'ouvrira toute seule dès qu'elle sera validée.",
            gateRejected: "Demande refusée",
            gateRejectedHint: "Ouvre le bot pour envoyer une nouvelle photo.",
            gateReasonLabel: "Motif :"
        },
        en: {
            introSub: "Loading shop...",
            brandSubtitle: "Premium menu 2026",
            greeting: "Hi {name}",
            heroKicker: "Shop",
            heroTitle: "Premium products, fast service",
            navHome: "Home",
            navCart: "Cart",
            navHistory: "History",
            navReviews: "Reviews",
            navProfile: "Profile",
            navInfo: "Contact",
            categoryAll: "All",
            categoryKeyLabel: "Category",
            categoryTypeLabel: "Type",
            badgeNew: "New",
            badgePromo: "Promo",
            badgeSoldOut: "Sold out",
            soldOutToast: "This product is sold out for now.",
            soldOutCartToast: "{name} is sold out: remove it from your cart to order.",
            cardAddAria: "Add {name} to cart",
            cartAdded: "{name} added to cart! 🛒",
            fromPrice: "From {price}",
            view: "View",
            cartTitle: "Cart",
            cartDesc: "Complete your order in seconds.",
            cartEmpty: "Cart is empty.",
            delivery: "Delivery",
            pickup: "Pickup",
            deliveryAddress: "Delivery address",
            pickupTime: "Pickup time",
            deliveryPlaceholder: "Ex: 10 Rue de la République, 68000 Colmar",
            total: "Total",
            clear: "Clear",
            checkout: "Order",
            unitSuffix: " / unit",
            historyTitle: "History",
            historyDesc: "Find all your orders.",
            noOrder: "No order yet.",
            orderWord: "Order",
            details: "Details",
            reviewsTitle: "Reviews",
            reviewsDesc: "What customers think.",
            basedOn: "Based on {count} reviews",
            noReview: "No review yet, be the first.",
            leaveReview: "Leave a review",
            name: "Name",
            rating: "Rating (1-5)",
            message: "Message",
            publish: "Publish",
            yourName: "Your name",
            yourFeedback: "Your feedback",
            profileLanguage: "Language",
            langFr: "French",
            langEn: "English",
            langDe: "German",
            profileOrders: "My Orders",
            statOrders: "Orders",
            statSpent: "Spent",
            statMember: "Member since",
            memberSincePhrase: "Member since {month} {year}",
            profileNoOrders: "No order yet.",
            watchTitle: "Notifications",
            watchSubtitle: "Get alerted in real time",
            watchNewTitle: "New products",
            watchNewDesc: "When a product is added",
            watchPromoTitle: "Promotions",
            watchPromoDesc: "New deals and discounts",
            watchHint: "Alerts arrive as a private message from the bot.",
            watchOn: "Alert enabled 🔔",
            watchOff: "Alert disabled",
            watchNeedBot: "Allow the bot to message you to receive alerts.",
            infoTitle: "Info",
            infoDesc: "Schedule, contact and payment.",
            deliveryTitle: "Delivery",
            hours: "Hours:",
            delay: "Delay:",
            zone: "Area:",
            contact: "Contact",
            contactBtn: "Contact",
            channelBtn: "Join the channel",
            payment: "Payment",
            cashOnly: "Cash payment only.",
            detailBack: "← Back",
            detailQty: "Select Quantity",
            unitLabel: "Per unit",
            add: "Add",
            slidePrev: "Previous media",
            slideNext: "Next media",
            muteLabel: "Mute",
            unmuteLabel: "Unmute",
            alertSelectQty: "Select a quantity.",
            alertCartEmpty: "Cart is empty.",
            alertAddress: "Address is too short.",
            alertPickupTime: "Select a pickup time.",
            alertPickupPast: "This time has already passed: pick a later time.",
            ordersClosed: "Orders closed",
            ordersClosedToast: "Orders are closed for now.",
            deliveryFeeLine: "Delivery: {fee}",
            deliveryFreeFrom: "free from {amount}",
            deliveryFree: "Free delivery",
            orderNotSaved: "Order sent but not saved on the server: make sure you send the Telegram message.",
            alertReview: "Fill name and message.",
            askProduct: "Hi, I want this product: {name}",
            orderText: "New order #{id}\nType: {type}\nDetails: {summary}\nTotal: {total}",
            orderOn: "Order on {name}",
            contactAlso: "Also on",
            contactHeroTitle: "Contact us",
            contactBubbleAsk: "A question?",
            contactBubbleReply: "Our team replies quickly on the network of your choice.",
            contactWriteUs: "Write to us",
            contactReport: "Report a problem",
            contactInfoTitle: "Info & terms",
            contactMeetup: "Meetup available",
            contactFree: "Free",
            contactDeliveryFree: "Free",
            contactDelay: "Delay: {delay}",
            contactPostal: "Secure postal shipping",
            contactMinOrder: "Min. order: {amount}",
            contactCitiesOne: "1 city served",
            contactCitiesMany: "{n} cities served",
            contactHours: "Opening hours",
            contactZone: "Area",
            gateRetry: "Try again",
            gateDone: "Done, check again",
            gateClose: "Close",
            gateChecking: "Checking…",
            gateStillBlocked: "Still blocked for now.",
            gateGranted: "Access granted, enjoy!",
            gateReopenLabel: "Reopening at",
            gateTitleTelegram: "Open the shop from Telegram",
            gateTitleClosed: "Shop closed",
            gateTitleMobile: "Mobile only",
            gateTitleVpn: "VPN detected",
            gateTitleBackup: "Start our backup bot",
            gateTitleChannel: "Join our channel",
            gateTitleVerification: "Verification required",
            gateTitleDefault: "Access unavailable",
            gateStepReopen: "Close this page, then reopen the shop from the Telegram bot.",
            gateStepPhone: "Open the shop from the Telegram app on your phone.",
            gateStepVpn: "Turn off your VPN or proxy, then try again.",
            gateStepStartBot: "Start the bot {bot}",
            gateStepJoin: "Join the channel",
            gateStepBack: "Come back here: the shop opens by itself.",
            gateStepOpenBot: "Open the bot {bot}",
            gateStepSendPhoto: "Send the photo the bot asks for",
            gateStepWait: "Wait for an admin to approve it",
            gateStartBot: "Start {bot}",
            gateJoinChannel: "Join the channel",
            gateOpenBot: "Open the bot",
            gatePending: "Verification in progress",
            gatePendingHint: "An admin is reviewing your request. The shop will open by itself once it is approved.",
            gateRejected: "Request declined",
            gateRejectedHint: "Open the bot to send a new photo.",
            gateReasonLabel: "Reason:"
        },
        de: {
            introSub: "Shop wird geladen...",
            brandSubtitle: "Premium-Menue 2026",
            greeting: "Hallo {name}",
            heroKicker: "Shop",
            heroTitle: "Premium-Produkte, schneller Service",
            navHome: "Start",
            navCart: "Warenkorb",
            navHistory: "Historie",
            navReviews: "Bewertungen",
            navProfile: "Profil",
            navInfo: "Kontakt",
            categoryAll: "Alle",
            categoryKeyLabel: "Kategorie",
            categoryTypeLabel: "Typ",
            badgeNew: "Neu",
            badgePromo: "Promo",
            badgeSoldOut: "Ausverkauft",
            soldOutToast: "Dieses Produkt ist derzeit ausverkauft.",
            soldOutCartToast: "{name} ist ausverkauft: entferne es aus dem Warenkorb, um zu bestellen.",
            cardAddAria: "{name} in den Warenkorb legen",
            cartAdded: "{name} in den Warenkorb gelegt! 🛒",
            fromPrice: "Ab {price}",
            view: "Ansehen",
            cartTitle: "Warenkorb",
            cartDesc: "Bestellung in Sekunden abschliessen.",
            cartEmpty: "Warenkorb ist leer.",
            delivery: "Lieferung",
            pickup: "Abholung",
            deliveryAddress: "Lieferadresse",
            pickupTime: "Abholzeit",
            deliveryPlaceholder: "Bsp: 10 Rue de la République, 68000 Colmar",
            total: "Gesamt",
            clear: "Leeren",
            checkout: "Bestellen",
            unitSuffix: " / Stk",
            historyTitle: "Historie",
            historyDesc: "Alle Bestellungen anzeigen.",
            noOrder: "Noch keine Bestellung.",
            orderWord: "Bestellung",
            details: "Details",
            reviewsTitle: "Bewertungen",
            reviewsDesc: "Das sagen Kunden.",
            basedOn: "Basierend auf {count} Bewertungen",
            noReview: "Noch keine Bewertung, sei der Erste.",
            leaveReview: "Bewertung abgeben",
            name: "Name",
            rating: "Bewertung (1-5)",
            message: "Nachricht",
            publish: "Senden",
            yourName: "Dein Name",
            yourFeedback: "Dein Feedback",
            profileLanguage: "Sprache",
            langFr: "Französisch",
            langEn: "Englisch",
            langDe: "Deutsch",
            profileOrders: "Meine Bestellungen",
            statOrders: "Bestellungen",
            statSpent: "Ausgaben",
            statMember: "Mitglied seit",
            memberSincePhrase: "Mitglied seit {month} {year}",
            profileNoOrders: "Noch keine Bestellung.",
            watchTitle: "Benachrichtigungen",
            watchSubtitle: "In Echtzeit informiert werden",
            watchNewTitle: "Neue Produkte",
            watchNewDesc: "Wenn ein Produkt hinzugefügt wird",
            watchPromoTitle: "Aktionen",
            watchPromoDesc: "Neue Aktionen und Rabatte",
            watchHint: "Benachrichtigungen kommen als private Nachricht vom Bot.",
            watchOn: "Benachrichtigung aktiviert 🔔",
            watchOff: "Benachrichtigung deaktiviert",
            watchNeedBot: "Erlaube dem Bot, dir zu schreiben, um Benachrichtigungen zu erhalten.",
            infoTitle: "Infos",
            infoDesc: "Zeiten, Kontakt und Zahlung.",
            deliveryTitle: "Lieferung",
            hours: "Zeiten:",
            delay: "Dauer:",
            zone: "Gebiet:",
            contact: "Kontakt",
            contactBtn: "Kontakt",
            channelBtn: "Kanal beitreten",
            payment: "Zahlung",
            cashOnly: "Nur Barzahlung.",
            detailBack: "← Zurueck",
            detailQty: "Menge waehlen",
            unitLabel: "Pro Stück",
            add: "Hinzufuegen",
            slidePrev: "Vorheriges Medium",
            slideNext: "Naechstes Medium",
            muteLabel: "Ton aus",
            unmuteLabel: "Ton an",
            alertSelectQty: "Bitte Menge waehlen.",
            alertCartEmpty: "Warenkorb ist leer.",
            alertAddress: "Adresse ist zu kurz.",
            alertPickupTime: "Bitte Abholzeit waehlen.",
            alertPickupPast: "Diese Uhrzeit ist schon vorbei: bitte eine spaetere waehlen.",
            ordersClosed: "Bestellungen geschlossen",
            ordersClosedToast: "Bestellungen sind im Moment geschlossen.",
            deliveryFeeLine: "Lieferung: {fee}",
            deliveryFreeFrom: "gratis ab {amount}",
            deliveryFree: "Kostenlose Lieferung",
            orderNotSaved: "Bestellung gesendet, aber nicht auf dem Server gespeichert: sende die Telegram-Nachricht unbedingt ab.",
            alertReview: "Name und Nachricht ausfuellen.",
            askProduct: "Hallo, ich moechte dieses Produkt: {name}",
            orderText: "Neue Bestellung #{id}\nTyp: {type}\nDetails: {summary}\nGesamt: {total}",
            orderOn: "Über {name} bestellen",
            contactAlso: "Auch auf",
            contactHeroTitle: "Kontaktiere uns",
            contactBubbleAsk: "Eine Frage?",
            contactBubbleReply: "Unser Team antwortet dir schnell auf dem Netzwerk deiner Wahl.",
            contactWriteUs: "Schreib uns",
            contactReport: "Problem melden",
            contactInfoTitle: "Infos & Bedingungen",
            contactMeetup: "Meetup möglich",
            contactFree: "Kostenlos",
            contactDeliveryFree: "Gratis",
            contactDelay: "Dauer: {delay}",
            contactPostal: "Sicherer Postversand",
            contactMinOrder: "Mindestbestellwert: {amount}",
            contactCitiesOne: "1 Stadt beliefert",
            contactCitiesMany: "{n} Städte beliefert",
            contactHours: "Öffnungszeiten",
            contactZone: "Gebiet",
            gateRetry: "Erneut versuchen",
            gateDone: "Erledigt, erneut prüfen",
            gateClose: "Schließen",
            gateChecking: "Wird geprüft…",
            gateStillBlocked: "Noch gesperrt.",
            gateGranted: "Zugang freigegeben, viel Spaß!",
            gateReopenLabel: "Wieder geöffnet um",
            gateTitleTelegram: "Öffne den Shop über Telegram",
            gateTitleClosed: "Shop geschlossen",
            gateTitleMobile: "Nur mobil",
            gateTitleVpn: "VPN erkannt",
            gateTitleBackup: "Starte unseren Backup-Bot",
            gateTitleChannel: "Tritt unserem Kanal bei",
            gateTitleVerification: "Überprüfung erforderlich",
            gateTitleDefault: "Zugang nicht verfügbar",
            gateStepReopen: "Schließe diese Seite und öffne den Shop erneut über den Telegram-Bot.",
            gateStepPhone: "Öffne den Shop in der Telegram-App auf deinem Handy.",
            gateStepVpn: "Schalte dein VPN oder deinen Proxy aus und versuche es erneut.",
            gateStepStartBot: "Starte den Bot {bot}",
            gateStepJoin: "Tritt dem Kanal bei",
            gateStepBack: "Komm hierher zurück: der Shop öffnet sich von selbst.",
            gateStepOpenBot: "Öffne den Bot {bot}",
            gateStepSendPhoto: "Sende das vom Bot verlangte Foto",
            gateStepWait: "Warte auf die Freigabe durch einen Admin",
            gateStartBot: "{bot} starten",
            gateJoinChannel: "Kanal beitreten",
            gateOpenBot: "Bot öffnen",
            gatePending: "Überprüfung läuft",
            gatePendingHint: "Ein Admin prüft deine Anfrage. Der Shop öffnet sich von selbst, sobald sie bestätigt ist.",
            gateRejected: "Anfrage abgelehnt",
            gateRejectedHint: "Öffne den Bot, um ein neues Foto zu senden.",
            gateReasonLabel: "Grund:"
        }
    };

    // Liens de médias et pseudos : < > " ' & retirés (pour un texte, voir escapeHtml et plainText)
    function sanitize(input) {
        if (typeof input !== "string") return "";
        return input.replace(/[<>"'&]/g, "").trim();
    }

    // Texte inséré en HTML : caractères spéciaux échappés, jamais retirés (« L'Original », « Fish & Chips »)
    function escapeHtml(input) {
        if (typeof input !== "string") return "";
        return input.trim().replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    // Texte posé avec textContent ou envoyé tel quel (commande, avis, message Telegram) : rien à échapper
    function plainText(input) {
        return typeof input === "string" ? input.trim() : "";
    }

    // Lien posé dans un attribut src/href ou un url() CSS : un fichier /uploads/ du serveur ou une adresse https,
    // sans espace, guillemet ni chevron. Tout le reste (javascript:, data:, http:…) donne "".
    function safeMediaUrl(url) {
        const s = String(url || "").trim();
        if (/^\/uploads\/[^\s"'<>\\()]+$/.test(s)) return s;
        if (/^https:\/\/[^\s"'<>\\()]+$/i.test(s)) return s;
        return "";
    }

    // Réglage booléen : le serveur rend les booléens sous forme de texte "true" / "false"
    function isOn(v) {
        return v === true || v === "true" || v === 1 || v === "1";
    }

    function isAdmin() {
        return state.adminVerified === true;
    }

    // Le panel n'existe pour ce client que si GET /admin/config accepte son initData Telegram signée
    async function fetchAdminConfig() {
        const initData = getAdminInitData();
        if (!initData || !getTelegramUser()) return null;
        try {
            const resp = await fetchWriteApi("/admin/config", { headers: { "X-Telegram-Init-Data": initData } });
            const data = await readJsonIfAny(resp);
            return resp.ok && data && data.config ? data.config : null;
        } catch (_) {
            return null;
        }
    }

    async function refreshAdminAccess() {
        state.adminVerified = Boolean(await fetchAdminConfig());
        if (els.profileAdminCard) els.profileAdminCard.style.display = state.adminVerified ? "block" : "none";
    }

    function getTelegramUser() {
        return tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
    }

    function resolveStorageScope() {
        const user = getTelegramUser();
        if (user && Number.isFinite(Number(user.id))) {
            return `u${Number(user.id)}`;
        }
        if (user && user.username) {
            return `n${sanitize(user.username).toLowerCase()}`;
        }
        return "guest";
    }

    function storageKey(name) {
        return `gh_${state.storageScope}_${name}`;
    }

    function t(key, params) {
        const dict = i18n[state.language] || i18n.fr;
        const fallback = i18n.fr[key] || key;
        const template = dict[key] || fallback;
        if (!params) return template;
        return Object.keys(params).reduce((acc, paramKey) => {
            return acc.replace(new RegExp(`\\{${paramKey}\\}`, "g"), () => String(params[paramKey]));
        }, template);
    }

    function getLocaleCode() {
        if (state.language === "en") return "en-GB";
        if (state.language === "de") return "de-DE";
        return "fr-FR";
    }

    function getMonthTexts(dateValue) {
        const locale = getLocaleCode();
        const monthLong = new Intl.DateTimeFormat(locale, { month: "long" }).format(dateValue);
        const monthShort = new Intl.DateTimeFormat(locale, { month: "short" }).format(dateValue).replace(".", "");
        return { monthLong, monthShort };
    }

    function toPrice(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : 0;
    }

    // Devise réglée dans la gestion (Réglages), « € » par défaut. Courte et sans < > " ' & : elle est
    // insérée telle quelle dans le HTML comme dans le texte (message de commande)
    function currencyLabel() {
        const rest = state.config && state.config.restaurant;
        return sanitize(rest && typeof rest.currency === "string" ? rest.currency : "").slice(0, 8).trim() || "€";
    }

    function formatPrice(value) {
        return `${toPrice(value).toFixed(2)} ${currencyLabel()}`;
    }

    function allProductsFromConfig(cfg) {
        const products = [];
        const byCat = cfg && cfg.products ? cfg.products : {};
        Object.keys(byCat).forEach((categoryId) => {
            byCat[categoryId].forEach((p) => {
                products.push({
                    ...p,
                    category: p.category || categoryId
                });
            });
        });
        return products;
    }

    function getCategoryMeta(categoryId) {
        const cats = (state.config && state.config.categories) || {};
        return cats[categoryId] || { name: categoryId, emoji: "📦" };
    }

    // Unité d'un palier : customPrices[qty] = { delivery, pickup, unit } ; sans unité (ou prix seul), des grammes
    const TIER_UNIT_SUFFIX = { g: "G", ml: "ml", "pièce": " pc", x: "x" };

    function tierUnit(priceData) {
        const unit = priceData && typeof priceData === "object" ? String(priceData.unit || "") : "";
        return Object.prototype.hasOwnProperty.call(TIER_UNIT_SUFFIX, unit) ? unit : "g";
    }

    // « 5G », « 250ml », « 3 pc », « 2x »
    function tierLabel(qty, unit) {
        return `${qty}${TIER_UNIT_SUFFIX[unit] || "G"}`;
    }

    // Palier (tier: true) : qty = quantité du palier (grammes par défaut), price = prix du palier entier, pas un prix au gramme.
    function getQtyEntries(product, orderType = state.orderType) {
        const custom = product.customPrices || {};
        const entries = Object.entries(custom)
            .map(([qtyRaw, priceData]) => {
                const qty = parseFloat(String(qtyRaw).replace(",", "."));
                if (!Number.isFinite(qty) || qty <= 0) return null;

                if (typeof priceData === "object" && priceData !== null) {
                    const delivery = toPrice(priceData.delivery);
                    const pickup = toPrice(priceData.pickup);
                    const price = orderType === "pickup" ? pickup : delivery;
                    return { qty, price: price || delivery || pickup || 0, tier: true, unit: tierUnit(priceData) };
                }

                return { qty, price: toPrice(priceData), tier: true, unit: "g" };
            })
            .filter(Boolean)
            .sort((a, b) => a.qty - b.qty);

        if (entries.length) return entries;
        return [{ qty: 1, price: toPrice(product.price), tier: false }];
    }

    function getStartingPrice(product) {
        const prices = getQtyEntries(product).map((e) => e.price).filter((p) => p > 0);
        return prices.length ? Math.min(...prices) : toPrice(product.price);
    }

    function saveLocal() {
        localStorage.setItem(storageKey("cart"), JSON.stringify(state.cart));
        localStorage.setItem(storageKey("orders"), JSON.stringify(state.orders));
        localStorage.setItem(storageKey("reviews"), JSON.stringify(state.reviews));
        localStorage.setItem(storageKey("language"), state.language);
        updateCartBadge();
        scheduleCloudMirror();
    }

    function paintStarPicker() {
        const value = parseInt(els.reviewStars.value, 10) || 5;
        document.querySelectorAll("#star-picker .star-btn").forEach((btn) => {
            btn.classList.toggle("on", Number(btn.dataset.star) <= value);
        });
    }

    function updateCartBadge() {
        const badge = document.getElementById("cart-badge");
        badge.hidden = !state.cart.length;
        badge.textContent = state.cart.length;
    }

    // Historique local vidé une fois par client : les commandes d'avant le correctif des prix par palier
    // pouvaient avoir un faux total, et la base n'en garde plus aucune. Changer la valeur pour revider.
    const ORDERS_RESET_ID = "2026-10-09";

    function loadLocal() {
        state.storageScope = resolveStorageScope();
        try {
            const scopedCartRaw = localStorage.getItem(storageKey("cart"));
            const scopedOrdersRaw = localStorage.getItem(storageKey("orders"));
            const scopedReviewsRaw = localStorage.getItem(storageKey("reviews"));
            const scopedLanguageRaw = localStorage.getItem(storageKey("language"));

            const cart = JSON.parse(scopedCartRaw || localStorage.getItem("gh_cart") || "[]");
            const orders = JSON.parse(scopedOrdersRaw || localStorage.getItem("gh_orders") || "[]");
            const reviews = JSON.parse(scopedReviewsRaw || localStorage.getItem("gh_reviews") || "[]");
            const language = scopedLanguageRaw || localStorage.getItem("gh_language") || "fr";
            const savedCart = Array.isArray(cart) ? cart : [];
            try {
                state.cart = savedCart.map(migrateLegacyCartLine).filter(Boolean);
            } catch (_) {
                state.cart = [];
            }
            const ordersReset = localStorage.getItem(storageKey("orders_reset")) !== ORDERS_RESET_ID;
            state.orders = !ordersReset && Array.isArray(orders) ? orders : [];
            state.reviews = Array.isArray(reviews) ? reviews : [];
            state.language = ["fr", "en", "de"].includes(language) ? language : "fr";

            // One-time migration from legacy non-scoped keys to user-scoped keys.
            if (!scopedCartRaw || !scopedOrdersRaw || !scopedReviewsRaw || !scopedLanguageRaw
                || JSON.stringify(state.cart) !== JSON.stringify(savedCart) || ordersReset) {
                saveLocal();
            }
            if (ordersReset) localStorage.setItem(storageKey("orders_reset"), ORDERS_RESET_ID);
        } catch (_) {
            state.cart = [];
            state.orders = [];
            state.reviews = [];
            state.language = "fr";
        }
        updateCartBadge();
    }

    // ===== COPIE DANS LE CLOUDSTORAGE TELEGRAM =====
    // L'adresse du quick tunnel change à chaque redémarrage du bot et le localStorage est lié à l'adresse de la page :
    // panier, historique et langue sont aussi copiés dans le CloudStorage Telegram du client (par compte et par bot),
    // puis recopiés au démarrage quand le localStorage de la nouvelle adresse est vide. Sans CloudStorage : rien.
    // La clé de l'historique suit ORDERS_RESET_ID : un historique vidé exprès ne revient pas du cloud.
    const CLOUD_KEYS = { cart: "gh_cart", orders: `gh_orders_${ORDERS_RESET_ID}`, language: "gh_language" };
    const CLOUD_VALUE_MAX = 4096;
    const CLOUD_RESTORE_MS = 2000;
    const CLOUD_MIRROR_DELAY_MS = 800;
    // ready : cloud lu (jamais de copie avant, elle écraserait une sauvegarde pas encore relue) ;
    // known : valeur présente dans le cloud par clé ; localLoaded : loadLocal() du démarrage déjà passé
    const cloud = { ready: false, known: {}, timer: null, localLoaded: false };

    function cloudStore() {
        const store = tg && tg.CloudStorage;
        return store && typeof store.getItems === "function" && typeof store.setItem === "function" && tgSupports("6.9") ? store : null;
    }

    function localValue(name) {
        try {
            return localStorage.getItem(storageKey(name));
        } catch (_) {
            return null;
        }
    }

    // Recopie dans le localStorage les valeurs du cloud des clés absentes au démarrage. Réponse arrivée après
    // loadLocal() : seulement ce que le client n'a pas rempli entre-temps. true si quelque chose a été recopié.
    function restoreCloudValues(values, missing, late) {
        let restored = false;
        missing.forEach((name) => {
            const raw = values[CLOUD_KEYS[name]];
            if (typeof raw !== "string" || !raw) return;
            if (late && (name === "cart" ? state.cart.length : name === "orders" ? state.orders.length : state.language !== "fr")) return;
            try {
                if (name === "language" ? !["fr", "en", "de"].includes(raw) : !Array.isArray(JSON.parse(raw))) return;
                localStorage.setItem(storageKey(name), raw);
                if (name === "orders") localStorage.setItem(storageKey("orders_reset"), ORDERS_RESET_ID);
                restored = true;
            } catch (_) { }
        });
        return restored;
    }

    // Lancé avant loadLocal() ; le démarrage n'attend jamais plus de CLOUD_RESTORE_MS. Une réponse plus tardive
    // est appliquée à son arrivée (panier, historique et langue réaffichés).
    function restoreFromCloudStorage() {
        const store = cloudStore();
        if (!store) return Promise.resolve();
        state.storageScope = resolveStorageScope();
        const missing = Object.keys(CLOUD_KEYS).filter((name) => localValue(name) === null);
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, CLOUD_RESTORE_MS);
            try {
                store.getItems(Object.values(CLOUD_KEYS), (err, values) => {
                    clearTimeout(timer);
                    if (!err && values && typeof values === "object") {
                        Object.values(CLOUD_KEYS).forEach((key) => {
                            cloud.known[key] = typeof values[key] === "string" ? values[key] : "";
                        });
                        const late = cloud.localLoaded;
                        if (restoreCloudValues(values, missing, late) && late) {
                            try {
                                loadLocal();
                                renderLanguageSelection();
                                applyTranslations();
                            } catch (_) { }
                        }
                        cloud.ready = true;
                        if (late) scheduleCloudMirror();
                    }
                    resolve();
                });
            } catch (_) {
                clearTimeout(timer);
                resolve();
            }
        });
    }

    // Tableau JSON qui tient dans une valeur du CloudStorage (4096 caractères) : les entrées les plus récentes,
    // en fin de tableau, sont gardées
    function cloudArrayValue(list) {
        let items = Array.isArray(list) ? list : [];
        let json = JSON.stringify(items);
        while (json.length > CLOUD_VALUE_MAX && items.length) {
            items = items.slice(1);
            json = JSON.stringify(items);
        }
        return json;
    }

    // N'écrit que les clés qui ont changé depuis la dernière valeur connue du cloud
    function mirrorToCloudStorage() {
        clearTimeout(cloud.timer);
        cloud.timer = null;
        const store = cloudStore();
        if (!store || !cloud.ready) return;
        const values = {
            [CLOUD_KEYS.cart]: cloudArrayValue(state.cart),
            [CLOUD_KEYS.orders]: cloudArrayValue(state.orders),
            [CLOUD_KEYS.language]: state.language
        };
        Object.keys(values).forEach((key) => {
            const value = values[key];
            if (value === cloud.known[key]) return;
            cloud.known[key] = value;
            try {
                store.setItem(key, value, (err) => {
                    if (err) delete cloud.known[key];
                });
            } catch (_) {
                delete cloud.known[key];
            }
        });
    }

    function scheduleCloudMirror() {
        if (!cloud.ready) return;
        clearTimeout(cloud.timer);
        cloud.timer = setTimeout(mirrorToCloudStorage, CLOUD_MIRROR_DELAY_MS);
    }

    function normalizeReviewEntry(review) {
        if (!review || typeof review !== "object") return null;
        const author = plainText(String(review.author || "")).trim();
        const message = plainText(String(review.message || "")).trim();
        if (!author || !message) return null;

        const rawStars = parseInt(review.stars, 10);
        const stars = Number.isFinite(rawStars) ? Math.max(1, Math.min(5, rawStars)) : 5;
        const rawTs = Number(review.timestamp);
        const timestamp = Number.isFinite(rawTs) ? rawTs : Date.now();

        return {
            author,
            stars,
            message,
            timestamp,
            telegramUserId: Number.isFinite(Number(review.telegramUserId)) ? Number(review.telegramUserId) : null,
            telegramUsername: review.telegramUsername ? plainText(String(review.telegramUsername)) : null,
            photo: typeof review.photo === "string" ? review.photo : "" // fidelite : photo jointe (/uploads/…)
        };
    }

    async function syncReviewsFromLocalApi() {
        try {
            const resp = await fetchWriteApi("/reviews", { method: "GET" });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.success && Array.isArray(data.reviews)) {
                    state.reviews = data.reviews.map(normalizeReviewEntry).filter(Boolean);
                    saveLocal();
                    return true;
                }
            }
        } catch (_) {}
        try {
            const resp = await fetchWithTimeout(`./reviews.json?t=${Date.now()}`, { cache: "no-store" }, 3000);
            if (!resp.ok) return false;
            const data = await resp.json();
            const list = Array.isArray(data) ? data : (Array.isArray(data.approved) ? data.approved : null);
            if (!list) return false;
            const normalized = list.map(normalizeReviewEntry).filter(Boolean);
            state.reviews = normalized;
            saveLocal();
            return true;
        } catch (_) {
            return false;
        }
    }

    // { ok, gated, error } : gated = avis refusé par un contrôle d'accès (403 avec gate), l'écran d'accès est alors affiché ;
    // error (fidelite :) = motif du refus donné par le serveur (avis coupés, commande requise…) ou envoi impossible
    async function persistReviewToLocalApi(review) {
        try {
            const resp = await fetchWriteApi("/save-review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, review, { init_data: getAdminInitData(), platform: telegramPlatform() }))
            });
            if (resp.ok) return { ok: true, gated: false, error: "" };
            const data = await readJsonIfAny(resp);
            if (resp.status === 403 && applyGateRefusal(data)) return { ok: false, gated: true, error: "" };
            return { ok: false, gated: false, error: (data && typeof data.error === "string" && data.error) || fidT("reviewNotSent") };
        } catch (_) {
            return { ok: false, gated: false, error: fidT("reviewNotSent") };
        }
    }

    // initData et plateforme ne partent que vers willy.py : la page elle-même quand c'est lui qui la sert,
    // ou une adresse de tunnel de confiance (trustedApiBase) — jamais vers un autre hôte (Vercel, api_base détournée)
    function isTrustedServerBase(base) {
        if (trustedApiBase(base)) return true;
        return pageServesUploads() && base === normalizeApiBase(window.location.origin);
    }

    function accessHeaders(base) {
        const headers = {};
        if (!isTrustedServerBase(base)) return headers;
        const initData = getAdminInitData();
        const platform = telegramPlatform();
        if (initData) headers["X-Telegram-Init-Data"] = initData;
        if (platform) headers["X-Telegram-Platform"] = platform;
        return headers;
    }

    // Champ access de /config : sans lui (ancien serveur ou ancien secours Vercel), la boutique reste publique
    function readAccess(raw) {
        if (!raw || typeof raw !== "object") return { allowed: true, admin: false, bypassed: [], gate: null };
        const blocked = raw.allowed === false;
        return {
            allowed: !blocked,
            admin: raw.admin === true,
            bypassed: Array.isArray(raw.bypassed) ? raw.bypassed.map((c) => String(c)) : [],
            gate: blocked ? (raw.gate && typeof raw.gate === "object" ? raw.gate : {}) : null
        };
    }

    async function loadConfig() {
        const bases = getWriteApiBases();
        let cfg = null;
        let cfgBase = "";

        // 1. Charger la configuration LIVE depuis le serveur VPS (ngrok)
        // willy.py vérifie l'accès avant de répondre (VPN, canal…) : plus de temps pour lui que pour les autres bases
        for (const base of bases) {
            if (!base) continue;
            try {
                const timeoutMs = isTrustedServerBase(base) ? 12000 : 4000;
                const resp = await fetchWithTimeout(`${base}/config?t=${Date.now()}`, { cache: "no-store", headers: accessHeaders(base) }, timeoutMs);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && typeof data === "object" && (data.products || data.categories || data.restaurant)) {
                        cfg = data;
                        cfgBase = base;
                        break;
                    }
                }
            } catch (_) {}
        }

        // 2. Si VPS inaccessible: essayer la fonction serverless Vercel /api/config (requête Neon en direct)
        if (!cfg) {
            try {
                const vercelOrigin = (window.location && /^https?:/i.test(String(window.location.origin || "")))
                    ? String(window.location.origin).replace(/\/+$/, "")
                    : "";
                if (vercelOrigin) {
                    const resp = await fetchWithTimeout(`${vercelOrigin}/api/config?t=${Date.now()}`, { cache: "no-store" }, 6000);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && typeof data === "object" && (data.products || data.categories || data.restaurant)) {
                            cfg = data;
                        }
                    }
                }
            } catch (_) {}
        }

        // 3. Si toujours rien: garder le state actuel si déjà chargé (évite d'écraser avec données figées).
        // Jamais de repli sur config.json : sans champ access, il afficherait le catalogue malgré les contrôles
        if (!cfg) {
            if (state.config && typeof state.config === "object") {
                return;
            }
            throw new Error("Impossible de charger la boutique, réessaie dans un instant.");
        }

        state.config = cfg;
        // Accès décidé par le serveur : refusé, /config ne contient ni produits ni catégories (écran d'accès)
        state.access = readAccess(cfg && cfg.access);
        // Page servie par willy.py : seule la config de sa propre origine peut changer l'adresse mémorisée
        const fromOwnServer = !pageServesUploads() || cfgBase === normalizeApiBase(window.location.origin);
        if (fromOwnServer && cfg && cfg.admin && cfg.admin.api_base) {
            setStoredWriteApiBase(cfg.admin.api_base);
        }
        state.products = allProductsFromConfig(cfg);
        state.categories = Object.keys((cfg && cfg.categories) || {});
        readCatalogueConfig(cfg); // catalogue : villes, ville du client, likes (avant le rendu des produits)
    }

    function renderUser() {
        const user = getTelegramUser();
        const firstName = plainText((user && user.first_name) || "Utilisateur");
        const username = user && user.username ? `@${plainText(user.username)}` : "-";
        const greetingName = user && user.username ? `@${plainText(user.username)}` : firstName;
        const avatarLetter = firstName.charAt(0).toUpperCase() || "U";
        const photoUrl = user && user.photo_url ? sanitize(user.photo_url) : "";
        const createdAt = user && user.id ? new Date((1704067200000 + (user.id % 220) * 86400000)) : new Date(2026, 3, 1);
        const monthData = getMonthTexts(createdAt);
        const year = createdAt.getFullYear();

        els.userChip.textContent = t("greeting", { name: greetingName });
        els.profileName.textContent = firstName;
        els.profileUsername.textContent = username;
        els.profileAvatar.textContent = avatarLetter;

        if (els.navProfileLetter) els.navProfileLetter.textContent = avatarLetter;
        if (els.navProfilePhoto) {
            if (photoUrl) {
                els.navProfilePhoto.src = photoUrl;
                els.navProfilePhoto.style.display = "block";
                if (els.navProfileLetter) els.navProfileLetter.style.display = "none";
            } else {
                els.navProfilePhoto.removeAttribute("src");
                els.navProfilePhoto.style.display = "none";
                if (els.navProfileLetter) els.navProfileLetter.style.display = "inline";
            }
        }

        els.profileMemberFull.textContent = t("memberSincePhrase", { month: monthData.monthLong, year });
        els.profileMemberShort.textContent = `${monthData.monthShort}. ${String(year).slice(-2)}`;
        // Pseudos Telegram de l'admin : tuiles « Telegram » de l'onglet Contact (renderContactCard)

        // Afficher le bouton admin si l'utilisateur est dans la whitelist
        if (els.profileAdminCard) {
            els.profileAdminCard.style.display = isAdmin() ? "block" : "none";
        }
    }

    function renderCategories() {
        if (!els.categoryTabs) return;
        // catalogue : catégorie sans produit dans la ville du client masquée (retour à « Tous » si elle était choisie)
        if (state.category !== "all" && !catalogueCategoryVisible(state.category)) state.category = "all";

        const allActive = state.category === "all" ? "active" : "";
        let html = `<button class="category-tab-btn ${allActive}" data-category="all" role="tab" aria-selected="${state.category === "all" ? "true" : "false"}">
            <span class="tab-emoji">📦</span>
            <span class="tab-text">${t("categoryAll")}</span>
        </button>`;

        html += state.categories
            .filter(catalogueCategoryVisible)
            .map((catId) => {
                const meta = getCategoryMeta(catId);
                const label = escapeHtml(meta.name || catId);
                const emoji = escapeHtml(meta.emoji || "🌿");
                const active = state.category === catId ? "active" : "";
                return `<button class="category-tab-btn ${active}" data-category="${escapeHtml(catId)}" role="tab" aria-selected="${state.category === catId ? "true" : "false"}">
                    <span class="tab-emoji">${emoji}</span>
                    <span class="tab-text">${label}</span>
                </button>`;
            })
            .join("");

        els.categoryTabs.innerHTML = html;

        // Add event listeners to the tabs
        const tabButtons = els.categoryTabs.querySelectorAll(".category-tab-btn");
        tabButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
                state.category = btn.getAttribute("data-category");

                // Update active class and aria-selected state on buttons
                tabButtons.forEach((b) => {
                    b.classList.remove("active");
                    b.setAttribute("aria-selected", "false");
                });
                btn.classList.add("active");
                btn.setAttribute("aria-selected", "true");

                renderProducts();
            });
        });
    }

    function productCardTemplate(product) {
        const rawImg = safeMediaUrl(resolveMediaUrl(product.image || "", "image"));
        const rawVideo = safeMediaUrl(resolveMediaUrl(product.video || "", "video"));
        const name = escapeHtml(product.name || "Product");
        const desc = escapeHtml(product.description || "");
        const categoryMeta = getCategoryMeta(product.category);
        const categoryName = escapeHtml(categoryMeta.name || product.category || "Categorie");
        const shortDesc = desc || categoryName;
        const start = getStartingPrice(product);

        const soldOut = isSoldOut(product);
        let badge = "";
        if (soldOut) badge = `<span class="badge sold-out">${t("badgeSoldOut")}</span>`;
        else if (product.isNew) badge = `<span class="badge new">${t("badgeNew")}</span>`;
        else if (product.isPromo) badge = `<span class="badge promo">${t("badgePromo")}</span>`;

        const playableVid = rawVideo ? getPlayableVideo(rawVideo) : "";
        const videoBadge = playableVid ? `<span class="badge video-pill" title="Vidéo disponible">▶ Vidéo</span>` : "";

        let mediaHtml = "";
        if (rawImg && !rawImg.startsWith("data:video/")) {
            mediaHtml = `<img class="card-product-img" data-img-src="${sanitize(rawImg)}" src="${sanitize(rawImg)}" alt="${name}" loading="lazy" referrerpolicy="no-referrer">`;
        } else if (playableVid) {
            mediaHtml = `<video class="card-preview-video" data-video-src="${sanitize(playableVid)}" muted playsinline webkit-playsinline preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>`;
        } else {
            mediaHtml = `<div class="media-fallback-icon" style="width:100%;height:100%;display:grid;place-items:center;background:rgba(255,255,255,0.05);font-size:2.2rem;">📦</div>`;
        }

        return `
            <article class="product-card${soldOut ? " is-sold-out" : ""}" data-product-id="${escapeHtml(String(product.id))}">
                <div class="product-media${likesEnabled() ? " has-like" : ""}">
                    ${mediaHtml}
                    ${badge}
                    ${videoBadge}
                    ${catalogueCardExtras(product)}
                </div>
                <div class="product-body">
                    <h3 class="product-title">${name}</h3>
                    <p class="product-desc">${shortDesc}</p>
                    <div class="card-foot">
                        ${cataloguePriceChip(start)}
                        ${cardCartButtonHtml(product, soldOut)}
                    </div>
                </div>
            </article>
        `;
    }

    function renderProducts() {
        const source = (state.category === "all"
            ? state.products
            : state.products.filter((p) => p.category === state.category))
            .filter(catalogueProductVisible); // catalogue : seulement les produits proposés dans la ville du client

        els.productGrid.innerHTML = source.map(productCardTemplate).join("");
        els.productGrid.querySelectorAll(".card-preview-video").forEach((v) => {
            if (v.dataset.videoSrc) attachVideoSource(v, v.dataset.videoSrc);
        });
        els.productGrid.querySelectorAll(".card-product-img").forEach((img) => {
            if (img.dataset.imgSrc) attachImageSource(img, img.dataset.imgSrc);
        });
        els.productGrid.querySelectorAll(".product-card").forEach((card) => {
            card.addEventListener("click", () => {
                const id = parseInt(card.dataset.productId, 10);
                const product = state.products.find((p) => p.id === id);
                if (product) openProductDetail(product);
            });
        });
    }

    function switchPage(pageName) {
        els.pages.forEach((page) => {
            const show = page.id === `page-${pageName}`;
            page.classList.toggle("active", show);
        });

        els.tabs.forEach((tab, index) => {
            const isActive = tab.dataset.page === pageName;
            tab.classList.toggle("active", isActive);
            // fidelite : position parmi les onglets affichés (l'onglet Avis peut être masqué)
            if (isActive) document.getElementById("bottom-nav").style.setProperty("--nav-index", fideliteNavIndex(tab, index));
        });

        const previousPage = document.body.dataset.page;
        if (previousPage && previousPage !== pageName && tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        document.body.dataset.page = pageName;
        window.scrollTo(0, 0);

        if (pageName === "cart") renderCart();
        if (pageName === "history") renderHistory();
        if (pageName === "reviews") renderReviews();
        if (pageName === "profile") renderProfileStats();
        if (pageName === "info") supportPreload(); // onglet Contact : ticket en cours chargé (fil affiché s'il est ouvert)
    }

    function attachNavigation() {
        els.tabs.forEach((btn) => {
            btn.addEventListener("click", () => switchPage(btn.dataset.page));
        });
    }

    // Commande en cours d'enregistrement (/save-order) : un seul envoi à la fois
    let checkoutBusy = false;

    // Réglages de l'onglet Commandes de la gestion. Clé jamais enregistrée = valeur affichée par défaut dans le panel
    // (commandes, meetup et calendrier actifs, frais de livraison coupés)
    function orderSettings() {
        const adm = (state.config && state.config.admin) || {};
        const rest = (state.config && state.config.restaurant) || {};
        const flag = (key, dflt) => (Object.prototype.hasOwnProperty.call(adm, key) ? isOn(adm[key]) : dflt);
        // catalogue : envoi postal (avec au moins un type d'envoi), paiement crypto (avec au moins une adresse),
        // jours proposés par le calendrier — mêmes règles que willy.py (build_catalogue_order)
        const postalOptions = cataloguePostalOptions(adm.postal_options);
        const wallets = catalogueWallets(adm.crypto_wallets);
        return {
            ordersEnabled: flag("orders_enabled", true),
            meetup: flag("meetup_enabled", true),
            calendar: flag("calendar_enabled", true),
            feeEnabled: flag("delivery_fee_enabled", false),
            fee: Math.max(0, toPrice(rest.deliveryFee)),
            freeFrom: Math.max(0, toPrice(adm.free_shipping)),
            postal: flag("postal_enabled", false) && postalOptions.length > 0,
            postalOptions,
            crypto: flag("crypto_enabled", false) && wallets.length > 0,
            wallets,
            calendarDays: catalogueCalendarDays(adm.calendar_days)
        };
    }

    // Frais du panier (sur le montant des articles après la promo globale) : livraison (ville du client, sinon frais
    // par défaut ; 0 si le réglage est coupé ou dès « livraison gratuite dès »), envoi postal (type choisi), meetup 0
    function deliveryFeeFor(subtotal) {
        const s = orderSettings();
        if (state.orderType === "postal") return s.postal ? catalogueSelectedPostalFee(s) : 0; // catalogue
        if (state.orderType !== "delivery" || !s.feeEnabled) return 0;
        const fee = catalogueCityFee(s.fee); // catalogue : frais de la ville du client, sinon ceux par défaut
        if (fee <= 0) return 0;
        if (s.freeFrom > 0 && subtotal >= s.freeFrom) return 0;
        return catRound2(fee);
    }

    function cartSubtotal() {
        return state.cart.reduce((sum, i) => sum + cartLineUnitPrice(i) * i.quantity, 0); // catalogue : prix du mode choisi
    }

    // Heure locale « HH:MM » (borne min du champ heure : les heures passées sont grisées)
    function currentTimeHHMM() {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    // Applique les réglages Commandes à la boutique : boutons meetup et envoi postal, créneau (calendrier),
    // paiement, bouton Commander
    function applyOrderOptions() {
        const s = orderSettings();
        if (els.servicePickupBtn) els.servicePickupBtn.style.display = s.meetup ? "" : "none";
        if (!s.meetup && state.orderType === "pickup") state.orderType = "delivery";
        // catalogue : envoi postal proposé seulement s'il est activé avec au moins un type d'envoi
        if (!s.postal && state.orderType === "postal") state.orderType = "delivery";
        const isDelivery = state.orderType === "delivery";
        if (els.serviceSwitch) {
            els.serviceSwitch.querySelectorAll(".service-btn").forEach((b) => b.classList.toggle("active", b.dataset.service === state.orderType));
        }
        if (els.deliveryFieldGroup) els.deliveryFieldGroup.style.display = isDelivery ? "grid" : "none";
        // catalogue : créneau (date + heure) en livraison comme sur place, jamais pour un envoi postal
        if (els.pickupFieldGroup) els.pickupFieldGroup.style.display = s.calendar && state.orderType !== "postal" ? "grid" : "none";
        renderCatalogueCheckout(s); // catalogue : envoi postal, dates du créneau, paiement, panier fermé
        if (els.checkoutBtn) {
            els.checkoutBtn.disabled = !s.ordersEnabled || checkoutBusy;
            els.checkoutBtn.textContent = s.ordersEnabled ? t("checkout") : t("ordersClosed");
        }
    }

    // Lignes « Promo » et « Livraison » / « Envoi » sous le total du panier (totals : cartTotals())
    function renderCartFee(totals) {
        renderCataloguePromoLine(totals); // catalogue : promotion globale
        if (!els.cartFeeLine) return;
        const s = orderSettings();
        const postal = state.orderType === "postal";
        if (!state.cart.length || (postal ? totals.fee <= 0 : (state.orderType !== "delivery" || !s.feeEnabled || catalogueCityFee(s.fee) <= 0))) {
            els.cartFeeLine.style.display = "none";
            return;
        }
        const fee = totals.fee;
        let text = postal ? ct("postalFeeLine", { fee: formatPrice(fee) }) : (fee > 0 ? t("deliveryFeeLine", { fee: formatPrice(fee) }) : t("deliveryFree"));
        if (!postal && fee > 0 && s.freeFrom > 0) text += ` · ${t("deliveryFreeFrom", { amount: formatPrice(s.freeFrom) })}`;
        els.cartFeeLine.textContent = text;
        els.cartFeeLine.style.display = "";
    }

    function renderCart() {
        applyOrderOptions();
        if (!state.cart.length) {
            els.cartEmptyState.style.display = "block";
            els.cartContent.style.display = "none";
            els.cartEmptyState.textContent = t("cartEmpty");
            els.cartTotal.textContent = formatPrice(0);
            renderCartFee(cartTotals());
            renderProfileStats();
            return;
        }

        els.cartEmptyState.style.display = "none";
        els.cartContent.style.display = "grid";

        let total = 0;
        const rows = state.cart.map((item, index) => {
            const unitPrice = cartLineUnitPrice(item); // catalogue : prix actuel du mode choisi (livraison / retrait)
            const line = unitPrice * item.quantity;
            total += line;
            // Passé « Épuisé » depuis l'ajout : la ligne reste (à retirer) mais ne peut pas être commandée
            const soldOut = isSoldOut(cartLineProduct(item));
            return `
                <div class="cart-row">
                    <div>
                        <h4>${escapeHtml(item.name)}${soldOut ? ` <span class="badge sold-out">${t("badgeSoldOut")}</span>` : ""}</h4>
                        <p class="muted">${formatPrice(unitPrice)}${t("unitSuffix")}</p>
                    </div>
                    <div class="cart-controls">
                        <button class="qty-btn" data-index="${index}" data-op="minus" type="button">-</button>
                        <span>${item.quantity}</span>
                        <button class="qty-btn" data-index="${index}" data-op="plus" type="button">+</button>
                    </div>
                </div>
            `;
        });

        els.cartItems.innerHTML = rows.join("");
        // Total affiché = total envoyé à la commande (promo globale et frais compris), recalculé par le serveur
        const totals = cartTotals(); // catalogue
        els.cartTotal.textContent = formatPrice(totals.total);
        // fidelite : avantages (points, code gagné) appliqués APRÈS la promo globale et les frais, comme save_order_api
        fideliteRenderCart(totals.total);
        renderCartFee(totals);

        els.cartItems.querySelectorAll(".qty-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const index = parseInt(btn.dataset.index, 10);
                const op = btn.dataset.op;
                changeQty(index, op === "plus" ? 1 : -1);
            });
        });

        renderProfileStats();
    }

    // Une ligne par (produit, palier) : plusieurs paliers du même produit ont chacun leur ligne.
    function changeQty(index, delta) {
        const item = state.cart[index];
        if (!item) return;
        if (delta > 0 && isSoldOut(cartLineProduct(item))) {
            showToast(t("soldOutToast"), "error");
            return;
        }
        item.quantity += delta;
        if (item.quantity <= 0) {
            state.cart.splice(index, 1);
        }
        saveLocal();
        renderCart();
    }

    function cartLineName(product, weight) {
        if (weight === null) return product.name;
        const entry = getQtyEntries(product).find((e) => e.tier && e.qty === weight);
        return `${product.name} (${tierLabel(weight, entry ? entry.unit : "g")})`;
    }

    // Produit marqué « Épuisé » dans la gestion (inStock: false) : visible mais impossible à commander
    function isSoldOut(product) {
        return Boolean(product) && product.inStock === false;
    }

    // Produit actuel (dernière config chargée) d'une ligne du panier
    function cartLineProduct(item) {
        return state.products.find((p) => String(p.id) === String(item.id));
    }

    // weight = poids du palier choisi (null sans palier) ; quantity = nombre de sachets à ce prix.
    // false si le produit est épuisé (rien n'est ajouté)
    function addToCart(product, weight, price) {
        if (isSoldOut(product)) return false;
        const existing = state.cart.find((c) => c.id === product.id && c.weight === weight && c.unitPrice === price);
        if (existing) {
            existing.quantity += 1;
        } else {
            state.cart.push({
                id: product.id,
                name: cartLineName(product, weight),
                weight,
                quantity: 1,
                unitPrice: price,
                category: product.category
            });
        }
        saveLocal();
        renderCart();
        renderProfileStats();
        return true;
    }

    // Carte produit : bouton rond « ajouter au panier » (sans ouvrir la fiche). Produit épuisé : grisé (aria-disabled,
    // pas disabled : le clic reste sur le bouton et affiche le toast « épuisé » comme le bouton Ajouter de la fiche)
    const CARD_CART_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 4h2.2l2.3 10.3a1.6 1.6 0 0 0 1.6 1.2h8.4a1.6 1.6 0 0 0 1.6-1.2L21 7.5H6"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>`;

    function cardCartButtonHtml(product, soldOut) {
        const label = soldOut ? t("badgeSoldOut") : t("cardAddAria", { name: plainText(product.name || "") });
        return `<button class="card-cart-btn${soldOut ? " is-disabled" : ""}" data-cart-pid="${escapeHtml(String(product.id))}" type="button" aria-label="${escapeHtml(label)}"${soldOut ? ' aria-disabled="true"' : ""}>${CARD_CART_SVG}</button>`;
    }

    // Rejoue une petite animation CSS (classe retirée à la fin) : cœur aimé, bouton panier, pastille du panier.
    // Animations coupées (prefers-reduced-motion) : pas d'animationend, la classe est retirée tout de suite
    function replayAnimationClass(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth; // reflow : l'animation repart de zéro
        el.classList.add(cls);
        if (getComputedStyle(el).animationName === "none") {
            el.classList.remove(cls);
            return;
        }
        el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
    }

    // Ajout direct depuis la carte : plus petit palier du mode de commande en cours (celui que la fiche présélectionne),
    // mêmes garde-fous que « Ajouter » de la fiche (épuisé → toast, prix manquant → fiche ouverte pour choisir).
    // Accès bloqué (mode fermé, vérification…) ou produit hors de la ville du client : rien n'est ajouté
    function addFromProductCard(rawPid, btn) {
        if (accessLocked()) return;
        if (state.access && state.access.allowed === false) {
            applyAccessState(); // accès retiré depuis le dernier rechargement : écran d'accès, comme au paiement
            return;
        }
        const product = state.products.find((p) => String(p.id) === String(rawPid));
        if (!product || !catalogueProductVisible(product)) return;
        if (isSoldOut(product)) {
            showToast(t("soldOutToast"), "error");
            return;
        }
        const entry = getQtyEntries(product)[0];
        if (!entry || !(entry.price > 0)) {
            openProductDetail(product);
            return;
        }
        const weight = entry.tier ? entry.qty : null;
        if (!addToCart(product, weight, entry.price)) return;
        // même libellé que la ligne du panier : « Produit (5G) » pour un palier, « Produit » sans palier
        showToast(t("cartAdded", { name: plainText(cartLineName(product, weight)) }));
        replayAnimationClass(btn, "is-added");
        replayAnimationClass(document.getElementById("cart-badge"), "is-bumping");
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    }

    // Avant le champ weight, un palier gardait son poids comme quantité : « 5G — 70 € » devenait
    // {quantity: 5, unitPrice: 70}, compté 350 €. Une ancienne ligne n'est gardée que si un seul poids
    // du produit a encore ce prix et divise la quantité (sans palier : poids 1, quantité = unités) ;
    // sinon elle est retirée, pour ne jamais garder un faux total.
    function migrateLegacyCartLine(line) {
        if (!line || typeof line !== "object") return null;
        if ("weight" in line) return line;
        const product = allProductsFromConfig(state.config).find((p) => String(p.id) === String(line.id));
        const quantity = toPrice(line.quantity);
        const unitPrice = toPrice(line.unitPrice);
        if (!product || quantity <= 0 || unitPrice <= 0) return null;

        const matches = getQtyEntries(product, "delivery").concat(getQtyEntries(product, "pickup"))
            .filter((e) => {
                const packs = quantity / e.qty;
                return Math.abs(e.price - unitPrice) < 0.005 && Math.round(packs) >= 1 && Math.abs(packs - Math.round(packs)) < 1e-6;
            });
        if (new Set(matches.map((e) => e.qty)).size !== 1) return null;
        const entry = matches[0];
        const weight = entry.tier ? entry.qty : null;
        return { ...line, name: cartLineName(product, weight), weight, quantity: Math.round(quantity / entry.qty) };
    }

    function renderHistory() {
        if (!state.orders.length) {
            els.historyList.innerHTML = `<div class="card panel empty-state" data-emoji="🧾">${t("noOrder")}</div>`;
            return;
        }

        const html = state.orders
            .slice()
            .reverse()
            .map((order) => {
                const date = new Date(order.timestamp).toLocaleString(getLocaleCode());
                const orderTypeText = catalogueOrderTypeLabel(order.type); // catalogue : livraison, sur place ou envoi postal
                return `
                    <article class="card panel order-card">
                        <div class="order-card-head">
                            <h3>${t("orderWord")} #${escapeHtml(String(order.id))}</h3>
                            <span class="order-card-total">${formatPrice(order.total)}</span>
                        </div>
                        <p class="muted">${date} · ${orderTypeText}</p>
                        <p class="order-card-summary">${escapeHtml(order.summary)}</p>
                    </article>
                `;
            })
            .join("");

        els.historyList.innerHTML = html;
    }

    function renderReviews() {
        if (!state.reviews.length) {
            els.reviewList.innerHTML = `<div class="card panel empty-state" data-emoji="💬">${t("noReview")}</div>`;
            els.reviewRating.textContent = "– / 5"; // fidelite : pas de note inventée sans avis
            els.reviewCount.textContent = t("basedOn", { count: 0 });
            return;
        }

        const avg = state.reviews.reduce((s, r) => s + r.stars, 0) / state.reviews.length;
        els.reviewRating.textContent = `${avg.toFixed(1)} / 5`;
        els.reviewCount.textContent = t("basedOn", { count: state.reviews.length });

        const html = state.reviews
            .slice()
            .reverse()
            .map((r) => `
                <article class="card panel review-item">
                    <div class="review-item-head">
                        <h4>${escapeHtml(r.author)}</h4>
                        <span class="review-item-stars">${"★".repeat(r.stars)}<span class="off">${"★".repeat(5 - r.stars)}</span></span>
                    </div>
                    <p>${escapeHtml(r.message)}</p>
                    ${fidReviewPhotoHtml(r)}
                </article>
            `)
            .join("");

        els.reviewList.innerHTML = html;
    }

    async function addReview(author, stars, message) {
        const currentUser = getTelegramUser();
        const review = {
            author,
            stars,
            message,
            timestamp: Date.now(),
            telegramUserId: currentUser && Number.isFinite(Number(currentUser.id)) ? Number(currentUser.id) : null,
            telegramUsername: currentUser && currentUser.username ? plainText(currentUser.username) : null
        };
        Object.assign(review, fideliteReviewExtras()); // fidelite : photo jointe (chemin renvoyé par /fidelite/review-photo)

        state.reviews.push(review);
        saveLocal();
        renderReviews();

        const saved = await persistReviewToLocalApi(review);
        if (!saved.ok) {
            // Refusé par un contrôle d'accès (boutique fermée, vérification…) ou par les réglages des avis (fidelite :
            // avis coupés, commande requise, délai, limite par jour), ou pas envoyé : il ne reste pas affiché comme envoyé
            state.reviews = state.reviews.filter((r) => r !== review);
            saveLocal();
            renderReviews();
            if (saved.error) showToast(saved.error, "error");
            return;
        }
        showToast(fidT("reviewSent")); // fidelite : avis en attente de modération
        fidRefresh(true);
        await syncReviewsFromLocalApi();
        renderReviews();
    }

    function renderProfileStats() {
        els.profileOrderCount.textContent = String(state.orders.length);
        const spent = state.orders.reduce((sum, order) => sum + toPrice(order.total), 0);
        els.profileTotalSpent.textContent = formatPrice(spent).replace(".00", "");
        renderProfileOrdersPreview();
    }

    function renderProfileOrdersPreview() {
        if (!state.orders.length) {
            els.profileOrdersPreview.innerHTML = `<div class="muted">${t("profileNoOrders")}</div>`;
            return;
        }

        const recent = state.orders.slice().reverse().slice(0, 2);
        els.profileOrdersPreview.innerHTML = recent
            .map((order) => {
                const date = new Date(order.timestamp).toLocaleDateString(getLocaleCode(), {
                    day: "2-digit",
                    month: "2-digit",
                    year: "2-digit"
                });
                return `<div class="profile-order-line"><span>#${escapeHtml(String(order.id))} - ${date}</span><strong>${formatPrice(order.total)}</strong></div>`;
            })
            .join("");
    }

    // Langues de la boutique. Drapeaux en SVG : les émojis drapeaux s'affichent « FR » sous Windows / Telegram Desktop
    const SHOP_LANGUAGES = [
        { code: "fr", key: "langFr", flag: '<svg viewBox="0 0 3 2" preserveAspectRatio="none"><rect width="1" height="2" fill="#002395"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ed2939"/></svg>' },
        { code: "en", key: "langEn", flag: '<svg viewBox="0 0 60 30" preserveAspectRatio="none"><rect width="60" height="30" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#c8102e" stroke-width="2"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#c8102e" stroke-width="6"/></svg>' },
        { code: "de", key: "langDe", flag: '<svg viewBox="0 0 5 3" preserveAspectRatio="none"><rect width="5" height="1" fill="#000"/><rect y="1" width="5" height="1" fill="#dd0000"/><rect y="2" width="5" height="1" fill="#ffce00"/></svg>' }
    ];

    function shopLanguage(code) {
        return SHOP_LANGUAGES.find((l) => l.code === code) || SHOP_LANGUAGES[0];
    }

    // Sélecteur de langue en haut à droite (drapeau + ▾) : bouton et menu redessinés dans la langue de l'interface
    function renderLanguageSelection() {
        if (!els.shopLangBtn || !els.shopLangMenu) return;
        const current = shopLanguage(state.language);
        if (els.shopLangFlag) els.shopLangFlag.innerHTML = current.flag;
        const label = `${t("profileLanguage")} · ${t(current.key)}`;
        els.shopLangBtn.setAttribute("aria-label", label);
        els.shopLangBtn.title = label;
        els.shopLangMenu.setAttribute("aria-label", t("profileLanguage"));
        els.shopLangMenu.innerHTML = SHOP_LANGUAGES.map((l) => {
            const active = l.code === current.code;
            return `<button class="shop-lang-option${active ? " active" : ""}" data-lang="${l.code}" type="button" role="menuitemradio" aria-checked="${active}">
                <span class="shop-lang-flag" aria-hidden="true">${l.flag}</span>
                <span class="shop-lang-name">${escapeHtml(t(l.key))}</span>
                <span class="shop-lang-check" aria-hidden="true">${active ? "✓" : ""}</span>
            </button>`;
        }).join("");
    }

    // Ouvre / ferme le menu des langues
    function setShopLangMenu(open) {
        if (!els.shopLangMenu || !els.shopLangBtn) return;
        els.shopLangMenu.hidden = !open;
        els.shopLangBtn.setAttribute("aria-expanded", open ? "true" : "false");
        if (els.shopLang) els.shopLang.classList.toggle("open", open);
    }

    // Lien du bouton « Canal » : seulement http(s) (même règle que start_links dans willy.py), sinon ""
    function shopChannelLink() {
        const link = String((state.config && state.config.admin && state.config.admin.channel_link) || "").trim();
        return /^https?:\/\/\S+$/i.test(link) ? link : "";
    }

    // Slogan et banderole modifiables dans la gestion : aussi réappliqués à chaque rechargement de la config
    function applyShopTexts() {
        const shopCfg = state.config || {};
        // Nom de la boutique (Réglages › Général) : titre de l'en-tête
        const brandTitle = document.querySelector(".brand-title");
        const shopName = shopCfg.restaurant && typeof shopCfg.restaurant.name === "string" ? shopCfg.restaurant.name.trim() : "";
        if (brandTitle) brandTitle.textContent = shopName || "GreenHouse 68";
        if (els.brandSubtitle) els.brandSubtitle.textContent = (shopCfg.restaurant && shopCfg.restaurant.slogan) || t("brandSubtitle");
        if (!els.tickerDefault && els.tickerTexts[0]) els.tickerDefault = els.tickerTexts[0].textContent;
        const tickerText = shopCfg.admin && shopCfg.admin.ticker_text ? `${shopCfg.admin.ticker_text} ✦` : els.tickerDefault;
        els.tickerTexts.forEach((span) => { if (span.textContent !== tickerText) span.textContent = tickerText; });
        // Sans lien de canal réglé, pas de bouton « Canal » (il ouvrirait la page de la boutique)
        if (els.channelBtn) els.channelBtn.style.display = shopChannelLink() ? "" : "none";
        renderContactCard();
        applyCatalogueShop(); // catalogue : ville du client (profil, écran de choix au premier lancement)
        fideliteApplyConfig(); // fidelite : onglet / formulaire d'avis et cartes fidélité du profil selon les réglages
        watchApplyConfig(); // alertes : carte Notifications du profil (textes, visibilité)
        // Réglages Commandes relus (commandes coupées, meetup, calendrier, frais de livraison) : panier à jour
        renderCart();
    }

    // ===== RÉSEAUX DE CONTACT (Réglages › Réseaux sociaux) =====
    // Mêmes règles que willy.py (settings/save) : une valeur invalide ne donne aucun bouton, ni dans la boutique ni dans l'aperçu
    const SOCIAL_NETWORKS = [
        { key: "whatsapp", name: "WhatsApp", icon: "💬" },
        { key: "signal", name: "Signal", icon: "🔒" },
        { key: "snapchat", name: "Snapchat", icon: "👻" },
        { key: "instagram", name: "Instagram", icon: "📸" },
        { key: "potato", name: "Potato", icon: "🥔" },
        { key: "luffa", name: "Luffa", icon: "🧽" }
    ];
    const WHATSAPP_RE = /^\+?\d{8,15}$/;
    const SOCIAL_LINK_RULES = {
        signal: /^https:\/\/signal\.me\/[^\s"'<>\\]+$/i,
        snapchat: /^https:\/\/(?:www\.|t\.)?snapchat\.com\/[^\s"'<>\\]+$/i,
        instagram: /^https:\/\/(?:www\.)?instagram\.com\/[^\s"'<>\\]+$/i,
        potato: /^https:\/\/[^\s"'<>\\]+$/i,
        luffa: /^https:\/\/[^\s"'<>\\]+$/i
    };

    // « +33 6 12-34.56.78 » ou « 0033612345678 » → « +33612345678 »
    function cleanWhatsapp(value) {
        return String(value || "").trim().replace(/[\s.()-]/g, "").replace(/^00/, "+");
    }

    // Lien du réseau pour une valeur réglée, "" si elle est vide ou invalide
    function socialLink(key, raw) {
        const value = String(raw || "").trim();
        if (!value) return "";
        if (key === "whatsapp") {
            const number = cleanWhatsapp(value);
            return WHATSAPP_RE.test(number) ? `https://wa.me/${number.replace(/^\+/, "")}` : "";
        }
        const rule = SOCIAL_LINK_RULES[key];
        return rule && rule.test(value) ? value : "";
    }

    function configuredSocialNetworks() {
        const adminCfg = (state.config && state.config.admin) || {};
        return SOCIAL_NETWORKS.filter((n) => socialLink(n.key, adminCfg[n.key]));
    }

    // Lien t.me : ouvert dans Telegram ; autre lien https : navigateur. Rien d'autre n'est ouvert.
    function openExternalLink(url) {
        const link = String(url || "");
        if (!/^https:\/\/[^\s"'<>\\]+$/i.test(link)) return;
        if (/^https:\/\/t\.me\//i.test(link) && tg && tg.openTelegramLink) tg.openTelegramLink(link);
        else if (tg && tg.openLink) tg.openLink(link);
        else window.open(link, "_blank", "noopener");
    }

    // Lien d'un réseau, avec le message prérempli pour WhatsApp (« Salut, je veux ce produit : … »)
    function socialOrderLink(key, productName) {
        const adminCfg = (state.config && state.config.admin) || {};
        const url = socialLink(key, adminCfg[key]);
        if (!url || key !== "whatsapp" || !productName) return url;
        return `${url}?text=${encodeURIComponent(t("askProduct", { name: productName }))}`;
    }

    // ===== ONGLET CONTACT (ancienne page Infos, data-page="info") =====
    // Carte d'accueil (logo, pastille « en ligne » de renderShopHeader, bulles, texte contact_text), « Nous écrire » (un
    // bouton par réseau réglé), « Signaler un problème » (tickets SAV), « Infos & conditions » tirées des réglages
    // Horaires, délai et zone repris tels quels de l'ancienne page Infos (aucun réglage dans la gestion)
    const CONTACT_FIXED_INFO = { hours: "10H-22H Lun-Dim", delay: "30-45mn", zone: "68 (et ses Alentours)" };
    // Icônes au trait 24×24 : contenu fixe, jamais de donnée de la config
    const CONTACT_ICONS = {
        meetup: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
        delivery: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
        postal: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
        bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
        cities: '<path d="M14.1 4.6 9.9 2.4a2 2 0 0 0-1.8 0L3.6 4.7A1 1 0 0 0 3 5.6v14.2a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.2a2 2 0 0 0 1.8 0l4.5-2.3a1 1 0 0 0 .6-.9V4.2a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0z"/><path d="M15 5.8v15M9 3.2v15"/>',
        hours: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        zone: '<path d="M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
        payment: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'
    };
    // Icônes des réseaux (couleurs de marque dans access.css) ; Potato et Luffa gardent l'emoji de SOCIAL_NETWORKS
    const CONTACT_NET_ICONS = {
        telegram: '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/>',
        whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
        signal: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" stroke-dasharray="3 2.4"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
        snapchat: '<path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>',
        instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>'
    };
    // HTML posé : rien n'est redessiné si rien ne change (config relue toutes les 45 s) ; reportBusy : un seul appui à la fois
    const contactUi = { grid: null, list: null, reportBusy: false };

    function contactSvg(paths) {
        return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    }

    // Pseudos Telegram valides de telegram_username (un ou plusieurs, séparés par une espace ou une virgule)
    function contactTelegramHandles() {
        const raw = String((state.config && state.config.admin && state.config.admin.telegram_username) || "GreenHouse682");
        return [...new Set(raw.split(/[\s,]+/).map(telegramHandle).filter(Boolean))].slice(0, 4);
    }

    // Conversation Telegram avec un admin (premier pseudo réglé par défaut), comme l'ancien bouton « Contacter »
    function openTelegramContact(username) {
        const handle = telegramHandle(username) || telegramHandle(getPrimaryTelegramUsername()) || "GreenHouse682";
        const url = `https://t.me/${handle}`;
        if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
        else window.open(url, "_blank");
    }

    // « Nous écrire » : Telegram (toujours, un bouton par pseudo), puis chaque réseau réglé dans la gestion
    function contactNetGridHtml() {
        const handles = contactTelegramHandles();
        const tiles = (handles.length ? handles : [""]).map((h) => `<button class="contact-net-tile" data-net="telegram" data-tg="${escapeHtml(h)}" type="button">`
            + `<span class="contact-net-icon" aria-hidden="true">${contactSvg(CONTACT_NET_ICONS.telegram)}</span>`
            + `<span class="contact-net-text"><span class="contact-net-name">Telegram</span>${h ? `<span class="contact-net-sub">@${escapeHtml(h)}</span>` : ""}</span></button>`);
        configuredSocialNetworks().forEach((n) => {
            const icon = CONTACT_NET_ICONS[n.key] ? contactSvg(CONTACT_NET_ICONS[n.key]) : `<span class="contact-net-emoji">${n.icon}</span>`;
            tiles.push(`<button class="contact-net-tile" data-net="${n.key}" type="button"><span class="contact-net-icon" aria-hidden="true">${icon}</span>`
                + `<span class="contact-net-text"><span class="contact-net-name">${escapeHtml(n.name)}</span></span></button>`);
        });
        return tiles.join("");
    }

    function contactInfoRow(icon, title, sub) {
        return `<div class="contact-info-row"><span class="contact-info-icon" aria-hidden="true">${contactSvg(CONTACT_ICONS[icon])}</span>`
            + `<span class="contact-info-text"><span class="contact-info-name">${escapeHtml(title)}</span>${sub ? `<span class="contact-info-sub">${escapeHtml(sub)}</span>` : ""}</span></div>`;
    }

    // « Infos & conditions » : réglages réels (Commandes, villes, paiement), puis horaires et zone d'origine
    function contactInfoRowsHtml() {
        const s = orderSettings();
        const rest = (state.config && state.config.restaurant) || {};
        const rows = [];
        if (s.meetup) rows.push(contactInfoRow("meetup", t("contactMeetup"), t("contactFree")));
        // Livraison : frais de la ville du client (sinon ceux par défaut) et « offerte dès », comme le panier
        const fee = s.feeEnabled ? catalogueCityFee(s.fee) : 0;
        const feeText = fee > 0
            ? `${formatPrice(fee)}${s.freeFrom > 0 ? ` · ${t("deliveryFreeFrom", { amount: formatPrice(s.freeFrom) })}` : ""}`
            : t("contactDeliveryFree");
        rows.push(contactInfoRow("delivery", t("deliveryTitle"), `${feeText} · ${t("contactDelay", { delay: CONTACT_FIXED_INFO.delay })}`));
        if (s.postal) {
            rows.push(contactInfoRow("postal", t("contactPostal"), s.postalOptions.map((o) => `${o.label} ${o.fee > 0 ? formatPrice(o.fee) : ct("postalFree")}`).join(" · ")));
        }
        // Commande minimum : restaurant.minOrder (même portée que deliveryFee) ; 0 ou absent = pas de ligne
        const minOrder = Math.max(0, toPrice(rest.minOrder));
        if (minOrder > 0) rows.push(contactInfoRow("bag", t("contactMinOrder", { amount: formatPrice(minOrder) }), ""));
        if (multicityActive()) {
            const names = catalogue.cities.map((c) => plainText(String(c.name || ""))).filter(Boolean);
            rows.push(contactInfoRow("cities", names.length > 1 ? t("contactCitiesMany", { n: names.length }) : t("contactCitiesOne"), names.join(", ")));
        }
        rows.push(contactInfoRow("hours", t("contactHours"), CONTACT_FIXED_INFO.hours));
        rows.push(contactInfoRow("zone", t("contactZone"), CONTACT_FIXED_INFO.zone));
        rows.push(contactInfoRow("payment", t("payment"), s.crypto ? ct("paymentInfoCrypto", { coins: s.wallets.map((w) => w.coin).join(", ") }) : t("cashOnly")));
        return rows.join("");
    }

    // Onglet Contact : textes, bulle contact_text, réseaux et infos ; onglet masqué si contact_tab_enabled vaut "false"
    function renderContactCard() {
        const adminCfg = (state.config && state.config.admin) || {};
        const texts = {
            "contact-hero-title": "contactHeroTitle", "contact-bubble-ask": "contactBubbleAsk", "contact-bubble-reply": "contactBubbleReply",
            "contact-write-title": "contactWriteUs", "contact-report-label": "contactReport", "contact-info-title": "contactInfoTitle"
        };
        Object.keys(texts).forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = t(texts[id]);
        });
        const note = document.getElementById("contact-text");
        if (note) {
            const text = plainText(String(adminCfg.contact_text || ""));
            note.textContent = text;
            note.hidden = !text;
        }
        if (els.contactNetGrid) {
            const html = contactNetGridHtml();
            if (html !== contactUi.grid) {
                contactUi.grid = html;
                els.contactNetGrid.innerHTML = html;
            }
        }
        if (els.contactInfoList) {
            const html = contactInfoRowsHtml();
            if (html !== contactUi.list) {
                contactUi.list = html;
                els.contactInfoList.innerHTML = html;
            }
        }
        // messages : « Signaler un problème » (tickets SAV) est dans l'onglet Contact : il reste tant que le support est ouvert
        const tabOff = (adminCfg.contact_tab_enabled === "false" || adminCfg.contact_tab_enabled === false)
            && !isOn(adminCfg.tickets_enabled);
        if (els.bottomNav) els.bottomNav.classList.toggle("contact-tab-off", tabOff);
        if (tabOff && document.body.dataset.page === "info") switchPage("home");
    }

    // Fiche produit : « Commander sur … » pour chaque réseau réglé (le bouton Telegram ✈ du bas reste)
    function renderDetailOrderLinks() {
        if (!els.detailOrderLinks) return;
        const networks = configuredSocialNetworks();
        els.detailOrderLinks.innerHTML = networks.map((n) => `
            <button class="btn ghost detail-order-link" data-net="${n.key}" type="button"><span class="detail-order-icon" aria-hidden="true">${n.icon}</span>${escapeHtml(t("orderOn", { name: n.name }))}</button>`).join("");
        els.detailOrderLinks.hidden = !networks.length;
    }

    // ===== ÉCRAN D'ACCÈS (contrôles décidés par willy.py : access de /config, 403 de /save-order et /save-review) =====
    const ACCESS_GATES = {
        telegram_required: { icon: "✈️", title: "gateTitleTelegram" },
        closed: { icon: "🌙", title: "gateTitleClosed" },
        mobile_only: { icon: "📱", title: "gateTitleMobile" },
        vpn: { icon: "🛡️", title: "gateTitleVpn" },
        backup_bot: { icon: "🤖", title: "gateTitleBackup" },
        channel: { icon: "📢", title: "gateTitleChannel" },
        verification: { icon: "🆔", title: "gateTitleVerification" }
    };
    // Contrôles contournés par un admin (access.bypassed) : libellés du rappel en haut de sa boutique
    const ACCESS_BYPASS_LABELS = {
        telegram_required: "Session Telegram", closed: "Mode fermé", mobile_only: "Mobile uniquement", vpn: "Blocage VPN",
        backup_bot: "Bot backup obligatoire", channel: "Canal obligatoire", verification: "Vérification"
    };
    // key : écran affiché (pas de nouveau rendu tant que rien ne change) ; actions : boutons de l'écran affiché
    const accessUi = { locked: false, key: "", actions: [], staffNoteHidden: "" };

    function accessLocked() {
        return document.body.classList.contains("access-locked");
    }

    // Lien t.me renvoyé par le serveur (bot backup, vérification) : seul format ouvert par ces boutons
    function telegramGateLink(url) {
        const link = String(url || "").trim();
        return /^https:\/\/t\.me\/[^\s"'<>\\]+$/i.test(link) ? link : "";
    }

    function accessStepsHtml(steps) {
        return `<ol class="access-steps">${steps.map((s, i) => `<li><span class="access-step-num">${i + 1}</span><span>${escapeHtml(s)}</span></li>`).join("")}</ol>`;
    }

    // Contenu de l'écran selon gate.code ; tout texte venu du serveur est échappé
    function accessGateHtml(gate) {
        const code = Object.prototype.hasOwnProperty.call(ACCESS_GATES, gate.code) ? gate.code : "";
        const look = ACCESS_GATES[code] || { icon: "🔒", title: "gateTitleDefault" };
        const title = plainText(String(gate.title || "")) || t(look.title);
        const message = plainText(String(gate.message || ""));
        const bot = telegramHandle(gate.bot_username);
        const botLabel = bot ? `@${bot}` : "";
        const retry = { kind: "ghost", label: t("gateRetry"), run: "retry" };
        const done = { kind: "ghost", label: t("gateDone"), run: "retry" };
        let extra = "";
        let actions = [retry];

        if (code === "closed") {
            const reopen = String(gate.reopen_at || "").trim();
            if (/^\d{1,2}:\d{2}$/.test(reopen)) {
                extra = `<div class="access-clock"><span class="access-clock-label">${escapeHtml(t("gateReopenLabel"))}</span><strong class="access-clock-time">${escapeHtml(reopen)}</strong></div>`;
            }
        } else if (code === "mobile_only") {
            extra = `<div class="access-chips"><span>🤖 Android</span><span>📱 iPhone</span></div><p class="access-hint">${escapeHtml(t("gateStepPhone"))}</p>`;
        } else if (code === "vpn") {
            extra = `<p class="access-hint">${escapeHtml(t("gateStepVpn"))}</p>`;
        } else if (code === "telegram_required") {
            extra = `<p class="access-hint">${escapeHtml(t("gateStepReopen"))}</p>`;
            actions = [{ kind: "primary", label: t("gateRetry"), run: "retry" }];
            if (tg && tg.close) actions.push({ kind: "ghost", label: t("gateClose"), run: "close" });
        } else if (code === "backup_bot") {
            const link = telegramGateLink(gate.link) || (bot ? `https://t.me/${bot}?start=shop` : "");
            extra = accessStepsHtml([t("gateStepStartBot", { bot: botLabel || "backup" }), t("gateStepBack")]);
            actions = link ? [{ kind: "primary", label: botLabel ? t("gateStartBot", { bot: botLabel }) : t("gateOpenBot"), run: "open", url: link }, done] : [done];
        } else if (code === "channel") {
            const raw = String(gate.link || "").trim();
            const link = /^https:\/\/[^\s"'<>\\]+$/i.test(raw) ? raw : "";
            extra = accessStepsHtml([t("gateStepJoin"), t("gateStepBack")]);
            actions = link ? [{ kind: "primary", label: t("gateJoinChannel"), run: "open", url: link }, done] : [done];
        } else if (code === "verification") {
            const status = ["pending", "rejected"].includes(gate.status) ? gate.status : "none";
            const link = telegramGateLink(gate.link) || (bot ? `https://t.me/${bot}?start=verify` : "");
            if (status === "pending") {
                extra = `<div class="access-pill is-pending">${escapeHtml(t("gatePending"))}</div><p class="access-hint">${escapeHtml(t("gatePendingHint"))}</p>`;
            } else if (status === "rejected") {
                const reason = plainText(String(gate.reason || ""));
                extra = `<div class="access-pill is-rejected">✕ ${escapeHtml(t("gateRejected"))}</div>`
                    + (reason ? `<p class="access-reason"><strong>${escapeHtml(t("gateReasonLabel"))}</strong> ${escapeHtml(reason)}</p>` : "")
                    + `<p class="access-hint">${escapeHtml(t("gateRejectedHint"))}</p>`;
            } else {
                extra = accessStepsHtml([t("gateStepOpenBot", { bot: botLabel || "" }).trim(), t("gateStepSendPhoto"), t("gateStepWait")]);
            }
            const open = { kind: status === "pending" ? "ghost" : "primary", label: botLabel ? `${t("gateOpenBot")} ${botLabel}` : t("gateOpenBot"), run: "open", url: link };
            actions = link ? (status === "pending" ? [{ kind: "primary", label: t("gateRetry"), run: "retry" }, open] : [open, retry]) : [retry];
        }

        accessUi.actions = actions;
        const shopName = plainText(String((state.config && state.config.restaurant && state.config.restaurant.name) || "")) || "GreenHouse 68";
        const logo = shopLogoSrc(state.config && state.config.admin && state.config.admin.logo_url);
        return `
            <div class="access-emblem" aria-hidden="true">
                <span class="access-emblem-icon">${look.icon}</span>
                <img class="access-logo" src="${escapeHtml(logo)}" alt="">
            </div>
            <p class="access-kicker">${escapeHtml(shopName)}</p>
            <h2 class="access-title" id="access-title">${escapeHtml(title)}</h2>
            ${message ? `<p class="access-message">${escapeHtml(message)}</p>` : ""}
            ${extra}
            <div class="access-actions">
                ${actions.map((a, i) => `<button class="btn ${a.kind} access-btn" data-access-action="${i}" type="button">${escapeHtml(a.label)}</button>`).join("")}
            </div>
            <p class="access-status" aria-live="polite"></p>
        `;
    }

    // Écran plein : catalogue, barre du bas et lecteur masqués (body.access-locked), fiche produit fermée, musique coupée
    function showAccessScreen(gate) {
        if (!els.accessScreen || !els.accessCard) return;
        const key = `${state.language}|${JSON.stringify(gate)}`;
        if (!accessUi.locked || accessUi.key !== key) {
            accessUi.key = key;
            els.accessCard.innerHTML = accessGateHtml(gate);
            els.accessCard.dataset.code = String(gate.code || "");
            els.accessCard.setAttribute("aria-labelledby", "access-title");
            // Logo réglé introuvable : logo par défaut (comme applyShopLogo)
            const logo = els.accessCard.querySelector(".access-logo");
            if (logo) logo.onerror = () => {
                logo.onerror = null;
                logo.src = "logo.png";
            };
        }
        if (accessUi.locked) return;
        accessUi.locked = true;
        els.accessScreen.classList.remove("is-leaving");
        els.accessScreen.hidden = false;
        document.body.classList.add("access-locked");
        if (els.detailOverlay && els.detailOverlay.style.display === "block") closeProductDetail();
        cancelMusicAutostart();
        if (!music.audio.paused) music.audio.pause();
    }

    function hideAccessScreen() {
        if (!accessUi.locked || !els.accessScreen) return;
        accessUi.locked = false;
        accessUi.key = "";
        document.body.classList.remove("access-locked");
        els.accessScreen.classList.add("is-leaving");
        setTimeout(() => {
            if (accessUi.locked) return;
            els.accessScreen.hidden = true;
            els.accessScreen.classList.remove("is-leaving");
        }, 380);
        showToast(t("gateGranted"));
        if (music.audio.paused && !music.autostart) startMusicPlayer();
    }

    // Rappel discret pour un admin : contrôles actifs qu'il contourne (bypassed n'est rempli que pour un admin ;
    // ✕ le masque jusqu'au prochain changement)
    function renderStaffNote(access) {
        if (!els.accessStaffNote || !els.accessStaffNoteText) return;
        const bypassed = access && access.allowed ? access.bypassed : [];
        const key = bypassed.join(",");
        const show = bypassed.length > 0 && accessUi.staffNoteHidden !== key;
        if (show) {
            const labels = bypassed.map((c) => ACCESS_BYPASS_LABELS[c] || c);
            els.accessStaffNoteText.textContent = `🛡️ ${labels.join(" · ")} ${labels.length > 1 ? "actifs" : "actif"} — tu vois la boutique car tu es admin`;
        }
        els.accessStaffNote.hidden = !show;
        els.accessStaffNote.dataset.key = key;
    }

    // Applique state.access (dernière décision du serveur) : écran d'accès ou boutique, et rappel admin
    function applyAccessState() {
        const access = state.access || readAccess(null);
        if (access.allowed === false) showAccessScreen(access.gate || {});
        else hideAccessScreen();
        renderStaffNote(access);
    }

    // Commande ou avis refusé (403 { error, gate }) : l'écran d'accès s'affiche. true si c'est le cas.
    async function handleGateRefusal(resp) {
        if (!resp || resp.status !== 403) return false;
        return applyGateRefusal(await readJsonIfAny(resp));
    }

    // Corps JSON déjà lu d'un refus 403 : true (et écran d'accès) s'il porte une gate
    function applyGateRefusal(data) {
        if (!data || !data.gate || typeof data.gate !== "object") return false;
        state.access = readAccess({ allowed: false, gate: data.gate });
        applyAccessState();
        return true;
    }

    // Bouton « Réessayer » / « C'est fait » : relit /config tout de suite ; l'écran disparaît seul si l'accès est autorisé
    async function recheckAccess() {
        const status = els.accessCard ? els.accessCard.querySelector(".access-status") : null;
        const buttons = els.accessCard ? els.accessCard.querySelectorAll(".access-btn") : [];
        buttons.forEach((b) => { b.disabled = true; });
        if (status) status.textContent = t("gateChecking");
        await reloadShop();
        if (!accessUi.locked) return;
        // Même écran qu'avant (sinon il vient d'être redessiné) : boutons réactivés et message
        buttons.forEach((b) => { b.disabled = false; });
        if (status && status.isConnected) status.textContent = t("gateStillBlocked");
    }

    function onAccessAction(event) {
        const btn = event.target.closest("[data-access-action]");
        if (!btn) return;
        const action = accessUi.actions[Number(btn.dataset.accessAction)];
        if (!action) return;
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        if (action.run === "open") openExternalLink(action.url);
        else if (action.run === "close" && tg && tg.close) tg.close();
        else recheckAccess();
    }

    let shopReload = null;

    // Rechargement silencieux de la config (retour sur l'app, focus, toutes les 45 s, « Réessayer » de l'écran d'accès) :
    // un seul à la fois, les appels pendant un rechargement attendent celui en cours
    function reloadShop() {
        if (!shopReload) {
            shopReload = (async () => {
                try {
                    await loadConfig();
                    renderCategories();
                    renderProducts();
                    applyShopTexts();
                    syncMusicPlaylist();
                    applyAccessState();
                } catch (_) {}
            })().finally(() => { shopReload = null; });
        }
        return shopReload;
    }

    function applyTranslations() {
        document.documentElement.lang = state.language;

        if (els.introSub) els.introSub.textContent = t("introSub");
        applyShopTexts();

        if (els.cartTitle) els.cartTitle.textContent = t("cartTitle");
        if (els.cartDesc) els.cartDesc.textContent = t("cartDesc");
        if (els.cartEmptyState && !state.cart.length) els.cartEmptyState.textContent = t("cartEmpty");
        if (els.serviceDeliveryBtn) els.serviceDeliveryBtn.textContent = t("delivery");
        if (els.servicePickupBtn) els.servicePickupBtn.textContent = t("pickup");
        if (els.deliveryLabel) els.deliveryLabel.textContent = t("deliveryAddress");
        if (els.pickupLabel) els.pickupLabel.textContent = t("pickupTime");
        if (els.deliveryAddress) els.deliveryAddress.placeholder = t("deliveryPlaceholder");
        if (els.cartTotalLabel) els.cartTotalLabel.textContent = t("total");
        if (els.clearCartBtn) els.clearCartBtn.textContent = t("clear");
        // Libellé « Commander » ou « Commandes fermées » selon les réglages Commandes
        applyOrderOptions();

        if (els.historyTitle) els.historyTitle.textContent = t("historyTitle");
        if (els.historyDesc) els.historyDesc.textContent = t("historyDesc");
        if (els.reviewsTitle) els.reviewsTitle.textContent = t("reviewsTitle");
        if (els.reviewsDesc) els.reviewsDesc.textContent = t("reviewsDesc");
        if (els.reviewFormTitle) els.reviewFormTitle.textContent = t("leaveReview");
        if (els.reviewAuthorLabel) els.reviewAuthorLabel.textContent = t("name");
        if (els.reviewStarsLabel) els.reviewStarsLabel.textContent = t("rating");
        if (els.reviewMessageLabel) els.reviewMessageLabel.textContent = t("message");
        if (els.reviewSubmitBtn) els.reviewSubmitBtn.textContent = t("publish");
        if (els.reviewAuthor) els.reviewAuthor.placeholder = t("yourName");
        if (els.reviewMessage) els.reviewMessage.placeholder = t("yourFeedback");

        if (els.profileStatOrders) els.profileStatOrders.textContent = t("statOrders");
        if (els.profileStatSpent) els.profileStatSpent.textContent = t("statSpent");
        if (els.profileStatMember) els.profileStatMember.textContent = t("statMember");
        if (els.profileOrdersTitle) els.profileOrdersTitle.textContent = t("profileOrders");

        // Onglet Contact : textes posés par renderContactCard (applyShopTexts ci-dessus) ; libellé du bouton du canal
        const channelLabel = document.getElementById("channel-btn-label");
        if (channelLabel) channelLabel.textContent = t("channelBtn");

        if (els.detailCloseBtn) els.detailCloseBtn.textContent = t("detailBack");
        if (els.detailQtyTitle) els.detailQtyTitle.textContent = t("detailQty");
        if (els.detailAddBtn) els.detailAddBtn.textContent = t("add");
        if (els.detailPrevBtn) els.detailPrevBtn.setAttribute("aria-label", t("slidePrev"));
        if (els.detailNextBtn) els.detailNextBtn.setAttribute("aria-label", t("slideNext"));

        els.tabs.forEach((tab) => {
            const labels = {
                home: t("navHome"),
                cart: t("navCart"),
                history: t("navHistory"),
                reviews: t("navReviews"),
                profile: t("navProfile"),
                info: t("navInfo")
            };
            const labelNode = tab.querySelector(".tab-label");
            if (labelNode) {
                labelNode.textContent = labels[tab.dataset.page] || labelNode.textContent;
            } else {
                tab.textContent = labels[tab.dataset.page] || tab.textContent;
            }
        });

        renderCategories();
        renderProducts();
        renderCart();
        renderHistory();
        renderReviews();
        renderProfileStats();
        renderUser();
        // Écran d'accès affiché : redessiné dans la nouvelle langue
        if (accessUi.locked) applyAccessState();
    }

    function getPlayableVideo(video) {
        if (!video) return "";
        const v = String(video).trim().replace(/[<>"'`]/g, "");
        if (!v) return "";
        if (v.includes("youtube.com") || v.includes("youtu.be")) return "";
        if (v.includes("imgur.com") && !v.includes("i.imgur.com")) {
            const matchAlbum = v.match(/\/a\/([a-zA-Z0-9]+)/);
            const matchSimple = v.match(/imgur\.com\/([a-zA-Z0-9]+)/);
            const id = (matchAlbum && matchAlbum[1]) || (matchSimple && matchSimple[1]) || "";
            return id ? `https://i.imgur.com/${id}.mp4` : "";
        }
        if (v.endsWith(".gifv")) return v.replace(".gifv", ".mp4");
        return v;
    }

    const mediaBlobCache = new Map();

    async function attachVideoSource(videoEl, rawUrl) {
        if (!videoEl || !rawUrl) return;
        const url = getPlayableVideo(rawUrl);
        if (!url) return;

        videoEl.muted = true;
        videoEl.defaultMuted = true;
        videoEl.playsInline = true;
        videoEl.setAttribute("playsinline", "");
        videoEl.setAttribute("webkit-playsinline", "");

        const applySrc = (src) => {
            if (videoEl.src !== src) {
                videoEl.src = src;
                try { videoEl.load(); } catch (_) {}
            }
            const tryPlay = () => {
                videoEl.muted = true;
                const p = videoEl.play();
                if (p && typeof p.catch === "function") p.catch(() => {});
            };
            if (videoEl.readyState >= 2) {
                tryPlay();
            } else {
                videoEl.addEventListener("canplay", tryPlay, { once: true });
                videoEl.addEventListener("loadeddata", tryPlay, { once: true });
            }
        };

        if (url.startsWith("data:") || url.startsWith("blob:")) {
            applySrc(url);
            return;
        }

        const uniqueCandidates = mediaCandidates(cleanMediaUrl(url, "video"));
        let idx = 0;

        const tryNextVideo = () => {
            if (idx >= uniqueCandidates.length) return;
            const current = uniqueCandidates[idx++];
            videoEl.onerror = tryNextVideo;
            applySrc(current);
        };

        tryNextVideo();
    }

    async function attachImageSource(imgEl, rawUrl) {
        if (!imgEl || !rawUrl) return;
        const cleanUrl = cleanMediaUrl(rawUrl, "image");
        if (!cleanUrl) return;

        if (cleanUrl.startsWith("data:") || cleanUrl.startsWith("blob:")) {
            imgEl.src = cleanUrl;
            return;
        }

        const uniqueCandidates = mediaCandidates(cleanUrl);
        let idx = 0;

        const tryNextImage = () => {
            if (idx >= uniqueCandidates.length) {
                imgEl.onerror = null;
                if (imgEl.parentElement && !imgEl.parentElement.querySelector(".media-fallback-icon")) {
                    imgEl.style.display = "none";
                    const placeholder = document.createElement("div");
                    placeholder.className = "media-fallback-icon";
                    placeholder.style.cssText = "width:100%;height:100%;display:grid;place-items:center;background:rgba(255,255,255,0.05);font-size:2.2rem;";
                    placeholder.textContent = "📦";
                    imgEl.parentElement.appendChild(placeholder);
                }
                return;
            }
            const current = uniqueCandidates[idx++];
            imgEl.onerror = tryNextImage;
            imgEl.onload = () => {
                imgEl.onerror = null;
                imgEl.style.display = "";
                if (imgEl.parentElement) {
                    const oldPlaceholder = imgEl.parentElement.querySelector(".media-fallback-icon");
                    if (oldPlaceholder) oldPlaceholder.remove();
                }
            };
            imgEl.src = current;
        };

        tryNextImage();
    }

    function getVideoPreviewImage(videoUrl) {
        if (!videoUrl) return "";
        const v = String(videoUrl).trim();
        if (!v) return "";

        let id = "";
        const iImgurMatch = v.match(/i\.imgur\.com\/([a-zA-Z0-9]+)\.(mp4|gifv)(\?.*)?$/i);
        if (iImgurMatch && iImgurMatch[1]) id = iImgurMatch[1];

        if (!id) {
            const imgurMatch = v.match(/imgur\.com\/(?:a\/)?([a-zA-Z0-9]+)(\?.*)?$/i);
            if (imgurMatch && imgurMatch[1]) id = imgurMatch[1];
        }

        if (!id) return "";
        return `https://i.imgur.com/${id}.jpg`;
    }

    function cleanMediaUrl(url, defaultType) {
        if (!url) return "";
        let s = String(url).trim();
        if (!s) return "";

        // application/octet-stream sans MIME → on devine selon le contexte
        if (s.startsWith("data:application/octet-stream") || s.startsWith("data:;")) {
            if (defaultType === "video") {
                s = s.replace(/^data:(application\/octet-stream|);/, "data:video/mp4;");
            } else {
                s = s.replace(/^data:(application\/octet-stream|);/, "data:image/jpeg;");
            }
        }
        // NE PAS remapper video/quicktime → video/mp4 : les données sont QuickTime,
        // changer le MIME ne transcode pas le contenu et casse la lecture sur Chrome.
        // iOS Safari lit nativement video/quicktime.

        // Convertir les liens absolus ngrok / cloudflare en /uploads/ (servis par le PC, à la même adresse que le site)
        if (/^https?:\/\/[^\/]*(ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i.test(s)) {
            s = s.replace(/^https?:\/\/[^\/]*(ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i, "/uploads/");
        }

        return s;
    }

    // La page est servie par willy.py (tunnel Cloudflare ou poste local) : /uploads/ est sur la même origine
    function pageServesUploads() {
        const loc = window.location || {};
        const host = String(loc.hostname || "").toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return true;
        return TRUSTED_API_BASE_RE.test(normalizeApiBase(loc.origin));
    }

    // Adresses à essayer pour un fichier /uploads/ : le chemin relatif quand l'origine le sert ;
    // sinon (site statique) d'abord l'api_base de confiance, puis le relatif en dernier recours
    function uploadsCandidates(path) {
        if (pageServesUploads()) return [path];
        const apiBase = trustedApiBase(state && state.config && state.config.admin && state.config.admin.api_base) || getStoredWriteApiBase() || "";
        return apiBase ? [`${apiBase}${path}`, path] : [path];
    }

    // Repli de attachImageSource / attachVideoSource : chaque adresse est essayée tour à tour en cas d'erreur
    function mediaCandidates(url) {
        if (url.startsWith("/uploads/")) return uploadsCandidates(url);
        const m = /^https?:\/\//i.test(url) ? url.match(/\/uploads\/[^\/?#]+/i) : null;
        return Array.from(new Set([url, ...(m ? uploadsCandidates(m[0]) : [])]));
    }

    function resolveMediaUrl(url, defaultType) {
        if (!url) return "";
        let s = cleanMediaUrl(url, defaultType);
        if (!s) return "";
        if (s.startsWith("data:") || s.startsWith("blob:")) return s;
        return s.startsWith("/uploads/") ? uploadsCandidates(s)[0] : s;
    }

    function buildMediaSlides(product) {
        const slides = [];
        const gallery = Array.isArray(product.gallery) ? product.gallery : [];
        const cleanImg = resolveMediaUrl(product.image || "", "image");
        const cleanVid = resolveMediaUrl(product.video || "", "video");

        gallery.forEach((item) => {
            if (!item) return;
            if (typeof item === "string") {
                const c = resolveMediaUrl(item, "image");
                if (c) slides.push({ type: c.startsWith("data:video/") ? "video" : "image", src: sanitize(c) });
                return;
            }
            const type = item.type === "video" ? "video" : "image";
            const src = type === "video" ? getPlayableVideo(resolveMediaUrl(item.src || "", "video")) : sanitize(resolveMediaUrl(item.src || "", "image"));
            if (!src) return;
            if (type === "video") {
                const fallbackThumb = sanitize(cleanImg);
                const thumb = sanitize(resolveMediaUrl(item.thumb || item.poster || getVideoPreviewImage(src) || fallbackThumb, "image"));
                slides.push({ type, src, thumb, fallbackThumb });
                return;
            }
            slides.push({ type, src });
        });

        const videoUrl = getPlayableVideo(cleanVid);
        if (videoUrl) {
            const fallbackThumb = sanitize(cleanImg);
            const thumb = sanitize(resolveMediaUrl(getVideoPreviewImage(videoUrl) || fallbackThumb, "image"));
            slides.push({ type: "video", src: videoUrl, thumb, fallbackThumb });
        }
        if (cleanImg && !cleanImg.startsWith("data:video/")) {
            slides.push({ type: "image", src: sanitize(cleanImg) });
        }

        // Ces liens finissent dans des attributs src / poster : uniquement /uploads/ ou https
        const dedup = [];
        const seen = new Set();
        slides.forEach((slide) => {
            const safe = { ...slide, src: safeMediaUrl(slide.src) };
            if ("thumb" in slide) safe.thumb = safeMediaUrl(slide.thumb);
            if ("fallbackThumb" in slide) safe.fallbackThumb = safeMediaUrl(slide.fallbackThumb);
            const key = `${safe.type}:${safe.src}`;
            if (!safe.src || seen.has(key)) return;
            seen.add(key);
            dedup.push(safe);
        });

        return dedup.length ? dedup : [{ type: "image", src: "https://picsum.photos/seed/fallback-red/900/700" }];
    }

    function renderDetailCarousel() {
        if (!detailSlides.length) return;

        els.detailMediaTrack.innerHTML = detailSlides
            .map((slide, idx) => {
                if (slide.type === "video") {
                    const posterAttr = slide.thumb ? `poster="${sanitize(slide.thumb)}"` : (slide.fallbackThumb ? `poster="${sanitize(slide.fallbackThumb)}"` : "");
                    return `<article class="slide-item slide-item-video" data-slide-index="${idx}"><video class="slide-video" autoplay muted playsinline webkit-playsinline loop preload="auto" ${posterAttr} data-video-src="${slide.src}"></video><button class="video-play-btn" type="button" aria-label="Lire la vidéo">▶</button><button class="video-fs-btn" type="button" aria-label="Plein écran">⛶</button></article>`;
                }
                return `<article class="slide-item" data-slide-index="${idx}"><img class="slide-image" data-img-src="${slide.src}" src="${slide.src}" alt="Media produit ${idx + 1}" loading="lazy" referrerpolicy="no-referrer"></article>`;
            })
            .join("");

        els.detailThumbs.innerHTML = detailSlides
            .map((slide, idx) => {
                const marker = slide.type === "video" ? "▶" : "";
                let thumbMedia = "";
                if (slide.type === "video") {
                    if (slide.thumb && !slide.thumb.startsWith("data:video/")) {
                        thumbMedia = `<img src="${slide.thumb}" alt="Miniature video ${idx + 1}" loading="lazy" referrerpolicy="no-referrer" data-fallback="${slide.fallbackThumb || ""}" onerror="this.style.display='none';">`;
                    } else {
                        thumbMedia = `<video class="thumb-video" data-video-src="${slide.src}" muted playsinline preload="metadata"></video>`;
                    }
                } else {
                    thumbMedia = `<img src="${slide.src}" data-img-src="${slide.src}" class="detail-thumb-img" alt="Miniature ${idx + 1}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';">`;
                }
                return `<button class="detail-thumb ${idx === 0 ? "active" : ""}" data-slide-index="${idx}" type="button">${thumbMedia}<span>${marker}</span></button>`;
            })
            .join("");

        els.detailThumbs.querySelectorAll("img[data-fallback]").forEach((img) => {
            img.addEventListener("error", () => {
                const fallback = img.getAttribute("data-fallback") || "";
                if (fallback && img.src !== fallback) img.src = fallback;
            }, { once: true });
        });

        els.detailThumbs.querySelectorAll(".detail-thumb").forEach((btn) => {
            btn.addEventListener("click", () => {
                setDetailSlide(parseInt(btn.dataset.slideIndex, 10), true);
            });
        });

        // Configurer les vidéos de slide : poster, bouton play, et chargement immédiat
        els.detailMediaTrack.querySelectorAll(".slide-item-video").forEach((article) => {
            const video = article.querySelector("video");
            if (!video) return;

            video.addEventListener("play", () => article.classList.add("playing"));
            video.addEventListener("playing", () => article.classList.add("playing"));
            video.addEventListener("pause", () => article.classList.remove("playing"));
            video.addEventListener("ended", () => article.classList.remove("playing"));

            const togglePlay = (e) => {
                if (e.target.closest(".video-fs-btn")) return;
                if (video.paused) {
                    video.muted = true;
                    video.play().catch(() => {});
                } else {
                    video.pause();
                }
            };

            article.addEventListener("click", togglePlay);

            if (video.dataset.videoSrc) attachVideoSource(video, video.dataset.videoSrc);
        });

        els.detailThumbs.querySelectorAll(".thumb-video").forEach((video) => {
            if (video.dataset.videoSrc) attachVideoSource(video, video.dataset.videoSrc);
        });

        els.detailMediaTrack.querySelectorAll(".slide-image").forEach((img) => {
            if (img.dataset.imgSrc) attachImageSource(img, img.dataset.imgSrc);
        });
        els.detailThumbs.querySelectorAll(".detail-thumb-img").forEach((img) => {
            if (img.dataset.imgSrc) attachImageSource(img, img.dataset.imgSrc);
        });

        // Bouton plein écran sur chaque slide vidéo
        els.detailMediaTrack.querySelectorAll(".video-fs-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const article = btn.closest(".slide-item");
                const video = article ? article.querySelector("video") : null;
                if (video) enterVideoFullscreen(video, btn);
            });
        });

        setDetailSlide(0, false);
    }

    function pauseAllSlideVideos() {
        els.detailMediaTrack.querySelectorAll("video").forEach((video) => {
            video.pause();
        });
    }

    function setDetailSlide(index, smooth) {
        if (!detailSlides.length) return;
        if (index < 0) index = detailSlides.length - 1;
        if (index >= detailSlides.length) index = 0;
        detailSlideIndex = index;

        els.detailMediaTrack.style.transition = smooth ? "transform 280ms ease" : "none";
        els.detailMediaTrack.style.transform = `translateX(-${detailSlideIndex * 100}%)`;

        els.detailThumbs.querySelectorAll(".detail-thumb").forEach((thumb) => {
            thumb.classList.toggle("active", parseInt(thumb.dataset.slideIndex, 10) === detailSlideIndex);
        });
        if (els.detailSlideCount) els.detailSlideCount.textContent = `${detailSlideIndex + 1} / ${detailSlides.length}`;
        pauseAllSlideVideos();

        const activeType = detailSlides[detailSlideIndex].type;
        const isVideo = activeType === "video";
        if (isVideo) {
            const activeVideo = els.detailMediaTrack.querySelector(`.slide-item[data-slide-index="${detailSlideIndex}"] video`);
            if (activeVideo) activeVideo.play().catch(() => { });
            if (els.detailMuteBtn) {
                els.detailMuteBtn.disabled = false;
                els.detailMuteBtn.style.opacity = "1";
            }
        } else {
            if (els.detailMuteBtn) {
                els.detailMuteBtn.disabled = true;
                els.detailMuteBtn.style.opacity = "0.45";
                els.detailMuteBtn.textContent = "🔈";
            }
        }
        if (els.detailMuteBtn) {
            els.detailMuteBtn.setAttribute("aria-label", t("muteLabel"));
        }
    }

    function toggleActiveVideoMute() {
        const video = els.detailMediaTrack.querySelector(`.slide-item[data-slide-index="${detailSlideIndex}"] video`);
        if (!video) return;
        video.muted = !video.muted;
        els.detailMuteBtn.textContent = video.muted ? "🔈" : "🔇";
        els.detailMuteBtn.setAttribute("aria-label", video.muted ? t("muteLabel") : t("unmuteLabel"));
    }

    function enterVideoFullscreen(video, _btn) {
        if (!video) return;

        // Sauvegarder les infos de la vidéo d'origine AVANT de la couper
        var originalSrc = video.src;
        var originalTime = video.currentTime || 0;
        var originalMuted = video.muted;

        // ✅ Fix double son : couper COMPLETEMENT la vidéo d'origine
        // (pause seul ne suffit pas sur certains WebViews mobiles)
        video.pause();
        video.muted = true;
        video.volume = 0;
        video.src = "";
        video.load();

        // Créer l'overlay s'il n'existe pas encore
        var overlay = document.getElementById("vfs-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "vfs-overlay";
            overlay.className = "vfs-overlay";
            overlay.innerHTML =
                "<button class=\"vfs-close\" id=\"vfs-close\" type=\"button\" aria-label=\"Fermer\">\u2715</button>" +
                "<video class=\"vfs-player\" id=\"vfs-player\" playsinline controls></video>";
            document.body.appendChild(overlay);
        }

        var player = document.getElementById("vfs-player");
        var closeBtn = document.getElementById("vfs-close");

        // Lancer le player fullscreen depuis la même position
        player.src = originalSrc;
        player.currentTime = originalTime;
        player.muted = false;
        player.volume = 1;
        overlay.style.display = "flex";
        document.body.classList.add("vfs-open");
        player.play().catch(function () { });

        function closeOverlay() {
            var resumeTime = 0;
            try { resumeTime = player.currentTime; } catch (e) { }

            // Stopper le player overlay
            player.pause();
            player.src = "";
            player.load();

            // Restaurer et reprendre la vidéo d'origine
            video.src = originalSrc;
            video.muted = originalMuted;
            video.volume = 1;
            video.load();
            video.currentTime = resumeTime;
            video.play().catch(function () { });

            overlay.style.display = "none";
            document.body.classList.remove("vfs-open");
            closeBtn.onclick = null;
            overlay.onclick = null;
        }

        closeBtn.onclick = closeOverlay;
        overlay.onclick = function (e) { if (e.target === overlay) closeOverlay(); };
    }

    function openProductDetail(product) {
        state.selectedProduct = product;
        state.selectedQty = null;
        state.selectedWeight = null;
        state.selectedPrice = 0;
        state.detailMedia = "image";
        detailSlides = buildMediaSlides(product);
        detailSlideIndex = 0;

        const categoryMeta = getCategoryMeta(product.category);
        els.detailName.textContent = plainText(product.name || "Product");
        els.detailDescription.textContent = plainText(product.description || "");
        els.detailCategoryChip.textContent = `${plainText(categoryMeta.emoji || "📦")} ${plainText(categoryMeta.name || product.category)}`;
        if (product.image) {
            attachImageSource(els.detailBrandImage, product.image);
        } else {
            els.detailBrandImage.src = "";
            els.detailBrandImage.style.display = "none";
        }

        renderDetailQuantities(product);
        renderDetailOrderLinks();
        renderDetailLike(product); // catalogue : like du produit
        const soldOut = isSoldOut(product);
        els.detailAddBtn.disabled = soldOut;
        els.detailAddBtn.textContent = soldOut ? t("badgeSoldOut") : t("add");
        els.detailOverlay.scrollTop = 0;
        els.detailOverlay.style.display = "block";
        document.body.style.overflow = "hidden";
        document.body.classList.add("detail-open");
        syncBgAnimation();

        renderDetailCarousel();
        setDetailSlide(0, false);
    }

    function closeProductDetail() {
        els.detailOverlay.style.display = "none";
        pauseAllSlideVideos();
        detailSlides = [];
        els.detailMediaTrack.innerHTML = "";
        els.detailThumbs.innerHTML = "";
        document.body.style.overflow = "";
        document.body.classList.remove("detail-open");
        syncBgAnimation();
    }

    // type : "error" (⚠, reste affiché plus longtemps), "info" (ℹ) ou succès (✓ par défaut).
    // Le message est du texte (textContent) : un texte venu du serveur ne peut pas injecter de HTML.
    function showToast(message, type) {
        const existing = document.getElementById("gh-toast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.id = "gh-toast";
        toast.className = `gh-toast${type === "error" ? " gh-toast-error" : type === "info" ? " gh-toast-info" : ""}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");
        const icon = document.createElement("span");
        icon.className = "toast-icon";
        icon.textContent = type === "error" ? "⚠" : type === "info" ? "ℹ" : "✓";
        const text = document.createElement("span");
        text.className = "toast-message";
        text.textContent = String(message || "");
        toast.append(icon, text);
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add("visible");
        });

        setTimeout(() => {
            toast.classList.remove("visible");
            toast.addEventListener("transitionend", () => {
                toast.remove();
            }, { once: true });
        }, type === "error" ? 4500 : 2500);
    }

    // Copie dans le presse-papiers : true seulement si la copie a vraiment eu lieu (API Clipboard refusée ou absente
    // dans certaines WebView Telegram : repli sur execCommand("copy") avec une zone de texte temporaire)
    async function copyTextToClipboard(text) {
        const value = String(text == null ? "" : text);
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("clipboard indisponible");
            await navigator.clipboard.writeText(value);
            return true;
        } catch (_) {
            const area = document.createElement("textarea");
            area.value = value;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            let ok = false;
            try {
                ok = document.execCommand("copy");
            } catch (_) {
                ok = false;
            }
            area.remove();
            return ok;
        }
    }

    // message est du HTML : l'appelant échappe toute valeur venue du serveur (escapeHtml)
    function showConfirmModal(opts) {
        const {
            title = "Confirmation",
            emoji = "⚠️",
            message = "Es-tu sûr ?",
            confirmText = "Confirmer",
            cancelText = "Annuler",
            isDanger = true,
            onConfirm = () => {},
            onCancel = () => {}
        } = (opts || {});

        const oldModal = document.getElementById("gh-confirm-modal");
        if (oldModal) oldModal.remove();

        const backdrop = document.createElement("div");
        backdrop.id = "gh-confirm-modal";
        backdrop.className = "gh-modal-backdrop";
        backdrop.innerHTML = `
            <div class="gh-modal-card ${isDanger ? 'gh-modal-danger' : ''}" role="dialog" aria-modal="true">
                <div class="gh-modal-glow"></div>
                <div class="gh-modal-icon-badge">${emoji}</div>
                <h3 class="gh-modal-title">${escapeHtml(title)}</h3>
                <div class="gh-modal-message">${message}</div>
                <div class="gh-modal-actions">
                    <button type="button" class="gh-modal-btn gh-modal-btn-cancel" id="gh-modal-cancel">${escapeHtml(cancelText)}</button>
                    <button type="button" class="gh-modal-btn gh-modal-btn-confirm ${isDanger ? 'danger' : ''}" id="gh-modal-confirm">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => {
            backdrop.classList.remove("visible");
            backdrop.addEventListener("transitionend", () => {
                backdrop.remove();
            }, { once: true });
        };

        const confirmBtn = backdrop.querySelector("#gh-modal-confirm");
        const cancelBtn = backdrop.querySelector("#gh-modal-cancel");

        confirmBtn.addEventListener("click", async () => {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "⏳ En cours...";
            try {
                await onConfirm();
            } finally {
                close();
            }
        });

        cancelBtn.addEventListener("click", () => {
            onCancel();
            close();
        });

        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) {
                onCancel();
                close();
            }
        });

        requestAnimationFrame(() => {
            backdrop.classList.add("visible");
        });
    }

    function renderDetailQuantities(product) {
        const entries = getQtyEntries(product);
        els.detailQtyGrid.innerHTML = entries
            .map((entry, idx) => `
                <button class="qty-card ${idx === 0 ? "active" : ""}" data-qty="${entry.qty}" data-price="${entry.price}" type="button">
                    <div class="qty-label">${entry.tier ? escapeHtml(tierLabel(entry.qty, entry.unit)) : t("unitLabel")}</div>
                    <div class="qty-price">${cataloguePriceHtml(entry.price)}</div>
                </button>
            `)
            .join("");

        const first = entries[0];
        state.selectedQty = first.qty;
        state.selectedWeight = first.tier ? first.qty : null;
        state.selectedPrice = first.price;
        els.detailSelectedPrice.textContent = catalogueDisplayPrice(state.selectedPrice); // catalogue : prix après promo

        els.detailQtyGrid.querySelectorAll(".qty-card").forEach((card) => {
            card.addEventListener("click", () => {
                els.detailQtyGrid.querySelectorAll(".qty-card").forEach((c) => c.classList.remove("active"));
                card.classList.add("active");
                state.selectedQty = parseFloat(card.dataset.qty);
                state.selectedWeight = first.tier ? state.selectedQty : null;
                state.selectedPrice = parseFloat(card.dataset.price);
                els.detailSelectedPrice.textContent = catalogueDisplayPrice(state.selectedPrice); // catalogue
            });
        });
    }

    async function onCheckout() {
        if (checkoutBusy) return;
        // Accès retiré depuis le dernier rechargement (boutique fermée, vérification…) : écran d'accès, rien ne part
        if (state.access && state.access.allowed === false) {
            applyAccessState();
            return;
        }
        // Commandes désactivées dans la gestion (Commandes › « Commandes activées ») : rien ne part
        const opts = orderSettings();
        if (!opts.ordersEnabled) {
            applyOrderOptions();
            showToast(t("ordersClosedToast"), "error");
            return;
        }
        if (!state.cart.length) {
            alert(t("alertCartEmpty"));
            return;
        }

        // Produit passé « Épuisé » après son ajout au panier (panier gardé en local / CloudStorage) : rien ne part
        const soldOutLine = state.cart.find((i) => isSoldOut(cartLineProduct(i)));
        if (soldOutLine) {
            renderCart();
            showToast(t("soldOutCartToast", { name: plainText(soldOutLine.name) }), "error");
            return;
        }

        // catalogue : en multi-ville, la ville est choisie avant de commander (catalogue et frais en dépendent)
        if (cityPickerNeeded()) {
            openCityPicker(false);
            return;
        }

        // Meetup ou envoi postal coupé depuis l'affichage du panier : retour en livraison avant de vérifier les champs
        applyOrderOptions();
        // catalogue : adresse, envoi postal, créneau (date + heure) et paiement vérifiés comme le fera le serveur
        const checkout = catalogueCheckoutFields(orderSettings());
        if (checkout.error) {
            alert(checkout.error);
            return;
        }
        const totals = cartTotals();
        const total = totals.total;
        const itemsText = state.cart.map((i) => `${plainText(i.name)} x${i.quantity}`).join(", ");
        const summary = [itemsText].concat(catalogueSummaryExtras(totals)).join(", ");
        const currentUser = getTelegramUser();
        const order = Object.assign({
            id: state.orders.length + 1,
            type: state.orderType,
            total,
            summary,
            items: JSON.parse(JSON.stringify(state.cart)),
            timestamp: Date.now(),
            telegramUserId: currentUser && Number.isFinite(Number(currentUser.id)) ? Number(currentUser.id) : null,
            telegramUsername: currentUser && currentUser.username ? plainText(currentUser.username) : null
        }, checkout.fields);
        Object.assign(order, fideliteCheckoutFields(total)); // fidelite : palier de points / code gagné (vérifiés par le serveur)

        // Enregistrement AVANT d'ouvrir Telegram : une commande refusée par le serveur (boutique fermée,
        // commandes coupées, accès retiré) ne laisse aucun message prérempli
        checkoutBusy = true;
        applyOrderOptions();
        let saved;
        try {
            saved = await persistOrderToServer(order);
        } finally {
            checkoutBusy = false;
            applyOrderOptions();
        }
        if (saved.status === "gated") return; // écran d'accès affiché, panier gardé
        if (saved.status === "closed") {
            if (state.config && state.config.admin) state.config.admin.orders_enabled = "false";
            applyOrderOptions();
            showToast(saved.error || t("ordersClosedToast"), "error");
            return;
        }
        // catalogue : commande refusée par le serveur (ville, créneau passé, produit indisponible…) : rien ne part
        if (saved.status === "refused") {
            showToast(saved.error, "error");
            if (saved.cityRequired) {
                catalogue.city = "";
                openCityPicker(false);
            }
            return;
        }
        // Numéro de la commande en base : le même que dans la liste « Commandes » du panel
        if (saved.orderId) order.id = saved.orderId;
        else showToast(t("orderNotSaved"), "error");
        applyServerOrder(order, saved); // catalogue : total et récapitulatif recalculés par le serveur
        state.orders.push(order);

        const username = getPrimaryTelegramUsername();
        let message = t("orderText", {
            id: order.id,
            type: catalogueOrderTypeLabel(order.type),
            summary: order.summary,
            total: formatPrice(order.total) // total confirmé par le serveur (promo globale, frais, réduction fidélité)
        });
        if (checkout.lines.length) message += `\n${checkout.lines.join("\n")}`;
        message += fideliteOrderNote(order); // fidelite : réduction fidélité appliquée
        const url = `https://t.me/${username}?text=${encodeURIComponent(message)}`;

        if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
        else window.open(url, "_blank");

        state.cart = [];
        saveLocal();
        renderCart();
        renderHistory();
        renderProfileStats();
        switchPage("history");
    }

    function bindActions() {
        els.clearCartBtn.addEventListener("click", () => {
            state.cart = [];
            saveLocal();
            renderCart();
        });

        els.checkoutBtn.addEventListener("click", onCheckout);

        els.serviceSwitch.querySelectorAll(".service-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                state.orderType = btn.dataset.service;
                // Affichage des champs (adresse / créneau) et frais de livraison selon les réglages Commandes
                renderCart();
            });
        });

        if (els.channelBtn) els.channelBtn.addEventListener("click", () => {
            const link = shopChannelLink();
            if (!link) return;
            if (tg && tg.openLink) tg.openLink(link);
            else window.open(link, "_blank");
        });

        // Onglet Contact : tuiles des réseaux (lien recalculé depuis la config au clic) et « Signaler un problème » ;
        // « Commander sur … » de la fiche produit juste après
        if (els.contactNetGrid) {
            els.contactNetGrid.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-net]");
                if (!btn) return;
                if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
                if (btn.dataset.net === "telegram") openTelegramContact(btn.dataset.tg);
                else openExternalLink(socialOrderLink(btn.dataset.net, ""));
            });
        }
        if (els.contactReportBtn) els.contactReportBtn.addEventListener("click", contactReportProblem);
        if (els.detailOrderLinks) {
            els.detailOrderLinks.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-net]");
                if (!btn) return;
                const productName = state.selectedProduct ? plainText(state.selectedProduct.name) : "";
                openExternalLink(socialOrderLink(btn.dataset.net, productName));
            });
        }

        // Écran d'accès (ouvrir le bot / le canal, réessayer, fermer) et rappel admin
        if (els.accessScreen) els.accessScreen.addEventListener("click", onAccessAction);
        if (els.accessStaffNoteClose) {
            els.accessStaffNoteClose.addEventListener("click", () => {
                accessUi.staffNoteHidden = els.accessStaffNote.dataset.key || "";
                els.accessStaffNote.hidden = true;
            });
        }

        els.reviewForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const author = plainText(els.reviewAuthor.value || "");
            const stars = Math.max(1, Math.min(5, parseInt(els.reviewStars.value, 10) || 5));
            const message = plainText(els.reviewMessage.value || "");
            if (!author || !message) {
                alert(t("alertReview"));
                return;
            }
            void addReview(author, stars, message);
            els.reviewForm.reset();
            els.reviewStars.value = "5";
            paintStarPicker();
        });

        document.getElementById("star-picker").addEventListener("click", (e) => {
            const btn = e.target.closest(".star-btn");
            if (!btn) return;
            els.reviewStars.value = btn.dataset.star;
            paintStarPicker();
            if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        });

        els.detailCloseBtn.addEventListener("click", closeProductDetail);
        els.detailPrevBtn.addEventListener("click", () => setDetailSlide(detailSlideIndex - 1, true));
        els.detailNextBtn.addEventListener("click", () => setDetailSlide(detailSlideIndex + 1, true));

        els.detailMediaWindow.addEventListener("touchstart", (event) => {
            detailTouchStartX = event.changedTouches[0].clientX;
            detailTouchDeltaX = 0;
        }, { passive: true });

        els.detailMediaWindow.addEventListener("touchmove", (event) => {
            detailTouchDeltaX = event.changedTouches[0].clientX - detailTouchStartX;
        }, { passive: true });

        els.detailMediaWindow.addEventListener("touchend", () => {
            if (Math.abs(detailTouchDeltaX) < 38) return;
            if (detailTouchDeltaX < 0) setDetailSlide(detailSlideIndex + 1, true);
            else setDetailSlide(detailSlideIndex - 1, true);
        });

        els.detailAddBtn.addEventListener("click", () => {
            if (isSoldOut(state.selectedProduct)) {
                showToast(t("soldOutToast"), "error");
                return;
            }
            if (!state.selectedProduct || !state.selectedQty || !state.selectedPrice) {
                alert(t("alertSelectQty"));
                return;
            }
            if (!addToCart(state.selectedProduct, state.selectedWeight, state.selectedPrice)) return;
            // même libellé que la ligne du panier : « Produit (5G) » pour un palier, « Produit » sans palier
            showToast(t("cartAdded", { name: plainText(cartLineName(state.selectedProduct, state.selectedWeight)) }));
            closeProductDetail();
        });

        if (els.detailMuteBtn) {
            els.detailMuteBtn.addEventListener("click", toggleActiveVideoMute);
        }

        if (els.detailTeleBtn) {
            els.detailTeleBtn.addEventListener("click", () => {
                const username = getPrimaryTelegramUsername();
                const productName = state.selectedProduct ? plainText(state.selectedProduct.name) : "product";
                const url = `https://t.me/${username}?text=${encodeURIComponent(t("askProduct", { name: productName }))}`;
                if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
                else window.open(url, "_blank");
            });
        }

        els.detailOverlay.addEventListener("click", (e) => {
            if (e.target === els.detailOverlay) closeProductDetail();
        });

        // Sélecteur de langue (en haut à droite de l'accueil) : menu ouvert / fermé, langue appliquée et mémorisée
        if (els.shopLang && els.shopLangBtn && els.shopLangMenu) {
            els.shopLangBtn.addEventListener("click", () => setShopLangMenu(els.shopLangMenu.hidden));
            els.shopLangMenu.addEventListener("click", (event) => {
                const target = event.target.closest(".shop-lang-option");
                if (!target) return;
                const nextLang = target.dataset.lang;
                setShopLangMenu(false);
                if (!["fr", "en", "de"].includes(nextLang)) return;
                if (nextLang === state.language) return;
                state.language = nextLang;
                if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
                renderLanguageSelection();
                applyTranslations();
                saveLocal();
            });
            // pointerdown et non click : sur iOS (WKWebView), un tap sur une zone non cliquable n'émet pas de click
            document.addEventListener("pointerdown", (event) => {
                if (!els.shopLangMenu.hidden && !els.shopLang.contains(event.target)) setShopLangMenu(false);
            });
            document.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && !els.shopLangMenu.hidden) {
                    setShopLangMenu(false);
                    els.shopLangBtn.focus();
                }
            });
        }

        if (els.profileOrdersRefresh) {
            els.profileOrdersRefresh.addEventListener("click", () => {
                renderProfileStats();
            });
        }

        if (els.adminPanelBtn) {
            els.adminPanelBtn.addEventListener("click", openAdminPanel);
        }

        if (els.adminCloseBtn) {
            els.adminCloseBtn.addEventListener("click", closeAdminPanel);
        }
    }

    // ===== ADMIN PANEL =====

    // État global du panel admin. Navigation : onglet du bas (accueil, catalogue, ventes, clients, reglages),
    // page affichée (ADMIN_PAGES) et dernière page ouverte de chaque onglet
    const adState = {
        activeTab: "accueil",
        activePage: "accueil",
        tabPages: {},
        // Fermeture réelle de la boutique (closed_now de /admin/config), pour le menu des Réglages
        closedInfo: null,
        productsFilter: "all",
        productsSort: "default",
        productsSearch: "",
        ordersFilter: "all",
        ticketsFilter: "all",
        usersFilter: "all",
        usersSearch: "",
        wizardStep: 1,
        wizardEditingProduct: null,
        wizardPriceRows: [],
        // Formulaire produit : numéro de session et annulation des envois en cours (resetWizardSession)
        wizardSession: 0,
        wizardUploads: null,
        editingCategoryKey: null,
        selectedLoader: "projecteur",
        selectedBg: "fumee",
        activeProducts: [],
        usersList: [],
        usersLoaded: false,
        usersCount: 0,
        usersRequest: null,
        ordersList: [],
        ordersLoaded: false,
        ordersError: "",
        ticketsList: [],
        ticketsError: "",
        usersError: "",
        profileUserId: null,
        whitelist: [],
        whitelistLinked: {},
        // Ajout d'un admin : « list » (recherche dans les utilisateurs du bot) ou « id » (ID Telegram)
        adminAddMode: "list",
        reviewsPending: 0,
        musicTracks: [],
        musicBusy: false,
        // Playlist lue au moins une fois : avant, toute modification écraserait la vraie (et supprimerait ses MP3)
        musicLoaded: false,
        // Éditeur /start : valeurs enregistrées (null = pas encore lues), photo affichée, envoi de photo en cours
        startSaved: null,
        startPhoto: "",
        startUploading: false,
        // Réglages : dernière valeur enregistrée par clé, enregistrements en attente (anti-rebond) ou en cours
        settingsSaved: {},
        settingsTimers: {},
        settingsSending: {},
        settingsQueue: {},
        settingsTouchedAt: {},
        startKeyboardRows: [],
        // Contrôles d'accès : état réel lu dans GET /admin/config (loaded = au moins une lecture réussie)
        backup: { loaded: false, error: "", tokenSet: false, username: "", id: "", running: false, active: false, usersCount: 0 },
        moderation: { loaded: false, chatSet: false, chatTitle: "" },
        mainBotUsername: "",
        accessRefreshTimer: null,
        // Vérifications en attente (CNI / approbation) ; photos chargées par fetch authentifié → URL blob,
        // révoquées à chaque nouveau rendu (verifCycle) et à la fermeture du panel
        verifItems: [],
        verifCounts: null,
        verifLoaded: false,
        verifError: "",
        verifCycle: 0,
        verifPhotos: new Map(),
        bound: false
    };

    function getAdminInitData() {
        return (tg && tg.initData) || "";
    }

    const MAX_UPLOAD_MB = 95;
    const SESSION_EXPIRED_MSG = "Session expirée : ferme et rouvre la mini-app, puis réessaie.";
    const ADMIN_SESSION_MS = 58 * 60 * 1000;
    const PAGE_OPENED_AT = Date.now();
    const UPLOAD_EXT_BY_MIME = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif",
        "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp",
        "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/ogg": "ogg"
    };

    function adminSessionExpired() {
        return Date.now() - PAGE_OPENED_AT > ADMIN_SESSION_MS;
    }

    // Appel admin unique : GET signé par l'en-tête X-Telegram-Init-Data, POST par init_data dans le corps.
    // Renvoie { ok, status, data, error } ; ok seulement si le serveur a confirmé (réponse JSON sans success:false),
    // error est le texte à afficher (403 = session expirée, sinon le message du serveur).
    async function adminRequest(path, body, timeoutMs) {
        const initData = getAdminInitData();
        const options = body === undefined
            ? { headers: { "X-Telegram-Init-Data": initData } }
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, body, { init_data: initData }))
            };
        let resp;
        try {
            resp = await fetchWriteApi(path, options, timeoutMs);
        } catch (_) {
            return { ok: false, status: 0, data: null, error: "Connexion impossible, réessaie." };
        }
        const data = await readJsonIfAny(resp);
        // bot : « CRM désactivé » (403 de /admin/users) garde le message du serveur
        if (resp.status === 403 && !(data && data.crm_disabled)) return { ok: false, status: 403, data, error: SESSION_EXPIRED_MSG };
        if (!resp.ok || !data || data.success === false) {
            return { ok: false, status: resp.status, data, error: (data && data.error) || `Erreur du serveur (HTTP ${resp.status}).` };
        }
        return { ok: true, status: resp.status, data, error: "" };
    }

    // Liste admin impossible à charger : le message remplace la liste (jamais un faux « aucune commande »)
    function renderAdminListError(container, message) {
        if (container) container.innerHTML = `<div class="gst-empty-placeholder gst-load-error">${escapeHtml(message)}</div>`;
    }

    // Config renvoyée après une modification réussie : boutique (catalogue, textes, musique) et listes admin ouvertes
    function applyUpdatedConfig(cfg) {
        if (!cfg || typeof cfg !== "object") return;
        state.config = cfg;
        state.products = allProductsFromConfig(cfg);
        state.categories = Object.keys(cfg.categories || {});
        if (state.category !== "all" && !state.categories.includes(state.category)) state.category = "all";
        if (cfg.admin && Array.isArray(cfg.admin.whitelist)) {
            adState.whitelist = cfg.admin.whitelist;
            if (cfg.admin.whitelist_linked && typeof cfg.admin.whitelist_linked === "object") adState.whitelistLinked = cfg.admin.whitelist_linked;
        }
        try {
            renderCategories();
            renderProducts();
            applyShopTexts();
            syncMusicPlaylist();
            if (isShown(document.getElementById("admin-overlay"))) {
                updateAdminBrandBar();
                if (adState.activeTab === "catalogue") {
                    adState.activeProducts = state.products.slice();
                    filterAndRenderProducts();
                    renderAdminCategories();
                }
            }
        } catch (err) {
            console.warn("Rafraîchissement après enregistrement :", err);
        }
    }

    function isShown(el) {
        return Boolean(el) && getComputedStyle(el).display !== "none";
    }

    // Les fichiers partent uniquement vers willy.py : la page elle-même quand c'est lui qui la sert,
    // sinon l'api_base de confiance (jamais Vercel, qui n'a pas de route /admin/upload)
    function getUploadApiBase() {
        if (pageServesUploads()) return normalizeApiBase(window.location.origin);
        const configured = state.config && state.config.admin ? trustedApiBase(state.config.admin.api_base) : "";
        return configured || getStoredWriteApiBase();
    }

    function uploadExtension(file) {
        const m = /\.([a-z0-9]{2,5})$/i.exec(file.name || "");
        return m ? m[1].toLowerCase() : (UPLOAD_EXT_BY_MIME[file.type] || "bin");
    }

    function uploadFileViaXhr(url, formData, onProgress, timeoutMs, signal) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            // Envoi annulé (formulaire fermé) : la promesse échoue avec une AbortError, sans message à afficher
            const aborted = () => {
                const err = new Error("Envoi annulé.");
                err.name = "AbortError";
                return err;
            };
            if (signal) {
                if (signal.aborted) {
                    reject(aborted());
                    return;
                }
                signal.addEventListener("abort", () => xhr.abort(), { once: true });
            }
            xhr.onabort = function() {
                reject(aborted());
            };
            xhr.open("POST", url, true);
            xhr.timeout = timeoutMs;
            xhr.setRequestHeader("X-Telegram-Init-Data", getAdminInitData());

            if (xhr.upload && typeof onProgress === "function") {
                xhr.upload.onprogress = function(e) {
                    if (e.lengthComputable && e.total > 0) {
                        const percent = Math.min(99, Math.round((e.loaded / e.total) * 100));
                        const loadedMb = (e.loaded / (1024 * 1024)).toFixed(1);
                        const totalMb = (e.total / (1024 * 1024)).toFixed(1);
                        onProgress(percent, loadedMb, totalMb);
                    }
                };
            }

            xhr.onload = function() {
                let data = null;
                try { data = JSON.parse(xhr.responseText); } catch (_) {}
                if (xhr.status >= 200 && xhr.status < 300 && data && data.success && data.url) {
                    resolve(String(data.url));
                } else if (xhr.status === 403) {
                    reject(new Error(SESSION_EXPIRED_MSG));
                } else if (xhr.status === 413) {
                    reject(new Error(`Fichier trop lourd (${MAX_UPLOAD_MB} Mo max).`));
                } else {
                    reject(new Error((data && data.error) || `Le serveur a refusé le fichier (erreur ${xhr.status}).`));
                }
            };
            xhr.ontimeout = function() {
                reject(new Error("Envoi trop long : la connexion est trop lente. Réessaie en Wi-Fi."));
            };
            xhr.onerror = function() {
                reject(new Error("Connexion au serveur perdue pendant l'envoi. Réessaie dans un instant."));
            };

            xhr.send(formData);
        });
    }

    // Envoie le fichier à willy.py et renvoie son chemin /uploads/… ; sinon lève une erreur au message lisible.
    // signal (AbortSignal, optionnel) interrompt l'envoi.
    async function uploadMediaFile(file, onProgress, signal) {
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            throw new Error(`Fichier trop lourd : ${Math.ceil(file.size / (1024 * 1024))} Mo (${MAX_UPLOAD_MB} Mo max). Raccourcis la vidéo ou filme en 1080p.`);
        }
        if (adminSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
        const base = getUploadApiBase();
        if (!base) throw new Error("Serveur introuvable : ferme et rouvre la mini-app.");

        const formData = new FormData();
        formData.append("file", file, `up_${Date.now()}.${uploadExtension(file)}`);
        const timeoutMs = 90000 + Math.round(file.size / 150);
        return uploadFileViaXhr(`${base}/admin/upload`, formData, onProgress, timeoutMs, signal);
    }

    function setUploadBusy(fileInputEl, busy) {
        fileInputEl.disabled = busy;
        if (!busy) fileInputEl.value = "";
        const form = fileInputEl.closest("form") || fileInputEl.closest(".gst-card") || fileInputEl.closest(".gst-modal-dialog");
        if (!form) return;
        const pending = Math.max(0, (Number(form.dataset.pendingUploads) || 0) + (busy ? 1 : -1));
        form.dataset.pendingUploads = String(pending);
        form.querySelectorAll('button[type="submit"], #pw-save-btn').forEach((btn) => { btn.disabled = pending > 0; });
    }

    // Photo ou vidéo d'après le type du fichier (ou son extension quand le téléphone ne donne pas de type)
    const UPLOAD_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
    const UPLOAD_VIDEO_EXT_RE = /\.(mp4|mov|avi|webm|m4v|mkv|3gp)$/i;

    // Le HEIC / HEIF n'est affiché ni par Chrome / Android ni par Telegram : refusé pour toutes les photos
    function isFileOfKind(file, kind) {
        if (kind === "image" && (/^image\/hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || ""))) return false;
        const type = String(file.type || "");
        if (type) return type.startsWith(`${kind}/`);
        return (kind === "video" ? UPLOAD_VIDEO_EXT_RE : UPLOAD_IMAGE_EXT_RE).test(file.name || "");
    }

    // Chemin /uploads/<fichier> d'une réponse d'envoi (seule forme acceptée pour background_image et logo_url)
    function uploadedPath(url) {
        const m = /\/uploads\/[^\s?#"'<>\\()]+/.exec(String(url || ""));
        return m ? m[0] : "";
    }

    // Image d'apparence (fond, logo) : rien n'est appliqué ni annoncé avant l'enregistrement confirmé
    function bindAppearanceUpload(inputId, key, successMsg, apply) {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener("change", async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            if (!isFileOfKind(file, "image")) {
                this.value = "";
                showToast("Choisis une image PNG, JPG ou WEBP.", "error");
                return;
            }
            setUploadBusy(this, true);
            showToast("Envoi de l'image… ⏳", "info");
            try {
                const path = uploadedPath(await uploadMediaFile(file, (percent) => showToast(`Envoi : ${percent}%`, "info")));
                if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
                if (await saveAdminSettings({ [key]: path })) {
                    adState.settingsSaved[key] = path;
                    apply(path);
                    showToast(successMsg);
                }
            } catch (err) {
                showToast(err.message, "error");
            } finally {
                setUploadBusy(this, false);
            }
        });
    }

    // Ouverture et Fermeture du Panel Admin : seulement après un GET /admin/config accepté (refreshAdminAccess)
    function openAdminPanel() {
        if (!isAdmin()) return;
        const overlay = document.getElementById("admin-overlay");
        if (!overlay) return;
        overlay.style.display = "flex";
        document.body.style.overflow = "hidden";
        if (!adState.bound) {
            bindAdminPanelEvents();
            adState.bound = true;
        }
        setTelegramAdminMode(true);
        syncBgAnimation();
        // Rafraîchir les titres de la boutique dans le bandeau
        updateAdminBrandBar();
        // Dernière page ouverte (Accueil à la première ouverture)
        openAdminPage(adState.activePage || "accueil");
    }

    function closeAdminPanel() {
        flushSettingsSaves();
        if (adState.activePage === "start") warnUnsavedStart();
        // Selfies d'identité : rien ne reste en mémoire une fois la gestion fermée (rechargés à la réouverture)
        closeVerificationsModal();
        releaseVerificationPhotos();
        const overlay = document.getElementById("admin-overlay");
        if (overlay) overlay.style.display = "none";
        document.body.style.overflow = "";
        setTelegramAdminMode(false);
        syncBgAnimation();
    }

    // Dans Telegram, tant que le panel est ouvert : le bouton Retour ferme la couche du dessus (confirmation,
    // modale), sinon remonte d'une page (réglage → menu des Réglages, autre onglet → Accueil), puis ferme le panel ;
    // la mini-app demande confirmation avant de se fermer et ne se ferme plus en glissant.
    function tgSupports(version) {
        return Boolean(tg) && (typeof tg.isVersionAtLeast !== "function" || tg.isVersionAtLeast(version));
    }

    function setTelegramAdminMode(on) {
        if (!tg) return;
        try {
            if (tg.BackButton && tgSupports("6.1")) {
                tg.BackButton.offClick(closeTopAdminLayer);
                if (on) {
                    tg.BackButton.onClick(closeTopAdminLayer);
                    tg.BackButton.show();
                } else {
                    tg.BackButton.hide();
                }
            }
            if (tgSupports("6.2")) {
                if (on) tg.enableClosingConfirmation();
                else tg.disableClosingConfirmation();
            }
            if (tgSupports("7.7") && typeof tg.disableVerticalSwipes === "function") {
                if (on) tg.disableVerticalSwipes();
                else tg.enableVerticalSwipes();
            }
        } catch (_) { }
    }

    function closeTopAdminLayer() {
        const confirmModal = document.getElementById("gh-confirm-modal");
        const cancelBtn = confirmModal && confirmModal.classList.contains("visible") && confirmModal.querySelector("#gh-modal-cancel");
        if (cancelBtn) {
            cancelBtn.click();
            return;
        }
        const closers = {
            "gst-modal-quick-list": closeQuickListDrawer,
            "gst-modal-more-menu": closeMoreMenu,
            "gst-modal-intro-loader": closeLoaderModal,
            "gst-modal-animated-bg": closeAnimatedBgModal,
            "gst-modal-product-wizard": closeProductWizard,
            "gst-modal-written-menu": closeWrittenMenuModal,
            "gst-modal-user-profile": closeUserProfileModal,
            "gst-modal-backup-users": closeBackupUsersModal,
            "gst-modal-verifications": closeVerificationsModal
        };
        // Modales au même z-index : la dernière du document est au-dessus
        const open = [...document.querySelectorAll(".gst-modal-backdrop")].filter(isShown);
        const top = open[open.length - 1];
        if (top) {
            if (closers[top.id]) closers[top.id]();
            else top.style.display = "none";
            return;
        }
        if (adminNavigateBack()) return;
        closeAdminPanel();
    }

    function updateAdminBrandBar() {
        const shopDisplayName = document.getElementById("gst-shop-display-name");
        const supportPill = document.getElementById("gst-support-pill");
        const cfg = state.config || {};
        const rest = cfg.restaurant || {};
        if (shopDisplayName) shopDisplayName.textContent = `${rest.name || "GreenHouse 68"} 🛍️`;
        // Compte Telegram connecté à la gestion (le pseudo de contact de la boutique se règle dans Réseaux sociaux)
        const me = getTelegramUser();
        if (supportPill) {
            supportPill.textContent = me && me.username ? `👤 @${me.username}` : `👤 ${(me && me.first_name) || "Admin"}`;
            supportPill.title = "Compte connecté à la gestion";
        }
    }

    // ===== NAVIGATION : 5 onglets par usage → pages =====
    // Onglet du bas → pages (.gst-page[data-gst-page] de index.html : les sections y ont été déplacées avec leurs ids
    // et leur JS). Catalogue, Ventes et Clients : pastilles des pages en haut ; Réglages : menu en liste
    // (REGLAGES_SECTIONS) puis une page par réglage avec « ‹ Réglages ». Les loaders d'une page sont appelés à chaque
    // ouverture de la page.
    const ADMIN_TABS = {
        accueil: { label: "Accueil", pages: ["accueil"] },
        catalogue: { label: "Catalogue", pages: ["produits", "categories", "villes", "promo"] },
        ventes: { label: "Ventes", pages: ["commandes", "options-commande", "reception", "neme-client"] },
        clients: { label: "Clients", pages: ["utilisateurs", "verifications", "fidelite", "jeux", "avis", "tickets"] },
        reglages: { label: "Réglages", pages: ["reglages"] } // + pages de REGLAGES_SECTIONS (ajoutées plus bas)
    };

    // Pages hors réglages : onglet, titre (short = pastille), icône, loaders, mots-clés de l'accès rapide 🔍.
    // crm : page masquée quand le CRM est coupé.
    const ADMIN_PAGES = {
        accueil: {
            tab: "accueil", title: "Tableau de bord", icon: "📊", load: [loadAdminDashboard], onOpen: renderDashboard,
            keywords: "accueil chiffres du jour commandes chiffre d'affaires panier moyen alertes à traiter état système bot tunnel lien raccourcis"
        },
        produits: {
            tab: "catalogue", title: "Produits", icon: "📦", load: [loadAdminProductsData],
            keywords: "produit stock rupture prix nouveau nouveaux promo menu écrit position grille assistant photo vidéo ville"
        },
        categories: { tab: "catalogue", title: "Catégories", icon: "📁", load: [loadAdminProductsData], keywords: "catégorie emoji description" },
        villes: {
            tab: "catalogue", title: "Villes & secteurs", short: "Villes", icon: "📍", load: [loadAdminSettingsData, loadCataloguePanel],
            keywords: "multi-ville multiville secteur ville frais de livraison par ville"
        },
        promo: {
            tab: "catalogue", title: "Promo & likes", short: "Promo", icon: "🏷️", load: [loadAdminSettingsData, loadCataloguePanel],
            keywords: "promotion globale réduction pourcentage prix barrés likes cœur coeur compteur"
        },
        commandes: {
            tab: "ventes", title: "Commandes", icon: "🧾", load: [loadAdminOrdersData],
            keywords: "commande statut nouvelle acceptée livraison livrée annulée revenus panier moyen crm dashboard click collect"
        },
        "options-commande": {
            tab: "ventes", title: "Options de commande", short: "Options", icon: "🛠️", load: [loadAdminSettingsData, loadCataloguePanel],
            keywords: "commandes activées fermer panier meetup envoi postal calendrier créneau frais de livraison gratuite crypto wallet paiement"
        },
        reception: {
            tab: "ventes", title: "Réception des commandes", short: "Réception", icon: "📥", load: [loadCataloguePanel],
            keywords: "groupe de réception /commandes notification nouvelle commande"
        },
        "neme-client": {
            tab: "ventes", title: "Messages N-ème client", short: "N-ème client", icon: "🎯", load: [loadCataloguePanel],
            keywords: "jalon nième n-ième commande message fidélité"
        },
        utilisateurs: {
            tab: "clients", title: "Fiches clients", short: "Clients", icon: "👤", load: [loadAdminUsersData], crm: true,
            keywords: "utilisateurs crm fiche client base actifs"
        },
        verifications: {
            tab: "clients", title: "Vérifications & approbation", short: "Vérifs", icon: "🪪", load: [loadAdminSettingsData, loadAdminVerifications],
            keywords: "cni selfie pièce d'identité approbation manuelle modération liste d'attente valider refuser"
        },
        fidelite: {
            tab: "clients", title: "Rang & parrainage", short: "Fidélité", icon: "👑", load: [loadAdminSettingsData, loadFidelitePanel],
            keywords: "rang parrainage points barème réduction classement fidélité"
        },
        jeux: {
            tab: "clients", title: "Roue & concours", short: "Jeux", icon: "🎡", load: [loadAdminSettingsData, loadFidelitePanel],
            keywords: "roue de la fortune lots tirage jeu concours gagnant"
        },
        avis: {
            tab: "clients", title: "Avis clients", short: "Avis", icon: "⭐", load: [loadAvisSettings, loadAdminReviews],
            keywords: "avis modération étoiles photo publier"
        },
        tickets: {
            tab: "clients", title: "Tickets SAV", short: "SAV", icon: "🎫", load: [loadAdminTicketsData],
            keywords: "ticket support sav service client réponse"
        },
        reglages: {
            tab: "reglages", title: "Réglages", icon: "⚙️", load: [loadAdminSettingsData, loadBotStatusQuiet], onOpen: renderSettingsMenu,
            keywords: "réglages paramètres menu"
        }
    };

    // Menu des Réglages : groupes → lignes (icône, titre, résumé de l'état réel : reglagesSummary) ;
    // chaque ligne ouvre la page de sa section, avec ses loaders
    const REGLAGES_SECTIONS = [
        {
            group: "Boutique & apparence", items: [
                { page: "general", icon: "📝", title: "Général", load: [loadAdminSettingsData], keywords: "logo nom slogan banderole défilante thème couleur loader d'intro fond animé" },
                { page: "image-fond", icon: "🖼️", title: "Image de fond", load: [loadAdminSettingsData, loadBotStatusData], keywords: "fond image arrière-plan ordinateur source lien startapp" },
                { page: "musique", icon: "🎵", title: "Musique", load: [loadAdminSettingsData, loadBotStatusData], keywords: "musique playlist son mp3 lecteur" },
                { page: "devise", icon: "💶", title: "Devise", load: [loadAdminSettingsData], keywords: "devise monnaie euro dollar symbole" },
                { page: "reseaux", icon: "🔗", title: "Réseaux & contact", load: [loadAdminSettingsData], keywords: "réseaux sociaux telegram whatsapp signal snapchat instagram potato luffa contact onglet contact infos signaler problème" },
                { page: "mode-ferme", icon: "🔒", title: "Mode fermé & horaires", load: [loadAdminSettingsData], keywords: "mode fermé fermeture ouverture horaires programmée fermer la boutique" }
            ]
        },
        {
            group: "Messages & bot", items: [
                { page: "start", icon: "💬", title: "Message /start", load: [loadAdminStartData], onOpen: () => showStartSubpane("msg"), keywords: "start bienvenue accueil photo boutons inline" },
                { page: "diffusion", icon: "📢", title: "Broadcast & messages auto", load: [loadAdminMessagesData], keywords: "broadcast diffusion message global envoyer modèles messages automatiques programmés" },
                { page: "autoclean", icon: "🧹", title: "Nettoyage auto", load: [loadAdminSettingsData, loadAutocleanStats], keywords: "autoclean nettoyage suppression messages discrétion" },
                { page: "profil-bot", icon: "🤖", title: "Profil du bot", load: [loadAdminSettingsData, loadBotPanelData], keywords: "profil nom description username bot" },
                { page: "logs", icon: "📜", title: "Logs Telegram", load: [loadAdminSettingsData, loadBotPanelData], keywords: "logs journal canal de logs /logs" }
            ]
        },
        {
            group: "Accès & sécurité", items: [
                { page: "mobile", icon: "📱", title: "Mobile uniquement", load: [loadAdminSettingsData], keywords: "mobile téléphone ordinateur pc appareil" },
                { page: "vpn", icon: "🚫", title: "Bloquer VPN / Proxy", load: [loadAdminSettingsData], keywords: "vpn proxy ip hébergeur bloquer" },
                { page: "canal", icon: "📣", title: "Canal officiel & obligatoire", load: [loadAdminSettingsData], keywords: "canal obligatoire rejoindre lien officiel" },
                { page: "backup", icon: "🛡️", title: "Bot backup", load: [loadAdminSettingsData], keywords: "backup secours token bascule utilisateurs" },
                { page: "admins", icon: "👥", title: "Admins du panel", load: [loadAdminSettingsData], keywords: "admins accès gestion pseudo whitelist liste blanche" }
            ]
        },
        {
            group: "Avancé", items: [
                { page: "crm", icon: "📊", title: "CRM", load: [loadAdminSettingsData, loadBotStatusData], keywords: "crm fiches clients compteurs" },
                { page: "important", icon: "⚠️", title: "Important & conseils", load: [], keywords: "important conseils ban spam logo parrainage redémarrer" },
                // Action (pas de page) : même confirmation que le menu ••• et le raccourci de l'Accueil
                { action: "restart", icon: "🔄", title: "Redémarrer le bot", keywords: "redémarrer relancer bloqué ne répond plus reboot" }
            ]
        }
    ];
    REGLAGES_SECTIONS.forEach((g) => g.items.forEach((it) => {
        if (!it.page) return;
        ADMIN_PAGES[it.page] = { tab: "reglages", title: it.title, icon: it.icon, load: it.load, onOpen: it.onOpen, keywords: it.keywords, group: g.group };
        ADMIN_TABS.reglages.pages.push(it.page);
    }));

    // Anciens noms d'onglet (switchAdminMainTab("produits")…) → leur page
    const LEGACY_TAB_PAGES = { start: "start", produits: "produits", commandes: "commandes", messages: "diffusion", tickets: "tickets", utilisateurs: "utilisateurs" };

    // Repères à l'intérieur des pages, proposés par l'accès rapide quand on cherche
    const ADMIN_QUICK_ANCHORS = [
        { page: "general", anchor: "gst-sec-theme", icon: "🎨", title: "Thème (couleur)", keywords: "couleur accent violet bleu vert rouge custom" },
        { page: "general", anchor: "gst-open-loader-modal-btn", icon: "✦", title: "Loader d'intro & fond animé", keywords: "animation intro fumée" },
        { page: "diffusion", anchor: "gst-msg-templates-list", icon: "📚", title: "Modèles de messages", keywords: "modèle template" },
        { page: "diffusion", anchor: "gst-sec-msg-scheduled", icon: "⏰", title: "Messages automatiques", keywords: "programmé créneau heure jours planifié" },
        { page: "verifications", anchor: "gst-sec-approbation", icon: "✅", title: "Approbation manuelle", keywords: "approuver tous réinitialiser liste d'attente" },
        { page: "jeux", anchor: "gst-sec-concours", icon: "🎁", title: "Jeu concours", keywords: "concours tirage gagnant participants" },
        { page: "canal", anchor: "gst-mandatory-channel-link", icon: "📣", title: "Canal obligatoire", keywords: "rejoindre canal membre" },
        { page: "options-commande", anchor: "gst-postal-editor", icon: "📮", title: "Envoi postal", keywords: "colis lettre suivie adresse postale" },
        { page: "options-commande", anchor: "gst-wallets-editor", icon: "🪙", title: "Paiement crypto", keywords: "btc usdt eth wallet adresse" },
        { page: "backup", anchor: "gst-backup-switch-btn", icon: "🔁", title: "Basculer vers le bot backup", keywords: "bascule secours principal supprimé" }
    ];
    const adminQuickState = { results: [] };

    function adminCrmOff() {
        const overlay = document.getElementById("admin-overlay");
        return Boolean(overlay && overlay.classList.contains("gst-crm-off"));
    }

    // Première page d'un onglet (Clients sans CRM : Vérifications)
    function defaultAdminPage(tabKey) {
        const first = ADMIN_TABS[tabKey].pages[0];
        return ADMIN_PAGES[first].crm && adminCrmOff() ? "verifications" : first;
    }

    // Onglet : reprend la dernière page ouverte de l'onglet. Ancien nom d'onglet (start, produits, messages…) : sa page.
    function switchAdminMainTab(tabKey) {
        if (!ADMIN_TABS[tabKey]) {
            openAdminPage(LEGACY_TAB_PAGES[tabKey] || "accueil");
            return;
        }
        openAdminPage(adState.tabPages[tabKey] || defaultAdminPage(tabKey));
    }

    // Barre du bas : toucher l'onglet déjà ouvert ramène à sa première page (menu des Réglages, Produits…)
    function selectAdminNavTab(tabKey) {
        if (ADMIN_TABS[tabKey] && tabKey === adState.activeTab) openAdminPage(defaultAdminPage(tabKey));
        else switchAdminMainTab(tabKey);
    }

    // Ouvre une page : onglet du bas, volet et page affichés, barre des pages, haut de page (ou repère opts.anchor),
    // puis les loaders de la page. opts.before : réglé avant les loaders (ex. filtre de la liste).
    function openAdminPage(pageKey, opts) {
        let key = ADMIN_PAGES[pageKey] ? pageKey : "accueil";
        if (ADMIN_PAGES[key].crm && adminCrmOff()) key = "verifications";
        const page = ADMIN_PAGES[key];
        const options = opts || {};
        // Saisies en attente enregistrées tout de suite ; /start pas enregistré : rappel
        flushSettingsSaves();
        if (adState.activePage === "start" && key !== "start") warnUnsavedStart();
        adState.activeTab = page.tab;
        adState.activePage = key;
        adState.tabPages[page.tab] = key;

        // 1. Onglets du bas
        document.querySelectorAll(".gst-bottom-nav .gst-nav-btn").forEach((btn) => {
            const isActive = btn.dataset.gstNav === page.tab;
            btn.classList.toggle("active", isActive);
            if (isActive) btn.setAttribute("aria-current", "page");
            else btn.removeAttribute("aria-current");
        });
        // 2. Volet de l'onglet, puis la page
        document.querySelectorAll("#gst-main-body .gst-tab-pane").forEach((pane) => {
            pane.classList.toggle("active", pane.dataset.gstTab === page.tab);
        });
        document.querySelectorAll("#gst-main-body .gst-page").forEach((el) => {
            el.classList.toggle("active", el.dataset.gstPage === key);
        });

        // 3. Barre des pages, haut de page
        renderAdminSubtabs();
        const bodyEl = document.getElementById("gst-main-body");
        if (bodyEl) bodyEl.scrollTop = 0;
        if (typeof page.onOpen === "function") page.onOpen();
        if (typeof options.before === "function") options.before();
        if (options.anchor) setTimeout(() => scrollToAdminId(options.anchor), 80);

        // 4. Données de la page, relues à chaque ouverture
        runAdminPageLoaders(key);
    }

    function runAdminPageLoaders(key) {
        const loads = (ADMIN_PAGES[key].load || []).map((load) => Promise.resolve()
            .then(load)
            .catch((err) => {
                console.warn(`Page ${key} :`, err);
                showToast("Erreur d'affichage de la page, réessaie.", "error");
            }));
        Promise.all(loads).then(() => adminPageLoaded(key));
    }

    // Retour (bouton Retour de Telegram, « ‹ Réglages ») : page d'un réglage → menu des Réglages ; autre onglet → Accueil.
    // false = déjà sur l'Accueil : rien à remonter, le panel peut se fermer.
    function adminNavigateBack() {
        if (adState.activeTab === "reglages" && adState.activePage !== "reglages") {
            openAdminPage("reglages");
            return true;
        }
        if (adState.activeTab !== "accueil") {
            openAdminPage("accueil");
            return true;
        }
        return false;
    }

    // Barre des pages : pastilles des pages de l'onglet (avec le nombre d'éléments à traiter), ou titre de la page
    // (Accueil, Réglages) précédé de « ‹ Réglages » sur la page d'un réglage. Les anciens appels avec un nom
    // d'onglet (filtres Produits, Tickets) la redessinent simplement.
    function renderAdminSubtabs() {
        const wrapper = document.getElementById("gst-subtabs-scroll");
        if (!wrapper) return;
        const tabKey = ADMIN_TABS[adState.activeTab] ? adState.activeTab : "accueil";
        const pageKey = ADMIN_PAGES[adState.activePage] ? adState.activePage : "accueil";
        const page = ADMIN_PAGES[pageKey];
        wrapper.innerHTML = "";
        const titled = tabKey === "accueil" || tabKey === "reglages";
        wrapper.classList.toggle("gst-pagebar-titled", titled);
        // Page d'un réglage : « ‹ Réglages » et le titre prennent la place, le bouton de recherche garde sa loupe seule
        wrapper.classList.toggle("gst-pagebar-sub", tabKey === "reglages" && pageKey !== "reglages");
        if (titled) {
            if (tabKey === "reglages" && pageKey !== "reglages") {
                const back = document.createElement("button");
                back.type = "button";
                back.className = "gst-pagebar-back";
                back.textContent = "‹ Réglages";
                back.setAttribute("aria-label", "Retour au menu des réglages");
                back.addEventListener("click", () => openAdminPage("reglages"));
                wrapper.appendChild(back);
            }
            const title = document.createElement("span");
            title.className = "gst-pagebar-title";
            title.textContent = `${page.icon} ${page.title}`;
            wrapper.appendChild(title);
            return;
        }
        ADMIN_TABS[tabKey].pages.forEach((key) => {
            const p = ADMIN_PAGES[key];
            if (p.crm && adminCrmOff()) return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `gst-subtab-pill${key === pageKey ? " active" : ""}`;
            btn.dataset.gstGoto = key;
            btn.setAttribute("aria-pressed", key === pageKey ? "true" : "false");
            btn.textContent = `${p.icon} ${p.short || p.title}`;
            const count = adminPageBadge(key);
            if (count > 0) {
                const badge = document.createElement("span");
                badge.className = "gst-pill-badge";
                badge.textContent = count > 99 ? "99+" : String(count);
                badge.setAttribute("aria-label", `${count} à traiter`);
                btn.appendChild(badge);
            }
            btn.addEventListener("click", () => openAdminPage(key));
            wrapper.appendChild(btn);
        });
        const active = wrapper.querySelector(".gst-subtab-pill.active");
        if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
    }

    function scrollToAdminId(elemId) {
        const el = document.getElementById(elemId);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Page /start : « msg » (message de bienvenue) ou « btns » (boutons inline), boutons internes de la page
    function showStartSubpane(which) {
        const isMsg = which !== "btns";
        document.getElementById("gst-start-tab-msg-btn")?.classList.toggle("active", isMsg);
        document.getElementById("gst-start-tab-btns-btn")?.classList.toggle("active", !isMsg);
        document.getElementById("gst-start-subpane-msg")?.classList.toggle("active", isMsg);
        document.getElementById("gst-start-subpane-btns")?.classList.toggle("active", !isMsg);
    }

    // ----- Accès rapide (bouton 🔍, remplace « ≡ Liste ») : toutes les pages, filtrées par la recherche -----
    function adminSearchText(value) {
        return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    }

    function adminQuickEntries() {
        const entries = [];
        Object.keys(ADMIN_PAGES).forEach((key) => {
            const p = ADMIN_PAGES[key];
            if (p.crm && adminCrmOff()) return;
            entries.push({
                page: key, icon: p.icon, title: p.title, keywords: p.keywords || "",
                where: p.group ? `Réglages › ${p.group}` : ADMIN_TABS[p.tab].label,
                // Menu des Réglages : son onglet suffit ; trouvé quand on le cherche
                searchOnly: key === "reglages"
            });
        });
        ADMIN_QUICK_ANCHORS.forEach((a) => {
            const p = ADMIN_PAGES[a.page];
            entries.push({ page: a.page, anchor: a.anchor, icon: a.icon, title: a.title, keywords: a.keywords, where: `${ADMIN_TABS[p.tab].label} › ${p.title}`, searchOnly: true });
        });
        // Actions des Réglages (redémarrage) : juste après les pages de leur groupe
        REGLAGES_SECTIONS.forEach((g) => g.items.forEach((it) => {
            if (!it.action) return;
            const where = `Réglages › ${g.group}`;
            const at = entries.map((e) => e.where).lastIndexOf(where);
            entries.splice(at + 1, 0, { action: it.action, icon: it.icon, title: it.title, keywords: it.keywords, where });
        }));
        return entries;
    }

    // Sans recherche : toutes les pages rangées par onglet (et par groupe dans les Réglages) ; avec : liste filtrée
    function populateQuickListDrawer(query) {
        const container = document.getElementById("gst-quick-list-links");
        if (!container) return;
        const raw = String(query || "").trim();
        const terms = adminSearchText(raw).split(/\s+/).filter(Boolean);
        const results = adminQuickEntries().filter((e) => {
            if (!terms.length) return !e.searchOnly;
            const haystack = adminSearchText(`${e.title} ${e.where} ${e.keywords}`);
            return terms.every((t) => haystack.includes(t));
        });
        // Titre qui contient tous les mots cherchés : en tête (Entrée ouvre le premier résultat)
        if (terms.length) {
            const inTitle = (e) => terms.every((t) => adminSearchText(e.title).includes(t));
            results.sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)));
        }
        adminQuickState.results = results;
        if (!results.length) {
            container.innerHTML = `<div class="gst-empty-placeholder">Aucun résultat pour « ${escapeHtml(raw)} ».</div>`;
            return;
        }
        const item = (e, i, withWhere) => `
            <button type="button" class="gst-drawer-item" data-ql-index="${i}">
                <span class="gst-drawer-item-icon" aria-hidden="true">${escapeHtml(e.icon)}</span>
                <span class="gst-drawer-item-label">${escapeHtml(e.title)}${withWhere ? `<small class="gst-ql-where">${escapeHtml(e.where)}</small>` : ""}</span>
                <span class="gst-chevron" aria-hidden="true">›</span>
            </button>`;
        if (terms.length) {
            container.innerHTML = results.map((e, i) => item(e, i, true)).join("");
            return;
        }
        let html = "";
        let lastGroup = "";
        results.forEach((e, i) => {
            if (e.where !== lastGroup) {
                html += `<div class="gst-ql-group">${escapeHtml(e.where)}</div>`;
                lastGroup = e.where;
            }
            html += item(e, i, false);
        });
        container.innerHTML = html;
    }

    function runQuickEntry(index) {
        const entry = adminQuickState.results[index];
        if (!entry) return;
        closeQuickListDrawer();
        if (entry.action === "restart") confirmAdminRestart();
        else openAdminPage(entry.page, { anchor: entry.anchor });
    }

    function openQuickListDrawer() {
        const input = document.getElementById("gst-quick-search-input");
        if (input) input.value = "";
        populateQuickListDrawer("");
        const drawer = document.getElementById("gst-modal-quick-list");
        if (drawer) drawer.style.display = "flex";
    }

    function closeQuickListDrawer() {
        const drawer = document.getElementById("gst-modal-quick-list");
        if (drawer) drawer.style.display = "none";
    }

    // Menu « ••• » du bandeau
    function openMoreMenu() {
        const menu = document.getElementById("gst-modal-more-menu");
        if (menu) menu.style.display = "flex";
    }

    function closeMoreMenu() {
        const menu = document.getElementById("gst-modal-more-menu");
        if (menu) menu.style.display = "none";
    }

    // ===== ONGLET 1: REGLAGES DATA & SAVE =====
    // Une ligne par contrôle des onglets Réglages et Commandes : clé enregistrée ↔ id ↔ type.
    // scope « restaurant » : clés du restaurant validées par le serveur ; « contact » : clé protégée,
    // enregistrée par /admin/contact/save ; sinon /admin/settings/save. Chaque contrôle n'envoie que sa propre clé,
    // sauf sendWith : à l'activation d'un interrupteur, les champs dont il dépend partent dans le même enregistrement.
    // max/counter : longueur maximale (contrat) et compteur affiché ; mirrors : autres listes du même réglage ;
    // pair : l'autre heure de la fermeture programmée ; access : relit l'état des contrôles d'accès après l'enregistrement.
    const SETTINGS_FIELDS = [
        { id: "gst-shop-name-input", key: "name", scope: "restaurant", type: "text" },
        { id: "gst-shop-slogan-input", key: "slogan", scope: "restaurant", type: "text" },
        { id: "gst-ticker-text-input", key: "ticker_text", scope: "contact", type: "text" },
        { id: "gst-channel-link-input", key: "channel_link", scope: "contact", type: "text" },
        { id: "gst-custom-color-picker", key: "theme_color", type: "color" },
        { id: "gst-crm-toggle", key: "crm_enabled", type: "bool" },
        { id: "gst-social-tg", key: "telegram_username", scope: "contact", type: "text" },
        { id: "gst-social-wa", key: "whatsapp", type: "text" },
        { id: "gst-social-signal", key: "signal", type: "text" },
        { id: "gst-social-snap", key: "snapchat", type: "text" },
        { id: "gst-social-insta", key: "instagram", type: "text" },
        { id: "gst-social-potato", key: "potato", type: "text" },
        { id: "gst-social-luffa", key: "luffa", type: "text" },
        { id: "gst-contact-tab-toggle", key: "contact_tab_enabled", type: "bool" },
        { id: "gst-contact-text", key: "contact_text", type: "text", max: 2000, counter: "gst-contact-text-count" },
        { id: "gst-closed-mode-toggle", key: "closed_mode_enabled", type: "bool", access: true },
        { id: "gst-closed-title-input", key: "closed_mode_title", type: "text", max: 80, counter: "gst-closed-title-count" },
        { id: "gst-closed-msg-input", key: "closed_mode_reason", type: "text", max: 500, counter: "gst-closed-msg-count" },
        { id: "gst-closed-scheduled-toggle", key: "closed_schedule_enabled", type: "bool", access: true, sendWith: ["closed_schedule_open", "closed_schedule_close"] },
        { id: "gst-closed-open-time", key: "closed_schedule_open", type: "time", pair: "closed_schedule_close", access: true },
        { id: "gst-closed-close-time", key: "closed_schedule_close", type: "time", pair: "closed_schedule_open", access: true },
        { id: "gst-mobile-only-toggle", key: "mobile_only", type: "bool", access: true },
        { id: "gst-block-vpn-toggle", key: "vpn_required", type: "bool", access: true },
        { id: "gst-channel-mandatory-toggle", key: "channel_mandatory", type: "bool", access: true, sendWith: ["mandatory_channel_link"] },
        { id: "gst-mandatory-channel-link", key: "mandatory_channel_link", type: "text" },
        { id: "gst-backup-bot-toggle", key: "backup_bot_enabled", type: "bool", access: true },
        { id: "gst-rank-toggle", key: "rank_enabled", type: "bool" },
        { id: "gst-cni-toggle", key: "cni_required", type: "bool", access: true },
        { id: "gst-cni-instructions", key: "cni_instructions", type: "text", max: 500, counter: "gst-cni-instructions-count" },
        { id: "gst-manual-approval-toggle", key: "approval_required", type: "bool", access: true },
        { id: "gst-approval-target-select", key: "moderation_target", type: "select", mirrors: ["gst-cni-target-select"], access: true },
        { id: "gst-multicity-toggle", key: "multicity_enabled", type: "bool" },
        { id: "gst-autoclean-toggle", key: "autoclean_enabled", type: "bool" },
        { id: "gst-wheel-toggle", key: "wheel_enabled", type: "bool" },
        // Onglet Commandes
        { id: "gst-orders-enabled-toggle", key: "orders_enabled", type: "bool" },
        { id: "gst-orders-meetup-toggle", key: "meetup_enabled", type: "bool" },
        { id: "gst-orders-postal-toggle", key: "postal_enabled", type: "bool" },
        { id: "gst-orders-calendar-toggle", key: "calendar_enabled", type: "bool" },
        { id: "gst-orders-fee-toggle", key: "delivery_fee_enabled", type: "bool" },
        { id: "gst-orders-fee-amount", key: "deliveryFee", scope: "restaurant", type: "number" },
        { id: "gst-orders-free-shipping", key: "free_shipping", type: "number" },
        { id: "gst-orders-crypto-toggle", key: "crypto_enabled", type: "bool" },
        { id: "gst-music-toggle", key: "music_enabled", type: "bool" },
        { id: "gst-bg-hide-pc-toggle", key: "background_hide_desktop", type: "bool" },
        { id: "gst-tg-logs-toggle", key: "tg_logs_enabled", type: "bool" },
        { id: "gst-autoclean-client-toggle", key: "autoclean_client_enabled", type: "bool" },
        { id: "gst-autoclean-client-delay", key: "autoclean_client_delay", type: "number" },
        { id: "gst-autoclean-bot-toggle", key: "autoclean_bot_enabled", type: "bool" },
        { id: "gst-autoclean-bot-keep", key: "autoclean_bot_keep", type: "number" },
        { id: "gst-auto-msgs-toggle", key: "auto_messages_enabled", type: "bool" },
        { id: "gst-tickets-toggle", key: "tickets_enabled", type: "bool" },
        { id: "gst-tickets-target-select", key: "tickets_target", type: "select" },
        // Catalogue : calendrier (jours à l'avance), promotion globale, compteur de likes
        { id: "gst-orders-calendar-days", key: "calendar_days", type: "number" },
        { id: "gst-prods-global-promo-toggle", key: "global_promo_enabled", type: "bool", sendWith: ["global_promo_percent"] },
        { id: "gst-promo-percent", key: "global_promo_percent", type: "number" },
        { id: "gst-promo-label", key: "global_promo_label", type: "text", max: 30 },
        { id: "gst-prods-likes-counter-toggle", key: "likes_enabled", type: "bool" },
        // Fidélité : parrainage, roue, avis
        { id: "gst-referral-points-input", key: "referral_points", type: "number" },
        { id: "gst-wheel-custom-hours", key: "wheel_cooldown_hours", type: "number" },
        { id: "gst-wheel-notify-select", key: "wheel_notify_target", type: "select" },
        { id: "gst-reviews-toggle", key: "reviews_enabled", type: "bool" },
        { id: "gst-reviews-order-req-toggle", key: "reviews_order_required", type: "bool" },
        { id: "gst-reviews-delay-input", key: "reviews_delay_hours", type: "number" },
        { id: "gst-reviews-photos-toggle", key: "reviews_photos_enabled", type: "bool" },
        { id: "gst-reviews-tab-toggle", key: "reviews_tab_enabled", type: "bool" }
    ];
    const SETTINGS_DEBOUNCE_MS = 600;
    const THEME_PRESET_COLORS = {
        violet: "#8b5cf6", bleu: "#3b82f6", vert: "#10b981", rouge: "#ef4444", orange: "#f97316",
        rose: "#ec4899", jaune: "#eab308", cyan: "#06b6d4", gris: "#6b7280"
    };

    // Valeur du contrôle telle qu'elle est envoyée : booléen, nombre ou texte sans espaces autour
    function readSettingField(field, el) {
        if (field.type === "bool") return el.checked;
        if (field.type === "number") return el.value.trim() === "" ? NaN : Number(el.value);
        if (field.type === "color") return el.value.trim().toLowerCase();
        // « @pseudo » → « pseudo » : le pseudo de contact (bouton « Nous contacter » du /start), sans @
        if (field.key === "telegram_username") return el.value.trim().replace(/^@+/, "");
        // « +33 6 12 34 56 78 » → « +33612345678 »
        if (field.key === "whatsapp") return cleanWhatsapp(el.value);
        return el.value.trim();
    }

    // Valeur enregistrée → contrôle (undefined = clé jamais enregistrée : valeur par défaut du HTML)
    function writeSettingField(field, el, value) {
        if (field.type === "bool") {
            el.checked = value === undefined ? el.defaultChecked : isOn(value);
        } else if (field.type === "number") {
            el.value = value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? el.defaultValue : String(Number(value));
        } else if (field.type === "color") {
            el.value = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : el.defaultValue;
        } else if (field.type === "time") {
            el.value = SETTING_TIME_RE.test(String(value || "")) ? String(value) : el.defaultValue;
        } else if (field.type === "select") {
            // Valeur inconnue ou jamais enregistrée : l'option marquée selected dans le HTML
            const wanted = String(value === undefined || value === null ? "" : value);
            const fallback = el.querySelector("option[selected]") || el.options[0];
            el.value = [...el.options].some((o) => o.value === wanted) ? wanted : (fallback ? fallback.value : "");
        } else {
            el.value = value === undefined || value === null ? el.defaultValue : String(value);
        }
        syncFieldMirrors(field, el);
        updateFieldCounter(field, el);
    }

    // Autres listes du même réglage (destination des demandes : CNI et approbation) : même valeur partout
    function syncFieldMirrors(field, el) {
        (field.mirrors || []).forEach((id) => {
            const mirror = document.getElementById(id);
            if (mirror && mirror !== el) mirror.value = el.value;
        });
    }

    function updateFieldCounter(field, el) {
        const counter = field.counter ? document.getElementById(field.counter) : null;
        if (counter) counter.textContent = `${el.value.length}/${field.max}`;
    }

    const SETTING_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    // Canal obligatoire (contrat) : https://t.me/<pseudo public>, @pseudo ou identifiant -100…
    const MANDATORY_CHANNEL_RE = /^(?:https:\/\/t\.me\/[A-Za-z0-9_]{4,32}\/?|@[A-Za-z0-9_]{4,32}|-100\d{5,})$/;
    const SOCIAL_LINK_ERRORS = {
        whatsapp: "WhatsApp invalide : numéro international avec l'indicatif du pays, ex : +33612345678 (8 à 15 chiffres).",
        signal: "Lien Signal invalide : il doit commencer par https://signal.me/",
        snapchat: "Lien Snapchat invalide : https://snapchat.com/…, https://www.snapchat.com/… ou https://t.snapchat.com/…",
        instagram: "Lien Instagram invalide : https://instagram.com/… ou https://www.instagram.com/…",
        potato: "Lien Potato invalide : il doit commencer par https://",
        luffa: "Lien Luffa invalide : il doit commencer par https://"
    };

    function settingFieldError(field, value) {
        const catalogueError = catalogueFieldError(field, value); // catalogue : pourcentage de promo, jours du calendrier
        if (catalogueError) return catalogueError;
        if (field.type === "number" && (!Number.isFinite(value) || value < 0)) return "Montant invalide : entre un nombre positif.";
        if (field.type === "color" && !/^#[0-9a-f]{6}$/.test(value)) return "Couleur invalide (format #rrggbb).";
        if (field.max && typeof value === "string" && value.length > field.max) return `Texte trop long : ${field.max} caractères maximum.`;
        if (field.key === "name" && !value) return "Le nom de la boutique ne peut pas être vide.";
        if (field.key === "channel_link" && value && !/^https?:\/\/\S+$/i.test(value)) return "Lien du canal invalide : il doit commencer par https://";
        if (field.key === "telegram_username") {
            if (!value) return "Le pseudo Telegram est obligatoire.";
            // willy.py n'accepte qu'un seul pseudo (4 à 32 lettres, chiffres ou _)
            if (!/^[A-Za-z0-9_]{4,32}$/.test(value)) return "Pseudo Telegram invalide : un seul pseudo, lettres, chiffres et _ uniquement.";
        }
        // Réseaux : vide autorisé partout, sinon les formats acceptés par willy.py (mêmes règles que la boutique)
        if (SOCIAL_LINK_ERRORS[field.key] && value && !socialLink(field.key, value)) return SOCIAL_LINK_ERRORS[field.key];
        if (field.type === "time") {
            if (!SETTING_TIME_RE.test(value)) return "Heure invalide : choisis une heure (HH:MM).";
            const pair = SETTINGS_FIELDS.find((f) => f.key === field.pair);
            const pairEl = pair ? document.getElementById(pair.id) : null;
            if (pairEl && pairEl.value === value) return "L'heure d'ouverture et l'heure de fermeture doivent être différentes.";
        }
        if (field.key === "mandatory_channel_link" && value && !MANDATORY_CHANNEL_RE.test(value)) {
            return "Canal invalide : https://t.me/pseudo, @pseudo ou identifiant -100…";
        }
        if (field.key === "channel_mandatory" && value === true) {
            const link = document.getElementById("gst-mandatory-channel-link");
            if (link && !link.value.trim()) return "Entre d'abord le canal à rejoindre (https://t.me/pseudo, @pseudo ou -100…).";
        }
        if (field.key === "backup_bot_enabled" && value === true && adState.backup.loaded && !adState.backup.tokenSet) {
            return "Ajoute d'abord le token de ton bot backup (bouton « Vérifier »).";
        }
        return "";
    }

    // Enregistrement partiel (/admin/settings/save ou /admin/contact/save) : seules les clés passées partent.
    // true uniquement après un succès confirmé ; sinon l'erreur (403 = session expirée) est déjà affichée.
    async function saveAdminSettings(values, endpoint) {
        const isContact = endpoint === "contact";
        Object.keys(values).forEach((k) => { adState.settingsTouchedAt[k] = Date.now(); });
        const res = await adminRequest(isContact ? "/admin/contact/save" : "/admin/settings/save", isContact ? { contact: values } : { settings: values });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        const ignored = Array.isArray(res.data.ignored) ? res.data.ignored.filter((k) => k in values) : [];
        if (ignored.length) {
            showToast(`Non enregistré par le serveur : ${ignored.join(", ")}`, "error");
            return false;
        }
        return true;
    }

    // Un enregistrement à la fois par clé : chaque passage relit le contrôle, la dernière valeur l'emporte toujours.
    // quiet : pas de toast de succès (champ enregistré en arrière-plan, l'erreur affichée juste avant reste lisible)
    function saveSettingField(field, fromTyping, quiet) {
        clearTimeout(adState.settingsTimers[field.key]);
        delete adState.settingsTimers[field.key];
        const run = () => saveSettingFieldNow(field, fromTyping, quiet);
        const queued = (adState.settingsQueue[field.key] || Promise.resolve()).then(run, run);
        adState.settingsQueue[field.key] = queued;
        return queued;
    }

    // Remet un contrôle sur ce qui est réellement enregistré (réglages pas encore chargés : couleur de la boutique affichée)
    function revertSettingField(field, el) {
        const saved = field.key in adState.settingsSaved
            ? adState.settingsSaved[field.key]
            : (field.type === "color" && state.config && state.config.admin ? state.config.admin.theme_color : undefined);
        writeSettingField(field, el, saved);
        if (field.type === "color") previewThemeColor(saved);
        refreshFieldDependents(field);
    }

    async function saveSettingFieldNow(field, fromTyping, quiet) {
        const el = document.getElementById(field.id);
        if (!el) return;
        const value = readSettingField(field, el);
        if (value === adState.settingsSaved[field.key]) return;
        const error = settingFieldError(field, value);
        if (error) {
            // Pendant la frappe, pas d'alerte : elle viendra quand le champ sera quitté
            if (!fromTyping) showToast(error, "error");
            // Interrupteur ou liste refusés avant l'envoi : ils reviennent à la valeur enregistrée
            if (!fromTyping && ["bool", "select", "time"].includes(field.type)) revertSettingField(field, el);
            return;
        }
        const values = { [field.key]: value };
        // Activation d'un interrupteur qui dépend d'autres champs (heures, canal) : leurs valeurs affichées partent avec lui
        const companions = value === true && field.sendWith
            ? field.sendWith.map((key) => SETTINGS_FIELDS.find((f) => f.key === key)).filter((f) => f && document.getElementById(f.id))
            : [];
        for (const extra of companions) {
            const extraValue = readSettingField(extra, document.getElementById(extra.id));
            const extraError = settingFieldError(extra, extraValue);
            if (extraError) {
                showToast(extraError, "error");
                revertSettingField(field, el);
                return;
            }
            values[extra.key] = extraValue;
            // Saisie en attente : elle part dans cet enregistrement
            clearTimeout(adState.settingsTimers[extra.key]);
            delete adState.settingsTimers[extra.key];
        }
        adState.settingsSending[field.key] = true;
        const ok = await saveAdminSettings(values, field.scope === "contact" ? "contact" : "settings");
        delete adState.settingsSending[field.key];
        if (ok) {
            Object.keys(values).forEach((k) => { adState.settingsSaved[k] = values[k]; });
            if (field.type === "color") {
                previewThemeColor(value);
                rememberThemeColor(value);
                showToast(`Thème appliqué : ${value} 🎨`);
            } else if (!quiet) {
                showToast("Réglage enregistré");
            }
            // État des contrôles d'accès (boutique fermée, bot backup, modération) relu sur le serveur
            if (field.access) scheduleAccessRefresh();
        } else if (["bool", "color", "select", "time"].includes(field.type)) {
            // Refusé (ex. « Ajoute le bot comme administrateur du canal ») : le contrôle revient à ce qui est enregistré ;
            // les champs liés saisis sont enregistrés seuls, sans toast qui cacherait l'erreur du serveur
            revertSettingField(field, el);
            companions.forEach((extra) => saveSettingField(extra, true, true));
        }
    }

    function scheduleSettingSave(field) {
        clearTimeout(adState.settingsTimers[field.key]);
        adState.settingsTimers[field.key] = setTimeout(() => saveSettingField(field, true), SETTINGS_DEBOUNCE_MS);
    }

    // Avant de changer d'onglet ou de fermer le panel : les saisies encore en attente partent tout de suite
    function flushSettingsSaves() {
        SETTINGS_FIELDS.forEach((field) => {
            if (adState.settingsTimers[field.key]) saveSettingField(field, false);
        });
    }

    function previewThemeColor(hex) {
        applyBrandColor(hex);
        markThemeSwatch(hex);
    }

    function markThemeSwatch(hex) {
        const color = String(hex || "").toLowerCase();
        const preset = Object.keys(THEME_PRESET_COLORS).find((name) => THEME_PRESET_COLORS[name] === color);
        document.querySelectorAll(".gst-theme-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.theme === (preset || "custom"));
        });
        const customPreview = document.getElementById("gst-custom-color-preview");
        if (customPreview && /^#[0-9a-f]{6}$/.test(color)) customPreview.style.background = color;
    }

    function markCurrency(cur) {
        document.querySelectorAll(".gst-btn-cur").forEach((btn) => btn.classList.toggle("active", btn.dataset.cur === cur));
    }

    // Nom affiché d'un loader / fond : le texte de son bouton dans la modale
    function setChoiceLabels() {
        const loaderBtn = document.querySelector(`#gst-modal-intro-loader .gst-choice-btn[data-loader="${safeLoaderName(adState.settingsSaved.loader_style)}"]`);
        const bgBtn = document.querySelector(`#gst-modal-animated-bg .gst-choice-btn[data-bg="${safeBgName(adState.settingsSaved.animated_bg)}"]`);
        const loaderName = loaderBtn ? loaderBtn.textContent.trim() : "";
        const bgName = bgBtn ? bgBtn.textContent.trim() : "";
        ["gst-current-loader-label", "gst-current-loader-name"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = loaderName;
        });
        ["gst-current-bg-label", "gst-current-bg-name"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = bgName;
        });
    }

    // Remplit TOUS les contrôles depuis la config admin. Une clé en cours de saisie ou d'envoi, ou enregistrée
    // après le départ de la lecture (startedAt), n'est pas écrasée par cette config peut-être plus ancienne.
    function fillSettingsControls(cfg, startedAt) {
        const rest = cfg.restaurant || {};
        const adminCfg = cfg.admin || {};
        const stale = (key) => (adState.settingsTouchedAt[key] || 0) >= startedAt;
        SETTINGS_FIELDS.forEach((field) => {
            const el = document.getElementById(field.id);
            if (!el || stale(field.key) || adState.settingsTimers[field.key] || adState.settingsSending[field.key] || document.activeElement === el) return;
            const source = (field.scope === "restaurant" ? rest : adminCfg) || {};
            writeSettingField(field, el, Object.prototype.hasOwnProperty.call(source, field.key) ? source[field.key] : undefined);
            adState.settingsSaved[field.key] = readSettingField(field, el);
        });
        markThemeSwatch(adState.settingsSaved.theme_color);

        if (!stale("currency")) adState.settingsSaved.currency = typeof rest.currency === "string" && rest.currency ? rest.currency : "€";
        markCurrency(adState.settingsSaved.currency);

        if (!stale("loader_style")) adState.settingsSaved.loader_style = adState.selectedLoader = safeLoaderName(adminCfg.loader_style);
        if (!stale("animated_bg")) adState.settingsSaved.animated_bg = adState.selectedBg = safeBgName(adminCfg.animated_bg);
        setChoiceLabels();

        if (!stale("background_image")) adState.settingsSaved.background_image = typeof adminCfg.background_image === "string" ? adminCfg.background_image : "";
        const bgPreview = document.getElementById("gst-bg-preview-img");
        if (bgPreview) bgPreview.src = safeMediaUrl(resolveMediaUrl(adState.settingsSaved.background_image, "image")) || "background.png";
        if (!stale("logo_url")) adState.settingsSaved.logo_url = typeof adminCfg.logo_url === "string" ? adminCfg.logo_url : "";
        const logoPreview = document.getElementById("gst-logo-img");
        if (logoPreview) logoPreview.src = shopLogoSrc(adState.settingsSaved.logo_url);

        // La liste blanche n'existe que dans la config admin (jamais dans /config public)
        if (!stale("whitelist")) {
            adState.whitelist = Array.isArray(adminCfg.whitelist) ? adminCfg.whitelist : [];
            adState.whitelistLinked = adminCfg.whitelist_linked && typeof adminCfg.whitelist_linked === "object" ? adminCfg.whitelist_linked : {};
        }
        renderAdminWhitelistChips(adState.whitelist);
        renderMainAdminCard();

        if (!stale("music_playlist") && !adState.musicBusy) adState.musicTracks = parseMusicPlaylist(adminCfg.music_playlist);
        adState.musicLoaded = true;
        renderAdminMusic();

        // Contrôles d'accès : image d'exemple CNI, champs dépendants, état réel (fermeture, backup, modération)
        if (!stale("cni_sample_image")) adState.settingsSaved.cni_sample_image = typeof adminCfg.cni_sample_image === "string" ? adminCfg.cni_sample_image : "";
        renderCniSample(adState.settingsSaved.cni_sample_image);
        SETTINGS_FIELDS.forEach(refreshFieldDependents);
        renderAccessPanel(adminCfg);
    }

    async function loadAdminSettingsData() {
        const startedAt = Date.now();
        const res = await adminRequest("/admin/config");
        if (!res.ok || !res.data.config) {
            showToast(res.error || "Réglages indisponibles, réessaie.", "error");
            if (!adState.musicLoaded) renderAdminMusic();
            if (!adState.backup.loaded) {
                adState.backup.error = "État du bot backup indisponible : rouvre la page Réglages › Bot backup.";
                renderBackupPanel();
            }
            return;
        }
        fillSettingsControls(res.data.config, startedAt);
    }

    function bindSettingsControls() {
        SETTINGS_FIELDS.forEach((field) => {
            const el = document.getElementById(field.id);
            if (!el) return;
            if (field.type === "text" || field.type === "number") el.addEventListener("input", () => scheduleSettingSave(field));
            if (field.type === "color") el.addEventListener("input", () => previewThemeColor(el.value));
            // Compteur et affichages qui dépendent du champ (aperçu des réseaux, heures, aide de modération) : pendant la saisie
            el.addEventListener("input", () => {
                updateFieldCounter(field, el);
                refreshFieldDependents(field);
            });
            el.addEventListener("change", () => {
                syncFieldMirrors(field, el);
                refreshFieldDependents(field);
                saveSettingField(field, false);
            });
            // Liste jumelle (destination CNI ↔ approbation) : même enregistrement que la liste principale
            (field.mirrors || []).forEach((id) => {
                const mirror = document.getElementById(id);
                if (!mirror) return;
                mirror.addEventListener("change", () => {
                    el.value = mirror.value;
                    syncFieldMirrors(field, el);
                    refreshFieldDependents(field);
                    saveSettingField(field, false);
                });
            });
        });

        // Pastilles du thème : même enregistrement que le sélecteur de couleur (theme_color)
        const themeField = SETTINGS_FIELDS.find((f) => f.key === "theme_color");
        document.querySelectorAll(".gst-theme-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const picker = document.getElementById(themeField.id);
                if (!picker) return;
                const preset = THEME_PRESET_COLORS[btn.dataset.theme];
                if (preset) picker.value = preset;
                previewThemeColor(picker.value);
                saveSettingField(themeField, false);
            });
        });

        // Devise : restaurant.currency
        document.querySelectorAll(".gst-btn-cur").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const cur = btn.dataset.cur || "";
                if (!cur || cur === adState.settingsSaved.currency) return;
                markCurrency(cur);
                if (await saveAdminSettings({ currency: cur })) {
                    adState.settingsSaved.currency = cur;
                    showToast(`Devise enregistrée : ${cur}`);
                } else {
                    markCurrency(adState.settingsSaved.currency);
                }
            });
        });
    }

    // ===== CONTRÔLES D'ACCÈS (sections Réseaux, Mode fermé, Bot backup, CNI et Approbation de Réglages) =====
    // Tout l'état affiché vient du serveur (GET /admin/config et routes /admin/backup/…, /admin/verifications…) :
    // un champ absent de la réponse n'affiche rien de supposé

    // Affichages qui suivent la valeur d'un champ, avant même son enregistrement
    function refreshFieldDependents(field) {
        if (field.key === "closed_schedule_enabled") {
            const el = document.getElementById(field.id);
            const box = document.getElementById("gst-closed-schedule-fields");
            if (el && box) box.style.display = el.checked ? "" : "none";
        } else if (field.key === "moderation_target") {
            renderModerationTarget();
        } else if (field.key === "backup_bot_enabled") {
            renderBackupPanel();
        } else if (field.key === "telegram_username" || field.key === "contact_tab_enabled" || SOCIAL_LINK_ERRORS[field.key]) {
            renderSocialPreview();
        }
    }

    // « Aperçu dans la boutique » : boutons de la fiche produit d'après les champs tels qu'ils sont saisis,
    // avec les mêmes règles que la boutique (une valeur invalide ne donne pas de bouton)
    function renderSocialPreview() {
        const box = document.getElementById("gst-social-preview");
        if (!box) return;
        const fieldValue = (key) => {
            const field = SETTINGS_FIELDS.find((f) => f.key === key);
            const el = field ? document.getElementById(field.id) : null;
            return el ? readSettingField(field, el) : "";
        };
        const rows = [`<div class="gst-preview-btn-cart">🛒 Ajouter au panier</div>`];
        if (telegramHandle(fieldValue("telegram_username"))) rows.push(`<div class="gst-preview-btn-tg">✈ Commander sur Telegram</div>`);
        const shown = [];
        const invalid = [];
        SOCIAL_NETWORKS.forEach((n) => {
            const value = fieldValue(n.key);
            if (!value) return;
            if (!socialLink(n.key, value)) {
                invalid.push(n.name);
                return;
            }
            shown.push(n.name);
            const cls = n.key === "instagram" ? "gst-preview-btn-insta" : "gst-preview-btn-net";
            rows.push(`<div class="${cls}" data-net="${n.key}">${n.icon} Commander sur ${escapeHtml(n.name)}</div>`);
        });
        box.innerHTML = rows.join("");
        const note = document.getElementById("gst-social-preview-note");
        if (note) {
            const tabToggle = document.getElementById("gst-contact-tab-toggle");
            const parts = [];
            if (invalid.length) parts.push(`⚠ Format invalide, pas de bouton : ${invalid.join(", ")}.`);
            parts.push(tabToggle && !tabToggle.checked
                ? "Onglet Contact masqué dans la boutique."
                : `Onglet Contact : Telegram${shown.length ? ` + ${shown.join(", ")}` : ""}.`);
            note.textContent = parts.join(" ");
        }
    }

    // Image d'exemple de la vérification CNI (cni_sample_image : chemin /uploads/… comme l'image de fond)
    function renderCniSample(path) {
        const img = document.getElementById("gst-cni-sample-img");
        const empty = document.getElementById("gst-cni-sample-empty");
        const clearBtn = document.getElementById("gst-cni-sample-clear-btn");
        const src = path ? safeMediaUrl(resolveMediaUrl(path, "image")) : "";
        if (empty) {
            empty.textContent = "Aucune image d'exemple : le bot envoie seulement les instructions.";
            empty.style.display = src ? "none" : "";
        }
        if (img) {
            // Fichier introuvable sur le serveur : le message remplace l'image cassée
            img.onerror = () => {
                img.style.display = "none";
                if (empty) {
                    empty.textContent = "Image d'exemple introuvable sur le serveur : choisis-en une autre.";
                    empty.style.display = "";
                }
            };
            if (src) img.src = src;
            else img.removeAttribute("src");
            img.style.display = src ? "" : "none";
        }
        if (clearBtn) clearBtn.disabled = !src;
    }

    function confirmClearCniSample() {
        if (!adState.settingsSaved.cni_sample_image) return;
        showConfirmModal({
            title: "Retirer l'image d'exemple ?",
            emoji: "🆔",
            message: "Le bot n'enverra plus que les instructions au client qui doit se faire vérifier.",
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                if (!await saveAdminSettings({ cni_sample_image: "" })) return;
                adState.settingsSaved.cni_sample_image = "";
                renderCniSample("");
                showToast("Image d'exemple retirée");
            }
        });
    }

    // État réel des contrôles d'accès (champs de config.admin ajoutés par le serveur, contrat §2)
    function renderAccessPanel(adminCfg) {
        const a = adminCfg || {};
        if ("main_bot_username" in a) adState.mainBotUsername = telegramHandle(a.main_bot_username);
        // Profil du bot › Username : pseudo réel du bot principal (sinon la valeur du HTML reste affichée)
        const botUsernameInput = document.getElementById("gst-bot-username-input");
        if (botUsernameInput && adState.mainBotUsername) botUsernameInput.value = `@${adState.mainBotUsername}`;
        if ("backup_bot_token_set" in a) {
            adState.backup = {
                loaded: true,
                error: "",
                tokenSet: isOn(a.backup_bot_token_set),
                username: telegramHandle(a.backup_bot_username),
                id: /^\d{1,20}$/.test(String(a.backup_bot_id || "")) ? String(a.backup_bot_id) : "",
                running: isOn(a.backup_bot_running),
                active: isOn(a.backup_active),
                usersCount: Math.max(0, parseInt(a.backup_users_count, 10) || 0)
            };
        } else if (!adState.backup.loaded) {
            adState.backup.error = "État du bot backup indisponible.";
        }
        if ("moderation_chat_set" in a) {
            adState.moderation = { loaded: true, chatSet: isOn(a.moderation_chat_set), chatTitle: plainText(String(a.moderation_chat_title || "")).slice(0, 128) };
        }
        if ("verifications_pending" in a) setVerificationsPending(Math.max(0, parseInt(a.verifications_pending, 10) || 0));
        if ("closed_now" in a) adState.closedInfo = { now: isOn(a.closed_now), reopenAt: plainText(String(a.closed_reopen_at || "")).slice(0, 20) };
        renderClosedStatus(a);
        renderBackupPanel();
        renderModerationTarget();
    }

    // « 🔴 Boutique fermée en ce moment » / « 🟢 Boutique ouverte » d'après closed_now (calculé par le serveur)
    function renderClosedStatus(a) {
        const el = document.getElementById("gst-closed-status");
        if (!el) return;
        if (!("closed_now" in a)) {
            el.style.display = "none";
            return;
        }
        const closed = isOn(a.closed_now);
        const reopen = plainText(String(a.closed_reopen_at || "")).slice(0, 20);
        el.textContent = closed ? `🔴 Boutique fermée en ce moment${reopen ? ` · réouverture à ${reopen}` : ""}` : "🟢 Boutique ouverte";
        el.classList.toggle("is-closed", closed);
        el.classList.toggle("is-open", !closed);
        el.style.display = "";
    }

    function renderBackupPanel() {
        const b = adState.backup;
        const card = document.getElementById("gst-backup-status-card");
        const nameEl = document.getElementById("gst-backup-bot-username");
        const idEl = document.getElementById("gst-backup-bot-id");
        const stateEl = document.getElementById("gst-backup-bot-state");
        const note = document.getElementById("gst-backup-active-note");
        const usersEl = document.getElementById("gst-backup-users-count");
        const switchBtn = document.getElementById("gst-backup-switch-btn");
        const switchCaption = document.getElementById("gst-backup-switch-caption");
        const removeBtn = document.getElementById("gst-backup-remove-btn");
        const sendBtn = document.getElementById("gst-backup-broadcast-send-btn");
        if (!b.loaded) {
            if (nameEl) nameEl.textContent = b.error || "Chargement…";
            if (idEl) idEl.textContent = "";
            if (stateEl) stateEl.style.display = "none";
            if (usersEl) usersEl.textContent = "—";
            [switchBtn, removeBtn, sendBtn].forEach((btn) => { if (btn) btn.disabled = true; });
            return;
        }
        const configured = b.tokenSet;
        if (nameEl) nameEl.textContent = configured ? (b.username ? `@${b.username}` : "Bot backup") : "Aucun bot backup";
        if (idEl) idEl.textContent = configured ? (b.id ? `ID : ${b.id}` : "") : "Colle le token de ton bot backup ci-dessous, puis « Vérifier ».";
        if (stateEl) {
            stateEl.textContent = !configured ? "Non configuré" : b.running ? "✓ En marche" : "⚠ Arrêté";
            stateEl.classList.toggle("is-off", !configured);
            stateEl.classList.toggle("is-down", configured && !b.running);
            stateEl.style.display = "";
        }
        if (card) {
            card.classList.toggle("is-off", !configured);
            card.classList.toggle("is-down", configured && !b.running);
        }
        if (note) {
            const backupName = b.username ? `@${b.username}` : "le bot backup";
            const mainName = adState.mainBotUsername ? ` (@${adState.mainBotUsername})` : "";
            const toggle = document.getElementById("gst-backup-bot-toggle");
            // Le serveur n'applique « Bot backup obligatoire » que si un bot backup tourne (gate_for) : le dire
            const idle = toggle && toggle.checked && (!configured || !b.running)
                ? "⚠ Interrupteur actif mais aucun bot backup en marche : les clients ne sont pas obligés de le démarrer. "
                : "";
            note.textContent = idle + (b.active
                ? `🔁 Bascule active : c'est ${backupName} qui sert la boutique.`
                : configured ? `Bot principal actif${mainName} : ${backupName} attend en réserve.` : "");
        }
        if (usersEl) usersEl.textContent = `${b.usersCount} utilisateur${b.usersCount > 1 ? "s" : ""}`;
        if (removeBtn) removeBtn.disabled = !configured;
        if (sendBtn) sendBtn.disabled = !configured;
        if (switchBtn) {
            switchBtn.textContent = b.active ? "↩ Revenir au bot principal" : "🔁 Basculer vers le backup";
            switchBtn.classList.toggle("gst-btn-danger", !b.active);
            switchBtn.classList.toggle("gst-btn-primary", b.active);
            switchBtn.disabled = !b.active && !configured;
        }
        if (switchCaption) {
            switchCaption.textContent = b.active
                ? "Le bot principal reprend la boutique : le bouton de la boutique revient sur lui."
                : configured
                    ? "Le bot principal saute → le backup prend le relais (bouton de la boutique posé sur le backup)."
                    : "Configure d'abord un bot backup pour pouvoir basculer.";
        }
    }

    // Destination des demandes (moderation_target) : groupe réellement enregistré par /moderation, ou marche à suivre
    function renderModerationTarget() {
        const select = document.getElementById("gst-approval-target-select");
        const target = select ? select.value : "dm";
        const m = adState.moderation;
        const bot = adState.mainBotUsername;
        document.querySelectorAll("#gst-approval-target-select option, #gst-cni-target-select option").forEach((opt) => {
            if (opt.value === "dm") opt.textContent = bot ? `Message privé avec @${bot} (admins)` : "Message privé avec le bot (admins)";
            else if (opt.value === "group") opt.textContent = m.chatSet ? `Groupe « ${m.chatTitle || "sans nom"} »` : "Groupe de modération (aucun enregistré)";
        });
        const pill = document.getElementById("gst-moderation-chat-pill");
        const help = document.getElementById("gst-moderation-chat-help");
        const dmHelp = document.getElementById("gst-moderation-dm-help");
        if (pill) {
            pill.textContent = m.chatSet ? `✓ Groupe enregistré : ${m.chatTitle || "sans nom"}` : "";
            pill.style.display = m.loaded && m.chatSet ? "" : "none";
        }
        if (help) help.style.display = m.loaded && !m.chatSet && target === "group" ? "" : "none";
        if (dmHelp) {
            dmHelp.textContent = target === "dm" ? `Les demandes arrivent en message privé${bot ? ` avec @${bot}` : " avec le bot"}, chez chaque admin lié à la gestion.` : "";
            dmHelp.style.display = target === "dm" ? "" : "none";
        }
    }

    // Après un enregistrement ou une action : état réel relu (fermeture, backup, modération) et boutique de l'admin
    // rechargée (son rappel « tu vois la boutique car tu es admin » suit)
    function scheduleAccessRefresh() {
        clearTimeout(adState.accessRefreshTimer);
        adState.accessRefreshTimer = setTimeout(refreshAccessPanel, 300);
    }

    async function refreshAccessPanel() {
        const res = await adminRequest("/admin/config");
        if (res.ok && res.data.config) renderAccessPanel(res.data.config.admin || {});
        reloadShop();
    }

    // ----- Bot backup : token (POST /admin/backup/token), utilisateurs, broadcast, bascule -----
    const BOT_TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
    const BACKUP_MISSING_MSG = "Configure d'abord ton bot backup (token + « Vérifier »).";

    async function verifyBackupToken() {
        const input = document.getElementById("gst-backup-token-input");
        const btn = document.getElementById("gst-backup-verify-btn");
        const token = input ? input.value.trim() : "";
        if (!token) {
            showToast("Colle d'abord le token de ton bot backup (donné par @BotFather).", "error");
            return;
        }
        if (!BOT_TOKEN_RE.test(token)) {
            showToast("Token invalide : il ressemble à 123456789:ABCdef… (copie-le en entier depuis @BotFather).", "error");
            return;
        }
        if (btn) btn.disabled = true;
        showToast("Vérification du token auprès de Telegram… ⏳", "info");
        const res = await adminRequest("/admin/backup/token", { token }, 20000);
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        if (input) input.value = "";
        const b = (res.data.backup && typeof res.data.backup === "object") ? res.data.backup : {};
        const name = telegramHandle(b.username);
        showToast(`Bot backup ${name ? `@${name} ` : ""}enregistré ✓${b.running ? " · en marche" : ""}`);
        scheduleAccessRefresh();
    }

    function confirmRemoveBackupBot() {
        const b = adState.backup;
        if (!b.tokenSet) return;
        showConfirmModal({
            title: "Retirer le bot backup ?",
            emoji: "🤖",
            message: `${b.username ? `<strong>@${escapeHtml(b.username)}</strong>` : "Le bot backup"} s'arrête et son token est effacé du serveur. Tant qu'aucun backup n'est configuré, les clients n'ont plus à le démarrer.`,
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const res = await adminRequest("/admin/backup/token", { token: "" }, 20000);
                if (!res.ok) {
                    showToast(res.error, "error");
                    return;
                }
                // Le serveur coupe aussi « Bot backup obligatoire » (plus aucun bot à démarrer) : l'interrupteur suit
                const backupToggle = document.getElementById("gst-backup-bot-toggle");
                if (backupToggle) backupToggle.checked = false;
                adState.settingsSaved.backup_bot_enabled = false;
                showToast("Bot backup retiré");
                scheduleAccessRefresh();
            }
        });
    }

    async function openBackupUsersModal() {
        const modal = document.getElementById("gst-modal-backup-users");
        const list = document.getElementById("gst-backup-users-list");
        const countEl = document.getElementById("gst-backup-users-modal-count");
        if (!modal || !list) return;
        list.innerHTML = `<div class="gst-empty-placeholder">Chargement des utilisateurs du backup…</div>`;
        if (countEl) countEl.textContent = "";
        modal.style.display = "flex";
        const res = await adminRequest("/admin/backup/users");
        if (!isShown(modal)) return;
        if (!res.ok) {
            renderAdminListError(list, res.error);
            return;
        }
        const users = Array.isArray(res.data.users) ? res.data.users : [];
        const count = Number.isInteger(Number(res.data.count)) && Number(res.data.count) >= 0 ? Number(res.data.count) : users.length;
        if (countEl) countEl.textContent = `(${count})`;
        if (adState.backup.loaded) {
            adState.backup.usersCount = count;
            renderBackupPanel();
        }
        // Noms et pseudos saisis par les clients : tous échappés
        list.innerHTML = users.length ? users.map((u) => {
            const handle = telegramHandle(u.username);
            const started = adminDate(u.started_at);
            return `
            <div class="gst-admin-chip-row">
                <span class="gst-user-handle">${escapeHtml(userDisplayName(u))}${u.username ? ` · @${escapeHtml(String(u.username))}` : ""}<span class="gst-admin-link-status">ID : ${escapeHtml(String(u.user_id || "?"))}${started ? ` · a démarré le backup le ${started.toLocaleDateString("fr-FR")}` : ""}</span></span>
                ${handle ? `<a href="https://t.me/${handle}" target="_blank" rel="noopener" class="gst-btn-icon-dm" title="Ouvrir le DM">✈</a>` : ""}
            </div>`;
        }).join("") : `<div class="gst-empty-placeholder">Personne n'a encore démarré le bot backup.</div>`;
    }

    function closeBackupUsersModal() {
        const modal = document.getElementById("gst-modal-backup-users");
        if (modal) modal.style.display = "none";
    }

    // Même fonctionnement que le broadcast de l'onglet Messages, envoyé par le bot backup à ses utilisateurs
    function sendBackupBroadcast() {
        const textarea = document.getElementById("gst-backup-broadcast-msg");
        const msg = textarea ? textarea.value.trim() : "";
        const b = adState.backup;
        if (!b.tokenSet) {
            showToast(BACKUP_MISSING_MSG, "error");
            return;
        }
        if (!msg) {
            showToast("Le message à diffuser est vide.", "error");
            return;
        }
        if (msg.length > BROADCAST_MAX_CHARS) {
            showToast(`Message trop long (${BROADCAST_MAX_CHARS} caractères max).`, "error");
            return;
        }
        showConfirmModal({
            title: "Envoyer aux utilisateurs du backup ?",
            emoji: "📢",
            message: `Ce message part à <strong>${b.usersCount} utilisateur${b.usersCount > 1 ? "s" : ""}</strong> de ${b.username ? `@${escapeHtml(b.username)}` : "ton bot backup"}. Un envoi lancé ne peut pas être annulé.`,
            confirmText: "Oui, envoyer",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: async () => {
                const btn = document.getElementById("gst-backup-broadcast-send-btn");
                if (btn) btn.disabled = true;
                const res = await adminRequest("/admin/backup/broadcast", { message: msg }, 30000);
                if (btn) btn.disabled = !adState.backup.tokenSet;
                if (res.ok) {
                    const n = Math.max(0, parseInt(res.data.recipients, 10) || 0);
                    showToast(`Envoi lancé à ${n} utilisateur${n > 1 ? "s" : ""} du backup 📢`);
                    if (textarea && textarea.value.trim() === msg) textarea.value = "";
                } else if (res.status === 409) {
                    showToast("Un envoi est déjà en cours : attends qu'il soit terminé pour en lancer un autre.", "error");
                } else {
                    showToast(res.error, "error");
                }
            }
        });
    }

    // Bascule (POST /admin/backup/switch) : confirmation, avec ou sans annonce aux utilisateurs du backup
    function confirmBackupSwitch() {
        const b = adState.backup;
        const toBackup = !b.active;
        if (toBackup && !b.tokenSet) {
            showToast(BACKUP_MISSING_MSG, "error");
            return;
        }
        const announceEl = document.getElementById("gst-backup-announce-toggle");
        const announce = Boolean(announceEl && announceEl.checked);
        const backupName = b.username ? `<strong>@${escapeHtml(b.username)}</strong>` : "Ton bot backup";
        const mainName = adState.mainBotUsername ? `<strong>@${escapeHtml(adState.mainBotUsername)}</strong>` : "Le bot principal";
        const announceLine = announce
            ? `<br><br>📣 Une annonce part aux <strong>${b.usersCount}</strong> utilisateur${b.usersCount > 1 ? "s" : ""} du backup.`
            : "<br><br>Aucune annonce ne sera envoyée.";
        showConfirmModal({
            title: toBackup ? "Basculer vers le backup ?" : "Revenir au bot principal ?",
            emoji: "🔁",
            message: (toBackup
                ? `${backupName} prend le relais : le bouton de la boutique est posé sur lui et il accueille les clients comme le bot principal.`
                : `${mainName} reprend la boutique, le backup redevient une réserve.`) + announceLine,
            confirmText: toBackup ? "Oui, basculer" : "Oui, revenir",
            cancelText: "Annuler",
            isDanger: toBackup,
            onConfirm: async () => {
                const btn = document.getElementById("gst-backup-switch-btn");
                if (btn) btn.disabled = true;
                const res = await adminRequest("/admin/backup/switch", { active: toBackup, announce }, 30000);
                if (btn) btn.disabled = false;
                if (!res.ok) {
                    showToast(res.error, "error");
                    renderBackupPanel();
                    return;
                }
                const active = isOn(res.data.backup_active);
                const announced = res.data.announced ? " · annonce envoyée" : "";
                showToast(active ? `Bascule faite : le backup sert la boutique 🔁${announced}` : `Retour au bot principal ✓${announced}`);
                adState.backup.active = active;
                renderBackupPanel();
                scheduleAccessRefresh();
            }
        });
    }

    // ----- Vérifications en attente (CNI + selfie, approbation manuelle) -----
    function setVerificationsPending(count) {
        const badge = document.getElementById("gst-cni-pending-badge");
        if (badge) {
            badge.textContent = count > 0 ? `${count} en attente` : "";
            badge.style.display = count > 0 ? "" : "none";
        }
        const waitCount = document.getElementById("gst-approval-waitlist-count");
        if (waitCount) waitCount.textContent = count > 0 ? `(${count})` : "";
        reorgSetCount("verifications", count); // reorg : pastille « Vérifs » et onglet Clients
    }

    async function loadAdminVerifications() {
        const res = await adminRequest("/admin/verifications?status=pending");
        adState.verifError = res.ok ? "" : res.error;
        if (res.ok) {
            adState.verifItems = Array.isArray(res.data.items)
                ? res.data.items.filter((i) => i && typeof i === "object" && /^\d{1,20}$/.test(String(i.user_id)))
                : [];
            adState.verifCounts = res.data.counts && typeof res.data.counts === "object" ? res.data.counts : null;
            adState.verifLoaded = true;
        }
        renderVerifications();
    }

    // Révoque les URL blob des selfies affichés : à chaque nouveau rendu et à la fermeture de la gestion
    function releaseVerificationPhotos() {
        adState.verifCycle += 1;
        adState.verifPhotos.forEach((photo) => photo.then((url) => URL.revokeObjectURL(url), () => {}));
        adState.verifPhotos = new Map();
        document.querySelectorAll("img.gst-verif-photo").forEach((img) => img.removeAttribute("src"));
    }

    // Selfie d'une demande : octets lus avec l'en-tête d'authentification admin (jamais d'URL publique) → URL blob
    async function fetchVerificationPhoto(userId) {
        const resp = await fetchWriteApi(`/admin/verifications/photo?user_id=${encodeURIComponent(userId)}`, {
            headers: { "X-Telegram-Init-Data": getAdminInitData() },
            cache: "no-store"
        }, 20000);
        const type = String(resp.headers.get("content-type") || "").toLowerCase();
        if (!resp.ok || !type.startsWith("image/")) throw new Error("Photo indisponible.");
        return URL.createObjectURL(await resp.blob());
    }

    // Une seule lecture par demande et par rendu (liste de la section et liste d'attente partagent l'URL)
    function verificationPhotoUrl(userId) {
        if (!adState.verifPhotos.has(userId)) {
            const cycle = adState.verifCycle;
            adState.verifPhotos.set(userId, fetchVerificationPhoto(userId).then((url) => {
                if (cycle === adState.verifCycle) return url;
                // Rendu remplacé pendant la lecture : l'URL ne sert plus
                URL.revokeObjectURL(url);
                throw new Error("Rendu remplacé.");
            }));
        }
        return adState.verifPhotos.get(userId);
    }

    function attachVerificationPhoto(img) {
        const box = img.parentElement;
        const stateEl = box ? box.querySelector(".gst-verif-photo-state") : null;
        verificationPhotoUrl(img.dataset.verifPhoto).then((url) => {
            if (!img.isConnected) return;
            // Format que la WebView ne sait pas décoder (ancienne photo HEIC…) : message au lieu d'une image cassée
            img.onerror = () => {
                img.style.display = "none";
                if (box && !box.querySelector(".gst-verif-photo-state")) {
                    box.insertAdjacentHTML("beforeend", '<span class="gst-verif-photo-state">Format non affichable ici : ouvre la demande dans Telegram.</span>');
                }
            };
            img.src = url;
            img.style.display = "";
            if (stateEl) stateEl.remove();
        }).catch(() => {
            if (stateEl && stateEl.isConnected) stateEl.textContent = "Photo indisponible (déjà traitée ou effacée).";
        });
    }

    function verificationCard(item) {
        const uid = escapeHtml(String(item.user_id));
        const name = escapeHtml(userDisplayName(item));
        const handle = item.username ? ` · @${escapeHtml(String(item.username))}` : "";
        const when = adminDate(item.submitted_at);
        const photo = item.has_photo
            ? `<div class="gst-verif-photo-box">
                    <img class="gst-verif-photo" alt="Selfie avec pièce d'identité de ${name}" data-verif-photo="${uid}" style="display:none">
                    <span class="gst-verif-photo-state">Chargement de la photo…</span>
                </div>`
            : `<div class="gst-verif-photo-box is-empty"><span class="gst-verif-photo-state">Pas de photo : demande d'approbation manuelle.</span></div>`;
        return `
            <div class="gst-ticket-card gst-verif-card">
                <div class="gst-card-row-head">
                    <strong>${name}</strong>
                    <span class="gst-verif-status">⏳ En attente</span>
                </div>
                <div class="gst-order-meta">ID : ${uid}${handle}${when ? ` · demande du ${when.toLocaleString("fr-FR")}` : ""}</div>
                ${photo}
                <div class="gst-review-actions">
                    <button type="button" class="gst-btn-success-sm" data-verif-decide="approve" data-verif-user="${uid}">✓ Approuver</button>
                    <button type="button" class="gst-btn-danger-sm" data-verif-decide="reject" data-verif-user="${uid}">✕ Refuser</button>
                </div>
            </div>`;
    }

    function renderVerifications() {
        releaseVerificationPhotos();
        const counts = adState.verifCounts;
        [["pending", "gst-verif-count-pending"], ["approved", "gst-verif-count-approved"], ["rejected", "gst-verif-count-rejected"]].forEach(([key, id]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = counts && Number.isFinite(Number(counts[key])) ? String(Number(counts[key])) : "—";
        });
        if (counts && Number.isFinite(Number(counts.pending))) setVerificationsPending(Number(counts.pending));
        else if (adState.verifLoaded) setVerificationsPending(adState.verifItems.length);

        const lists = [document.getElementById("gst-cni-pending-list")];
        if (isShown(document.getElementById("gst-modal-verifications"))) lists.push(document.getElementById("gst-verif-modal-list"));
        lists.filter(Boolean).forEach((list) => {
            if (adState.verifError) {
                renderAdminListError(list, adState.verifError);
                return;
            }
            if (!adState.verifLoaded) {
                list.innerHTML = `<div class="gst-empty-placeholder">Chargement des demandes…</div>`;
                return;
            }
            list.innerHTML = adState.verifItems.length
                ? adState.verifItems.map(verificationCard).join("")
                : `<div class="gst-empty-placeholder">Aucune demande en attente.</div>`;
            list.querySelectorAll("img[data-verif-photo]").forEach(attachVerificationPhoto);
        });
    }

    // Approuver (direct) ou Refuser (motif optionnel, envoyé au client) ; toucher la photo l'agrandit
    function onVerificationListClick(event) {
        const img = event.target.closest("img.gst-verif-photo");
        if (img) {
            img.classList.toggle("is-zoomed");
            return;
        }
        const btn = event.target.closest("[data-verif-decide]");
        if (!btn) return;
        const item = adState.verifItems.find((i) => String(i.user_id) === btn.dataset.verifUser);
        if (!item) return;
        if (btn.dataset.verifDecide === "approve") {
            btn.disabled = true;
            decideVerification(item, "approve", "");
            return;
        }
        showConfirmModal({
            title: "Refuser cette demande ?",
            emoji: "🆔",
            message: `<strong>${escapeHtml(userDisplayName(item))}</strong>${item.username ? ` (@${escapeHtml(String(item.username))})` : ""} n'aura pas accès à la boutique et sera prévenu par le bot.
                <textarea class="gst-textarea gst-verif-reason" data-verif-reason rows="3" maxlength="300" placeholder="Motif (optionnel), montré au client : ex. photo floue"></textarea>`,
            confirmText: "Oui, refuser",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const reasonEl = document.querySelector("#gh-confirm-modal [data-verif-reason]");
                await decideVerification(item, "reject", reasonEl ? reasonEl.value.trim().slice(0, 300) : "");
            }
        });
    }

    async function decideVerification(item, decision, reason) {
        const body = { user_id: Number(item.user_id), decision };
        if (decision === "reject" && reason) body.reason = reason;
        const res = await adminRequest("/admin/verifications/decide", body, 20000);
        if (res.ok) showToast(decision === "approve" ? `${userDisplayName(item)} a accès à la boutique ✓` : "Demande refusée : le client est prévenu.");
        else showToast(res.error, "error");
        await loadAdminVerifications();
        scheduleAccessRefresh();
    }

    // Actions groupées (POST /admin/verifications/bulk) → { affected }
    const VERIFICATION_BULK_DONE = {
        approve_all: (n) => `${n} client${n > 1 ? "s" : ""} validé${n > 1 ? "s" : ""} ✓`,
        reset_all: (n) => `${n} approbation${n > 1 ? "s" : ""} réinitialisée${n > 1 ? "s" : ""}`,
        resend_pending: (n) => (n ? `${n} demande${n > 1 ? "s" : ""} ré-envoyée${n > 1 ? "s" : ""} aux modérateurs` : "Aucune demande en attente à ré-envoyer.")
    };

    async function runVerificationBulk(action, btn) {
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/verifications/bulk", { action }, 30000);
        if (btn) btn.disabled = false;
        if (res.ok) showToast(VERIFICATION_BULK_DONE[action](Math.max(0, parseInt(res.data.affected, 10) || 0)));
        else showToast(res.error, "error");
        await loadAdminVerifications();
        scheduleAccessRefresh();
    }

    function confirmApproveAll() {
        const counts = adState.verifCounts;
        const pending = counts && Number.isFinite(Number(counts.pending)) ? Number(counts.pending) : adState.verifItems.length;
        showConfirmModal({
            title: "Approuver tous les clients en attente ?",
            emoji: "✅",
            message: `${pending ? `Les <strong>${pending}</strong> client${pending > 1 ? "s" : ""} en attente` : "Tous les clients en attente"} auront accès à la boutique, sans vérification de leur photo.`,
            confirmText: "Oui, approuver",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: () => runVerificationBulk("approve_all", document.getElementById("gst-approval-approve-all"))
        });
    }

    function confirmResetApprovals() {
        showConfirmModal({
            title: "Réinitialiser toutes les approbations ?",
            emoji: "♻️",
            message: "Toutes les validations sont effacées : chaque client devra de nouveau être validé (vérification CNI ou approbation manuelle) avant d'accéder à la boutique.<br><br><strong>Action irréversible.</strong> Les admins ne sont pas concernés.",
            confirmText: "Oui, tout réinitialiser",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: () => runVerificationBulk("reset_all", document.getElementById("gst-approval-reset-all"))
        });
    }

    function openVerificationsModal() {
        const modal = document.getElementById("gst-modal-verifications");
        const list = document.getElementById("gst-verif-modal-list");
        if (!modal) return;
        if (list) list.innerHTML = `<div class="gst-empty-placeholder">Chargement de la liste d'attente…</div>`;
        modal.style.display = "flex";
        loadAdminVerifications();
    }

    function closeVerificationsModal() {
        const modal = document.getElementById("gst-modal-verifications");
        if (modal) modal.style.display = "none";
        const list = document.getElementById("gst-verif-modal-list");
        if (list) list.innerHTML = "";
    }

    function bindAccessControls() {
        // Bot backup
        document.getElementById("gst-backup-verify-btn")?.addEventListener("click", verifyBackupToken);
        document.getElementById("gst-backup-token-input")?.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            verifyBackupToken();
        });
        document.getElementById("gst-backup-remove-btn")?.addEventListener("click", confirmRemoveBackupBot);
        document.getElementById("gst-backup-view-users-btn")?.addEventListener("click", openBackupUsersModal);
        document.getElementById("gst-close-backup-users-btn")?.addEventListener("click", closeBackupUsersModal);
        document.getElementById("gst-close-backup-users-foot-btn")?.addEventListener("click", closeBackupUsersModal);
        document.getElementById("gst-backup-broadcast-send-btn")?.addEventListener("click", sendBackupBroadcast);
        document.getElementById("gst-backup-switch-btn")?.addEventListener("click", confirmBackupSwitch);

        // CNI : image d'exemple (même envoi que l'image de fond), liste des demandes
        bindAppearanceUpload("gst-cni-sample-upload-input", "cni_sample_image", "Image d'exemple enregistrée ! 🆔", renderCniSample);
        document.getElementById("gst-cni-sample-clear-btn")?.addEventListener("click", confirmClearCniSample);
        document.getElementById("gst-verif-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation des demandes...", "info");
            loadAdminVerifications();
        });
        ["gst-cni-pending-list", "gst-verif-modal-list"].forEach((id) => {
            document.getElementById(id)?.addEventListener("click", onVerificationListClick);
        });

        // Approbation manuelle : actions groupées et liste d'attente
        document.getElementById("gst-approval-approve-all")?.addEventListener("click", confirmApproveAll);
        document.getElementById("gst-approval-reset-all")?.addEventListener("click", confirmResetApprovals);
        document.getElementById("gst-approval-resend-btn")?.addEventListener("click", (e) => runVerificationBulk("resend_pending", e.currentTarget));
        document.getElementById("gst-approval-waitlist-btn")?.addEventListener("click", openVerificationsModal);
        document.getElementById("gst-close-verif-modal-btn")?.addEventListener("click", closeVerificationsModal);
        document.getElementById("gst-close-verif-modal-foot-btn")?.addEventListener("click", closeVerificationsModal);
        document.getElementById("gst-verif-modal-refresh-btn")?.addEventListener("click", loadAdminVerifications);
    }

    // ===== ADMINS (section Admins de Réglages) =====
    // La liste blanche du serveur est faite de pseudos Telegram (sans @, en minuscules) ; un pseudo est lié au
    // compte de la personne la première fois qu'elle ouvre la gestion. Un ID ne sert qu'à retrouver un pseudo.
    const TELEGRAM_USERNAME_RE = /^[a-z0-9_]{4,32}$/;

    function normalizeAdminUsername(value) {
        return String(value || "").trim().replace(/^@+/, "").toLowerCase();
    }

    function ownAdminUsername() {
        const user = getTelegramUser();
        return normalizeAdminUsername(user && user.username);
    }

    function isWhitelisted(username) {
        const name = normalizeAdminUsername(username);
        return adState.whitelist.some((u) => normalizeAdminUsername(u) === name);
    }

    // Carte « Ton compte » : le compte Telegram connecté au panel
    function renderMainAdminCard() {
        const user = getTelegramUser() || {};
        const handleEl = document.getElementById("gst-main-admin-handle");
        const idEl = document.getElementById("gst-main-admin-id");
        if (handleEl) handleEl.textContent = user.username ? `@${user.username}` : (user.first_name || "—");
        if (idEl) idEl.textContent = user.id ? `ID : ${user.id}` : "";
    }

    function renderAdminWhitelistChips(whitelist) {
        const container = document.getElementById("gst-admins-whitelist-list");
        if (!container) return;
        if (!whitelist.length) {
            container.innerHTML = `<div class="gst-empty-placeholder">Aucun admin enregistré.</div>`;
            return;
        }
        const me = ownAdminUsername();
        const linked = adState.whitelistLinked || {};
        container.innerHTML = whitelist.map((u) => {
            const known = Object.prototype.hasOwnProperty.call(linked, u);
            const status = !known ? "" : linked[u] ? "✓ lié à son compte Telegram" : "⏳ en attente de sa première connexion";
            const self = normalizeAdminUsername(u) === me;
            return `
            <div class="gst-admin-chip-row${self ? " is-self" : ""}">
                <span class="gst-user-handle">@${escapeHtml(u)}${self ? " (toi)" : ""}${status ? `<span class="gst-admin-link-status">${status}</span>` : ""}</span>
                <button type="button" class="gst-btn-remove-sm" data-remove-admin="${escapeHtml(u)}">✕ Retirer</button>
            </div>`;
        }).join("");

        container.querySelectorAll("[data-remove-admin]").forEach((btn) => {
            btn.addEventListener("click", () => confirmRemoveAdmin(btn.dataset.removeAdmin));
        });
    }

    function confirmRemoveAdmin(username) {
        const name = normalizeAdminUsername(username);
        if (!name) return;
        if (adState.whitelist.length <= 1) {
            showToast("Impossible de retirer le dernier admin : ajoute d'abord un autre compte.", "error");
            return;
        }
        const self = name === ownAdminUsername();
        showConfirmModal({
            title: "Retirer cet admin ?",
            emoji: "👥",
            message: self
                ? `Tu vas retirer <strong>ton propre accès</strong> (@${escapeHtml(name)}) : tu ne pourras plus ouvrir la gestion.`
                : `<strong>@${escapeHtml(name)}</strong> ne pourra plus ouvrir la gestion.`,
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const ok = await updateAdminWhitelist((list) => list.filter((u) => normalizeAdminUsername(u) !== name), `@${name} n'a plus accès à la gestion`);
                if (ok && self) {
                    // Plus admin : le panel se ferme et la carte de gestion du profil disparaît
                    closeAdminPanel();
                    refreshAdminAccess();
                }
            }
        });
    }

    function confirmAddAdmin(username) {
        const name = normalizeAdminUsername(username);
        if (!TELEGRAM_USERNAME_RE.test(name)) {
            showToast("Pseudo Telegram invalide : 4 à 32 lettres, chiffres ou _.", "error");
            return;
        }
        if (isWhitelisted(name)) {
            showToast(`@${name} a déjà accès à la gestion.`, "info");
            return;
        }
        showConfirmModal({
            title: "Donner l'accès ?",
            emoji: "👥",
            message: `<strong>@${escapeHtml(name)}</strong> pourra tout modifier dans la gestion : produits, réglages, messages et admins.`,
            confirmText: "Oui, ajouter",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: async () => {
                const ok = await updateAdminWhitelist((list) => (list.some((u) => normalizeAdminUsername(u) === name) ? list : [...list, name]), `@${name} peut maintenant ouvrir la gestion 👥`);
                if (!ok) return;
                const input = document.getElementById("gst-admin-search-input");
                if (input) input.value = "";
                renderAdminAddResults();
            }
        });
    }

    // /admin/whitelist/save remplace toute la liste : elle est relue sur le serveur juste avant l'envoi,
    // jamais construite à partir d'un état vide ou périmé du panel
    async function updateAdminWhitelist(change, successMsg) {
        const fresh = await adminRequest("/admin/config");
        const current = fresh.ok && fresh.data.config && fresh.data.config.admin ? fresh.data.config.admin.whitelist : null;
        if (!Array.isArray(current)) {
            showToast(fresh.error || "Liste des admins indisponible, réessaie.", "error");
            return false;
        }
        const next = change(current.slice());
        if (!next.length) {
            showToast("Impossible de retirer le dernier admin : ajoute d'abord un autre compte.", "error");
            return false;
        }
        return saveAdminWhitelist(next, successMsg);
    }

    async function saveAdminWhitelist(list, successMsg) {
        adState.settingsTouchedAt.whitelist = Date.now();
        const res = await adminRequest("/admin/whitelist/save", { whitelist: list });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else adState.whitelist = list;
        renderAdminWhitelistChips(adState.whitelist);
        renderAdminAddResults();
        showToast(successMsg || "Admins mis à jour ! 👥");
        return true;
    }

    function setAdminAddMode(mode) {
        adState.adminAddMode = mode === "id" ? "id" : "list";
        const byId = adState.adminAddMode === "id";
        document.getElementById("gst-admin-add-by-list-btn")?.classList.toggle("active", !byId);
        document.getElementById("gst-admin-add-by-id-btn")?.classList.toggle("active", byId);
        const input = document.getElementById("gst-admin-search-input");
        if (input) {
            input.value = "";
            input.placeholder = byId ? "ID Telegram (ex : 123456789)" : "Pseudo, nom ou @pseudo…";
            input.inputMode = byId ? "numeric" : "text";
        }
        const caption = document.getElementById("gst-admin-add-caption");
        if (caption) {
            caption.textContent = byId
                ? "L'accès se donne par pseudo : l'ID sert à retrouver le pseudo d'une personne qui a déjà démarré le bot."
                : "L'accès se donne par pseudo Telegram : il est lié au compte dès que la personne ouvre la gestion pour la première fois.";
        }
        renderAdminAddResults();
        fetchAdminUsers(false).then(renderAdminAddResults);
    }

    function adminCandidateRow(user) {
        const uname = normalizeAdminUsername(user.username);
        const name = [user.first_name, user.last_name].map((v) => String(v || "").trim()).filter(Boolean).join(" ") || "Client";
        const uid = String(user.user_id || user.id || "");
        let action = `<button type="button" class="gst-btn-success-sm" data-add-admin="${escapeHtml(uname)}">+ Ajouter</button>`;
        if (!uname) action = `<button type="button" class="gst-btn-secondary-sm" disabled>Sans pseudo</button>`;
        else if (isWhitelisted(uname)) action = `<button type="button" class="gst-btn-secondary-sm" disabled>Déjà admin</button>`;
        return `
            <div class="gst-admin-chip-row">
                <span class="gst-user-handle">${escapeHtml(name)}${uname ? ` · @${escapeHtml(uname)}` : ""}<span class="gst-admin-link-status">ID : ${escapeHtml(uid) || "?"}</span></span>
                ${action}
            </div>`;
    }

    // Résultats sous le champ « Ajouter un accès » : utilisateurs du bot (pseudo, nom, ID) ou pseudo tapé tel quel
    function renderAdminAddResults() {
        const box = document.getElementById("gst-admin-search-results");
        const input = document.getElementById("gst-admin-search-input");
        if (!box || !input) return;
        const query = input.value.trim();
        const note = (text, isError) => `<div class="gst-empty-placeholder${isError ? " gst-load-error" : ""}">${escapeHtml(text)}</div>`;
        let html = "";
        if (!query) {
            box.innerHTML = "";
            return;
        }
        if (!adState.usersLoaded) {
            html = adState.usersError ? note(adState.usersError, true) : note("Chargement des utilisateurs du bot…");
        }
        if (adState.adminAddMode === "id") {
            if (!/^\d{1,15}$/.test(query)) {
                html = note("Entre l'ID Telegram en chiffres (ex : 123456789).");
            } else if (adState.usersLoaded) {
                const user = adState.usersList.find((u) => String(u.user_id || u.id) === query);
                if (!user) html = note("ID inconnu : la personne doit d'abord démarrer le bot (/start), puis réessaie.");
                else if (!user.username) html = adminCandidateRow(user) + note("Ce compte n'a pas de pseudo Telegram : l'accès admin se donne par pseudo. Demande-lui d'en choisir un (Réglages Telegram › Nom d'utilisateur), puis de relancer le bot.");
                else html = adminCandidateRow(user);
            }
        } else {
            const q = normalizeAdminUsername(query);
            const matches = adState.usersList.filter((u) => [u.username, u.first_name, u.last_name, u.user_id || u.id]
                .some((v) => String(v || "").toLowerCase().includes(q))).slice(0, 6);
            const typed = TELEGRAM_USERNAME_RE.test(q) && !matches.some((u) => normalizeAdminUsername(u.username) === q)
                ? `
            <div class="gst-admin-chip-row">
                <span class="gst-user-handle">@${escapeHtml(q)}<span class="gst-admin-link-status">Pseudo saisi</span></span>
                ${isWhitelisted(q) ? `<button type="button" class="gst-btn-secondary-sm" disabled>Déjà admin</button>` : `<button type="button" class="gst-btn-success-sm" data-add-admin="${escapeHtml(q)}">+ Ajouter</button>`}
            </div>`
                : "";
            if (adState.usersLoaded) html = typed + matches.map(adminCandidateRow).join("") || note("Aucun utilisateur trouvé.");
            else html = typed + html;
        }
        box.innerHTML = html;
        box.querySelectorAll("[data-add-admin]").forEach((btn) => {
            btn.addEventListener("click", () => confirmAddAdmin(btn.dataset.addAdmin));
        });
    }

    // ===== AVIS CLIENTS (section Avis de Réglages) : en attente → publier ou refuser ; publiés → retirer =====
    const REVIEW_MODERATION = {
        approve: { path: "/admin/reviews/approve", done: "Avis publié dans la boutique ! ⭐" },
        reject: { path: "/admin/reviews/reject", done: "Avis refusé" },
        "delete-approved": { path: "/admin/reviews/delete-approved", done: "Avis retiré de la boutique 🗑️" }
    };

    function adminReviewCard(r, actionsHtml) {
        const rawStars = Math.max(1, Math.min(5, parseInt(r.stars, 10) || 5));
        // timestamp BIGINT : nombre avec willy.py, chaîne avec le secours Vercel (pg)
        const ts = Number(r.timestamp);
        const date = ts ? new Date(ts).toLocaleString("fr-FR") : "date inconnue";
        const username = r.telegram_username || r.telegramUsername;
        return `
            <div class="gst-ticket-card">
                <div class="gst-card-row-head">
                    <strong>${escapeHtml(String(r.author || "Anonyme"))}</strong>
                    <span class="gst-review-stars">${"★".repeat(rawStars)}${"☆".repeat(5 - rawStars)}</span>
                </div>
                <div class="gst-order-summary">${escapeHtml(String(r.message || ""))}</div>
                ${fidReviewPhotoHtml(r)}
                <div class="gst-order-meta">${date}${username ? ` · @${escapeHtml(String(username))}` : ""}</div>
                <div class="gst-review-actions">${actionsHtml}</div>
            </div>`;
    }

    function setReviewsPendingCount(count) {
        adState.reviewsPending = count;
        const badge = document.getElementById("gst-reviews-pending-badge");
        if (badge) {
            badge.textContent = count > 0 ? `${count} en attente` : "";
            badge.style.display = count > 0 ? "" : "none";
        }
        // reorg : pastille « Avis » des pages Clients et de l'onglet Clients
        reorgSetCount("reviews", count);
    }

    async function loadAdminReviews() {
        const pendingList = document.getElementById("gst-reviews-pending-list");
        const approvedList = document.getElementById("gst-reviews-approved-list");
        if (!pendingList || !approvedList) return;
        // En attente : route admin (initData vérifiée) ; publiés : liste publique, qui porte l'id de chaque avis
        const [pendingRes, approvedResp] = await Promise.all([
            adminRequest("/admin/reviews/pending"),
            fetchWriteApi("/reviews", { method: "GET" }).catch(() => null)
        ]);
        const approvedData = approvedResp && approvedResp.ok ? await readJsonIfAny(approvedResp) : null;

        if (!pendingRes.ok || !Array.isArray(pendingRes.data.pending)) {
            renderAdminListError(pendingList, pendingRes.error || "Avis en attente indisponibles, réessaie.");
        } else {
            const pending = pendingRes.data.pending;
            setReviewsPendingCount(pending.length);
            pendingList.innerHTML = pending.length
                ? pending.map((r) => adminReviewCard(r, `
                    <button type="button" class="gst-btn-success-sm" data-review-action="approve" data-review-id="${escapeHtml(String(r.id))}">✓ Publier</button>
                    <button type="button" class="gst-btn-danger-sm" data-review-action="reject" data-review-id="${escapeHtml(String(r.id))}">✕ Refuser</button>`)).join("")
                : `<div class="gst-empty-placeholder">Aucun avis en attente.</div>`;
        }

        if (!approvedData || !Array.isArray(approvedData.reviews)) {
            renderAdminListError(approvedList, "Avis publiés indisponibles, réessaie.");
        } else {
            approvedList.innerHTML = approvedData.reviews.length
                ? approvedData.reviews.map((r) => adminReviewCard(r, `
                    <button type="button" class="gst-btn-remove-sm" data-review-action="delete-approved" data-review-id="${escapeHtml(String(r.id))}">🗑️ Retirer de la boutique</button>`)).join("")
                : `<div class="gst-empty-placeholder">Aucun avis publié.</div>`;
        }

        [pendingList, approvedList].forEach((list) => list.querySelectorAll("[data-review-action]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const action = btn.dataset.reviewAction;
                const reviewId = Number(btn.dataset.reviewId);
                if (action !== "delete-approved") {
                    btn.disabled = true;
                    adminModerateReview(action, reviewId);
                    return;
                }
                showConfirmModal({
                    title: "Retirer cet avis ?",
                    emoji: "🗑️",
                    message: "L'avis sera supprimé de la boutique. Cette action est irréversible.",
                    confirmText: "Oui, retirer",
                    cancelText: "Annuler",
                    isDanger: true,
                    onConfirm: () => adminModerateReview("delete-approved", reviewId)
                });
            });
        }));
    }

    async function adminModerateReview(action, reviewId) {
        const step = REVIEW_MODERATION[action];
        if (!step || !Number.isInteger(reviewId) || reviewId <= 0) {
            showToast("Identifiant d'avis manquant : actualise la liste des avis.", "error");
            return;
        }
        const res = await adminRequest(step.path, { review_id: reviewId });
        if (res.ok) {
            showToast(step.done);
            // Avis publié ou retiré : la page Avis de la boutique suit
            if (action !== "reject" && await syncReviewsFromLocalApi()) renderReviews();
        } else {
            showToast(res.error, "error");
        }
        await loadAdminReviews();
    }

    // ===== MUSIQUE (section Musique de Réglages) : playlist [{title, url}] enregistrée par /admin/contact/save =====
    const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg)$/i;
    const MUSIC_TRACKS_MAX = 50; // comme willy.py (contact/save)
    const MUSIC_UNAVAILABLE_MSG = "Playlist indisponible : rouvre la page Réglages › Musique pour réessayer.";

    function parseMusicPlaylist(raw) {
        try {
            const list = JSON.parse(raw || "[]");
            return Array.isArray(list) ? list.filter((t) => t && typeof t === "object" && t.url) : [];
        } catch (_) {
            return [];
        }
    }

    function renderAdminMusic() {
        const list = document.getElementById("gst-music-playlist-list");
        const countEl = document.getElementById("gst-music-count");
        const tracks = adState.musicTracks;
        if (!adState.musicLoaded) {
            if (countEl) countEl.textContent = "—";
            if (list) list.innerHTML = `<div class="gst-empty-placeholder">${MUSIC_UNAVAILABLE_MSG}</div>`;
            return;
        }
        if (countEl) countEl.textContent = `${tracks.length} musique${tracks.length > 1 ? "s" : ""}`;
        if (!list) return;
        if (!tracks.length) {
            list.innerHTML = `<div class="gst-empty-placeholder">Aucune musique : la boutique reste silencieuse.</div>`;
            return;
        }
        const busy = adState.musicBusy ? "disabled" : "";
        list.innerHTML = tracks.map((t, i) => `
            <div class="gst-cat-row">
                <span class="gst-cat-emoji">🎵</span>
                <div class="gst-cat-info">
                    <div class="gst-cat-name">${escapeHtml(String(t.title || `Piste ${i + 1}`))}</div>
                    <div class="gst-cat-meta">${escapeHtml(String(t.url).split("/").pop())}</div>
                </div>
                <div class="gst-prod-reorder">
                    <button type="button" class="gst-prod-reorder-btn" data-music-move="${i}" data-dir="-1" aria-label="Monter" ${i === 0 ? "disabled" : busy}>▲</button>
                    <button type="button" class="gst-prod-reorder-btn" data-music-move="${i}" data-dir="1" aria-label="Descendre" ${i === tracks.length - 1 ? "disabled" : busy}>▼</button>
                </div>
                <button type="button" class="gst-btn-remove-sm" data-music-remove="${i}" aria-label="Retirer ce son" ${busy}>✕</button>
            </div>
        `).join("");

        list.querySelectorAll("[data-music-move]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const from = Number(btn.dataset.musicMove);
                const to = from + Number(btn.dataset.dir);
                const next = adState.musicTracks.slice();
                if (!next[from] || !next[to]) return;
                [next[from], next[to]] = [next[to], next[from]];
                saveAdminMusic(next, "Ordre de la playlist enregistré 🎵");
            });
        });
        list.querySelectorAll("[data-music-remove]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const index = Number(btn.dataset.musicRemove);
                const track = adState.musicTracks[index];
                if (!track) return;
                showConfirmModal({
                    title: "Retirer ce son ?",
                    emoji: "🎵",
                    message: `<strong>${escapeHtml(String(track.title || `Piste ${index + 1}`))}</strong> ne sera plus joué dans la boutique.`,
                    confirmText: "Oui, retirer",
                    cancelText: "Annuler",
                    isDanger: true,
                    onConfirm: () => saveAdminMusic(adState.musicTracks.filter((_, i) => i !== index), "Son retiré de la playlist")
                });
            });
        });
    }

    // Une modification à la fois ; true seulement après l'enregistrement confirmé (la boutique suit via applyUpdatedConfig)
    async function saveAdminMusic(tracks, successMsg) {
        if (adState.musicBusy) return false;
        if (!adState.musicLoaded) {
            showToast(MUSIC_UNAVAILABLE_MSG, "error");
            return false;
        }
        adState.musicBusy = true;
        renderAdminMusic();
        const ok = await saveAdminSettings({ music_playlist: JSON.stringify(tracks) }, "contact");
        adState.musicBusy = false;
        if (ok) {
            adState.musicTracks = tracks;
            showToast(successMsg);
        }
        renderAdminMusic();
        return ok;
    }

    function bindAdminMusicUpload() {
        const input = document.getElementById("gst-music-upload-input");
        if (!input) return;
        input.addEventListener("change", async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            if (!/^audio\//.test(String(file.type || "")) && !AUDIO_EXT_RE.test(file.name || "")) {
                this.value = "";
                showToast("Choisis un fichier audio (MP3, M4A, WAV, OGG).", "error");
                return;
            }
            // Vérifié avant l'envoi : sinon le fichier resterait sur le serveur sans être dans la playlist
            if (!adState.musicLoaded || adState.musicTracks.length >= MUSIC_TRACKS_MAX) {
                this.value = "";
                showToast(adState.musicLoaded ? `${MUSIC_TRACKS_MAX} sons maximum dans la playlist.` : MUSIC_UNAVAILABLE_MSG, "error");
                return;
            }
            const titleEl = document.getElementById("gst-music-title-input");
            const title = ((titleEl && titleEl.value.trim()) || String(file.name || "").replace(/\.[^.]+$/, "").trim() || `Piste ${adState.musicTracks.length + 1}`).slice(0, 80);
            setUploadBusy(this, true);
            showToast("Envoi du son… ⏳", "info");
            try {
                const path = uploadedPath(await uploadMediaFile(file, (percent) => showToast(`Envoi : ${percent}%`, "info")));
                if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
                // Une autre modification de la playlist en cours : on attend qu'elle se termine
                while (adState.musicBusy) await new Promise((r) => setTimeout(r, 200));
                if (await saveAdminMusic([...adState.musicTracks, { title, url: path }], "Son ajouté à la playlist 🎵") && titleEl) titleEl.value = "";
            } catch (err) {
                showToast(err.message, "error");
            } finally {
                setUploadBusy(this, false);
            }
        });
    }

    // ==================== MOTEUR DE FOND ANIMÉ CANVAS (10 THÈMES) ====================
class CanvasBackgroundEngine {
    constructor(canvas, theme = "fumee") {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext("2d") : null;
        this.theme = theme || "fumee";
        this.animId = null;
        this.running = false;
        this.particles = [];
        this.time = 0;
        this.width = 0;
        this.height = 0;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.resizeHandler = () => this.resize();
        if (this.canvas) {
            window.addEventListener("resize", this.resizeHandler);
            this.resize();
            this.initTheme(this.theme);
        }
    }

    // Taille de mise en page (offsetWidth/Height) : juste même pendant l'animation d'ouverture d'une modale
    // (un transform scale fausse getBoundingClientRect), puis surface de dessin × devicePixelRatio.
    resize() {
        if (!this.canvas) return;
        this.width = this.canvas.offsetWidth || this.width || window.innerWidth;
        this.height = this.canvas.offsetHeight || this.height || window.innerHeight;
        const pxW = Math.floor(this.width * this.dpr);
        const pxH = Math.floor(this.height * this.dpr);
        if (this.canvas.width !== pxW) this.canvas.width = pxW;
        if (this.canvas.height !== pxH) this.canvas.height = pxH;
        if (this.ctx) {
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.ctx.scale(this.dpr, this.dpr);
        }
    }

    // Change de thème sans démarrer l'animation : c'est syncBgAnimation() qui décide si le fond est visible
    setTheme(themeName) {
        this.theme = themeName || "fumee";
        this.time = 0;
        this.initTheme(this.theme);
    }

    // Une seule boucle requestAnimationFrame par moteur. Sur mobile, dessin limité à ~30 i/s ; la simulation
    // avance quand même au rythme de 60 Hz (plusieurs update() par image) pour garder la même vitesse.
    start() {
        if (this.running || !this.canvas) return;
        if (this.animId) cancelAnimationFrame(this.animId);
        this.running = true;
        this.resize();
        const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
        const minFrameMs = coarse ? 33 : 16;
        let last = 0;
        const loop = (now) => {
            if (!this.running) return;
            this.animId = requestAnimationFrame(loop);
            const elapsed = now - last;
            if (last && elapsed < minFrameMs - 2) return;
            const steps = last ? Math.min(3, Math.max(1, Math.round(elapsed / 16.7))) : 1;
            last = now;
            for (let i = 0; i < steps; i++) this.update();
            this.draw();
        };
        this.animId = requestAnimationFrame(loop);
    }

    stop() {
        this.running = false;
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
    }

    initTheme(t) {
        this.particles = [];
        const w = this.width || 300;
        const h = this.height || 400;

        switch (t) {
            case "feuilles": {
                const colors = ["#10b981", "#34d399", "#eab308", "#f59e0b", "#059669"];
                for (let i = 0; i < 36; i++) {
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        size: 8 + Math.random() * 12,
                        speedY: 0.8 + Math.random() * 1.6,
                        swayAmp: 1.5 + Math.random() * 3,
                        swayFreq: 0.02 + Math.random() * 0.03,
                        phase: Math.random() * Math.PI * 2,
                        angle: Math.random() * Math.PI * 2,
                        rotSpeed: (Math.random() - 0.5) * 0.04,
                        color: colors[Math.floor(Math.random() * colors.length)],
                        alpha: 0.65 + Math.random() * 0.35
                    });
                }
                break;
            }
            case "galaxie": {
                const colors = ["#8b5cf6", "#c084fc", "#3b82f6", "#60a5fa", "#e0e7ff", "#ec4899"];
                for (let i = 0; i < 110; i++) {
                    const radius = 10 + Math.random() * (Math.min(w, h) * 0.55);
                    const angle = Math.random() * Math.PI * 2;
                    this.particles.push({
                        radius,
                        angle,
                        baseSpeed: (0.003 + Math.random() * 0.007) * (Math.random() > 0.5 ? 1 : 1),
                        size: 1 + Math.random() * 2.4,
                        color: colors[Math.floor(Math.random() * colors.length)],
                        alpha: 0.3 + Math.random() * 0.7,
                        twinkleSpeed: 0.03 + Math.random() * 0.06
                    });
                }
                break;
            }
            case "meduses": {
                const colors = ["#a855f7", "#06b6d4", "#ec4899", "#8b5cf6"];
                const count = Math.max(4, Math.floor(w / 70));
                for (let i = 0; i < count; i++) {
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        radius: 12 + Math.random() * 16,
                        speedY: 0.4 + Math.random() * 0.8,
                        driftX: (Math.random() - 0.5) * 0.4,
                        pulsePhase: Math.random() * Math.PI * 2,
                        pulseSpeed: 0.04 + Math.random() * 0.03,
                        tentacles: 4 + Math.floor(Math.random() * 3),
                        color: colors[i % colors.length]
                    });
                }
                break;
            }
            case "orbes": {
                const palette = [
                    { c1: "rgba(139, 92, 246, 0.45)", c2: "rgba(139, 92, 246, 0)" },
                    { c1: "rgba(6, 182, 212, 0.40)", c2: "rgba(6, 182, 212, 0)" },
                    { c1: "rgba(236, 72, 153, 0.42)", c2: "rgba(236, 72, 153, 0)" },
                    { c1: "rgba(16, 185, 129, 0.38)", c2: "rgba(16, 185, 129, 0)" },
                    { c1: "rgba(249, 115, 22, 0.38)", c2: "rgba(249, 115, 22, 0)" }
                ];
                for (let i = 0; i < 9; i++) {
                    const pal = palette[i % palette.length];
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        vx: (Math.random() - 0.5) * 0.8,
                        vy: (Math.random() - 0.5) * 0.8,
                        r: 35 + Math.random() * 55,
                        c1: pal.c1,
                        c2: pal.c2
                    });
                }
                break;
            }
            case "particules3d": {
                for (let i = 0; i < 110; i++) {
                    this.particles.push({
                        x: (Math.random() - 0.5) * 800,
                        y: (Math.random() - 0.5) * 800,
                        z: 10 + Math.random() * 700,
                        pz: 700,
                        speed: 3 + Math.random() * 6,
                        color: Math.random() > 0.3 ? "#c084fc" : "#38bdf8"
                    });
                }
                break;
            }
            case "constellations": {
                const count = Math.min(80, Math.max(25, Math.floor((w * h) / 7000)));
                for (let i = 0; i < count; i++) {
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        vx: (Math.random() - 0.5) * 0.9,
                        vy: (Math.random() - 0.5) * 0.9,
                        r: 1.5 + Math.random() * 2.5,
                        color: Math.random() > 0.4 ? "#a855f7" : "#06b6d4"
                    });
                }
                break;
            }
            case "fumee": {
                for (let i = 0; i < 16; i++) {
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        r: 45 + Math.random() * 65,
                        vx: (Math.random() - 0.5) * 0.4,
                        vy: -(0.3 + Math.random() * 0.6),
                        angle: Math.random() * Math.PI * 2,
                        vAngle: (Math.random() - 0.5) * 0.015,
                        alpha: 0.08 + Math.random() * 0.14
                    });
                }
                break;
            }
            case "soie": {
                // 5 harmonic waves
                this.particles = [
                    { color: "rgba(139, 92, 246, 0.22)", amp: 28, freq: 0.008, speed: 0.02, offset: 0 },
                    { color: "rgba(236, 72, 153, 0.18)", amp: 35, freq: 0.006, speed: 0.015, offset: 1.5 },
                    { color: "rgba(6, 182, 212, 0.20)", amp: 22, freq: 0.010, speed: 0.025, offset: 3.0 },
                    { color: "rgba(168, 85, 247, 0.16)", amp: 40, freq: 0.005, speed: 0.012, offset: 4.5 },
                    { color: "rgba(59, 130, 246, 0.18)", amp: 30, freq: 0.007, speed: 0.018, offset: 2.2 }
                ];
                break;
            }
            case "points": {
                // Cyber grid points with distance ripples
                const step = 26;
                const cols = Math.ceil(w / step) + 1;
                const rows = Math.ceil(h / step) + 1;
                for (let c = 0; c < cols; c++) {
                    for (let r = 0; r < rows; r++) {
                        this.particles.push({
                            gx: c * step,
                            gy: r * step,
                            baseR: 1.4
                        });
                    }
                }
                break;
            }
            case "bulles": {
                for (let i = 0; i < 30; i++) {
                    this.particles.push({
                        x: Math.random() * w,
                        y: Math.random() * h,
                        r: 4 + Math.random() * 14,
                        vy: -(0.6 + Math.random() * 1.5),
                        swayAmp: 0.8 + Math.random() * 2,
                        swayFreq: 0.02 + Math.random() * 0.04,
                        phase: Math.random() * Math.PI * 2,
                        alpha: 0.35 + Math.random() * 0.45
                    });
                }
                break;
            }
        }
    }

    update() {
        this.time += 0.03;
        const w = this.width;
        const h = this.height;

        switch (this.theme) {
            case "feuilles":
                this.particles.forEach(p => {
                    p.y += p.speedY;
                    p.x += Math.sin(this.time * p.swayFreq + p.phase) * p.swayAmp;
                    p.angle += p.rotSpeed;
                    if (p.y > h + 30) { p.y = -20; p.x = Math.random() * w; }
                    if (p.x < -30) p.x = w + 20;
                    if (p.x > w + 30) p.x = -20;
                });
                break;

            case "galaxie":
                this.particles.forEach(p => {
                    p.angle += p.baseSpeed;
                });
                break;

            case "meduses":
                this.particles.forEach(p => {
                    p.pulsePhase += p.pulseSpeed;
                    p.y -= p.speedY * (1 + 0.5 * Math.sin(p.pulsePhase));
                    p.x += p.driftX;
                    if (p.y < -50) { p.y = h + 40; p.x = Math.random() * w; }
                    if (p.x < -30) p.x = w + 20;
                    if (p.x > w + 30) p.x = -20;
                });
                break;

            case "orbes":
                this.particles.forEach(p => {
                    p.x += p.vx;
                    p.y += p.vy;
                    if (p.x < -p.r) p.vx = Math.abs(p.vx);
                    if (p.x > w + p.r) p.vx = -Math.abs(p.vx);
                    if (p.y < -p.r) p.vy = Math.abs(p.vy);
                    if (p.y > h + p.r) p.vy = -Math.abs(p.vy);
                });
                break;

            case "particules3d":
                this.particles.forEach(p => {
                    p.pz = p.z;
                    p.z -= p.speed;
                    if (p.z <= 2) {
                        p.z = 700;
                        p.pz = 700;
                        p.x = (Math.random() - 0.5) * 800;
                        p.y = (Math.random() - 0.5) * 800;
                    }
                });
                break;

            case "constellations":
                this.particles.forEach(p => {
                    p.x += p.vx;
                    p.y += p.vy;
                    if (p.x < 0 || p.x > w) p.vx *= -1;
                    if (p.y < 0 || p.y > h) p.vy *= -1;
                });
                break;

            case "fumee":
                this.particles.forEach(p => {
                    p.x += p.vx;
                    p.y += p.vy;
                    p.angle += p.vAngle;
                    if (p.y < -p.r * 1.5) {
                        p.y = h + p.r;
                        p.x = Math.random() * w;
                    }
                });
                break;

            case "bulles":
                this.particles.forEach(p => {
                    p.y += p.vy;
                    p.x += Math.sin(this.time * p.swayFreq + p.phase) * p.swayAmp;
                    if (p.y < -p.r * 2) {
                        p.y = h + p.r;
                        p.x = Math.random() * w;
                    }
                });
                break;

            case "soie":
                break;

            case "points":
                break;
        }
    }

    draw() {
        const ctx = this.ctx;
        if (!ctx) return;
        const w = this.width;
        const h = this.height;

        ctx.clearRect(0, 0, w, h);

        switch (this.theme) {
            case "feuilles": {
                this.particles.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.angle);
                    ctx.globalAlpha = p.alpha;
                    ctx.fillStyle = p.color;

                    ctx.beginPath();
                    ctx.moveTo(0, -p.size);
                    ctx.quadraticCurveTo(p.size * 0.7, 0, 0, p.size);
                    ctx.quadraticCurveTo(-p.size * 0.7, 0, 0, -p.size);
                    ctx.fill();

                    // Nervure centrale
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(0, -p.size * 0.8);
                    ctx.lineTo(0, p.size * 0.8);
                    ctx.stroke();

                    ctx.restore();
                });
                break;
            }

            case "galaxie": {
                const cx = w / 2;
                const cy = h / 2;

                // Halo galactique central
                const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, Math.min(w, h) * 0.45);
                grad.addColorStop(0, "rgba(168, 85, 247, 0.35)");
                grad.addColorStop(0.4, "rgba(59, 130, 246, 0.18)");
                grad.addColorStop(1, "rgba(0, 0, 0, 0)");
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(cx, cy, Math.min(w, h) * 0.45, 0, Math.PI * 2);
                ctx.fill();

                // Étoiles de la galaxie
                this.particles.forEach(p => {
                    const x = cx + Math.cos(p.angle) * p.radius;
                    const y = cy + Math.sin(p.angle) * (p.radius * 0.75); // perspective elliptique
                    const alpha = Math.max(0.15, Math.min(1, p.alpha + Math.sin(this.time * p.twinkleSpeed * 10) * 0.25));

                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = p.color;
                    ctx.beginPath();
                    ctx.arc(x, y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.globalAlpha = 1;
                break;
            }

            case "meduses": {
                this.particles.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    const pulse = 1 + 0.18 * Math.sin(p.pulsePhase);
                    const r = p.radius * pulse;

                    // Cloche bioluminescente
                    const grad = ctx.createRadialGradient(0, -r * 0.3, 2, 0, 0, r);
                    grad.addColorStop(0, "rgba(255, 255, 255, 0.9)");
                    grad.addColorStop(0.5, p.color);
                    grad.addColorStop(1, "rgba(0, 0, 0, 0.1)");
                    ctx.fillStyle = grad;

                    ctx.beginPath();
                    ctx.arc(0, 0, r, Math.PI, 0, false);
                    ctx.quadraticCurveTo(r * 0.4, r * 0.3, 0, r * 0.15);
                    ctx.quadraticCurveTo(-r * 0.4, r * 0.3, -r, 0);
                    ctx.closePath();
                    ctx.fill();

                    // Tentacules ondulantes
                    ctx.strokeStyle = p.color;
                    ctx.lineWidth = 1.2;
                    ctx.globalAlpha = 0.65;
                    const spacing = (r * 1.6) / (p.tentacles + 1);
                    for (let i = 1; i <= p.tentacles; i++) {
                        const tx = -r * 0.8 + spacing * i;
                        ctx.beginPath();
                        ctx.moveTo(tx, r * 0.15);
                        const wave = Math.sin(p.pulsePhase + i) * 6;
                        ctx.bezierCurveTo(
                            tx + wave, r + 10,
                            tx - wave, r + 24,
                            tx + wave * 0.5, r + 40
                        );
                        ctx.stroke();
                    }

                    ctx.restore();
                });
                break;
            }

            case "orbes": {
                this.particles.forEach(p => {
                    const grad = ctx.createRadialGradient(p.x, p.y, p.r * 0.1, p.x, p.y, p.r);
                    grad.addColorStop(0, p.c1);
                    grad.addColorStop(1, p.c2);
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                    ctx.fill();
                });
                break;
            }

            case "particules3d": {
                const cx = w / 2;
                const cy = h / 2;
                const fov = 260;

                this.particles.forEach(p => {
                    const sx = (p.x / p.z) * fov + cx;
                    const sy = (p.y / p.z) * fov + cy;
                    const px = (p.x / p.pz) * fov + cx;
                    const py = (p.y / p.pz) * fov + cy;

                    if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) {
                        const alpha = Math.min(1, (1 - p.z / 700) * 1.4);
                        ctx.strokeStyle = p.color;
                        ctx.globalAlpha = alpha;
                        ctx.lineWidth = Math.max(1, (1 - p.z / 700) * 3);

                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(sx, sy);
                        ctx.stroke();
                    }
                });
                ctx.globalAlpha = 1;
                break;
            }

            case "constellations": {
                // Lignes de connexion
                ctx.lineWidth = 0.8;
                const len = this.particles.length;
                for (let i = 0; i < len; i++) {
                    const pi = this.particles[i];
                    for (let j = i + 1; j < len; j++) {
                        const pj = this.particles[j];
                        const dx = pi.x - pj.x;
                        const dy = pi.y - pj.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < 75) {
                            const alpha = (1 - dist / 75) * 0.45;
                            ctx.strokeStyle = `rgba(168, 85, 247, ${alpha})`;
                            ctx.beginPath();
                            ctx.moveTo(pi.x, pi.y);
                            ctx.lineTo(pj.x, pj.y);
                            ctx.stroke();
                        }
                    }
                }

                // Nœuds
                this.particles.forEach(p => {
                    ctx.fillStyle = p.color;
                    ctx.globalAlpha = 0.85;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.globalAlpha = 1;
                break;
            }

            case "fumee": {
                this.particles.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.angle);

                    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, p.r);
                    grad.addColorStop(0, `rgba(139, 92, 246, ${p.alpha * 1.5})`);
                    grad.addColorStop(0.5, `rgba(59, 130, 246, ${p.alpha * 0.8})`);
                    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
                    ctx.fillStyle = grad;

                    ctx.beginPath();
                    ctx.arc(0, 0, p.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                });
                break;
            }

            case "soie": {
                this.particles.forEach(ribbon => {
                    ctx.fillStyle = ribbon.color;
                    ctx.beginPath();
                    ctx.moveTo(0, h);

                    const baseline = h * 0.5 + Math.sin(this.time * 0.5 + ribbon.offset) * (h * 0.25);
                    for (let x = 0; x <= w + 10; x += 15) {
                        const y = baseline + Math.sin(x * ribbon.freq + this.time * ribbon.speed * 10 + ribbon.offset) * ribbon.amp;
                        if (x === 0) ctx.lineTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.lineTo(w, h);
                    ctx.closePath();
                    ctx.fill();
                });
                break;
            }

            case "points": {
                const cx = w / 2;
                const cy = h / 2;

                this.particles.forEach(p => {
                    const dx = p.gx - cx;
                    const dy = p.gy - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const ripple = Math.sin(dist * 0.04 - this.time * 3);
                    const r = Math.max(0.6, p.baseR + ripple * 1.8);
                    const alpha = Math.max(0.15, 0.45 + ripple * 0.45);

                    ctx.fillStyle = ripple > 0.2 ? "#06b6d4" : "#a855f7";
                    ctx.globalAlpha = alpha;
                    ctx.beginPath();
                    ctx.arc(p.gx, p.gy, r, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.globalAlpha = 1;
                break;
            }

            case "bulles": {
                this.particles.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.globalAlpha = p.alpha;

                    // Bulle avec dégradé iridescent
                    const grad = ctx.createRadialGradient(-p.r * 0.3, -p.r * 0.3, p.r * 0.1, 0, 0, p.r);
                    grad.addColorStop(0, "rgba(255, 255, 255, 0.8)");
                    grad.addColorStop(0.4, "rgba(168, 85, 247, 0.35)");
                    grad.addColorStop(0.8, "rgba(6, 182, 212, 0.45)");
                    grad.addColorStop(1, "rgba(236, 72, 153, 0.3)");
                    ctx.fillStyle = grad;
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
                    ctx.lineWidth = 1;

                    ctx.beginPath();
                    ctx.arc(0, 0, p.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();

                    // Éclat brillant
                    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
                    ctx.beginPath();
                    ctx.arc(-p.r * 0.35, -p.r * 0.35, p.r * 0.25, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.restore();
                });
                ctx.globalAlpha = 1;
                break;
            }
        }
    }
}


    let appBgEngine = null;
    let previewBgEngine = null;

    // Valeurs connues seulement : un loader_style / animated_bg abîmé en base retombe sur la valeur par défaut
    const LOADER_STYLES = ["mosaique", "hyperespace", "piece3d", "orbite", "portail", "hologramme", "eventail", "diaphragme", "portes", "pulsation", "goutte", "glitch", "projecteur"];
    const BG_THEMES = ["feuilles", "galaxie", "meduses", "orbes", "particules3d", "constellations", "fumee", "soie", "points", "bulles"];

    function safeLoaderName(name) {
        return LOADER_STYLES.includes(name) ? name : "projecteur";
    }

    function safeBgName(name) {
        return BG_THEMES.includes(name) ? name : "fumee";
    }

    // Un fond animé ne tourne que s'il est visible : pas en arrière-plan, ni sous le panel admin ou la fiche
    // produit (plein écran, opaques). L'aperçu ne tourne que modale ouverte : jamais deux boucles à la fois.
    function syncBgAnimation() {
        const hidden = document.hidden;
        if (appBgEngine) {
            const covered = isShown(document.getElementById("admin-overlay")) || document.body.classList.contains("detail-open");
            if (hidden || covered) appBgEngine.stop();
            else appBgEngine.start();
        }
        if (previewBgEngine) {
            if (hidden || !isShown(document.getElementById("gst-modal-animated-bg"))) previewBgEngine.stop();
            else previewBgEngine.start();
        }
    }

    // ===== MODALES: LOADER ET FOND =====
    function openLoaderModal() {
        const modal = document.getElementById("gst-modal-intro-loader");
        if (!modal) return;
        modal.style.display = "flex";
        selectLoaderChoice(adState.settingsSaved.loader_style || adState.selectedLoader);
    }

    // Fermer sans confirmer : le choix revient au loader enregistré
    function closeLoaderModal() {
        const modal = document.getElementById("gst-modal-intro-loader");
        if (modal) modal.style.display = "none";
        adState.selectedLoader = safeLoaderName(adState.settingsSaved.loader_style || adState.selectedLoader);
    }

    function selectLoaderChoice(loaderName) {
        const name = safeLoaderName(loaderName);
        adState.selectedLoader = name;
        document.querySelectorAll("#gst-modal-intro-loader .gst-choice-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.loader === name);
        });
        const target = document.getElementById("gst-loader-anim-target");
        if (target) {
            target.className = "gst-loader-anim-target";
            void target.offsetWidth; // force reflow
            target.classList.add("anim-" + name);
        }
    }

    function applyStoreIntroLoader(loaderName) {
        const name = safeLoaderName(loaderName);
        adState.selectedLoader = name;
        const introLogo = document.querySelector(".intro-logo");
        // Loader déjà posé (par willy.py ou un appel précédent) : rien à changer, l'animation ne redémarre pas
        if (introLogo && !introLogo.classList.contains("anim-" + name)) {
            Array.from(introLogo.classList).forEach(c => {
                if (c.startsWith("anim-")) introLogo.classList.remove(c);
            });
            introLogo.classList.add("anim-" + name);
        }
    }

    function openAnimatedBgModal() {
        const modal = document.getElementById("gst-modal-animated-bg");
        if (!modal) return;
        modal.style.display = "flex";
        const curBg = safeBgName(adState.settingsSaved.animated_bg || adState.selectedBg);
        adState.selectedBg = curBg;
        document.querySelectorAll("#gst-modal-animated-bg .gst-choice-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.bg === curBg);
        });

        // Moteur de l'aperçu sur le canvas de la maquette (mesuré une fois la modale affichée)
        const prevCanvas = document.getElementById("gst-bg-canvas");
        if (prevCanvas) {
            if (!previewBgEngine) {
                previewBgEngine = new CanvasBackgroundEngine(prevCanvas, curBg);
            } else {
                previewBgEngine.resize();
                previewBgEngine.setTheme(curBg);
            }
            syncBgAnimation();
        }
    }

    // Fermer sans confirmer : le choix revient au fond enregistré
    function closeAnimatedBgModal() {
        const modal = document.getElementById("gst-modal-animated-bg");
        if (modal) modal.style.display = "none";
        adState.selectedBg = safeBgName(adState.settingsSaved.animated_bg || adState.selectedBg);
        syncBgAnimation();
    }

    function selectAnimatedBgChoice(bgName) {
        const name = safeBgName(bgName);
        adState.selectedBg = name;
        document.querySelectorAll("#gst-modal-animated-bg .gst-choice-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.bg === name);
        });
        if (previewBgEngine) {
            previewBgEngine.setTheme(name);
        }
    }

    function applyStoreAnimatedBg(bgName) {
        const name = safeBgName(bgName);
        adState.selectedBg = name;
        const appCanvas = document.getElementById("app-animated-bg-canvas");
        if (appCanvas) {
            if (!appBgEngine) {
                appBgEngine = new CanvasBackgroundEngine(appCanvas, name);
            } else if (appBgEngine.theme !== name) {
                appBgEngine.setTheme(name);
            }
            syncBgAnimation();
        }
    }

    // ===== ONGLET 2: /START MESSAGE & INLINE BUTTONS =====
    // Ce que le bot envoie vraiment (willy.py start()) : welcome_message en Markdown (sinon son message par défaut),
    // welcome_photo (sinon sa photo par défaut) et, sous ses boutons, une ligne par bouton de start_buttons [{text, url}].
    // Rien ne part avant « Enregistrer » ; seules les clés modifiées sont envoyées à /admin/contact/save.
    const START_BUTTONS_MAX = 6;
    const START_BUTTON_URL_RE = /^(https|tg):\/\/\S+$/i;
    const START_FORMATS = { b: ["*", "*"], i: ["_", "_"], code: ["`", "`"], link: ["[", "](https://t.me/...)"] };

    function startTextarea() {
        return document.getElementById("gst-start-welcome-textarea");
    }

    // start_buttons enregistré (JSON) → [{text, url}] ; ancien format du panel {label, url} accepté
    function parseStartButtons(raw) {
        try {
            const list = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : [];
            return Array.isArray(list)
                ? list.filter((b) => b && typeof b === "object").map((b) => ({ text: String(b.text || b.label || ""), url: String(b.url || "") }))
                : [];
        } catch (_) {
            return [];
        }
    }

    // Boutons tels qu'ils seront enregistrés : lignes entièrement vides ignorées, textes et liens sans espaces autour
    function startButtonsForSave() {
        return adState.startKeyboardRows
            .map((b) => ({ text: String(b.text || "").trim(), url: String(b.url || "").trim() }))
            .filter((b) => b.text || b.url);
    }

    function startButtonsError(buttons) {
        if (buttons.length > START_BUTTONS_MAX) return `${START_BUTTONS_MAX} boutons maximum sous /start.`;
        for (let i = 0; i < buttons.length; i++) {
            const b = buttons[i];
            if (!b.text || b.text.length > 64) return `Bouton ${i + 1} : texte obligatoire (64 caractères max).`;
            if (b.url.length > 512 || !START_BUTTON_URL_RE.test(b.url)) return `Bouton « ${b.text} » : le lien doit commencer par https:// ou tg://`;
        }
        return "";
    }

    // Clés à envoyer : seulement celles qui diffèrent de ce qui est enregistré
    function startChanges() {
        const saved = adState.startSaved;
        if (!saved) return {};
        const changes = {};
        const textarea = startTextarea();
        const msg = textarea ? textarea.value.trim() : saved.welcome_message;
        if (msg !== saved.welcome_message) changes.welcome_message = msg;
        if (adState.startPhoto !== saved.welcome_photo) changes.welcome_photo = adState.startPhoto;
        const buttons = JSON.stringify(startButtonsForSave());
        if (buttons !== saved.start_buttons) changes.start_buttons = buttons;
        return changes;
    }

    function renderStartStatus() {
        const saved = adState.startSaved;
        const dirty = Object.keys(startChanges()).length > 0;
        const statusEl = document.getElementById("gst-start-save-status");
        if (statusEl) {
            statusEl.textContent = !saved ? "" : dirty ? "● Modifications non enregistrées" : "✓ Enregistré";
            statusEl.classList.toggle("is-dirty", dirty);
        }
        const saveBtn = document.getElementById("gst-btn-save-start");
        if (saveBtn) saveBtn.disabled = !saved || adState.startUploading;
        const msgStatus = document.getElementById("gst-start-msg-status");
        if (msgStatus && saved) {
            msgStatus.textContent = saved.welcome_message
                ? "Message personnalisé : c'est ce texte que le bot envoie à chaque /start."
                : "Aucun message personnalisé : le bot envoie son message d'accueil par défaut (bienvenue et invitation à commander ou à nous contacter). Écris ici pour le remplacer.";
        }
        const textarea = startTextarea();
        const countEl = document.getElementById("gst-start-msg-count");
        if (countEl && textarea) countEl.textContent = `${textarea.value.length}/1000`;
        const preview = document.getElementById("gst-start-preview-box");
        if (preview && isShown(preview)) renderStartPreview();
    }

    function warnUnsavedStart() {
        if (Object.keys(startChanges()).length) showToast("Message /start : modifications pas encore enregistrées.", "info");
    }

    // Valeurs enregistrées → éditeur (texte, photo, boutons)
    function fillStartEditor(adminCfg) {
        const msg = typeof adminCfg.welcome_message === "string" ? adminCfg.welcome_message.trim() : "";
        const photo = typeof adminCfg.welcome_photo === "string" ? adminCfg.welcome_photo.trim() : "";
        const buttons = parseStartButtons(adminCfg.start_buttons);
        adState.startSaved = { welcome_message: msg, welcome_photo: photo, start_buttons: JSON.stringify(buttons) };
        adState.startPhoto = photo;
        adState.startKeyboardRows = buttons;
        const textarea = startTextarea();
        if (textarea) textarea.value = msg;
        renderStartPhoto();
        renderStartButtonsBuilder();
        renderStartStatus();
    }

    // Relu à chaque ouverture de l'onglet ; des modifications pas encore enregistrées restent dans l'éditeur
    async function loadAdminStartData() {
        renderStartStatus();
        const res = await adminRequest("/admin/config");
        if (!res.ok || !res.data.config) {
            const msgStatus = document.getElementById("gst-start-msg-status");
            if (msgStatus && !adState.startSaved) msgStatus.textContent = res.error || "Message actuel du bot indisponible, réessaie.";
            showToast(res.error || "Message /start indisponible, réessaie.", "error");
            return;
        }
        if (adState.startSaved && Object.keys(startChanges()).length) return;
        fillStartEditor(res.data.config.admin || {});
    }

    function renderStartPhoto() {
        const img = document.getElementById("gst-start-photo-preview");
        const empty = document.getElementById("gst-start-photo-empty");
        const clearBtn = document.getElementById("gst-start-photo-clear-btn");
        if (!img || !empty) return;
        const src = adState.startPhoto ? safeMediaUrl(resolveMediaUrl(adState.startPhoto, "image")) : "";
        if (clearBtn) clearBtn.disabled = !adState.startPhoto;
        if (!src) {
            img.removeAttribute("src");
            img.style.display = "none";
            empty.textContent = adState.startPhoto
                ? "Photo enregistrée illisible : le bot envoie sa photo par défaut."
                : "Aucune photo choisie : le bot envoie sa photo par défaut.";
            empty.style.display = "";
            return;
        }
        // Fichier supprimé du serveur : le bot reprend lui aussi sa photo par défaut
        img.onerror = () => {
            img.style.display = "none";
            empty.textContent = "Photo introuvable sur le serveur : le bot envoie sa photo par défaut.";
            empty.style.display = "";
        };
        img.src = src;
        img.style.display = "";
        empty.style.display = "none";
    }

    function bindStartPhotoUpload() {
        const input = document.getElementById("gst-start-photo-input");
        if (!input) return;
        input.addEventListener("change", async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            // Telegram n'affiche pas le HEIC (refusé par isFileOfKind) : seules les photos JPG, PNG, WEBP ou GIF partent
            if (!isFileOfKind(file, "image")) {
                this.value = "";
                showToast("Choisis une photo JPG, PNG ou WEBP.", "error");
                return;
            }
            adState.startUploading = true;
            setUploadBusy(this, true);
            renderStartStatus();
            showToast("Envoi de la photo… ⏳", "info");
            try {
                const path = uploadedPath(await uploadMediaFile(file, (percent) => showToast(`Envoi : ${percent}%`, "info")));
                if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
                adState.startPhoto = path;
                renderStartPhoto();
                showToast("Photo prête : appuie sur « Enregistrer » pour l'utiliser dans /start.", "info");
            } catch (err) {
                showToast(err.message, "error");
            } finally {
                adState.startUploading = false;
                setUploadBusy(this, false);
                renderStartStatus();
            }
        });
    }

    function renderStartButtonsBuilder() {
        const container = document.getElementById("gst-kb-builder-list");
        if (!container) return;
        const addBtn = document.getElementById("gst-add-start-row-btn");
        if (addBtn) addBtn.disabled = adState.startKeyboardRows.length >= START_BUTTONS_MAX;
        if (!adState.startKeyboardRows.length) {
            container.innerHTML = `<div class="gst-empty-placeholder">Aucun bouton ajouté : /start garde seulement ses boutons habituels.</div>`;
            return;
        }
        container.innerHTML = adState.startKeyboardRows.map((b, idx) => `
            <div class="gst-start-btn-row">
                <input type="text" class="gst-input-sm" data-btn-idx="${idx}" data-field="text" maxlength="64" value="${escapeHtml(b.text)}" placeholder="Texte du bouton" autocomplete="off">
                <input type="url" class="gst-input-sm" data-btn-idx="${idx}" data-field="url" maxlength="512" value="${escapeHtml(b.url)}" placeholder="https://… ou tg://…" inputmode="url" autocomplete="off">
                <button type="button" class="gst-btn-remove-sm" data-delete-btn-idx="${idx}" aria-label="Retirer ce bouton">✕</button>
            </div>
        `).join("");

        container.querySelectorAll("[data-field]").forEach(input => {
            input.addEventListener("input", (e) => {
                const row = adState.startKeyboardRows[Number(e.target.dataset.btnIdx)];
                if (row) row[e.target.dataset.field] = e.target.value;
                renderStartStatus();
            });
        });

        container.querySelectorAll("[data-delete-btn-idx]").forEach(btn => {
            btn.addEventListener("click", () => {
                adState.startKeyboardRows.splice(Number(btn.dataset.deleteBtnIdx), 1);
                renderStartButtonsBuilder();
                renderStartStatus();
            });
        });
    }

    // Mise en forme Markdown, celle que le bot utilise pour le message de /start (parse_mode « Markdown »)
    function applyTelegramFormat(cmd) {
        const textarea = startTextarea();
        const marks = START_FORMATS[cmd];
        if (!textarea || !marks) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = textarea.value.substring(start, end) || "texte";
        textarea.setRangeText(`${marks[0]}${selected}${marks[1]}`, start, end, "select");
        textarea.focus();
        renderStartStatus();
    }

    // Aperçu approximatif du message (mise en forme Markdown) et des boutons, sans aucun lien cliquable
    function renderStartPreview() {
        const box = document.getElementById("gst-start-preview-box");
        const textarea = startTextarea();
        if (!box || !textarea) return;
        const msg = textarea.value.trim();
        const escaped = msg.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
        const html = escaped
            .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="gst-preview-link">$1</span>')
            .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
            .replace(/_([^_\n]+)_/g, "<i>$1</i>")
            .replace(/`([^`\n]+)`/g, "<code>$1</code>");
        const buttons = ["📢 Canal Officiel · 💬 Nous contacter", "📖 VOIR LA CARTE 📖"]
            .concat(startButtonsForSave().map((b) => b.text || "(sans texte)"))
            .map((label) => `<div class="gst-start-preview-btn">${escapeHtml(label)}</div>`).join("");
        box.innerHTML = `${msg ? html : "<i>Message d'accueil par défaut du bot</i>"}<div class="gst-start-preview-btns">${buttons}</div>`;
    }

    async function adminSaveStartConfig() {
        if (!adState.startSaved) {
            showToast("Message /start pas encore chargé, réessaie.", "error");
            return;
        }
        if (adState.startUploading) {
            showToast("Attends la fin de l'envoi de la photo.", "info");
            return;
        }
        const buttonsError = startButtonsError(startButtonsForSave());
        if (buttonsError) {
            showStartSubpane("btns");
            showToast(buttonsError, "error");
            return;
        }
        const changes = startChanges();
        if (!Object.keys(changes).length) {
            showToast("Aucune modification à enregistrer.", "info");
            return;
        }
        const saveBtn = document.getElementById("gst-btn-save-start");
        if (saveBtn) saveBtn.disabled = true;
        const ok = await saveAdminSettings(changes, "contact");
        if (ok) {
            Object.assign(adState.startSaved, changes);
            showToast("Message /start enregistré ! 👋");
        }
        renderStartStatus();
    }

    // ===== ONGLET 3: PRODUITS CATALOGUE & ASSISTANT 3 ÉTAPES =====
    async function loadAdminProductsData() {
        // catalogue : villes et likes (GET /admin/catalogue) chargés en même temps ; /config donne à un admin
        // le catalogue complet, jamais réduit à la ville qu'il a choisie dans sa boutique
        const catalogueLoad = loadCataloguePanel();
        await loadConfig();
        const cfg = state.config || {};
        adState.activeProducts = allProductsFromConfig(cfg);
        fillCatalogueProductSettings(cfg.admin || {}); // catalogue : promotion globale et compteur de likes
        filterAndRenderProducts();
        renderAdminCategories();
        await catalogueLoad;
    }

    function findAdminProduct(pid) {
        return adState.activeProducts.find((p) => String(p.id) === String(pid)) || null;
    }

    // Produit tel que /admin/products/save l'enregistre : tous les champs stockés, rien d'autre.
    // Sert aux changements rapides (stock) : le produit repart intact, seul overrides change.
    function productPayload(p, overrides) {
        return Object.assign({
            id: p.id,
            category: p.category,
            name: p.name || "",
            description: p.description || "",
            price: toPrice(p.price),
            emoji: p.emoji || "📦",
            image: p.image || "",
            video: p.video || "",
            isNew: Boolean(p.isNew),
            isPromo: Boolean(p.isPromo),
            inStock: p.inStock !== false,
            customPrices: p.customPrices && typeof p.customPrices === "object" ? p.customPrices : {}
        }, overrides || {});
    }

    // Prix de la carte admin : prix unique, ou nombre de paliers et prix de départ
    function adminPriceSummary(p) {
        const tiers = getQtyEntries(p, "delivery").filter((e) => e.tier).length;
        return tiers ? `${tiers} palier${tiers > 1 ? "s" : ""} · dès ${formatPrice(getStartingPrice(p))}` : formatPrice(p.price || 0);
    }

    // Puces de filtre de l'onglet Produits alignées sur adState.productsFilter (« Rupture » = filtre "out")
    function syncProductFilterChips() {
        const current = adState.productsFilter;
        document.querySelectorAll("#gst-pane-produits .gst-filter-chips-row .gst-filter-chip").forEach((chip) => {
            const f = chip.dataset.filter === "rupture" ? "out" : chip.dataset.filter;
            chip.classList.toggle("active", f === current);
        });
    }

    function filterAndRenderProducts() {
        const listContainer = document.getElementById("gst-prods-list-container") || document.getElementById("gst-products-list-container");
        if (!listContainer) return;
        let prods = [...adState.activeProducts];

        // 1. Recherche texte
        const search = (adState.productsSearch || "").toLowerCase().trim();
        if (search) {
            prods = prods.filter(p =>
                (p.name || "").toLowerCase().includes(search) ||
                (p.description || "").toLowerCase().includes(search) ||
                (p.category || "").toLowerCase().includes(search)
            );
        }

        // catalogue : filtre « par ville » (produits proposés dans la ville choisie, y compris ceux proposés partout)
        prods = prods.filter(catalogueAdminCityMatch);

        // 2. Filtres puces
        if (adState.productsFilter === "stock") prods = prods.filter(p => p.inStock !== false);
        else if (adState.productsFilter === "out" || adState.productsFilter === "rupture") prods = prods.filter(p => p.inStock === false);
        else if (adState.productsFilter === "promo") prods = prods.filter(p => Boolean(p.isPromo));
        else if (adState.productsFilter === "new") prods = prods.filter(p => Boolean(p.isNew));

        // 3. Tri (« Manuel » = ordre de la boutique)
        if (adState.productsSort === "alpha" || adState.productsSort === "az") {
            prods.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        } else if (adState.productsSort === "za") {
            prods.sort((a, b) => (b.name || "").localeCompare(a.name || ""));
        } else if (adState.productsSort === "price-asc") {
            prods.sort((a, b) => getStartingPrice(a) - getStartingPrice(b));
        } else if (adState.productsSort === "price-desc") {
            prods.sort((a, b) => getStartingPrice(b) - getStartingPrice(a));
        } else if (adState.productsSort === "recent") {
            prods.sort((a, b) => (b.id || 0) - (a.id || 0));
        }
        const manualOrder = !["alpha", "az", "za", "price-asc", "price-desc", "recent"].includes(adState.productsSort);

        // 4. Mise à jour des 4 Cartes Stats
        const total = adState.activeProducts.length;
        const inStockCount = adState.activeProducts.filter(p => p.inStock !== false).length;
        const outStockCount = total - inStockCount;
        const promoCount = adState.activeProducts.filter(p => Boolean(p.isPromo)).length;
        const totalStockVal = adState.activeProducts.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

        const stTotal = document.getElementById("gst-prods-count-total") || document.getElementById("gst-stat-prods-total");
        if (stTotal) stTotal.textContent = total;
        const stStock = document.getElementById("gst-prods-count-stock") || document.getElementById("gst-stat-prods-stock");
        if (stStock) stStock.textContent = inStockCount;
        const stOut = document.getElementById("gst-prods-count-rupture") || document.getElementById("gst-stat-prods-out");
        if (stOut) stOut.textContent = outStockCount;
        const stPromo = document.getElementById("gst-prods-count-promo") || document.getElementById("gst-stat-prods-promo");
        if (stPromo) stPromo.textContent = promoCount;
        const stVal = document.getElementById("gst-stat-prods-value");
        if (stVal) stVal.textContent = `${totalStockVal.toFixed(0)}€`;

        // 5. Rendu des cartes produits
        if (!prods.length) {
            listContainer.innerHTML = `<div class="gst-empty-placeholder">Aucun produit ne correspond à ces critères.</div>`;
            return;
        }

        // Position de chaque produit dans sa catégorie (▲ ▼ : ordre de la boutique, seulement en tri « Manuel »)
        const orderByCat = {};
        adState.activeProducts.forEach((p) => {
            (orderByCat[p.category] = orderByCat[p.category] || []).push(String(p.id));
        });

        listContainer.innerHTML = prods.map(p => {
            const thumbImg = safeMediaUrl(resolveMediaUrl(p.image, "image"));
            const thumbVid = safeMediaUrl(resolveMediaUrl(p.video, "video"));
            // Vidéo seule : première image (#t=0.1, preload=metadata, playsinline), sinon l'iPhone affiche un carré vide
            const thumb = thumbImg
                ? `<img class="gst-prod-card-thumb" src="${thumbImg}" alt="" loading="lazy" onerror="this.src='logo.png'">`
                : (thumbVid
                    ? `<video class="gst-prod-card-thumb" src="${thumbVid}#t=0.1" muted playsinline webkit-playsinline preload="metadata" aria-hidden="true"></video>`
                    : `<div class="gst-prod-card-thumb gst-prod-card-thumb-emoji">${escapeHtml(String(p.emoji || "📦"))}</div>`);
            const inStock = p.inStock !== false;
            const pid = escapeHtml(String(p.id));
            const catKey = escapeHtml(String(p.category || ""));
            const cat = getCategoryMeta(p.category);
            const siblings = orderByCat[p.category] || [];
            const pos = siblings.indexOf(String(p.id));
            const reorder = manualOrder ? `
                        <div class="gst-prod-reorder">
                            <button type="button" class="gst-prod-reorder-btn" data-reorder="up" data-pid="${pid}" data-cat="${catKey}" aria-label="Monter" ${pos <= 0 ? "disabled" : ""}>▲</button>
                            <button type="button" class="gst-prod-reorder-btn" data-reorder="down" data-pid="${pid}" data-cat="${catKey}" aria-label="Descendre" ${pos < 0 || pos >= siblings.length - 1 ? "disabled" : ""}>▼</button>
                        </div>` : "";

            return `
                <div class="gst-prod-card${inStock ? "" : " is-out"}" data-pid="${pid}">
                    <div class="gst-prod-card-top">
                        ${thumb}
                        <div class="gst-prod-card-info">
                            <div class="gst-prod-card-title">${escapeHtml(String(p.name || "Produit"))}</div>
                            <div class="gst-prod-card-cat">${escapeHtml(String(cat.emoji || "📦"))} ${escapeHtml(String(cat.name || p.category || ""))} · ${escapeHtml(adminPriceSummary(p))}</div>
                            <div class="gst-prod-badges-row">
                                <button type="button" class="gst-badge-status ${inStock ? 'in-stock' : 'out-stock'}" data-toggle-stock="${pid}" title="Changer le stock">
                                    ${inStock ? '● En stock' : '○ Épuisé'}
                                </button>
                                ${p.isPromo ? '<span class="gst-badge-promo">Promo</span>' : ''}
                                ${p.isNew ? '<span class="gst-badge-new">Nouveau</span>' : ''}
                                ${catalogueAdminProductBadges(p)}
                            </div>
                        </div>${reorder}
                    </div>
                    <div class="gst-prod-card-actions">
                        <button type="button" class="gst-prod-btn-action" data-action="edit" data-pid="${pid}">✏️ Modifier</button>
                        <button type="button" class="gst-prod-btn-action" data-action="duplicate" data-pid="${pid}">📋 Dupliquer</button>
                        <button type="button" class="gst-prod-btn-action danger" data-action="delete" data-pid="${pid}">🗑️ Supprimer</button>
                    </div>
                </div>
            `;
        }).join("");

        // Badge En stock / Épuisé : le produit est renvoyé intact, seul inStock change
        listContainer.querySelectorAll("[data-toggle-stock]").forEach(badge => {
            badge.addEventListener("click", async (e) => {
                e.stopPropagation();
                const targetProd = findAdminProduct(badge.dataset.toggleStock);
                if (!targetProd) return;
                const nextStock = targetProd.inStock === false;
                badge.disabled = true;
                await adminSaveProductDirect(productPayload(targetProd, { inStock: nextStock }), nextStock ? "Produit remis en stock ✅" : "Produit marqué épuisé ⛔");
                badge.disabled = false;
            });
        });

        // ▲ ▼ : un déplacement à la fois, la liste est redessinée avec la config renvoyée
        listContainer.querySelectorAll("[data-reorder]").forEach(btn => {
            btn.addEventListener("click", async () => {
                listContainer.querySelectorAll("[data-reorder]").forEach((b) => { b.disabled = true; });
                if (!await adminReorderProduct(btn.dataset.cat, btn.dataset.pid, btn.dataset.reorder)) filterAndRenderProducts();
            });
        });

        // Actions Modifier / Dupliquer / Supprimer
        listContainer.querySelectorAll("[data-action]").forEach(btn => {
            btn.addEventListener("click", () => {
                const action = btn.dataset.action;
                const targetProd = findAdminProduct(btn.dataset.pid);
                if (!targetProd) return;

                if (action === "edit") {
                    openProductWizard(targetProd);
                } else if (action === "duplicate") {
                    openProductWizard({ ...targetProd, id: null, name: `${targetProd.name || ""} (copie)` });
                } else if (action === "delete") {
                    showConfirmModal({
                        title: "Supprimer le produit ?",
                        emoji: "🗑️",
                        message: `Supprimer définitivement <strong>« ${escapeHtml(String(targetProd.name || ''))} »</strong> ?`,
                        confirmText: "Oui, supprimer",
                        cancelText: "Annuler",
                        isDanger: true,
                        onConfirm: () => adminDeleteProductDirect(targetProd.id)
                    });
                }
            });
        });
    }

    // true seulement si le serveur a confirmé ; la config renvoyée rafraîchit boutique et liste admin
    async function adminSaveProductDirect(productData, successMsg = "Produit sauvegardé ! 📦") {
        const res = await adminRequest("/admin/products/save", { product: productData });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else await loadAdminProductsData();
        showToast(successMsg);
        return true;
    }

    async function adminDeleteProductDirect(productId) {
        const res = await adminRequest("/admin/products/delete", { product_id: String(productId) });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else await loadAdminProductsData();
        showToast("Produit supprimé ! 🗑️");
        return true;
    }

    // Monte ou descend un produit d'une place dans sa catégorie (ordre de la boutique)
    async function adminReorderProduct(category, productId, direction) {
        const res = await adminRequest("/admin/products/reorder", { category, product_id: String(productId), direction });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else await loadAdminProductsData();
        showToast("Ordre mis à jour ↕️");
        return true;
    }

    // ===== CATÉGORIES (carte de l'onglet Produits) =====
    function renderAdminCategories() {
        const list = document.getElementById("gst-cat-list");
        if (!list) return;
        const cfg = state.config || {};
        const cats = Object.entries(cfg.categories || {});
        const products = cfg.products || {};
        const countEl = document.getElementById("gst-cat-count");
        if (countEl) countEl.textContent = String(cats.length);
        if (!cats.length) {
            list.innerHTML = `<div class="gst-empty-placeholder">Aucune catégorie : crée la première avec « + Nouvelle ».</div>`;
            return;
        }
        list.innerHTML = cats.map(([key, c]) => {
            const count = (products[key] || []).length;
            const k = escapeHtml(key);
            return `
                <div class="gst-cat-row">
                    <span class="gst-cat-emoji">${escapeHtml(String(c.emoji || "📦"))}</span>
                    <div class="gst-cat-info">
                        <div class="gst-cat-name">${escapeHtml(String(c.name || key))}</div>
                        <div class="gst-cat-meta">${count} produit${count > 1 ? "s" : ""}${c.description ? ` · ${escapeHtml(String(c.description))}` : ""}</div>
                    </div>
                    <button type="button" class="gst-btn-secondary-sm" data-cat-edit="${k}">✏️ Modifier</button>
                    <button type="button" class="gst-btn-danger-sm" data-cat-delete="${k}" aria-label="Supprimer la catégorie">🗑️</button>
                </div>
            `;
        }).join("");

        list.querySelectorAll("[data-cat-edit]").forEach((btn) => {
            btn.addEventListener("click", () => openCategoryForm(btn.dataset.catEdit));
        });
        list.querySelectorAll("[data-cat-delete]").forEach((btn) => {
            btn.addEventListener("click", () => confirmDeleteCategory(btn.dataset.catDelete));
        });
    }

    // Formulaire de la carte Catégories : key = catégorie modifiée, rien = nouvelle catégorie
    function openCategoryForm(key) {
        const cats = (state.config && state.config.categories) || {};
        const cat = key ? cats[key] : null;
        if (key && !cat) return;
        adState.editingCategoryKey = key || null;
        const form = document.getElementById("gst-cat-form");
        if (!form) return;
        document.getElementById("gst-cat-form-title").textContent = cat ? "Modifier la catégorie" : "Nouvelle catégorie";
        document.getElementById("gst-cat-name").value = cat ? String(cat.name || "") : "";
        document.getElementById("gst-cat-emoji").value = cat ? String(cat.emoji || "📦") : "📦";
        document.getElementById("gst-cat-desc").value = cat ? String(cat.description || "") : "";
        document.getElementById("gst-cat-save-btn").textContent = cat ? "Enregistrer" : "Ajouter la catégorie";
        form.style.display = "flex";
        form.scrollIntoView({ behavior: "smooth", block: "nearest" });
        document.getElementById("gst-cat-name").focus();
    }

    function closeCategoryForm() {
        const form = document.getElementById("gst-cat-form");
        if (form) form.style.display = "none";
        adState.editingCategoryKey = null;
    }

    // Clé d'une nouvelle catégorie (comme le serveur : a-z, 0-9, _ ; 30 caractères max), jamais celle d'une existante
    function uniqueCategoryKey(name) {
        const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "categorie";
        const existing = (state.config && state.config.categories) || {};
        let candidate = base;
        for (let n = 2; Object.prototype.hasOwnProperty.call(existing, candidate); n++) {
            const suffix = `_${n}`;
            candidate = `${base.slice(0, 30 - suffix.length)}${suffix}`;
        }
        return candidate;
    }

    async function saveCategoryForm() {
        const name = document.getElementById("gst-cat-name").value.trim();
        if (!name) {
            showToast("Le nom de la catégorie est obligatoire.", "error");
            return;
        }
        const editing = adState.editingCategoryKey;
        const saveBtn = document.getElementById("gst-cat-save-btn");
        saveBtn.disabled = true;
        const res = await adminRequest("/admin/categories/save", {
            key: editing || uniqueCategoryKey(name),
            name,
            emoji: document.getElementById("gst-cat-emoji").value.trim() || "📦",
            description: document.getElementById("gst-cat-desc").value.trim()
        });
        saveBtn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        closeCategoryForm();
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else await loadAdminProductsData();
        renderAdminCategories();
        showToast(editing ? "Catégorie modifiée ! 📁" : "Catégorie ajoutée ! 📁");
    }

    function confirmDeleteCategory(key) {
        const cfg = state.config || {};
        const cat = (cfg.categories || {})[key];
        if (!cat) return;
        const count = ((cfg.products || {})[key] || []).length;
        const catName = escapeHtml(String(cat.name || key));
        showConfirmModal({
            title: "Supprimer la catégorie ?",
            emoji: "🗑️",
            message: count > 0
                ? `Supprimer définitivement la catégorie <strong>« ${catName} »</strong> <strong>et ses ${count} produit${count > 1 ? "s" : ""}</strong> ?`
                : `Supprimer définitivement la catégorie <strong>« ${catName} »</strong> ?`,
            confirmText: "Oui, supprimer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: () => adminDeleteCategory(key)
        });
    }

    async function adminDeleteCategory(key) {
        const res = await adminRequest("/admin/categories/delete", { key });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (adState.editingCategoryKey === key) closeCategoryForm();
        if (res.data.config) applyUpdatedConfig(res.data.config);
        else await loadAdminProductsData();
        renderAdminCategories();
        showToast("Catégorie supprimée ! 🗑️");
        return true;
    }

    // ===== ASSISTANT PRODUIT 3 ÉTAPES (WIZARD) =====
    // Montant ou quantité saisi au clavier (« 4,5 » accepté) ; NaN si vide ou invalide
    function parseAmount(value) {
        const s = String(value == null ? "" : value).trim().replace(",", ".");
        return /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : NaN;
    }

    // Comme uploaded_media_path de willy.py : "" ou /uploads/<fichier> (ancien lien absolu du tunnel ramené
    // à /uploads/) ; null pour tout le reste, que les deux serveurs refusent
    const PRODUCT_MEDIA_NAME_RE = /^[a-zA-Z0-9_\-.]+\.(?:png|jpe?g|gif|webp|heic|heif|mp4|mov|avi|webm|m4v|mkv|3gp|mp3|m4a|aac|wav|ogg)$/i;

    function productMediaPath(value) {
        const v = String(value || "").trim().replace(/^https?:\/\/[^\/]*(?:ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i, "/uploads/");
        if (!v) return "";
        return v.startsWith("/uploads/") && PRODUCT_MEDIA_NAME_RE.test(v.slice("/uploads/".length)) ? v : null;
    }

    // Chaque ouverture du formulaire est une session : fermer ou rouvrir annule l'envoi de fichier en cours,
    // et un envoi d'une session précédente n'est jamais rattaché au produit ouvert ensuite
    function resetWizardSession() {
        if (adState.wizardUploads) adState.wizardUploads.abort();
        adState.wizardUploads = typeof AbortController !== "undefined" ? new AbortController() : null;
        adState.wizardSession += 1;
        const dialog = document.querySelector("#gst-modal-product-wizard .gst-modal-dialog");
        if (dialog) dialog.dataset.pendingUploads = "0";
        ["pw-image-file-input", "pw-video-file-input"].forEach((id) => {
            const input = document.getElementById(id);
            if (input) {
                input.disabled = false;
                input.value = "";
            }
        });
        const saveBtn = document.getElementById("pw-save-btn");
        if (saveBtn) saveBtn.disabled = false;
    }

    // Paliers du produit → lignes du tableau (prix seul ou { delivery, pickup, unit }) ; sans palier : aucune ligne
    function wizardRowsFromProduct(product) {
        const cp = product && product.customPrices && typeof product.customPrices === "object" ? product.customPrices : {};
        return Object.entries(cp).map(([qty, value]) => {
            const isObj = value !== null && typeof value === "object";
            const delivery = isObj ? value.delivery : value;
            const pickup = isObj && toPrice(value.pickup) > 0 && toPrice(value.pickup) !== toPrice(value.delivery) ? value.pickup : "";
            return {
                qty: String(qty),
                unit: tierUnit(value),
                delivery: delivery === undefined || delivery === null ? "" : String(delivery),
                pickup: String(pickup),
                orig: isObj ? value : null
            };
        });
    }

    function openProductWizard(product = null) {
        const modal = document.getElementById("gst-modal-product-wizard");
        if (!modal) return;
        const cats = (state.config && state.config.categories) || {};
        if (!Object.keys(cats).length) {
            showToast("Crée d'abord une catégorie (Catalogue › Catégories).", "error");
            return;
        }
        resetWizardSession();
        adState.wizardStep = 1;
        adState.wizardEditingProduct = product;
        modal.style.display = "flex";

        const titleEl = document.getElementById("gst-wizard-modal-title");
        if (titleEl) titleEl.textContent = product && product.id ? "Modifier le produit" : (product ? "Dupliquer le produit" : "Nouveau produit");

        const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.value = v;
        };
        const setChecked = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.checked = v;
        };

        // Étape 1 : Informations
        setVal("pw-name", product ? String(product.name || "") : "");
        setVal("pw-description", product ? String(product.description || "") : "");
        setVal("pw-emoji", product ? String(product.emoji || "📦") : "📦");
        const catSelect = document.getElementById("pw-category");
        if (catSelect) {
            catSelect.innerHTML = Object.entries(cats).map(([k, c]) =>
                `<option value="${escapeHtml(k)}">${escapeHtml(String(c.emoji || '📦'))} ${escapeHtml(String(c.name || k))}</option>`
            ).join("");
            if (product && Object.prototype.hasOwnProperty.call(cats, product.category)) catSelect.value = product.category;
        }

        // Étape 2 : Prix (prix unique, et paliers seulement si le produit en a)
        const cur = document.getElementById("pw-currency");
        if (cur) cur.textContent = currencyLabel();
        setVal("pw-price", product && toPrice(product.price) > 0 ? String(toPrice(product.price)) : "");
        adState.wizardPriceRows = wizardRowsFromProduct(product);
        renderWizardPricesTable();

        // Étape 3 : Médias & Options
        setWizardMedia("image", product ? product.image : "");
        setWizardMedia("video", product ? product.video : "");
        setChecked("pw-new-toggle", Boolean(product && product.isNew));
        setChecked("pw-promo-toggle", Boolean(product && product.isPromo));
        setChecked("pw-stock-toggle", !product || product.inStock !== false);
        openCatalogueWizard(product); // catalogue : villes du produit, likes reçus

        renderWizardStepView();
    }

    function closeProductWizard() {
        resetWizardSession();
        adState.wizardEditingProduct = null;
        const modal = document.getElementById("gst-modal-product-wizard");
        if (modal) modal.style.display = "none";
    }

    function renderWizardStepView() {
        const s = adState.wizardStep;
        // Puces d'étapes
        document.getElementById("gst-step-pill-1")?.classList.toggle("active", s === 1);
        document.getElementById("gst-step-pill-2")?.classList.toggle("active", s === 2);
        document.getElementById("gst-step-pill-3")?.classList.toggle("active", s === 3);

        // Panes
        document.getElementById("gst-wizard-step-1")?.classList.toggle("active", s === 1);
        document.getElementById("gst-wizard-step-2")?.classList.toggle("active", s === 2);
        document.getElementById("gst-wizard-step-3")?.classList.toggle("active", s === 3);

        // Boutons navigation
        const prevBtn = document.getElementById("pw-prev-btn");
        const nextBtn = document.getElementById("pw-next-btn");
        const saveBtn = document.getElementById("pw-save-btn");

        if (prevBtn) prevBtn.style.visibility = s > 1 ? "visible" : "hidden";
        if (nextBtn) nextBtn.style.display = s < 3 ? "inline-block" : "none";
        if (saveBtn) saveBtn.style.display = s === 3 ? "inline-block" : "none";
    }

    function renderWizardPricesTable() {
        const table = document.getElementById("pw-prices-table");
        if (!table) return;
        const rows = adState.wizardPriceRows;
        const head = document.getElementById("pw-prices-head");
        if (head) head.style.display = rows.length ? "" : "none";
        const cur = escapeHtml(currencyLabel());
        table.innerHTML = rows.length ? rows.map((r, idx) => `
            <div class="gst-price-row">
                <input type="text" inputmode="decimal" class="gst-input gst-input-qty" data-price-idx="${idx}" data-field="qty" value="${escapeHtml(String(r.qty))}" placeholder="5" aria-label="Quantité">
                <select class="gst-select gst-select-unit" data-price-idx="${idx}" data-field="unit" aria-label="Unité">
                    ${Object.keys(TIER_UNIT_SUFFIX).map((u) => `<option value="${u}" ${r.unit === u ? "selected" : ""}>${u}</option>`).join("")}
                </select>
                <div class="gst-price-input-eur">
                    <input type="text" inputmode="decimal" class="gst-input gst-input-eur" data-price-idx="${idx}" data-field="delivery" value="${escapeHtml(String(r.delivery))}" placeholder="50" aria-label="Prix en livraison">
                    <span>${cur}</span>
                </div>
                <div class="gst-price-input-eur">
                    <input type="text" inputmode="decimal" class="gst-input gst-input-eur" data-price-idx="${idx}" data-field="pickup" value="${escapeHtml(String(r.pickup))}" placeholder="=" aria-label="Prix sur place">
                    <span>${cur}</span>
                </div>
                <button type="button" class="gst-btn-remove-price" data-del-price-idx="${idx}" aria-label="Retirer ce palier">✕</button>
            </div>
        `).join("") : `<div class="gst-empty-placeholder">Aucun palier : vendu « À l'unité » au prix ci-dessus.</div>`;

        // Écouteurs de modification
        table.querySelectorAll("[data-field]").forEach(input => {
            const update = (e) => {
                const row = adState.wizardPriceRows[Number(e.target.dataset.priceIdx)];
                if (row) row[e.target.dataset.field] = e.target.value;
                updateWizardDbPreview();
            };
            input.addEventListener("input", update);
            input.addEventListener("change", update);
        });

        table.querySelectorAll("[data-del-price-idx]").forEach(btn => {
            btn.addEventListener("click", () => {
                const idx = Number(btn.dataset.delPriceIdx);
                adState.wizardPriceRows.splice(idx, 1);
                renderWizardPricesTable();
            });
        });

        updateWizardDbPreview();
    }

    // Ce que la boutique affichera, recalculé à chaque saisie
    function updateWizardDbPreview() {
        const preview = document.getElementById("pw-db-format-preview");
        if (!preview) return;
        const fmt = (n) => (Number.isFinite(n) && n > 0 ? formatPrice(n) : "?");
        const rows = adState.wizardPriceRows;
        if (!rows.length) {
            const base = parseAmount(document.getElementById("pw-price")?.value);
            preview.textContent = `${t("unitLabel")} : ${Number.isFinite(base) && base > 0 ? formatPrice(base) : "prix à indiquer"}`;
            return;
        }
        preview.textContent = rows.map((r) => {
            const qty = parseAmount(r.qty);
            const delivery = parseAmount(r.delivery);
            const pickup = String(r.pickup || "").trim() ? parseAmount(r.pickup) : delivery;
            const label = Number.isFinite(qty) && qty > 0 ? tierLabel(qty, r.unit) : "?";
            return `${label} : ${fmt(delivery)} en livraison · ${fmt(pickup)} sur place`;
        }).join("\n");
    }

    // Prix seul (format historique) tant que le palier n'a ni prix sur place différent ni unité ;
    // sinon { delivery, pickup, unit }, en gardant les autres clés d'un palier existant
    function wizardTierValue(row, delivery, pickup) {
        if (!row.orig && row.unit === "g" && pickup === delivery) return delivery;
        const value = { ...(row.orig || {}), delivery, pickup };
        if (row.unit === "g") delete value.unit;
        else value.unit = row.unit;
        return value;
    }

    // Prix du formulaire → { price, customPrices } (customPrices {} sans palier), ou { error }
    function readWizardPrices() {
        const customPrices = {};
        for (const [i, row] of adState.wizardPriceRows.entries()) {
            const qty = parseAmount(row.qty);
            if (!(qty > 0)) return { error: `Palier ${i + 1} : quantité invalide.` };
            const key = String(qty);
            if (Object.prototype.hasOwnProperty.call(customPrices, key)) return { error: `Deux paliers ont la même quantité (${key}).` };
            const delivery = parseAmount(row.delivery);
            if (!(delivery > 0)) return { error: `Palier ${tierLabel(qty, row.unit)} : prix en livraison invalide.` };
            const pickup = String(row.pickup || "").trim() ? parseAmount(row.pickup) : delivery;
            if (!(pickup > 0)) return { error: `Palier ${tierLabel(qty, row.unit)} : prix sur place invalide.` };
            customPrices[key] = wizardTierValue(row, delivery, pickup);
        }
        const rawBase = (document.getElementById("pw-price")?.value || "").trim();
        const base = parseAmount(rawBase);
        if (rawBase && !(base >= 0)) return { error: "Prix invalide." };
        const tierPrices = Object.values(customPrices).map((v) => (typeof v === "object" ? v.delivery : v));
        if (!tierPrices.length) {
            if (!(base > 0)) return { error: "Indique le prix du produit (ou ajoute un palier)." };
            return { price: base, customPrices };
        }
        // Avec paliers : le prix saisi est gardé, sinon le prix du plus petit palier
        return { price: base > 0 ? base : Math.min(...tierPrices), customPrices };
    }

    function setWizardMedia(kind, value) {
        const input = document.getElementById(`pw-${kind}-url`);
        if (input) input.value = String(value || "").trim();
        updateWizardMediaPreview(kind);
    }

    // Aperçu d'une photo ou d'une vidéo du formulaire : seulement un fichier /uploads/ (seul format accepté)
    function updateWizardMediaPreview(kind) {
        const input = document.getElementById(`pw-${kind}-url`);
        const preview = document.getElementById(`pw-preview-${kind}`);
        const empty = document.getElementById(`pw-${kind}-empty`);
        const clearBtn = document.getElementById(`pw-${kind}-clear-btn`);
        const raw = input ? input.value.trim() : "";
        const path = productMediaPath(raw);
        const src = path ? safeMediaUrl(resolveMediaUrl(path, kind)) : "";
        if (preview) {
            if (src) {
                const wanted = kind === "video" ? `${src}#t=0.1` : src;
                if (preview.getAttribute("src") !== wanted) preview.src = wanted;
                preview.style.display = "block";
            } else if (preview.hasAttribute("src")) {
                preview.removeAttribute("src");
                if (kind === "video") preview.load();
                preview.style.display = "none";
            } else {
                preview.style.display = "none";
            }
        }
        if (empty) {
            const refused = Boolean(raw) && path === null;
            empty.style.display = src ? "none" : "block";
            empty.classList.toggle("gst-load-error", refused);
            empty.textContent = refused
                ? "Lien refusé par le serveur : envoie le fichier avec le bouton 📁."
                : (kind === "video" ? "Aucune vidéo" : "Aucune photo");
        }
        if (clearBtn) clearBtn.disabled = !raw;
    }

    // Envoi d'une photo ou d'une vidéo depuis le formulaire produit (voir resetWizardSession)
    function bindWizardUpload(kind) {
        const input = document.getElementById(`pw-${kind}-file-input`);
        if (!input) return;
        input.addEventListener("change", async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            if (!isFileOfKind(file, kind)) {
                this.value = "";
                showToast(kind === "video" ? "Choisis une vidéo (MP4, MOV…)." : "Choisis une photo JPG, PNG ou WEBP.", "error");
                return;
            }
            const session = adState.wizardSession;
            const controller = adState.wizardUploads;
            setUploadBusy(this, true);
            showToast(kind === "video" ? "Envoi de la vidéo… ⏳" : "Envoi de la photo… ⏳", "info");
            try {
                const url = await uploadMediaFile(file, (percent) => {
                    if (session !== adState.wizardSession) return;
                    showToast(percent < 99 ? `Envoi : ${percent}%` : "Enregistrement sur le serveur… ⚙️", "info");
                }, controller ? controller.signal : undefined);
                // Formulaire fermé ou rouvert pendant l'envoi : ce fichier n'appartient pas au produit ouvert
                if (session !== adState.wizardSession) return;
                const path = uploadedPath(url);
                if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
                setWizardMedia(kind, path);
                showToast(kind === "video" ? "Vidéo envoyée, pense à enregistrer 🎬" : "Photo envoyée, pense à enregistrer 📸");
            } catch (err) {
                if (err.name !== "AbortError" && session === adState.wizardSession) showToast(err.message, "error");
            } finally {
                setUploadBusy(this, false);
            }
        });
    }

    async function handleWizardSave() {
        const session = adState.wizardSession;
        const goToStep = (step) => {
            adState.wizardStep = step;
            renderWizardStepView();
        };
        const name = (document.getElementById("pw-name")?.value || "").trim();
        const category = document.getElementById("pw-category")?.value || "";
        if (!name || !category) {
            showToast("Le nom et la catégorie sont obligatoires", "error");
            goToStep(1);
            return;
        }

        const prices = readWizardPrices();
        if (prices.error) {
            showToast(prices.error, "error");
            goToStep(2);
            return;
        }

        // Les deux serveurs n'acceptent que des fichiers envoyés (/uploads/…) ; un champ vide retire le média
        const image = productMediaPath(document.getElementById("pw-image-url")?.value);
        const video = productMediaPath(document.getElementById("pw-video-url")?.value);
        if (image === null || video === null) {
            showToast("Les liens ne sont pas acceptés : envoie la photo ou la vidéo avec le bouton 📁, ou retire-la avec ✕.", "error");
            goToStep(3);
            return;
        }

        const editing = adState.wizardEditingProduct;
        const payload = {
            category,
            name,
            description: (document.getElementById("pw-description")?.value || "").trim(),
            price: prices.price,
            customPrices: prices.customPrices,
            emoji: (document.getElementById("pw-emoji")?.value || "").trim() || "📦",
            image,
            video,
            isNew: Boolean(document.getElementById("pw-new-toggle")?.checked),
            isPromo: Boolean(document.getElementById("pw-promo-toggle")?.checked),
            inStock: document.getElementById("pw-stock-toggle")?.checked !== false
        };
        if (editing && editing.id) payload.id = editing.id;
        if (catPanel.loaded) payload.cities = catalogueWizardCities(); // catalogue : absent = villes inchangées

        // Le formulaire reste ouvert si l'enregistrement échoue (l'erreur est affichée au-dessus)
        const saveBtn = document.getElementById("pw-save-btn");
        if (saveBtn) saveBtn.disabled = true;
        const ok = await adminSaveProductDirect(payload, editing && editing.id ? "Produit modifié ! ✅" : "Produit ajouté ! 🎉");
        if (session !== adState.wizardSession) return;
        if (ok) {
            closeProductWizard();
        } else if (saveBtn) {
            const dialog = saveBtn.closest(".gst-modal-dialog");
            saveBtn.disabled = Boolean(dialog && Number(dialog.dataset.pendingUploads) > 0);
        }
    }

    // Menu Écrit Telegram
    function openWrittenMenuModal() {
        const modal = document.getElementById("gst-modal-written-menu");
        const textarea = document.getElementById("gst-written-menu-text");
        if (!modal || !textarea) return;

        const cfg = state.config || {};
        const rest = cfg.restaurant || {};
        const categories = cfg.categories || {};
        const products = adState.activeProducts || [];

        let text = `🛍️ **MENU OFFICIEL ${rest.name || 'GreenHouse 68'}** 🛍️\n`;
        text += `Livraison rapide & Click & Collect sécurisé\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

        for (const [catKey, cat] of Object.entries(categories)) {
            const catProds = products.filter(p => p.category === catKey && p.inStock !== false);
            if (!catProds.length) continue;

            text += `${cat.emoji || '📦'} **${String(cat.name || catKey).toUpperCase()}**\n`;
            catProds.forEach(p => {
                text += `• **${p.name}**\n`;
                // Paliers aux prix de livraison, avec leur unité ; sinon le prix unique
                const tiers = getQtyEntries(p, "delivery").filter((e) => e.tier);
                if (tiers.length) {
                    text += `  └ ${tiers.map((e) => `${tierLabel(e.qty, e.unit)} = ${formatPrice(e.price)}`).join(' | ')}\n`;
                } else {
                    text += `  └ Prix : ${formatPrice(p.price || 0)}\n`;
                }
            });
            text += `\n`;
        }

        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `📱 Commandes en direct sur notre Mini-App Telegram !\n`;
        const ch = (cfg.admin && cfg.admin.channel_link) || "";
        if (ch) text += `📢 Canal officiel : ${ch}\n`;

        textarea.value = text;
        modal.style.display = "flex";
    }

    function closeWrittenMenuModal() {
        const modal = document.getElementById("gst-modal-written-menu");
        if (modal) modal.style.display = "none";
    }

    // ===== ONGLET 4: COMMANDES & DASHBOARD CRM =====
    // Commandes du serveur (les 200 plus récentes) ; aussi lues par la fiche client de l'onglet Utilisateurs
    async function fetchAdminOrders() {
        const res = await adminRequest("/admin/orders");
        // En erreur (session expirée, serveur injoignable) : message et compteurs « — », jamais « 0 commande / 0 € »
        adState.ordersError = res.ok ? "" : res.error;
        if (res.ok) {
            adState.ordersList = Array.isArray(res.data.orders) ? res.data.orders : [];
            adState.ordersLoaded = true;
        }
        return res.ok;
    }

    async function loadAdminOrdersData() {
        const listContainer = document.getElementById("gst-orders-cards-list") || document.getElementById("gst-orders-list-container");
        if (listContainer) listContainer.innerHTML = `<div class="gst-empty-placeholder">Chargement des commandes...</div>`;
        const catalogueLoad = loadCataloguePanel(); // catalogue : groupes de réception, types d'envoi, adresses crypto
        await fetchAdminOrders();
        filterAndRenderOrders();
        await catalogueLoad;
    }

    // Horodatage du serveur en secondes ou en millisecondes → Date (null si absent)
    function adminDate(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        return new Date(n < 1e12 ? n * 1000 : n);
    }

    function filterAndRenderOrders() {
        const listContainer = document.getElementById("gst-orders-cards-list") || document.getElementById("gst-orders-list-container");
        if (!listContainer) return;
        const statEls = {
            total: document.getElementById("gst-orders-stat-total"),
            revenue: document.getElementById("gst-orders-stat-revenue"),
            today: document.getElementById("gst-orders-stat-today"),
            avg: document.getElementById("gst-orders-stat-avg")
        };
        if (adState.ordersError) {
            Object.values(statEls).forEach((el) => { if (el) el.textContent = "—"; });
            renderAdminListError(listContainer, adState.ordersError);
            return;
        }
        let orders = [...adState.ordersList];

        const search = (adState.ordersSearch || "").toLowerCase().trim();
        if (search) {
            orders = orders.filter(o =>
                String(o.id || "").includes(search) ||
                String(o.telegram_username || "").toLowerCase().includes(search) ||
                String(o.telegram_user_id || "").includes(search) ||
                String(o.summary || "").toLowerCase().includes(search)
            );
        }

        if (adState.ordersFilter === "pickup") orders = orders.filter(o => o.type === "pickup");
        else if (adState.ordersFilter === "delivery") orders = orders.filter(o => o.type === "delivery");
        else if (adState.ordersFilter === "postal") orders = orders.filter(o => o.type === "postal");
        // catalogue : filtre par statut (pastilles de la carte)
        if (catPanel.ordersStatus !== "all") orders = orders.filter((o) => (o.status || "") === catPanel.ordersStatus);

        // Calcul des 4 stats CRM (« Aujourd'hui » = passées depuis minuit ; revenus et panier moyen sans les annulées)
        const totalCmds = adState.ordersList.length;
        const paidOrders = adState.ordersList.filter((o) => o.status !== "cancelled");
        const totalCa = paidOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
        const avgBasket = paidOrders.length > 0 ? (totalCa / paidOrders.length) : 0;
        const midnight = new Date().setHours(0, 0, 0, 0);
        const todayCount = adState.ordersList.filter((o) => {
            const d = adminDate(o.timestamp);
            return d && d.getTime() >= midnight;
        }).length;

        if (statEls.total) statEls.total.textContent = totalCmds;
        if (statEls.revenue) statEls.revenue.textContent = formatPrice(totalCa);
        if (statEls.today) statEls.today.textContent = todayCount;
        if (statEls.avg) statEls.avg.textContent = formatPrice(avgBasket);
        // reorg : pastille « Commandes » et onglet Ventes (commandes nouvelles parmi les 200 dernières)
        if (adState.ordersLoaded) reorgSetCount("ordersNew", adState.ordersList.filter((o) => o.status === "new").length);

        if (!orders.length) {
            listContainer.innerHTML = `<div class="gst-empty-placeholder">Aucune commande enregistrée.</div>`;
            return;
        }

        listContainer.innerHTML = orders.map(o => {
            const d = adminDate(o.timestamp);
            const date = d ? d.toLocaleString("fr-FR") : "date inconnue";
            const typeLabel = o.type === "pickup" ? "Click & Collect" : (o.type === "postal" ? "Envoi postal" : "Livraison");
            const user = o.telegram_username ? `@${escapeHtml(String(o.telegram_username))}` : (o.telegram_user_id ? `ID ${escapeHtml(String(o.telegram_user_id))}` : "Client");

            return `
                <div class="gst-order-card">
                    <div class="gst-order-card-header">
                        <div>
                            <span class="gst-order-id">Commande #${escapeHtml(String(o.id))}</span>
                            <span class="gst-badge-type">${typeLabel}</span>
                            ${catalogueOrderStatusBadge(o)}
                        </div>
                        <span class="gst-order-total">${formatPrice(o.total || 0)}</span>
                    </div>
                    <div class="gst-order-meta">${user} · ${date}</div>
                    ${catalogueOrderDetailsHtml(o)}
                    <div class="gst-order-summary">${escapeHtml(String(o.summary || ""))}</div>
                    ${catalogueOrderActionsHtml(o)}
                </div>
            `;
        }).join("");
    }

    // ===== ONGLET 5: MESSAGES BROADCAST =====
    // Limite d'un message texte Telegram (aussi utilisée par le broadcast du bot backup, section Backup).
    // Onglets 5 (Messages) et 6 (Tickets SAV) : section « ÉQUIPE MESSAGES », juste avant FIN ADMIN PANEL.
    const BROADCAST_MAX_CHARS = 4000;

    // ===== ONGLET 7: CRM UTILISATEURS =====
    const ACTIVE_USER_DAYS = 7;

    // Utilisateurs du bot (CRM, recherche d'admin, nombre de destinataires) : une seule requête à la fois ;
    // force = false réutilise la liste déjà chargée
    function fetchAdminUsers(force) {
        if (!force && adState.usersLoaded) return Promise.resolve(true);
        if (!adState.usersRequest) {
            adState.usersRequest = adminRequest("/admin/users").then((res) => {
                adState.usersRequest = null;
                adState.usersError = res.ok ? "" : res.error;
                if (res.ok) {
                    adState.usersList = Array.isArray(res.data.users) ? res.data.users : [];
                    const count = Number(res.data.count);
                    adState.usersCount = Number.isInteger(count) && count >= 0 ? count : adState.usersList.length;
                    adState.usersLoaded = true;
                }
                return res.ok;
            });
        }
        return adState.usersRequest;
    }

    async function loadAdminUsersData() {
        const listContainer = document.getElementById("gst-users-list-container");
        if (listContainer) listContainer.innerHTML = `<div class="gst-empty-placeholder">Chargement de la base clients...</div>`;
        await fetchAdminUsers(true);
        filterAndRenderUsers();
    }

    // Pseudo Telegram public (lettres, chiffres, _) : seul cas où un lien t.me est construit
    function telegramHandle(username) {
        const u = String(username || "").replace(/^@+/, "");
        return /^[A-Za-z0-9_]{4,32}$/.test(u) ? u : "";
    }

    function userDisplayName(u) {
        return [u.first_name, u.last_name].map((v) => String(v || "").trim()).filter(Boolean).join(" ") || "Client";
    }

    function filterAndRenderUsers() {
        const listContainer = document.getElementById("gst-users-list-container");
        const totalEl = document.getElementById("gst-users-total-count");
        if (totalEl) totalEl.textContent = adState.usersError || !adState.usersLoaded ? "—" : `${adState.usersCount} client${adState.usersCount > 1 ? "s" : ""}`;
        if (!listContainer) return;
        if (adState.usersError) {
            renderAdminListError(listContainer, adState.usersError);
            return;
        }
        let users = [...adState.usersList];

        // « Actifs récents » : /start ou ouverture de la boutique dans les 7 derniers jours (updated_at)
        if (adState.usersFilter === "active") {
            const since = Date.now() - ACTIVE_USER_DAYS * 86400000;
            users = users.filter((u) => {
                const d = adminDate(u.updated_at);
                return d && d.getTime() >= since;
            });
        }

        const search = (adState.usersSearch || "").toLowerCase().trim();
        if (search) {
            users = users.filter(u =>
                String(u.id || u.user_id || "").includes(search) ||
                String(u.username || "").toLowerCase().includes(search) ||
                userDisplayName(u).toLowerCase().includes(search)
            );
        }

        if (!users.length) {
            listContainer.innerHTML = `<div class="gst-empty-placeholder">${adState.usersFilter === "active" && !search ? `Aucun utilisateur actif ces ${ACTIVE_USER_DAYS} derniers jours.` : "Aucun utilisateur trouvé."}</div>`;
            return;
        }

        listContainer.innerHTML = users.map(u => {
            const uid = escapeHtml(String(u.id || u.user_id || "0"));
            const uname = u.username ? `@${escapeHtml(String(u.username))}` : "Sans pseudo";
            const rawName = userDisplayName(u);
            const name = escapeHtml(rawName);
            const initial = escapeHtml(rawName.charAt(0).toUpperCase()) || "👤";
            const handle = telegramHandle(u.username);
            const seen = adminDate(u.updated_at);

            return `
                <div class="gst-user-crm-card">
                    <div class="gst-user-crm-avatar">${initial}</div>
                    <div class="gst-user-crm-body">
                        <div class="gst-user-crm-name">${name} <span class="gst-user-crm-handle">${uname}</span></div>
                        <div class="gst-user-crm-id">ID : <code>${uid}</code>${seen ? ` · vu le ${seen.toLocaleDateString("fr-FR")}` : ""}</div>
                    </div>
                    <div class="gst-user-crm-actions">
                        <button type="button" class="gst-btn-icon-copy" data-copy-id="${uid}" title="Copier l'ID">📋</button>
                        ${handle ? `<a href="https://t.me/${handle}" target="_blank" rel="noopener" class="gst-btn-icon-dm" title="Ouvrir DM">✈</a>` : ''}
                        <button type="button" class="gst-btn-crm-profile" data-profile-user-id="${uid}">Fiche</button>
                    </div>
                </div>
            `;
        }).join("");

        // Copier l'ID
        listContainer.querySelectorAll("[data-copy-id]").forEach(btn => {
            btn.addEventListener("click", async () => {
                const uid = btn.dataset.copyId;
                if (await copyTextToClipboard(uid)) showToast(`ID ${uid} copié ! 📋`);
                else showToast(`Copie impossible : note l'ID ${uid} à la main.`, "error");
            });
        });

        // Ouvrir la fiche client CRM
        listContainer.querySelectorAll("[data-profile-user-id]").forEach(btn => {
            btn.addEventListener("click", () => {
                const uid = btn.dataset.profileUserId;
                const user = adState.usersList.find(u => String(u.id || u.user_id) === String(uid));
                if (user) openUserProfileModal(user);
            });
        });
    }

    // Fiche client : les commandes sont chargées à l'ouverture si l'onglet Commandes ne l'a pas encore fait
    function openUserProfileModal(user) {
        const modal = document.getElementById("gst-modal-user-profile");
        if (!modal) return;
        const uid = String(user.id || user.user_id);
        adState.profileUserId = uid;
        renderUserProfile(user, "loading", []);
        modal.style.display = "flex";
        // Toutes les commandes de ce client (GET /admin/orders?user_id=…), pas seulement parmi les 200 dernières
        const login = String(user.username || "").replace(/^@+/, "");
        const query = `user_id=${encodeURIComponent(uid)}${login ? `&username=${encodeURIComponent(login)}` : ""}`;
        adminRequest(`/admin/orders?${query}`).then((res) => {
            if (adState.profileUserId !== uid || !isShown(modal)) return;
            const orders = res.ok && Array.isArray(res.data.orders) ? res.data.orders : [];
            renderUserProfile(user, res.ok ? "ready" : "error", orders, res.error);
        });
    }

    function renderUserProfile(user, phase, orders, error) {
        const body = document.getElementById("gst-user-modal-body");
        if (!body) return;
        const uid = user.id || user.user_id;
        const uname = user.username ? `@${user.username}` : "Non renseigné";
        const name = userDisplayName(user);
        const login = String(user.username || "").toLowerCase();
        // Commandes de cet utilisateur (liste propre à ce client, filtrée encore ici par sécurité)
        const userOrders = phase === "ready"
            ? (orders || []).filter(o => String(o.telegram_user_id) === String(uid) || (login && String(o.telegram_username || "").toLowerCase() === login))
            : [];
        const totalSpent = userOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
        const ordersHtml = phase === "loading"
            ? '<div class="gst-empty-placeholder">Chargement des commandes…</div>'
            : phase === "error"
                ? `<div class="gst-empty-placeholder gst-load-error">${escapeHtml(error || "Commandes indisponibles, réessaie.")}</div>`
                : userOrders.length ? userOrders.map(o => {
                    const d = adminDate(o.timestamp);
                    return `
                    <div class="gst-order-card" style="padding:10px;margin-top:6px;">
                        <div class="gst-card-row-head">
                            <span>Commande #${escapeHtml(String(o.id))}</span>
                            <strong>${formatPrice(o.total || 0)}</strong>
                        </div>
                        <div class="gst-order-meta">${d ? d.toLocaleDateString("fr-FR") : "date inconnue"} · ${escapeHtml(String(o.summary || ""))}</div>
                    </div>`;
                }).join("") : '<div class="gst-empty-placeholder">Aucune commande enregistrée pour ce client.</div>';
        const stat = (value) => (phase === "ready" ? value : "—");

        // Toutes les valeurs (nom, pseudo, résumé de commande saisi par le client) sont échappées
        body.innerHTML = `
            <div class="gst-user-card-lead" style="margin-bottom:16px;">
                <div class="gst-user-avatar" style="font-size:1.8rem;">👤</div>
                <div class="gst-user-info-col">
                    <strong style="font-size:1.1rem;color:#fff;">${escapeHtml(String(name))}</strong>
                    <span style="color:#a78bfa;">${escapeHtml(String(uname))}</span>
                    <span style="font-size:0.8rem;color:#9ca3af;">ID: ${escapeHtml(String(uid))}</span>
                </div>
            </div>
            <div class="gst-stats-quad" style="margin-bottom:16px;">
                <div class="gst-stat-box">
                    <span class="gst-stat-number">${stat(userOrders.length)}</span>
                    <span class="gst-stat-label">Commandes</span>
                </div>
                <div class="gst-stat-box">
                    <span class="gst-stat-number">${stat(formatPrice(totalSpent))}</span>
                    <span class="gst-stat-label">Total dépensé</span>
                </div>
            </div>
            <div class="gst-field-group">
                <div class="gst-field-subtitle">HISTORIQUE DES COMMANDES</div>
                ${ordersHtml}
            </div>
        `;
    }

    function closeUserProfileModal() {
        const modal = document.getElementById("gst-modal-user-profile");
        if (modal) modal.style.display = "none";
        adState.profileUserId = null;
    }

    // ===== BINDING GLOBAL DES ÉVÉNEMENTS DU PANEL ADMIN =====
    function bindAdminPanelEvents() {
        // 1. Les 5 onglets du bas (le bouton Fermer est relié dans bindActions)
        document.querySelectorAll(".gst-bottom-nav .gst-nav-btn").forEach(btn => {
            btn.addEventListener("click", () => selectAdminNavTab(btn.dataset.gstNav));
        });

        // 2. Bouton 🔍 (accès rapide à toutes les pages)
        const qlBtn = document.getElementById("gst-quick-list-btn");
        if (qlBtn) qlBtn.addEventListener("click", openQuickListDrawer);
        const qlClose = document.getElementById("gst-close-quick-list-btn");
        if (qlClose) qlClose.addEventListener("click", closeQuickListDrawer);

        // 3. Réglages et réglages Commandes : enregistrement partiel au changement (table SETTINGS_FIELDS),
        // pastilles du thème et devise
        bindSettingsControls();
        // Contrôles d'accès : bot backup, image d'exemple CNI, vérifications et approbations
        bindAccessControls();

        // 4. Modale Loader d'intro
        const pickLoaderBtn = document.getElementById("gst-open-loader-modal-btn") || document.getElementById("gst-btn-pick-loader");
        if (pickLoaderBtn) pickLoaderBtn.addEventListener("click", openLoaderModal);
        const closeLoaderBtn = document.getElementById("gst-close-loader-modal-btn");
        if (closeLoaderBtn) closeLoaderBtn.addEventListener("click", closeLoaderModal);
        const cancelLoaderBtn = document.getElementById("gst-cancel-loader-btn");
        if (cancelLoaderBtn) cancelLoaderBtn.addEventListener("click", closeLoaderModal);

        document.querySelectorAll("#gst-modal-intro-loader .gst-choice-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                selectLoaderChoice(btn.dataset.loader);
            });
        });

        const replayLoaderBtn = document.getElementById("gst-loader-replay-btn");
        if (replayLoaderBtn) {
            replayLoaderBtn.addEventListener("click", () => {
                const target = document.getElementById("gst-loader-anim-target");
                if (target) {
                    const curClass = target.className;
                    target.className = "gst-loader-anim-target";
                    void target.offsetWidth;
                    target.className = curClass;
                }
            });
        }

        // Loader et fond animé : appliqués à la boutique seulement après l'enregistrement confirmé ;
        // en cas d'échec la modale reste ouverte avec l'erreur affichée au-dessus
        const confirmLoaderBtn = document.getElementById("gst-confirm-loader-btn");
        if (confirmLoaderBtn) {
            confirmLoaderBtn.addEventListener("click", async () => {
                const name = safeLoaderName(adState.selectedLoader);
                if (name !== adState.settingsSaved.loader_style) {
                    confirmLoaderBtn.disabled = true;
                    const ok = await saveAdminSettings({ loader_style: name });
                    confirmLoaderBtn.disabled = false;
                    if (!ok) return;
                    adState.settingsSaved.loader_style = name;
                    applyStoreIntroLoader(name);
                    setChoiceLabels();
                    showToast(`Loader d'intro enregistré : ${document.getElementById("gst-current-loader-label")?.textContent || name} ✨`);
                }
                closeLoaderModal();
            });
        }

        // 5. Modale Fond animé
        const pickBgBtn = document.getElementById("gst-open-animated-bg-btn") || document.getElementById("gst-btn-pick-bg");
        if (pickBgBtn) pickBgBtn.addEventListener("click", openAnimatedBgModal);
        const closeBgBtn = document.getElementById("gst-close-bg-modal-btn");
        if (closeBgBtn) closeBgBtn.addEventListener("click", closeAnimatedBgModal);
        const cancelBgBtn = document.getElementById("gst-cancel-bg-btn");
        if (cancelBgBtn) cancelBgBtn.addEventListener("click", closeAnimatedBgModal);

        document.querySelectorAll("#gst-modal-animated-bg .gst-choice-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                selectAnimatedBgChoice(btn.dataset.bg);
            });
        });

        const confirmBgBtn = document.getElementById("gst-confirm-bg-btn");
        if (confirmBgBtn) {
            confirmBgBtn.addEventListener("click", async () => {
                const name = safeBgName(adState.selectedBg);
                if (name !== adState.settingsSaved.animated_bg) {
                    confirmBgBtn.disabled = true;
                    const ok = await saveAdminSettings({ animated_bg: name });
                    confirmBgBtn.disabled = false;
                    if (!ok) return;
                    adState.settingsSaved.animated_bg = name;
                    applyStoreAnimatedBg(name);
                    setChoiceLabels();
                    showToast(`Fond animé enregistré : ${document.getElementById("gst-current-bg-label")?.textContent || name} 🌌`);
                }
                closeAnimatedBgModal();
            });
        }

        // 6. Image de fond et logo : envoi du fichier (progression affichée), puis enregistrement de son chemin /uploads/
        bindAppearanceUpload("gst-bg-upload-input", "background_image", "Image de fond enregistrée ! 🖼️", (path) => {
            applyShopBackgroundImage(path);
            const prevImg = document.getElementById("gst-bg-preview-img");
            if (prevImg) prevImg.src = safeMediaUrl(resolveMediaUrl(path, "image")) || "background.png";
        });
        bindAppearanceUpload("gst-logo-upload-input", "logo_url", "Logo enregistré ! 🌟", applyShopLogo);

        // 7. Section Musique (envoi d'un son), Admins (ajout par pseudo ou ID) et Avis (actualiser)
        bindAdminMusicUpload();
        document.getElementById("gst-admin-add-by-list-btn")?.addEventListener("click", () => setAdminAddMode("list"));
        document.getElementById("gst-admin-add-by-id-btn")?.addEventListener("click", () => setAdminAddMode("id"));
        const adminSearch = document.getElementById("gst-admin-search-input");
        if (adminSearch) {
            // Utilisateurs du bot chargés à la première recherche (focus ou saisie), puis gardés pour le panel
            const searchAdminCandidates = () => {
                renderAdminAddResults();
                if (!adState.usersLoaded) fetchAdminUsers(false).then(renderAdminAddResults);
            };
            adminSearch.addEventListener("focus", searchAdminCandidates);
            adminSearch.addEventListener("input", searchAdminCandidates);
        }
        document.getElementById("gst-reviews-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation des avis...", "info");
            loadAdminReviews();
        });

        // Boutons « ℹ Aide balises » : affichent ou masquent l'aide placée sous eux
        document.querySelectorAll("#admin-overlay [data-help-target]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const box = document.getElementById(btn.dataset.helpTarget);
                if (box) box.style.display = isShown(box) ? "none" : "";
            });
        });

        // 8. Menu « ••• » : redémarrer le bot (le lien du quick tunnel change, la mini-app doit être rouverte)
        document.getElementById("admin-more-btn")?.addEventListener("click", openMoreMenu);
        document.getElementById("gst-close-more-menu-btn")?.addEventListener("click", closeMoreMenu);
        document.getElementById("gst-modal-more-menu")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeMoreMenu();
        });
        // Menu •••, tête du menu des Réglages et raccourci de l'Accueil : même confirmation
        ["gst-btn-restart-bot", "gst-restart-bot-inline-btn", "gst-dash-restart-btn"].forEach((id) => {
            document.getElementById(id)?.addEventListener("click", confirmAdminRestart);
        });

        // 9. Événements Onglet /START : rien n'est envoyé avant « Enregistrer »
        document.querySelectorAll("[data-format-cmd]").forEach(btn => {
            btn.addEventListener("click", () => applyTelegramFormat(btn.dataset.formatCmd));
        });

        const addStartBtn = document.getElementById("gst-add-start-row-btn");
        if (addStartBtn) {
            addStartBtn.addEventListener("click", () => {
                if (adState.startKeyboardRows.length >= START_BUTTONS_MAX) return;
                adState.startKeyboardRows.push({ text: "", url: "" });
                renderStartButtonsBuilder();
                renderStartStatus();
                const inputs = document.querySelectorAll('#gst-kb-builder-list [data-field="text"]');
                if (inputs.length) inputs[inputs.length - 1].focus();
            });
        }

        document.getElementById("gst-start-tab-msg-btn")?.addEventListener("click", () => showStartSubpane("msg"));
        document.getElementById("gst-start-tab-btns-btn")?.addEventListener("click", () => showStartSubpane("btns"));

        document.getElementById("gst-btn-save-start")?.addEventListener("click", adminSaveStartConfig);
        startTextarea()?.addEventListener("input", renderStartStatus);
        bindStartPhotoUpload();
        document.getElementById("gst-start-photo-clear-btn")?.addEventListener("click", () => {
            adState.startPhoto = "";
            renderStartPhoto();
            renderStartStatus();
        });
        document.getElementById("gst-start-preview-btn")?.addEventListener("click", () => {
            const box = document.getElementById("gst-start-preview-box");
            if (!box) return;
            const show = !isShown(box);
            box.style.display = show ? "" : "none";
            if (show) renderStartPreview();
        });

        // 10. Événements Onglet PRODUITS
        const searchInput = document.getElementById("gst-prods-search-input") || document.getElementById("gst-prod-search-input");
        if (searchInput) {
            searchInput.addEventListener("input", (e) => {
                adState.productsSearch = e.target.value;
                filterAndRenderProducts();
            });
        }

        document.querySelectorAll(".gst-sort-chips-row .gst-sort-chip").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".gst-sort-chips-row .gst-sort-chip").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                adState.productsSort = btn.dataset.sort || "manual";
                filterAndRenderProducts();
            });
        });

        document.querySelectorAll("#gst-pane-produits .gst-filter-chips-row .gst-filter-chip").forEach(btn => {
            btn.addEventListener("click", () => {
                // « Rupture » de l'onglet = « Épuisés » des pastilles du haut : un seul filtre, affiché aux deux endroits
                const filter = btn.dataset.filter || "all";
                adState.productsFilter = filter === "rupture" ? "out" : filter;
                syncProductFilterChips();
                renderAdminSubtabs("produits");
                filterAndRenderProducts();
            });
        });

        const sortSelect = document.getElementById("gst-prod-sort-select");
        if (sortSelect) {
            sortSelect.addEventListener("change", (e) => {
                adState.productsSort = e.target.value;
                filterAndRenderProducts();
            });
        }

        const addProdBtn = document.getElementById("gst-prods-new-btn") || document.getElementById("gst-prod-add-btn");
        if (addProdBtn) addProdBtn.addEventListener("click", () => openProductWizard(null));

        const writtenMenuBtn = document.getElementById("gst-prods-written-menu-btn") || document.getElementById("gst-btn-written-menu");
        if (writtenMenuBtn) writtenMenuBtn.addEventListener("click", openWrittenMenuModal);

        // « Position dans la grille » : liste complète dans l'ordre de la boutique, avec les flèches ▲ ▼
        document.getElementById("gst-prods-reorder-grid-btn")?.addEventListener("click", () => {
            adState.productsSearch = "";
            if (searchInput) searchInput.value = "";
            document.querySelector('#gst-pane-produits .gst-filter-chip[data-filter="all"]')?.click();
            document.querySelector('#gst-pane-produits .gst-sort-chip[data-sort="manual"]')?.click();
            renderAdminSubtabs("produits");
            showToast("Ordre de la boutique : utilise ▲ ▼ sur chaque produit.", "info");
        });

        // Wizard Événements
        const closeWizBtn = document.getElementById("gst-close-wizard-btn");
        if (closeWizBtn) closeWizBtn.addEventListener("click", closeProductWizard);

        const prevWizBtn = document.getElementById("pw-prev-btn");
        if (prevWizBtn) {
            prevWizBtn.addEventListener("click", () => {
                if (adState.wizardStep > 1) {
                    adState.wizardStep--;
                    renderWizardStepView();
                }
            });
        }

        const nextWizBtn = document.getElementById("pw-next-btn");
        if (nextWizBtn) {
            nextWizBtn.addEventListener("click", () => {
                if (adState.wizardStep === 1) {
                    const name = (document.getElementById("pw-name")?.value || "").trim();
                    if (!name) {
                        showToast("Le nom du produit est obligatoire", "error");
                        return;
                    }
                }
                if (adState.wizardStep < 3) {
                    adState.wizardStep++;
                    renderWizardStepView();
                }
            });
        }

        const saveWizBtn = document.getElementById("pw-save-btn");
        if (saveWizBtn) saveWizBtn.addEventListener("click", handleWizardSave);

        const addPriceRowBtn = document.getElementById("pw-add-price-row-btn");
        if (addPriceRowBtn) {
            addPriceRowBtn.addEventListener("click", () => {
                adState.wizardPriceRows.push({ qty: "", unit: "g", delivery: "", pickup: "", orig: null });
                renderWizardPricesTable();
                const qtyInputs = document.querySelectorAll("#pw-prices-table .gst-input-qty");
                if (qtyInputs.length) qtyInputs[qtyInputs.length - 1].focus();
            });
        }
        document.getElementById("pw-price")?.addEventListener("input", updateWizardDbPreview);

        // Photo et vidéo : envoi du fichier, aperçu, ✕ pour retirer le média
        ["image", "video"].forEach((kind) => {
            document.getElementById(`pw-${kind}-url`)?.addEventListener("input", () => updateWizardMediaPreview(kind));
            document.getElementById(`pw-${kind}-clear-btn`)?.addEventListener("click", () => setWizardMedia(kind, ""));
            bindWizardUpload(kind);
        });

        // Carte Catégories
        document.getElementById("gst-cat-new-btn")?.addEventListener("click", () => openCategoryForm(null));
        document.getElementById("gst-cat-cancel-btn")?.addEventListener("click", closeCategoryForm);
        document.getElementById("gst-cat-save-btn")?.addEventListener("click", saveCategoryForm);

        // Modale Menu Écrit
        const closeWmBtn = document.getElementById("gst-close-written-menu-btn");
        if (closeWmBtn) closeWmBtn.addEventListener("click", closeWrittenMenuModal);
        const closeWmFootBtn = document.getElementById("gst-close-written-menu-foot-btn");
        if (closeWmFootBtn) closeWmFootBtn.addEventListener("click", closeWrittenMenuModal);
        const copyWmBtn = document.getElementById("gst-copy-written-menu-btn");
        if (copyWmBtn) {
            copyWmBtn.addEventListener("click", async () => {
                const textarea = document.getElementById("gst-written-menu-text");
                if (textarea) {
                    const ok = await copyTextToClipboard(textarea.value);
                    textarea.select();
                    if (ok) showToast("Menu copié dans le presse-papier ! 📋");
                    else showToast("Copie impossible : le texte est sélectionné, copie-le à la main.", "error");
                }
            });
        }

        // 11. Événements Onglet COMMANDES
        const orderSearchInput = document.getElementById("gst-orders-search-input");
        if (orderSearchInput) {
            orderSearchInput.addEventListener("input", (e) => {
                adState.ordersSearch = e.target.value;
                filterAndRenderOrders();
            });
        }
        const orderRefreshBtn = document.getElementById("gst-orders-refresh-btn");
        if (orderRefreshBtn) {
            orderRefreshBtn.addEventListener("click", () => {
                showToast("Actualisation des commandes...", "info");
                loadAdminOrdersData();
            });
        }

        // 14. Événements Onglet UTILISATEURS
        const usersSearchInput = document.getElementById("gst-users-search-input");
        if (usersSearchInput) {
            usersSearchInput.addEventListener("input", (e) => {
                adState.usersSearch = e.target.value;
                filterAndRenderUsers();
            });
        }

        const closeUserModalBtn = document.getElementById("gst-close-user-modal-btn");
        if (closeUserModalBtn) closeUserModalBtn.addEventListener("click", closeUserProfileModal);
        const closeUserModalFootBtn = document.getElementById("gst-close-user-modal-foot-btn");
        if (closeUserModalFootBtn) closeUserModalFootBtn.addEventListener("click", closeUserProfileModal);
        bindBotPanel();
        bindMessagesPanel(); // équipe Messages : diffusion, modèles, messages automatiques, tickets, autoclean
        bindCataloguePanel(); // catalogue : multi-ville, promo, likes, options de commande, groupe des commandes, N-ème client
        bindFidelitePanel(); // fidelite : Rang & Parrainage, Roue, Concours
        bindReorgPanel(); // reorg : tableau de bord, menu des Réglages, accès rapide, filtres des listes
    }

    function confirmAdminRestart() {
        closeMoreMenu();
        showConfirmModal({
            title: "Redémarrer le bot ?",
            emoji: "🔄",
            message: "Le bot sera coupé quelques secondes puis repartira tout seul.<br><br><strong>Le lien de la mini-app change à chaque redémarrage</strong> : tout le monde (toi compris) devra la rouvrir depuis le bot (/start ou « Voir la carte »). Cette page cessera de répondre.",
            confirmText: "Oui, redémarrer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: adminRestartBot
        });
    }

    async function adminRestartBot() {
        const res = await adminRequest("/admin/restart", {});
        if (res.ok) showToast("Redémarrage lancé 🔄 Dans 15 secondes environ, ferme la mini-app et rouvre-la depuis le bot.");
        else showToast(res.error, "error");
    }

    // Enregistre la commande avant l'ouverture de Telegram. Résultat :
    //   { status: "ok", orderId }      commande en base (orderId = numéro affiché dans le panel)
    //   { status: "gated" }            403 avec gate (accès retiré entre-temps) : l'écran d'accès s'affiche
    //   { status: "closed", error }    commandes désactivées dans la gestion
    //   { status: "refused", error, cityRequired }  refus motivé (400 / 429 : ville, créneau, produit…) : rien ne part
    //   { status: "error" }            serveur injoignable ou autre erreur : la commande part quand même en DM
    // Réponse ok : data = total, summary et price_changed recalculés par le serveur (catalogue)
    async function persistOrderToServer(order) {
        try {
            const resp = await fetchWriteApi("/save-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, order, { init_data: getAdminInitData(), platform: telegramPlatform() }))
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok) {
                const id = Number(data && data.order_id);
                fideliteOrderSaved(order, data); // fidelite : total réduit confirmé par le serveur
                return { status: "ok", orderId: Number.isInteger(id) && id > 0 ? id : null, data };
            }
            if (resp.status === 403 && applyGateRefusal(data)) return { status: "gated" };
            if (resp.status === 403 && data && data.orders_closed) {
                return { status: "closed", error: typeof data.error === "string" ? data.error : "" };
            }
            // fidelite : réduction fidélité refusée (400 « fidelite ») : message affiché, avantages relus, panier gardé
            if (resp.status === 400 && data && data.fidelite === true && fideliteOrderBlocked(order, data)) return { status: "gated" };
            // catalogue : refus motivé du serveur, le message est affiché et rien ne part
            if ((resp.status === 400 || resp.status === 429) && data && typeof data.error === "string" && data.error) {
                return { status: "refused", error: data.error, cityRequired: data.city_required === true };
            }
            if (fideliteOrderBlocked(order, data)) return { status: "gated" }; // fidelite : réduction non vérifiée, panier gardé
            return { status: "error" };
        } catch (_) {
            if (fideliteOrderBlocked(order, null)) return { status: "gated" }; // fidelite : réduction non vérifiée
            return { status: "error" };
        }
    }


    // ===== ÉQUIPE BOT : profil du bot, CRM, image de fond, musique, logs Telegram (onglet Réglages) =====
    // Tout ce qui est affiché vient du serveur : GET /admin/bot/status (interrupteurs, canal de logs, images par source)
    // et GET /admin/bot/profile (nom, descriptions et @username lus sur Telegram). Les interrupteurs eux-mêmes sont
    // enregistrés par SETTINGS_FIELDS (crm_enabled, music_enabled, background_hide_desktop, tg_logs_enabled).
    const BOT_PROFILE_FIELDS = [
        { key: "name", id: "gst-bot-name-input", counter: "gst-bot-name-count", max: 64, label: "Nom du bot" },
        { key: "short_description", id: "gst-bot-profile-desc", counter: "gst-bot-profile-desc-count", max: 120, label: "Description du profil" },
        { key: "description", id: "gst-bot-start-desc", counter: "gst-bot-start-desc-count", max: 512, label: "Description au démarrage" }
    ];
    const BG_TARGETS_MAX = 20;
    const LOGS_COMMAND_RE = /^\/logs [A-Z0-9]{8}$/;
    const LOGS_CODE_POLL_MS = 6000;
    const botPanel = {
        status: null,          // dernière réponse de GET /admin/bot/status
        statusError: "",
        statusRequest: null,
        profile: null,         // profil lu sur Telegram : {id, username, name, short_description, description}
        profileError: "",
        profileBusy: false,
        profileReadAt: null,
        targetsBusy: false,
        codeExpiresAt: 0,
        codeTimer: null
    };

    function bindBotPanel() {
        // Profil du bot : compteurs et bouton « Enregistrer » suivent la saisie
        BOT_PROFILE_FIELDS.forEach((f) => {
            document.getElementById(f.id)?.addEventListener("input", renderBotProfile);
        });
        document.getElementById("gst-bot-profile-save-btn")?.addEventListener("click", saveBotProfile);
        document.getElementById("gst-bot-profile-reload-btn")?.addEventListener("click", () => loadBotProfile(true));
        // Interrupteurs : effet appliqué et état relu sur le serveur une fois l'enregistrement terminé
        onSettingSaved("crm_enabled", () => loadBotStatus(true));
        onSettingSaved("music_enabled", () => loadBotStatus(true));
        onSettingSaved("tg_logs_enabled", () => loadBotStatus(true));
        onSettingSaved("background_hide_desktop", () => {
            refreshShopBackground();
            loadBotStatus(true);
        });
        // Image de fond : fond d'origine, images par source
        document.getElementById("gst-bg-reset-btn")?.addEventListener("click", confirmResetBackground);
        document.getElementById("gst-bg-target-upload-input")?.addEventListener("change", addBackgroundTarget);
        // Logs Telegram : code de liaison, test, retrait du canal
        document.getElementById("gst-tg-logs-code-btn")?.addEventListener("click", generateLogsCode);
        document.getElementById("gst-tg-logs-copy-btn")?.addEventListener("click", copyLogsCommand);
        document.getElementById("gst-tg-logs-test-btn")?.addEventListener("click", sendLogsTest);
        document.getElementById("gst-tg-logs-unlink-btn")?.addEventListener("click", confirmUnlinkLogs);
        // Musique : la ligne d'état suit la playlist (redessinée par renderAdminMusic à chaque ajout ou retrait)
        const playlist = document.getElementById("gst-music-playlist-list");
        if (playlist && typeof MutationObserver === "function") new MutationObserver(renderMusicState).observe(playlist, { childList: true });
        // CRM : config publique en attendant /admin/bot/status (clé absente = actif)
        const adm = (state.config && state.config.admin) || {};
        applyCrmVisibility(!("crm_enabled" in adm) || adm.crm_enabled === "" || isOn(adm.crm_enabled));
        renderBotProfile();
        renderBotStatus();
    }

    // Chargeur des pages Profil du bot et Logs Telegram (ADMIN_PAGES / REGLAGES_SECTIONS)
    function loadBotPanelData() {
        return Promise.all([loadBotStatus(false), loadBotProfile(false)]);
    }

    // Après l'enregistrement d'un interrupteur de SETTINGS_FIELDS : l'écouteur de bindSettingsControls passe avant
    // celui-ci et a déjà mis l'envoi dans la file de la clé ; fn est appelée quand il est terminé (réussi ou non)
    function onSettingSaved(key, fn) {
        const field = SETTINGS_FIELDS.find((f) => f.key === key);
        const el = field ? document.getElementById(field.id) : null;
        if (!el) return;
        el.addEventListener("change", () => {
            Promise.resolve(adState.settingsQueue[key]).then(fn, fn);
        });
    }

    // true si l'état a été relu ; quiet : pas de toast en cas d'échec (rafraîchissement en arrière-plan)
    async function loadBotStatus(quiet) {
        if (!botPanel.statusRequest) {
            botPanel.statusRequest = adminRequest("/admin/bot/status").finally(() => {
                botPanel.statusRequest = null;
            });
        }
        const res = await botPanel.statusRequest;
        if (res.ok) {
            botPanel.status = res.data;
            botPanel.statusError = "";
        } else {
            botPanel.statusError = res.error || "État indisponible, réessaie.";
            if (!quiet) showToast(botPanel.statusError, "error");
        }
        renderBotStatus();
        return res.ok;
    }

    function renderBotStatus() {
        const s = botPanel.status;
        if (s) applyCrmVisibility(s.crm_enabled !== false);
        renderCrmState();
        renderMusicState();
        renderBackgroundTargets();
        renderLogsPanel();
    }

    // Ligne d'état sous un interrupteur ; tone : ok (vert), off (neutre), warn (jaune), bad (rouge) ; "" = masquée
    function setBotStateLine(id, text, tone) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle("is-open", tone === "ok");
        el.classList.toggle("is-off", tone === "off");
        el.classList.toggle("is-warn", tone === "warn");
        el.classList.toggle("is-closed", tone === "bad");
        el.style.display = text ? "" : "none";
    }

    // ----- CRM -----
    // Coupé : onglet Utilisateurs et compteurs des onglets Produits / Commandes masqués (classe sur le panel, access.css)
    function applyCrmVisibility(on) {
        const overlay = document.getElementById("admin-overlay");
        const changed = Boolean(overlay) && overlay.classList.contains("gst-crm-off") === on;
        if (overlay) overlay.classList.toggle("gst-crm-off", !on);
        // reorg : pastille « Clients » (Fiches clients) ajoutée ou retirée de la barre des pages
        if (changed && adState.activeTab === "clients" && adState.activePage !== "utilisateurs") renderAdminSubtabs();
        if (on) return;
        // Liste des clients oubliée : /admin/users répond « CRM désactivé » tant qu'il est coupé
        adState.usersList = [];
        adState.usersLoaded = false;
        if (adState.activePage === "utilisateurs") openAdminPage("verifications");
    }

    function renderCrmState() {
        const s = botPanel.status;
        if (!s) {
            setBotStateLine("gst-crm-state", "", "");
            return;
        }
        if (s.crm_enabled === false) setBotStateLine("gst-crm-state", "⚪ CRM coupé : fiches clients et compteurs masqués", "off");
        else setBotStateLine("gst-crm-state", "🟢 CRM actif : fiches clients et compteurs affichés", "ok");
    }

    // ----- Musique -----
    function renderMusicState() {
        const s = botPanel.status;
        if (!s) {
            setBotStateLine("gst-music-state", "", "");
            return;
        }
        const count = adState.musicLoaded ? adState.musicTracks.length : null;
        if (s.music_enabled === false) {
            setBotStateLine("gst-music-state", "🔇 Lecteur masqué dans la boutique", "off");
        } else if (count === 0) {
            setBotStateLine("gst-music-state", "⚠ Musique activée mais playlist vide : aucun lecteur dans la boutique", "warn");
        } else {
            setBotStateLine("gst-music-state", `🎵 Lecteur affiché dans la boutique${count ? ` · ${count} son${count > 1 ? "s" : ""} en boucle` : ""}`, "ok");
        }
    }

    // ----- Image de fond : fond d'origine, images par source de démarrage -----
    // La boutique (derrière le panel) suit tout de suite : même règle que pour les clients (shopBackgroundPath)
    function refreshShopBackground() {
        const adm = (state.config && state.config.admin) || {};
        applyShopBackgroundImage(typeof adm.background_image === "string" ? adm.background_image : "");
    }

    function confirmResetBackground() {
        const adm = (state.config && state.config.admin) || {};
        const current = adState.settingsSaved.background_image !== undefined ? adState.settingsSaved.background_image : adm.background_image;
        if (!current) {
            showToast("La boutique affiche déjà son fond d'origine.", "info");
            return;
        }
        showConfirmModal({
            title: "Revenir au fond d'origine ?",
            emoji: "🖼️",
            message: "L'image de fond choisie est retirée : la boutique reprend son fond d'origine. Les images par source restent.",
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                if (!await saveAdminSettings({ background_image: "" })) return;
                adState.settingsSaved.background_image = "";
                refreshShopBackground();
                const prevImg = document.getElementById("gst-bg-preview-img");
                if (prevImg) prevImg.src = "background.png";
                showToast("Fond d'origine rétabli");
            }
        });
    }

    function currentBackgroundTargets() {
        return botPanel.status ? parseBackgroundTargets(botPanel.status.background_targets) : [];
    }

    // Lien à partager : bot qui ouvre la boutique (le backup après une bascule), Mini App principale + startapp
    function backgroundTargetLink(source) {
        const bot = botPanel.status ? telegramHandle(botPanel.status.shop_bot_username) : "";
        return bot ? `https://t.me/${bot}?startapp=${encodeURIComponent(source)}` : "";
    }

    function renderBackgroundTargets() {
        const list = document.getElementById("gst-bg-targets-list");
        const uploadInput = document.getElementById("gst-bg-target-upload-input");
        if (uploadInput) uploadInput.disabled = !botPanel.status || botPanel.targetsBusy;
        if (!list) return;
        if (!botPanel.status) {
            if (botPanel.statusError) renderAdminListError(list, botPanel.statusError);
            else list.innerHTML = `<div class="gst-empty-placeholder">Chargement…</div>`;
            return;
        }
        const targets = currentBackgroundTargets();
        if (!targets.length) {
            list.innerHTML = `<div class="gst-empty-placeholder">Aucune source : tous les clients voient l'image de fond générale.</div>`;
            return;
        }
        const busy = botPanel.targetsBusy ? "disabled" : "";
        list.innerHTML = targets.map((t, i) => {
            const src = safeMediaUrl(resolveMediaUrl(t.image, "image"));
            const link = backgroundTargetLink(t.source);
            return `
                <div class="gst-cat-row gst-bg-target-row">
                    ${src ? `<img class="gst-bg-target-thumb" src="${escapeHtml(src)}" alt="" loading="lazy">` : `<span class="gst-cat-emoji">🖼️</span>`}
                    <div class="gst-cat-info">
                        <div class="gst-cat-name">${escapeHtml(t.source)}</div>
                        <div class="gst-cat-meta">${link ? escapeHtml(link) : "Lien disponible quand le bot sera démarré"}</div>
                    </div>
                    ${link ? `<button type="button" class="gst-btn-icon-copy" data-bg-target-copy="${i}" title="Copier le lien" aria-label="Copier le lien">📋</button>` : ""}
                    <button type="button" class="gst-btn-remove-sm" data-bg-target-remove="${i}" aria-label="Retirer cette source" ${busy}>✕</button>
                </div>`;
        }).join("");
        list.querySelectorAll("[data-bg-target-copy]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const target = targets[Number(btn.dataset.bgTargetCopy)];
                const link = target ? backgroundTargetLink(target.source) : "";
                if (!link) return;
                if (await copyTextToClipboard(link)) showToast("Lien copié ! 📋");
                else showToast(`Copie impossible : ${link}`, "error");
            });
        });
        list.querySelectorAll("[data-bg-target-remove]").forEach((btn) => {
            btn.addEventListener("click", () => confirmRemoveBackgroundTarget(Number(btn.dataset.bgTargetRemove)));
        });
    }

    // Nouvelle source : la photo est envoyée au serveur, puis la liste complète est enregistrée
    async function addBackgroundTarget(event) {
        const input = event.target;
        const file = input.files && input.files[0];
        if (!file) return;
        const sourceEl = document.getElementById("gst-bg-target-source");
        const source = sourceEl ? sourceEl.value.trim() : "";
        const targets = currentBackgroundTargets();
        let error = "";
        if (!botPanel.status) error = "Images par source indisponibles : rouvre la page Réglages › Image de fond.";
        else if (!START_SOURCE_RE.test(source)) error = "Source invalide : 1 à 64 lettres sans accent, chiffres, _ ou - (pas d'espace).";
        else if (targets.some((t) => t.source.toLowerCase() === source.toLowerCase())) error = `La source « ${source} » a déjà une image : retire-la d'abord.`;
        else if (targets.length >= BG_TARGETS_MAX) error = `${BG_TARGETS_MAX} sources maximum.`;
        else if (!isFileOfKind(file, "image")) error = "Choisis une image PNG, JPG ou WEBP.";
        if (error) {
            input.value = "";
            showToast(error, "error");
            return;
        }
        setUploadBusy(input, true);
        botPanel.targetsBusy = true;
        renderBackgroundTargets();
        showToast("Envoi de l'image… ⏳", "info");
        try {
            const path = uploadedPath(await uploadMediaFile(file, (percent) => showToast(`Envoi : ${percent}%`, "info")));
            if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
            if (await saveBackgroundTargets([...targets, { source, image: path }], `Image ajoutée pour « ${source} » 🖼️`) && sourceEl) sourceEl.value = "";
        } catch (err) {
            showToast(err.message, "error");
        } finally {
            setUploadBusy(input, false);
            botPanel.targetsBusy = false;
            renderBackgroundTargets();
        }
    }

    function confirmRemoveBackgroundTarget(index) {
        const target = currentBackgroundTargets()[index];
        if (!target) return;
        showConfirmModal({
            title: "Retirer cette source ?",
            emoji: "🖼️",
            message: `Les clients venus par <strong>${escapeHtml(target.source)}</strong> verront l'image de fond générale.`,
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                botPanel.targetsBusy = true;
                renderBackgroundTargets();
                await saveBackgroundTargets(currentBackgroundTargets().filter((t) => t.source !== target.source), `Source « ${target.source} » retirée`);
                botPanel.targetsBusy = false;
                renderBackgroundTargets();
            }
        });
    }

    // true seulement après l'enregistrement confirmé (POST /admin/background/targets)
    async function saveBackgroundTargets(targets, successMsg) {
        const res = await adminRequest("/admin/background/targets", { targets });
        if (!res.ok) {
            showToast(res.error, "error");
            return false;
        }
        if (res.data.config) applyUpdatedConfig(res.data.config);
        if (botPanel.status) botPanel.status.background_targets = Array.isArray(res.data.targets) ? res.data.targets : targets;
        refreshShopBackground();
        renderBackgroundTargets();
        showToast(successMsg);
        return true;
    }

    // ----- Profil du bot (appliqué sur Telegram) -----
    function readBotProfileFields() {
        const values = {};
        BOT_PROFILE_FIELDS.forEach((f) => {
            const el = document.getElementById(f.id);
            values[f.key] = el ? el.value.replace(/\r\n?/g, "\n").trim() : "";
        });
        return values;
    }

    // Mêmes règles que willy.py (bot_profile_values) ; longueur en unités UTF-16, comme maxlength et Telegram
    function botProfileError(values) {
        if (!values.name) return "Le nom du bot ne peut pas être vide.";
        const tooLong = BOT_PROFILE_FIELDS.find((f) => values[f.key].length > f.max);
        return tooLong ? `${tooLong.label} trop long (${tooLong.max} caractères max).` : "";
    }

    // Champs qui diffèrent du profil lu sur Telegram : seuls eux partent (Telegram limite les changements)
    function botProfileChanges(values) {
        const p = botPanel.profile || {};
        const changes = {};
        BOT_PROFILE_FIELDS.forEach((f) => {
            if (values[f.key] !== String(p[f.key] || "")) changes[f.key] = values[f.key];
        });
        return changes;
    }

    function fillBotProfile() {
        const p = botPanel.profile;
        if (!p) return;
        BOT_PROFILE_FIELDS.forEach((f) => {
            const el = document.getElementById(f.id);
            if (el) el.value = String(p[f.key] || "");
        });
        renderBotProfile();
    }

    function renderBotProfile() {
        const p = botPanel.profile;
        const username = p ? telegramHandle(p.username) : "";
        const handle = document.getElementById("gst-bot-profile-handle");
        if (handle) {
            handle.textContent = p
                ? (username ? `@${username}` : "Bot sans pseudo")
                : (botPanel.profileBusy ? "Lecture du profil sur Telegram…" : (botPanel.profileError || "Chargement…"));
        }
        const meta = document.getElementById("gst-bot-profile-meta");
        if (meta) {
            const id = p && /^\d{1,20}$/.test(String(p.id || "")) ? `ID : ${p.id}` : "";
            const read = p && botPanel.profileReadAt ? `lu sur Telegram à ${botPanel.profileReadAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
            meta.textContent = [id, read].filter(Boolean).join(" · ");
        }
        document.getElementById("gst-bot-profile-card")?.classList.toggle("is-down", !p && Boolean(botPanel.profileError));
        const usernameInput = document.getElementById("gst-bot-username-input");
        if (usernameInput && username) usernameInput.value = `@${username}`;
        BOT_PROFILE_FIELDS.forEach((f) => {
            const el = document.getElementById(f.id);
            if (el) el.disabled = !p || botPanel.profileBusy;
            const counter = document.getElementById(f.counter);
            if (counter) counter.textContent = p && el ? `${el.value.length}/${f.max}` : "—";
        });
        const reloadBtn = document.getElementById("gst-bot-profile-reload-btn");
        if (reloadBtn) reloadBtn.disabled = botPanel.profileBusy;
        const values = readBotProfileFields();
        const error = p ? botProfileError(values) : "";
        const changed = p ? Object.keys(botProfileChanges(values)).length : 0;
        const saveBtn = document.getElementById("gst-bot-profile-save-btn");
        if (saveBtn) {
            saveBtn.disabled = !p || botPanel.profileBusy || !changed || Boolean(error);
            saveBtn.textContent = p && botPanel.profileBusy ? "Envoi à Telegram…" : "Enregistrer sur Telegram";
        }
        const note = document.getElementById("gst-bot-profile-note");
        if (note) {
            note.textContent = !p
                ? (botPanel.profileError ? "Profil illisible : touche ↻ pour réessayer." : "Le profil est lu sur Telegram à l'ouverture de la page.")
                : error || (changed
                    ? `${changed} champ${changed > 1 ? "s" : ""} modifié${changed > 1 ? "s" : ""} : touche « Enregistrer sur Telegram ».`
                    : "Identique au profil Telegram. Telegram limite le nombre de changements : enregistre une fois tout prêt.");
            note.classList.toggle("is-error", Boolean(error));
        }
    }

    // force : relu chez Telegram (bouton ↻) ; sinon le serveur peut répondre avec sa copie d'il y a moins d'une minute
    async function loadBotProfile(force) {
        if (botPanel.profileBusy) return;
        // Rechargement automatique de l'onglet : une saisie pas encore enregistrée n'est pas écrasée
        const keepEdits = !force && botPanel.profile && Object.keys(botProfileChanges(readBotProfileFields())).length > 0;
        botPanel.profileBusy = true;
        renderBotProfile();
        const res = await adminRequest(`/admin/bot/profile${force ? "?refresh=1" : ""}`, undefined, 15000);
        botPanel.profileBusy = false;
        if (!res.ok || !res.data.profile || typeof res.data.profile !== "object") {
            botPanel.profileError = res.error || "Profil du bot illisible, réessaie.";
            if (force || !botPanel.profile) showToast(botPanel.profileError, "error");
            renderBotProfile();
            return;
        }
        botPanel.profile = res.data.profile;
        botPanel.profileError = "";
        botPanel.profileReadAt = new Date();
        if (keepEdits) renderBotProfile();
        else fillBotProfile();
    }

    async function saveBotProfile() {
        if (!botPanel.profile || botPanel.profileBusy) return;
        const values = readBotProfileFields();
        const error = botProfileError(values);
        if (error) {
            showToast(error, "error");
            return;
        }
        const changes = botProfileChanges(values);
        if (!Object.keys(changes).length) {
            showToast("Rien n'a changé par rapport au profil Telegram.", "info");
            return;
        }
        botPanel.profileBusy = true;
        renderBotProfile();
        const res = await adminRequest("/admin/bot/profile", { profile: changes }, 30000);
        botPanel.profileBusy = false;
        const data = res.data || {};
        // Profil renvoyé même en cas de refus : les champs déjà appliqués sont à jour, les autres gardent la saisie
        if (data.profile && typeof data.profile === "object") {
            botPanel.profile = data.profile;
            botPanel.profileReadAt = new Date();
        }
        if (res.ok) {
            fillBotProfile();
            showToast("Profil du bot mis à jour sur Telegram ✅");
            return;
        }
        renderBotProfile();
        showToast(res.error, "error");
    }

    // ----- Logs Telegram -----
    function renderLogsPanel() {
        const s = botPanel.status;
        const logs = s && s.logs && typeof s.logs === "object" ? s.logs : null;
        const titleEl = document.getElementById("gst-tg-logs-chat-title");
        const metaEl = document.getElementById("gst-tg-logs-chat-meta");
        const card = document.getElementById("gst-tg-logs-chat-card");
        const unlinkBtn = document.getElementById("gst-tg-logs-unlink-btn");
        const testBtn = document.getElementById("gst-tg-logs-test-btn");
        const botNameEl = document.getElementById("gst-tg-logs-bot-name");
        const botName = s ? telegramHandle(s.main_bot_username) : "";
        if (botNameEl) botNameEl.textContent = botName ? `@${botName}` : "le bot";
        if (!logs) {
            if (titleEl) titleEl.textContent = botPanel.statusError || "Chargement…";
            if (metaEl) metaEl.textContent = "";
            [unlinkBtn, testBtn].forEach((btn) => { if (btn) btn.disabled = true; });
            setBotStateLine("gst-tg-logs-state", "", "");
            return;
        }
        const kind = logs.chat_type === "channel" ? "Canal" : "Groupe";
        const title = plainText(String(logs.chat_title || "")).slice(0, 128);
        if (titleEl) titleEl.textContent = logs.chat_set ? (title || `${kind} sans titre`) : "Aucun canal de logs";
        if (metaEl) {
            const when = adminDate(logs.registered_at);
            const by = plainText(String(logs.registered_by || "")).slice(0, 80);
            metaEl.textContent = logs.chat_set
                ? `${kind}${when ? ` · enregistré le ${when.toLocaleDateString("fr-FR")}` : ""}${by ? ` par ${by}` : ""}`
                : "Génère un code ci-dessous, puis tape la commande dans ton canal.";
        }
        const lastError = plainText(String(logs.last_error || "")).slice(0, 200);
        if (card) {
            card.classList.toggle("is-off", !logs.chat_set);
            card.classList.toggle("is-down", Boolean(logs.chat_set && lastError));
        }
        if (unlinkBtn) unlinkBtn.disabled = !logs.chat_set;
        if (testBtn) testBtn.disabled = !logs.chat_set;
        if (logs.chat_set && lastError) {
            setBotStateLine("gst-tg-logs-state", `⚠ Dernier envoi refusé par Telegram : ${lastError}`, "bad");
        } else if (logs.enabled && logs.chat_set) {
            const sent = adminDate(logs.last_sent_at);
            setBotStateLine("gst-tg-logs-state", `🟢 Logs actifs${sent ? ` · dernier envoi à ${sent.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}`, "ok");
        } else if (logs.enabled) {
            setBotStateLine("gst-tg-logs-state", "⚠ Logs activés mais aucun canal enregistré : rien n'est publié", "warn");
        } else {
            setBotStateLine("gst-tg-logs-state", logs.chat_set ? "⚪ Logs coupés : active l'interrupteur pour publier dans le canal" : "⚪ Logs coupés", "off");
        }
        // Code encore valable (généré avant un rechargement ou depuis un autre appareil) : réaffiché
        if (!botPanel.codeExpiresAt && /^[A-Z0-9]{8}$/.test(String(logs.code || "")) && Number(logs.code_expires_in) > 0) {
            showLogsCode(`/logs ${logs.code}`, Number(logs.code_expires_in));
        }
    }

    // Commande « /logs CODE » affichée ; tant qu'elle est valable, l'enregistrement du canal est guetté
    function showLogsCode(command, seconds) {
        const valid = LOGS_COMMAND_RE.test(command) && seconds > 0;
        const input = document.getElementById("gst-tg-logs-code");
        if (input) input.value = valid ? command : "";
        const copyBtn = document.getElementById("gst-tg-logs-copy-btn");
        if (copyBtn) copyBtn.disabled = !valid;
        clearInterval(botPanel.codeTimer);
        botPanel.codeTimer = null;
        botPanel.codeExpiresAt = valid ? Date.now() + seconds * 1000 : 0;
        if (valid) {
            const logs = botPanel.status && botPanel.status.logs;
            const registeredAt = logs ? Number(logs.registered_at) || 0 : 0;
            botPanel.codeTimer = setInterval(() => watchLogsCode(registeredAt), LOGS_CODE_POLL_MS);
        }
        renderLogsCodeNote();
    }

    function renderLogsCodeNote() {
        const note = document.getElementById("gst-tg-logs-code-note");
        if (!note) return;
        const left = Math.round((botPanel.codeExpiresAt - Date.now()) / 1000);
        note.textContent = left > 0
            ? `Code à usage unique, valable encore ${Math.max(1, Math.ceil(left / 60))} min. Le canal apparaît ici dès qu'il est enregistré.`
            : "Code à usage unique, valable 15 minutes.";
    }

    async function watchLogsCode(registeredAt) {
        if (Date.now() >= botPanel.codeExpiresAt) {
            showLogsCode("", 0);
            return;
        }
        renderLogsCodeNote();
        if (!isShown(document.getElementById("admin-overlay")) || adState.activePage !== "logs" || botPanel.statusRequest) return;
        if (!await loadBotStatus(true)) return;
        const logs = botPanel.status && botPanel.status.logs;
        if (logs && logs.chat_set && Number(logs.registered_at) > registeredAt) {
            showLogsCode("", 0);
            showToast(`Canal de logs enregistré : ${plainText(String(logs.chat_title || "")) || "sans titre"} ✅`);
        }
    }

    async function generateLogsCode() {
        const btn = document.getElementById("gst-tg-logs-code-btn");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/tglogs/code", {});
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        showLogsCode(String(res.data.command || ""), Number(res.data.expires_in) || 0);
        showToast("Code prêt : copie la commande et envoie-la dans ton canal de logs");
    }

    async function copyLogsCommand() {
        const input = document.getElementById("gst-tg-logs-code");
        const command = input ? input.value : "";
        if (!LOGS_COMMAND_RE.test(command)) return;
        if (await copyTextToClipboard(command)) {
            showToast("Commande copiée ! 📋");
        } else {
            input.select();
            showToast("Copie impossible : la commande est sélectionnée, copie-la à la main.", "error");
        }
    }

    async function sendLogsTest() {
        const btn = document.getElementById("gst-tg-logs-test-btn");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/tglogs/test", {}, 20000);
        if (btn) btn.disabled = false;
        if (res.ok) showToast("Message de test publié dans le canal de logs ✅");
        else showToast(res.error, "error");
        loadBotStatus(true);
    }

    function confirmUnlinkLogs() {
        const logs = botPanel.status && botPanel.status.logs;
        if (!logs || !logs.chat_set) return;
        showConfirmModal({
            title: "Retirer le canal de logs ?",
            emoji: "📜",
            message: "Le bot ne publiera plus rien dans ce canal et l'interrupteur « Logs Telegram » sera coupé. Tu pourras en enregistrer un autre avec /logs.",
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const res = await adminRequest("/admin/tglogs/unlink", {});
                if (!res.ok) {
                    showToast(res.error, "error");
                    return;
                }
                adState.settingsSaved.tg_logs_enabled = false;
                const toggle = document.getElementById("gst-tg-logs-toggle");
                if (toggle) toggle.checked = false;
                showToast("Canal de logs retiré");
                await loadBotStatus(true);
            }
        });
    }


    // ===== ÉQUIPE MESSAGES : diffusion avancée, modèles, messages automatiques, tickets SAV, autoclean =====
    // Routes de willy.py : /admin/messages/* et /admin/support/* (gestion), /support/ticket* (boutique, plus bas).
    // Les interrupteurs simples (auto_messages_enabled, tickets_enabled, tickets_target, autoclean_*) sont dans SETTINGS_FIELDS.
    const MSG_CAPTION_MAX = 1024;
    const MSG_INACTIVE_DEFAULT = 30;
    const MSG_IMAGE_MAX_MB = 10;   // limites de Telegram pour un bot (photo / fichier)
    const MSG_VIDEO_MAX_MB = 50;
    // 0 = lundi … 6 = dimanche, comme datetime.weekday() dans willy.py
    const MSG_WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
    const MSG_TARGET_TEXT = {
        all: "tous les utilisateurs du bot",
        active: "les clients actifs ces 7 derniers jours",
        inactive: "les clients inactifs",
        city: "les clients d'une ville",
        verified: "les clients vérifiés"
    };
    const MSG_TARGET_SHORT = { all: "Tous", active: "Actifs (7 j)", inactive: "Inactifs", city: "Par ville", verified: "Vérifiés" };
    const MSG_TYPE_ICONS = { text: "📝", image: "🖼", video: "🎬" };
    const MSG_FORMATS = {
        b: ["<b>", "</b>"], i: ["<i>", "</i>"], u: ["<u>", "</u>"], s: ["<s>", "</s>"],
        code: ["<code>", "</code>"], spoiler: ["<tg-spoiler>", "</tg-spoiler>"]
    };
    const msgHas = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const msgState = {
        loaded: false,
        cities: [],
        backup: { ready: false, username: "", users: 0 },
        templates: [],
        auto: [],
        serverTime: "",
        status: null,
        composer: { type: "text", media: "", target: "all", days: MSG_INACTIVE_DEFAULT, city: "", backup: false },
        uploading: false,
        count: null,
        countSeq: 0,
        countTimer: null,
        statusTimer: null,
        // Formulaire d'un message automatique (null = fermé)
        editor: null,
        editorUploading: false,
        // Tickets : réglages du support (groupe enregistré…), ticket ouvert dans la modale
        support: null,
        ticketCounts: null,
        ticket: null,
        ticketTimer: null,
        ticketPoll: 0,         // chaîne de rafraîchissement de la modale en cours (une seule à la fois)
        ticketBusy: false,
        autocleanObserver: null
    };

    // --- Mise en forme HTML de Telegram (mêmes règles que telegram_html_error dans willy.py) ---
    const TG_HTML_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "span", "blockquote"]);

    function telegramTagAttrsError(name, attrs) {
        if (name === "a") {
            return /^\s+href\s*=\s*(["'])(?:https?|tg):\/\/[^"'<>\s]+\1\s*$/i.test(attrs)
                ? "" : "Lien refusé : écris <a href=\"https://…\">texte</a> (adresse en https://).";
        }
        if (name === "span") {
            return /^\s+class\s*=\s*(["'])tg-spoiler\1\s*$/.test(attrs)
                ? "" : "La balise <span> ne sert qu'au spoiler : <span class=\"tg-spoiler\">…</span> (ou <tg-spoiler>).";
        }
        if (!attrs.trim()) return "";
        if (name === "code" && /^\s+class\s*=\s*(["'])language-[A-Za-z0-9_+-]{1,32}\1\s*$/.test(attrs)) return "";
        if (name === "blockquote" && attrs.trim().toLowerCase() === "expandable") return "";
        return `La balise <${name}> ne prend pas d'attribut.`;
    }

    // Message d'erreur si Telegram refuserait la mise en forme (balise inconnue, mal fermée, « < » seul), sinon ""
    function telegramHtmlError(text) {
        const src = String(text || "");
        const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)>/y;
        const stack = [];
        let pos = 0;
        for (;;) {
            const start = src.indexOf("<", pos);
            if (start < 0) break;
            tagRe.lastIndex = start;
            const m = tagRe.exec(src);
            if (!m) return "Caractère « < » seul : écris &lt; à la place (ou utilise la barre de mise en forme).";
            const closing = m[1] === "/";
            const name = m[2].toLowerCase();
            const attrs = m[3] || "";
            if (!TG_HTML_TAGS.has(name)) return `Balise <${name}> refusée par Telegram : utilise gras, italique, souligné, barré, lien, code ou spoiler.`;
            if (closing) {
                if (attrs.trim()) return `Balise </${name}> mal écrite.`;
                if (!stack.length) return `Balise </${name}> fermée sans avoir été ouverte.`;
                const open = stack[stack.length - 1];
                if (open !== name) return `Balises mal imbriquées : ferme <${open}> avant </${name}>.`;
                stack.pop();
            } else {
                const error = telegramTagAttrsError(name, attrs);
                if (error) return error;
                stack.push(name);
            }
            pos = tagRe.lastIndex;
        }
        if (stack.length) {
            const open = stack[stack.length - 1];
            return `Balise <${open}> jamais fermée : ajoute </${open}>.`;
        }
        return "";
    }

    function decodeTelegramEntities(text) {
        const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
        return String(text || "").replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (all, ent) => {
            const e = ent.toLowerCase();
            if (e[0] !== "#") return named[e];
            const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try {
                return String.fromCodePoint(code);
            } catch (_) {
                return all;
            }
        });
    }

    // Texte visible (balises retirées) : c'est lui que Telegram compte pour la légende d'un média (1024 max)
    function telegramPlainText(text) {
        return decodeTelegramEntities(String(text || "").replace(/<\/?[A-Za-z][^<>]*>/g, ""));
    }

    // Comme escapeHtml, sans retirer les espaces autour (morceaux de texte de l'aperçu)
    function msgEscape(text) {
        return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
    }

    // Aperçu du message tel que Telegram l'affiche : seules les balises connues deviennent de la mise en forme
    // (sans attribut ni lien cliquable) ; tout le reste est du texte échappé
    function telegramHtmlPreview(text) {
        const src = String(text || "");
        const simple = { b: "b", strong: "b", i: "i", em: "i", u: "u", ins: "u", s: "s", strike: "s", del: "s", code: "code", pre: "pre", blockquote: "blockquote" };
        const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)>/g;
        const out = [];
        let pos = 0;
        let m;
        while ((m = re.exec(src))) {
            out.push(msgEscape(decodeTelegramEntities(src.slice(pos, m.index))));
            const closing = m[1] === "/";
            const name = m[2].toLowerCase();
            if (msgHas(simple, name)) out.push(`<${closing ? "/" : ""}${simple[name]}>`);
            else if (name === "a") out.push(closing ? "</span>" : "<span class=\"gst-preview-link\">");
            else if (name === "tg-spoiler" || name === "span") out.push(closing ? "</span>" : "<span class=\"gst-msg-spoiler\">");
            else out.push(msgEscape(m[0]));
            pos = re.lastIndex;
        }
        out.push(msgEscape(decodeTelegramEntities(src.slice(pos))));
        return out.join("");
    }

    // Barre de format : entoure la sélection (ou « texte ») des balises ; lien = curseur placé sur l'adresse à compléter
    function msgApplyFormat(textarea, cmd) {
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = textarea.value.substring(start, end);
        if (cmd === "link") {
            const opening = "<a href=\"https://";
            textarea.setRangeText(`${opening}">${selected || "texte du lien"}</a>`, start, end, "end");
            textarea.setSelectionRange(start + opening.length, start + opening.length);
        } else if (msgHas(MSG_FORMATS, cmd)) {
            const [open, close] = MSG_FORMATS[cmd];
            textarea.setRangeText(`${open}${selected || "texte"}${close}`, start, end, "select");
        } else {
            return;
        }
        textarea.focus();
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Erreur du contenu (texte / média / légende) avant tout envoi au serveur, "" si tout va bien
    function msgContentError(p) {
        if (p.media_type === "text" && !p.message) return "Le message est vide.";
        if (p.media_type !== "text" && !p.media_url) return `Ajoute d'abord ${p.media_type === "image" ? "l'image" : "la vidéo"} avec le bouton « Choisir… ».`;
        if (p.message.length > BROADCAST_MAX_CHARS) return `Message trop long (${BROADCAST_MAX_CHARS} caractères max).`;
        const htmlError = telegramHtmlError(p.message);
        if (htmlError) return htmlError;
        if (p.media_type !== "text" && telegramPlainText(p.message).length > MSG_CAPTION_MAX) {
            return `Légende trop longue : ${MSG_CAPTION_MAX} caractères maximum sous une image ou une vidéo.`;
        }
        return "";
    }

    function msgAudienceError(target, days, city) {
        if (target === "inactive" && !(Number.isInteger(days) && days >= 1 && days <= 365)) return "Inactifs depuis : nombre de jours entre 1 et 365.";
        if (target === "city" && !city) return "Choisis la ville des destinataires.";
        return "";
    }

    function msgPlural(n, word) {
        return `${n} ${word}${n > 1 ? "s" : ""}`;
    }

    function msgTime(ts) {
        const d = adminDate(ts);
        return d ? d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    }

    function msgCityName(key) {
        const city = msgState.cities.find((c) => c.key === key);
        return city ? city.name : key;
    }

    function msgTargetLabel(target, days, city) {
        if (target === "inactive") return `les clients inactifs depuis plus de ${msgPlural(days, "jour")}`;
        if (target === "city") return `les clients de ${msgCityName(city) || "la ville choisie"}`;
        return msgHas(MSG_TARGET_TEXT, target) ? MSG_TARGET_TEXT[target] : MSG_TARGET_TEXT.all;
    }

    // Média d'un message (aperçu du composeur, d'un créneau) : image ou vidéo servie par willy.py
    function msgMediaHtml(type, url) {
        const src = url ? safeMediaUrl(resolveMediaUrl(url, type === "video" ? "video" : "image")) : "";
        if (!src) return `<div class="gst-empty-placeholder">${type === "video" ? "Aucune vidéo choisie" : "Aucune image choisie"}</div>`;
        return type === "video"
            ? `<video src="${escapeHtml(src)}" controls muted playsinline preload="metadata"></video>`
            : `<img src="${escapeHtml(src)}" alt="Média du message">`;
    }

    // Envoi d'un fichier du composeur ou d'un créneau : vérifie le type et la limite de Telegram, renvoie /uploads/…
    async function msgUploadFile(file, type) {
        const kind = type === "video" ? "video" : "image";
        if (!isFileOfKind(file, kind)) throw new Error(kind === "video" ? "Choisis une vidéo (MP4 conseillé)." : "Choisis une image JPG, PNG ou WEBP.");
        if (kind === "image" && /\.gif$/i.test(file.name || "")) throw new Error("GIF non accepté : choisis une image JPG, PNG ou WEBP.");
        const maxMb = kind === "video" ? MSG_VIDEO_MAX_MB : MSG_IMAGE_MAX_MB;
        if (file.size > maxMb * 1024 * 1024) throw new Error(`Fichier trop lourd pour Telegram : ${maxMb} Mo maximum.`);
        showToast("Envoi du fichier… ⏳", "info");
        const path = uploadedPath(await uploadMediaFile(file, (percent) => showToast(`Envoi : ${percent}%`, "info")));
        if (!path) throw new Error("Réponse inattendue du serveur après l'envoi.");
        return path;
    }

    // --- Chargement de l'onglet Messages ---
    async function loadAdminMessagesData() {
        // Interrupteur « Messages automatiques » (SETTINGS_FIELDS) : relu avec les autres réglages
        loadAdminSettingsData();
        const res = await adminRequest("/admin/messages/state");
        if (!res.ok) {
            const list = document.getElementById("gst-msg-templates-list");
            renderAdminListError(list, res.error);
            renderAdminListError(document.getElementById("gst-auto-slots-list"), res.error);
            showToast(res.error, "error");
            return;
        }
        const data = res.data;
        msgState.loaded = true;
        msgState.cities = Array.isArray(data.cities) ? data.cities.filter((c) => c && c.key).map((c) => ({ key: String(c.key), name: String(c.name || c.key) })) : [];
        msgState.backup = data.backup && typeof data.backup === "object"
            ? { ready: data.backup.ready === true, username: String(data.backup.username || ""), users: Number(data.backup.users) || 0 }
            : { ready: false, username: "", users: 0 };
        msgState.templates = Array.isArray(data.templates) ? data.templates : [];
        msgState.auto = Array.isArray(data.auto) ? data.auto : [];
        msgState.serverTime = String(data.server_time || "");
        msgState.status = data.status || null;
        if (msgState.composer.city && !msgState.cities.some((c) => c.key === msgState.composer.city)) msgState.composer.city = "";
        if (!msgState.backup.ready) msgState.composer.backup = false;
        renderMsgComposer();
        renderMsgTemplates();
        renderAutoMessages();
        renderMsgStatus();
        msgScheduleCount(0);
        if (msgState.status && msgState.status.running) msgPollStatus();
    }

    // --- Composeur de diffusion ---
    function msgComposerPayload() {
        const textarea = document.getElementById("gst-broadcast-msg-textarea");
        const c = msgState.composer;
        return {
            message: textarea ? textarea.value.trim() : "",
            media_type: c.type,
            media_url: c.type === "text" ? "" : c.media,
            target: c.target,
            days: c.days,
            city: c.target === "city" ? c.city : "",
            also_backup: c.backup
        };
    }

    // Compteur, état de la mise en forme et aperçu d'une zone de message (composeur ou formulaire d'un créneau)
    function renderMsgTextState(textarea, type, media, counterId, stateId, previewId) {
        const text = textarea ? textarea.value : "";
        const counter = document.getElementById(counterId);
        const isMedia = type !== "text";
        if (counter) {
            const used = isMedia ? telegramPlainText(text.trim()).length : text.length;
            const max = isMedia ? MSG_CAPTION_MAX : BROADCAST_MAX_CHARS;
            counter.textContent = `${used}/${max}`;
            counter.classList.toggle("is-over", used > max);
        }
        const stateEl = document.getElementById(stateId);
        if (stateEl) {
            const error = telegramHtmlError(text);
            stateEl.textContent = error ? `⚠ ${error}` : (/<[A-Za-z]/.test(text) ? "✓ Mise en forme valide" : "");
            stateEl.classList.toggle("is-error", Boolean(error));
        }
        const preview = previewId ? document.getElementById(previewId) : null;
        if (preview) {
            const mediaHtml = isMedia ? `<div class="gst-msg-preview-media">${msgMediaHtml(type, media)}</div>` : "";
            const body = text.trim()
                ? `<div class="gst-msg-preview-text">${telegramHtmlPreview(text.trim())}</div>`
                : (isMedia ? "" : "<div class=\"gst-msg-preview-text gst-msg-preview-empty\">Ton message apparaîtra ici.</div>");
            preview.innerHTML = mediaHtml + body;
        }
    }

    function renderMsgComposer() {
        const c = msgState.composer;
        document.querySelectorAll("#gst-msg-type-row [data-msgtype]").forEach((btn) => btn.classList.toggle("active", btn.dataset.msgtype === c.type));
        const mediaGroup = document.getElementById("gst-msg-media-group");
        const isMedia = c.type !== "text";
        if (mediaGroup) mediaGroup.hidden = !isMedia;
        const mediaLabel = document.getElementById("gst-msg-media-label");
        if (mediaLabel) mediaLabel.textContent = c.type === "video" ? "Vidéo" : "Image";
        const mediaInput = document.getElementById("gst-msg-media-input");
        if (mediaInput) {
            mediaInput.accept = c.type === "video" ? "video/*" : "image/png,image/jpeg,image/webp";
            mediaInput.disabled = msgState.uploading;
        }
        const hint = document.getElementById("gst-msg-media-hint");
        if (hint) hint.textContent = c.type === "video" ? `MP4 conseillé, ${MSG_VIDEO_MAX_MB} Mo max (limite de Telegram pour un bot).` : `JPG, PNG ou WEBP, ${MSG_IMAGE_MAX_MB} Mo max.`;
        const mediaPreview = document.getElementById("gst-msg-media-preview");
        if (mediaPreview && isMedia) mediaPreview.innerHTML = msgState.uploading ? "<div class=\"gst-empty-placeholder\">Envoi en cours…</div>" : msgMediaHtml(c.type, c.media);
        const clearBtn = document.getElementById("gst-msg-media-clear-btn");
        if (clearBtn) clearBtn.disabled = !c.media || msgState.uploading;
        const textLabel = document.getElementById("gst-msg-text-label");
        if (textLabel) textLabel.textContent = isMedia ? "Légende (facultative)" : "Message";

        document.querySelectorAll("#gst-msg-target-row [data-msgtarget]").forEach((btn) => btn.classList.toggle("active", btn.dataset.msgtarget === c.target));
        const inactiveBox = document.getElementById("gst-msg-inactive-box");
        if (inactiveBox) inactiveBox.hidden = c.target !== "inactive";
        const daysInput = document.getElementById("gst-msg-inactive-days");
        if (daysInput && document.activeElement !== daysInput) daysInput.value = String(c.days);
        const cityBox = document.getElementById("gst-msg-city-box");
        if (cityBox) cityBox.hidden = c.target !== "city";
        const citySelect = document.getElementById("gst-msg-city-select");
        if (citySelect) {
            citySelect.innerHTML = msgState.cities.length
                ? `<option value="">Choisis une ville…</option>` + msgState.cities.map((city) => `<option value="${escapeHtml(city.key)}">${escapeHtml(city.name)}</option>`).join("")
                : "<option value=\"\">Aucune ville créée (Catalogue › Villes)</option>";
            citySelect.value = c.city;
            citySelect.disabled = !msgState.cities.length;
        }

        const backupToggle = document.getElementById("gst-broadcast-backup-toggle");
        if (backupToggle) {
            backupToggle.disabled = !msgState.backup.ready;
            backupToggle.checked = c.backup && msgState.backup.ready;
        }
        const backupState = document.getElementById("gst-msg-backup-state");
        if (backupState) {
            backupState.textContent = msgState.backup.ready
                ? `(@${msgState.backup.username || "backup"} · ${msgPlural(msgState.backup.users, "utilisateur")})`
                : "(bot backup arrêté : Réglages › Bot backup)";
        }
        renderMsgTextState(document.getElementById("gst-broadcast-msg-textarea"), c.type, c.media, "gst-msg-char-count", "gst-msg-html-state", "gst-msg-preview");
    }

    // Nombre de destinataires du filtre, calculé par le serveur (même calcul que l'envoi)
    function msgScheduleCount(delay) {
        clearTimeout(msgState.countTimer);
        msgState.countTimer = setTimeout(msgRefreshCount, delay === undefined ? 400 : delay);
    }

    async function msgRefreshCount() {
        const line = document.getElementById("gst-broadcast-recipients-count");
        const c = msgState.composer;
        const audienceError = msgAudienceError(c.target, c.days, c.city);
        if (audienceError) {
            msgState.count = null;
            if (line) line.textContent = `⚠ ${audienceError}`;
            return;
        }
        const seq = ++msgState.countSeq;
        if (line) line.textContent = "Comptage des destinataires…";
        const params = new URLSearchParams({ target: c.target, days: String(c.days), city: c.target === "city" ? c.city : "", backup: c.backup ? "1" : "0" });
        const res = await adminRequest(`/admin/messages/count?${params.toString()}`);
        if (seq !== msgState.countSeq) return;
        if (!res.ok) {
            msgState.count = null;
            if (line) line.textContent = `⚠ ${res.error}`;
            return;
        }
        msgState.count = { main: Number(res.data.main) || 0, backup: Number(res.data.backup) || 0 };
        if (line) {
            const extra = c.backup ? ` + ${msgPlural(msgState.count.backup, "envoi")} par le bot backup` : "";
            line.textContent = `📬 ${msgPlural(msgState.count.main, "destinataire")} (${msgTargetLabel(c.target, c.days, c.city)})${extra}`;
        }
    }

    function msgSetComposer(changes) {
        Object.assign(msgState.composer, changes);
        renderMsgComposer();
    }

    async function msgSendBroadcast() {
        if (msgState.uploading) {
            showToast("Attends la fin de l'envoi du fichier.", "info");
            return;
        }
        const p = msgComposerPayload();
        const error = msgContentError(p) || msgAudienceError(p.target, p.days, p.city);
        if (error) {
            showToast(error, "error");
            return;
        }
        const count = msgState.count;
        const total = count ? count.main + (p.also_backup ? count.backup : 0) : null;
        if (total === 0) {
            showToast("Aucun destinataire pour ce filtre.", "error");
            return;
        }
        const who = escapeHtml(msgTargetLabel(p.target, p.days, p.city));
        const howMany = total === null ? "" : ` (<strong>${escapeHtml(msgPlural(total, "envoi"))}</strong>)`;
        showConfirmModal({
            title: "Envoyer ce message ?",
            emoji: p.media_type === "text" ? "📢" : msgTypeIcon(p.media_type),
            message: `Destinataires : <strong>${who}</strong>${howMany}${p.also_backup ? ", aussi par le bot backup" : ""}.<br>Un envoi lancé ne peut pas être annulé.`,
            confirmText: "Oui, envoyer",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: async () => {
                const btn = document.getElementById("gst-broadcast-send-btn");
                if (btn) btn.disabled = true;
                const res = await adminRequest("/admin/messages/broadcast", p, 30000);
                if (btn) btn.disabled = false;
                if (res.ok) {
                    const sent = Number(res.data.total) || 0;
                    showToast(`Envoi lancé : ${msgPlural(sent, "destinataire")} 📢`);
                    msgPollStatus();
                } else if (res.status === 409) {
                    showToast("Un envoi est déjà en cours : attends qu'il soit terminé.", "error");
                    msgPollStatus();
                } else {
                    showToast(res.error, "error");
                }
            }
        });
    }

    async function msgSendTest() {
        if (msgState.uploading) {
            showToast("Attends la fin de l'envoi du fichier.", "info");
            return;
        }
        const p = msgComposerPayload();
        const error = msgContentError(p);
        if (error) {
            showToast(error, "error");
            return;
        }
        const btn = document.getElementById("gst-msg-test-btn");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/messages/test", { message: p.message, media_type: p.media_type, media_url: p.media_url }, 60000);
        if (btn) btn.disabled = false;
        if (res.ok) showToast("Test envoyé dans ta conversation avec le bot ✅");
        else showToast(res.error, "error");
    }

    // --- Suivi de l'envoi en cours / dernier envoi ---
    function renderMsgStatus() {
        const line = document.getElementById("gst-msg-status-line");
        if (!line) return;
        const s = msgState.status;
        if (s && s.running) {
            line.textContent = s.total ? `⏳ Envoi en cours : ${s.done}/${s.total}${s.label ? ` (${s.label})` : ""}…` : "⏳ Un envoi est en cours…";
            return;
        }
        const last = s && s.last;
        if (!last) {
            line.textContent = "";
            return;
        }
        const parts = [`${msgPlural(Number(last.sent) || 0, "envoyé")}`, `${msgPlural(Number(last.blocked) || 0, "bloqué")}`, `${msgPlural(Number(last.failed) || 0, "échec")}`];
        line.textContent = `${last.error ? "⚠" : "✅"} Dernier envoi${last.label ? ` (${last.label})` : ""} ${msgTime(last.finished_at)} : ${parts.join(" · ")}${last.error ? ` — ${last.error}` : ""}`;
    }

    function msgPollStatus() {
        clearTimeout(msgState.statusTimer);
        const tick = async () => {
            const panelOpen = isShown(document.getElementById("admin-overlay"));
            if (!panelOpen || adState.activePage !== "diffusion") return;
            const res = await adminRequest("/admin/messages/status");
            if (res.ok) {
                msgState.status = res.data.status || null;
                renderMsgStatus();
            }
            if (!res.ok || (msgState.status && msgState.status.running)) {
                msgState.statusTimer = setTimeout(tick, 3000);
            } else {
                // envoi terminé : les comptes rendus des messages automatiques ont pu changer
                refreshAutoMessages();
            }
        };
        msgState.statusTimer = setTimeout(tick, 1200);
    }

    // --- Modèles ---
    function renderMsgTemplates() {
        const list = document.getElementById("gst-msg-templates-list");
        const count = document.getElementById("gst-msg-templates-count");
        if (count) count.textContent = String(msgState.templates.length);
        if (!list) return;
        if (!msgState.templates.length) {
            list.innerHTML = "<div class=\"gst-empty-placeholder\">Aucun modèle : écris un message puis « 💾 Enregistrer l'actuel ».</div>";
            return;
        }
        list.innerHTML = msgState.templates.map((tpl) => {
            const snippet = telegramPlainText(String(tpl.message || "")).replace(/\s+/g, " ").trim();
            const short = snippet.length > 70 ? `${snippet.slice(0, 70)}…` : snippet;
            return `
                <div class="gst-msg-template-row">
                    <div class="gst-msg-template-info">
                        <strong>${msgTypeIcon(tpl.media_type)} ${escapeHtml(String(tpl.name || ""))}</strong>
                        <span class="gst-order-meta">${short ? escapeHtml(short) : "(sans texte)"}</span>
                    </div>
                    <div class="gst-msg-template-actions">
                        <button type="button" class="gst-btn-chip-action" data-tpl-load="${Number(tpl.id)}">Charger</button>
                        <button type="button" class="gst-btn-chip-action danger" data-tpl-delete="${Number(tpl.id)}" aria-label="Supprimer le modèle">🗑</button>
                    </div>
                </div>`;
        }).join("");
    }

    function msgLoadTemplate(id) {
        const tpl = msgState.templates.find((t) => Number(t.id) === id);
        const textarea = document.getElementById("gst-broadcast-msg-textarea");
        if (!tpl || !textarea) return;
        const apply = () => {
            textarea.value = String(tpl.message || "");
            const type = ["text", "image", "video"].includes(tpl.media_type) ? tpl.media_type : "text";
            msgSetComposer({ type, media: type === "text" ? "" : String(tpl.media_url || "") });
            const nameInput = document.getElementById("gst-msg-template-name");
            if (nameInput) nameInput.value = String(tpl.name || "");
            showToast(`Modèle « ${tpl.name} » chargé`);
        };
        const current = textarea.value.trim();
        if (current && current !== String(tpl.message || "").trim()) {
            showConfirmModal({
                title: "Remplacer le message ?",
                emoji: "📚",
                message: `Le message en cours sera remplacé par le modèle <strong>${escapeHtml(String(tpl.name || ""))}</strong>.`,
                confirmText: "Remplacer",
                cancelText: "Annuler",
                isDanger: false,
                onConfirm: apply
            });
        } else {
            apply();
        }
    }

    async function msgSaveTemplate() {
        const nameInput = document.getElementById("gst-msg-template-name");
        const name = nameInput ? nameInput.value.trim() : "";
        if (!name) {
            showToast("Donne un nom au modèle.", "error");
            if (nameInput) nameInput.focus();
            return;
        }
        if (msgState.uploading) {
            showToast("Attends la fin de l'envoi du fichier.", "info");
            return;
        }
        const p = msgComposerPayload();
        const error = msgContentError(p);
        if (error) {
            showToast(error, "error");
            return;
        }
        const btn = document.getElementById("gst-msg-template-confirm-btn");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/messages/templates/save", { name, message: p.message, media_type: p.media_type, media_url: p.media_url });
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        msgState.templates = Array.isArray(res.data.templates) ? res.data.templates : msgState.templates;
        renderMsgTemplates();
        const row = document.getElementById("gst-msg-template-save-row");
        if (row) row.hidden = true;
        showToast(`Modèle « ${name} » enregistré 💾`);
    }

    function msgDeleteTemplate(id) {
        const tpl = msgState.templates.find((t) => Number(t.id) === id);
        if (!tpl) return;
        showConfirmModal({
            title: "Supprimer ce modèle ?",
            emoji: "🗑",
            message: `Le modèle <strong>${escapeHtml(String(tpl.name || ""))}</strong> sera supprimé.`,
            confirmText: "Supprimer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const res = await adminRequest("/admin/messages/templates/delete", { id });
                if (!res.ok) {
                    showToast(res.error, "error");
                    return;
                }
                msgState.templates = Array.isArray(res.data.templates) ? res.data.templates : msgState.templates.filter((t) => Number(t.id) !== id);
                renderMsgTemplates();
                showToast("Modèle supprimé");
            }
        });
    }

    // --- Messages automatiques ---
    function msgTypeIcon(type) {
        return msgHas(MSG_TYPE_ICONS, type) ? MSG_TYPE_ICONS[type] : "📝";
    }

    function autoTargetText(item) {
        const label = msgHas(MSG_TARGET_SHORT, item.target) ? MSG_TARGET_SHORT[item.target] : "Tous";
        if (item.target === "inactive") return `${label} (+${item.target_days} j)`;
        if (item.target === "city") return `${label} : ${msgCityName(item.target_city)}`;
        return label;
    }

    function autoResultText(item) {
        const r = item.last_result;
        if (!item.last_sent_at && !r) return "Jamais envoyé";
        const when = msgTime(r && r.at ? r.at : item.last_sent_at);
        if (!r) return `Envoi lancé ${when}…`;
        if (r.error && !r.sent) return `⚠ ${when} : ${r.error}`;
        return `✅ ${when} : ${msgPlural(Number(r.sent) || 0, "envoyé")} · ${msgPlural(Number(r.blocked) || 0, "bloqué")}${Number(r.failed) ? ` · ${msgPlural(Number(r.failed), "échec")}` : ""}${r.error ? ` (${r.error})` : ""}`;
    }

    function renderAutoMessagesState() {
        const stateEl = document.getElementById("gst-auto-msgs-state");
        const toggle = document.getElementById("gst-auto-msgs-toggle");
        if (!stateEl) return;
        const on = toggle ? toggle.checked : false;
        const active = msgState.auto.filter((a) => a.active).length;
        const clock = msgState.serverTime ? `Heure du serveur à l'ouverture : ${msgState.serverTime}. ` : "";
        const slots = active > 1 ? `${active} créneaux actifs envoyés automatiquement.` : (active ? "1 créneau actif envoyé automatiquement." : "Aucun créneau actif.");
        stateEl.textContent = on
            ? `${clock}${slots}`
            : `${clock}Interrupteur coupé : aucun message automatique n'est envoyé.`;
    }

    function renderAutoMessages() {
        renderAutoMessagesState();
        const list = document.getElementById("gst-auto-slots-list");
        if (!list) return;
        if (!msgState.auto.length) {
            list.innerHTML = "<div class=\"gst-empty-placeholder\">Aucun créneau : « + Ajouter un créneau » pour programmer un message.</div>";
            return;
        }
        list.innerHTML = msgState.auto.map((item) => {
            const id = Number(item.id);
            const days = Array.isArray(item.days) ? item.days : [];
            const dayChips = MSG_WEEKDAYS.map((label, i) => `<span class="gst-day-chip ${days.includes(i) ? "on" : ""}">${label}</span>`).join("");
            const snippet = telegramPlainText(String(item.message || "")).replace(/\s+/g, " ").trim();
            const short = snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet;
            return `
                <div class="gst-auto-slot ${item.active ? "" : "is-off"}">
                    <div class="gst-card-row-head">
                        <div class="gst-auto-slot-time">⏰ <strong>${escapeHtml(String(item.send_time || ""))}</strong></div>
                        <label class="gst-switch" title="Activer ce créneau">
                            <input type="checkbox" data-auto-toggle="${id}" ${item.active ? "checked" : ""}>
                            <span class="gst-slider"></span>
                        </label>
                    </div>
                    <div class="gst-auto-days">${dayChips}</div>
                    <div class="gst-order-meta">${msgTypeIcon(item.media_type)} ${escapeHtml(autoTargetText(item))}${item.also_backup ? " · + bot backup" : ""}</div>
                    <div class="gst-auto-slot-text">${short ? escapeHtml(short) : "<i>(sans texte)</i>"}</div>
                    <div class="gst-order-meta">${escapeHtml(autoResultText(item))}</div>
                    <div class="gst-auto-slot-actions">
                        <button type="button" class="gst-btn-chip-action" data-auto-edit="${id}">✏️ Modifier</button>
                        <button type="button" class="gst-btn-chip-action danger" data-auto-delete="${id}">🗑 Supprimer</button>
                    </div>
                </div>`;
        }).join("");
    }

    async function refreshAutoMessages() {
        const res = await adminRequest("/admin/messages/state");
        if (!res.ok) return;
        msgState.auto = Array.isArray(res.data.auto) ? res.data.auto : msgState.auto;
        msgState.status = res.data.status || msgState.status;
        renderAutoMessages();
        renderMsgStatus();
    }

    function openAutoEditor(item) {
        const base = item || {};
        msgState.editor = {
            id: item ? Number(item.id) : null,
            send_time: String(base.send_time || ""),
            days: Array.isArray(base.days) ? base.days.slice() : [0, 1, 2, 3, 4, 5, 6],
            message: String(base.message || ""),
            type: ["text", "image", "video"].includes(base.media_type) ? base.media_type : "text",
            media: String(base.media_url || ""),
            target: msgHas(MSG_TARGET_SHORT, base.target) ? base.target : "all",
            target_days: Number(base.target_days) || MSG_INACTIVE_DEFAULT,
            target_city: String(base.target_city || ""),
            also_backup: base.also_backup === true,
            active: item ? item.active !== false : true
        };
        renderAutoEditor();
        const addBtn = document.getElementById("gst-auto-add-slot-btn");
        if (addBtn) addBtn.hidden = true;
        scrollToAdminId("gst-auto-editor");
    }

    function closeAutoEditor() {
        msgState.editor = null;
        const box = document.getElementById("gst-auto-editor");
        if (box) {
            box.hidden = true;
            box.innerHTML = "";
        }
        const addBtn = document.getElementById("gst-auto-add-slot-btn");
        if (addBtn) addBtn.hidden = false;
    }

    function renderAutoEditor() {
        const box = document.getElementById("gst-auto-editor");
        const ed = msgState.editor;
        if (!box || !ed) return;
        const isMedia = ed.type !== "text";
        const cityOptions = msgState.cities.length
            ? `<option value="">Choisis une ville…</option>` + msgState.cities.map((c) => `<option value="${escapeHtml(c.key)}" ${c.key === ed.target_city ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")
            : "<option value=\"\">Aucune ville créée</option>";
        box.hidden = false;
        box.innerHTML = `
            <div class="gst-card-row-head"><strong>${ed.id ? "Modifier le créneau" : "Nouveau créneau"}</strong></div>
            <div class="gst-field-group">
                <label class="gst-field-subtitle" for="gst-auto-ed-time">Heure d'envoi (heure du serveur)</label>
                <input type="time" class="gst-input" id="gst-auto-ed-time" value="${escapeHtml(ed.send_time)}">
            </div>
            <div class="gst-field-group">
                <span class="gst-field-subtitle">Jours</span>
                <div class="gst-auto-days">${MSG_WEEKDAYS.map((label, i) => `<button type="button" class="gst-day-chip ${ed.days.includes(i) ? "on" : ""}" data-ed-day="${i}" aria-pressed="${ed.days.includes(i)}">${label}</button>`).join("")}</div>
            </div>
            <div class="gst-field-group">
                <span class="gst-field-subtitle">Type de message</span>
                <div class="gst-btn-row-trio">
                    ${["text", "image", "video"].map((type) => `<button type="button" class="gst-btn-choice ${ed.type === type ? "active" : ""}" data-ed-type="${type}">${MSG_TYPE_ICONS[type]} ${type === "text" ? "Texte" : type === "image" ? "Image" : "Vidéo"}</button>`).join("")}
                </div>
            </div>
            <div class="gst-field-group" ${isMedia ? "" : "hidden"}>
                <div class="gst-media-preview-container gst-msg-media-box">${msgState.editorUploading ? "<div class=\"gst-empty-placeholder\">Envoi en cours…</div>" : msgMediaHtml(ed.type, ed.media)}</div>
                <div class="gst-input-btn-row">
                    <label class="gst-btn-secondary-sm" for="gst-auto-ed-media">
                        📁 Choisir…
                        <input type="file" id="gst-auto-ed-media" accept="${ed.type === "video" ? "video/*" : "image/png,image/jpeg,image/webp"}" style="display:none" ${msgState.editorUploading ? "disabled" : ""}>
                    </label>
                    <button type="button" class="gst-btn-remove-sm" data-ed-clear-media ${ed.media && !msgState.editorUploading ? "" : "disabled"}>✕ Retirer</button>
                </div>
            </div>
            <div class="gst-field-group">
                <label class="gst-field-subtitle" for="gst-auto-ed-text">${isMedia ? "Légende (facultative)" : "Message"}</label>
                <div class="gst-format-toolbar" data-msg-format-target="gst-auto-ed-text">
                    <button type="button" class="gst-btn-chip-action" data-msg-format="b"><b>G</b></button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="i"><i>I</i></button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="u"><u>S</u></button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="s"><s>B</s></button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="link">🔗</button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="code">Code</button>
                    <button type="button" class="gst-btn-chip-action" data-msg-format="spoiler">▒</button>
                </div>
                <textarea class="gst-textarea" id="gst-auto-ed-text" rows="4" maxlength="4000" placeholder="Message envoyé automatiquement…"></textarea>
                <div class="gst-card-bottom-row">
                    <span class="gst-msg-html-state" id="gst-auto-ed-html-state"></span>
                    <span class="gst-counter" id="gst-auto-ed-count"></span>
                </div>
            </div>
            <div class="gst-field-group">
                <label class="gst-field-subtitle" for="gst-auto-ed-target">Destinataires</label>
                <select class="gst-select" id="gst-auto-ed-target">
                    ${Object.keys(MSG_TARGET_SHORT).map((key) => `<option value="${key}" ${ed.target === key ? "selected" : ""}>${MSG_TARGET_SHORT[key]}</option>`).join("")}
                </select>
                <div class="gst-msg-target-extra" ${ed.target === "inactive" ? "" : "hidden"}>
                    <label class="gst-field-subtitle" for="gst-auto-ed-days">Sans activité depuis plus de (jours)</label>
                    <input type="number" class="gst-input" id="gst-auto-ed-days" min="1" max="365" step="1" inputmode="numeric" value="${Number(ed.target_days)}">
                </div>
                <div class="gst-msg-target-extra" ${ed.target === "city" ? "" : "hidden"}>
                    <label class="gst-field-subtitle" for="gst-auto-ed-city">Ville</label>
                    <select class="gst-select" id="gst-auto-ed-city" ${msgState.cities.length ? "" : "disabled"}>${cityOptions}</select>
                </div>
            </div>
            <div class="gst-toggle-row">
                <span class="gst-label-sm">Envoyer aussi via le Bot backup${msgState.backup.ready ? "" : " (arrêté pour l'instant)"}</span>
                <label class="gst-switch"><input type="checkbox" id="gst-auto-ed-backup" ${ed.also_backup ? "checked" : ""}><span class="gst-slider"></span></label>
            </div>
            <div class="gst-toggle-row">
                <span class="gst-label-sm">Créneau actif</span>
                <label class="gst-switch"><input type="checkbox" id="gst-auto-ed-active" ${ed.active ? "checked" : ""}><span class="gst-slider"></span></label>
            </div>
            <div class="gst-msg-actions">
                <button type="button" class="gst-btn-secondary" data-ed-cancel>Annuler</button>
                <button type="button" class="gst-btn-primary" data-ed-save>💾 Enregistrer le créneau</button>
            </div>`;
        const textarea = document.getElementById("gst-auto-ed-text");
        if (textarea) textarea.value = ed.message;
        renderMsgTextState(textarea, ed.type, ed.media, "gst-auto-ed-count", "gst-auto-ed-html-state", null);
    }

    // Valeurs saisies du formulaire → état (avant un nouveau rendu ou l'enregistrement)
    function readAutoEditor() {
        const ed = msgState.editor;
        if (!ed) return null;
        const time = document.getElementById("gst-auto-ed-time");
        const text = document.getElementById("gst-auto-ed-text");
        const days = document.getElementById("gst-auto-ed-days");
        const city = document.getElementById("gst-auto-ed-city");
        const backup = document.getElementById("gst-auto-ed-backup");
        const active = document.getElementById("gst-auto-ed-active");
        if (time) ed.send_time = time.value;
        if (text) ed.message = text.value;
        if (days) ed.target_days = days.value.trim() === "" ? NaN : Number(days.value);
        if (city) ed.target_city = city.value;
        if (backup) ed.also_backup = backup.checked;
        if (active) ed.active = active.checked;
        return ed;
    }

    async function saveAutoEditor() {
        const ed = readAutoEditor();
        if (!ed) return;
        if (msgState.editorUploading) {
            showToast("Attends la fin de l'envoi du fichier.", "info");
            return;
        }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ed.send_time)) {
            showToast("Choisis l'heure d'envoi (HH:MM).", "error");
            return;
        }
        if (!ed.days.length) {
            showToast("Choisis au moins un jour d'envoi.", "error");
            return;
        }
        const payload = {
            id: ed.id, send_time: ed.send_time, days: ed.days.slice().sort((a, b) => a - b),
            message: ed.message.trim(), media_type: ed.type, media_url: ed.type === "text" ? "" : ed.media,
            target: ed.target, target_days: ed.target_days, target_city: ed.target === "city" ? ed.target_city : "",
            also_backup: ed.also_backup, active: ed.active
        };
        const error = msgContentError(payload) || msgAudienceError(payload.target, payload.target_days, payload.target_city);
        if (error) {
            showToast(error, "error");
            return;
        }
        const btn = document.querySelector("#gst-auto-editor [data-ed-save]");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/messages/auto/save", payload);
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        msgState.auto = Array.isArray(res.data.auto) ? res.data.auto : msgState.auto;
        closeAutoEditor();
        renderAutoMessages();
        const toggle = document.getElementById("gst-auto-msgs-toggle");
        showToast(toggle && !toggle.checked ? "Créneau enregistré ⏰ (active l'interrupteur « Messages automatiques » pour l'envoi)" : "Créneau enregistré ⏰");
    }

    async function toggleAutoMessage(id, input) {
        input.disabled = true;
        const res = await adminRequest("/admin/messages/auto/toggle", { id, active: input.checked });
        input.disabled = false;
        if (!res.ok) {
            input.checked = !input.checked;
            showToast(res.error, "error");
            return;
        }
        const item = res.data.item;
        msgState.auto = msgState.auto.map((a) => (Number(a.id) === id && item ? item : a));
        renderAutoMessages();
        showToast(input.checked ? "Créneau activé" : "Créneau désactivé");
    }

    function deleteAutoMessage(id) {
        const item = msgState.auto.find((a) => Number(a.id) === id);
        if (!item) return;
        showConfirmModal({
            title: "Supprimer ce créneau ?",
            emoji: "⏰",
            message: `Le message automatique de <strong>${escapeHtml(String(item.send_time || ""))}</strong> ne sera plus envoyé.`,
            confirmText: "Supprimer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: async () => {
                const res = await adminRequest("/admin/messages/auto/delete", { id });
                if (!res.ok) {
                    showToast(res.error, "error");
                    return;
                }
                msgState.auto = Array.isArray(res.data.auto) ? res.data.auto : msgState.auto.filter((a) => Number(a.id) !== id);
                if (msgState.editor && msgState.editor.id === id) closeAutoEditor();
                renderAutoMessages();
                showToast("Créneau supprimé");
            }
        });
    }

    // --- Tickets SAV ---
    async function loadAdminTicketsData() {
        // Interrupteur et destination des notifications (SETTINGS_FIELDS) : relus avec les autres réglages
        loadAdminSettingsData();
        const listContainer = document.getElementById("gst-tickets-list-container");
        if (listContainer && !adState.ticketsList.length) listContainer.innerHTML = "<div class=\"gst-empty-placeholder\">Chargement des tickets…</div>";
        const res = await adminRequest("/admin/support/tickets");
        adState.ticketsError = res.ok ? "" : res.error;
        if (res.ok) {
            adState.ticketsList = Array.isArray(res.data.tickets) ? res.data.tickets : [];
            msgState.ticketCounts = res.data.counts || null;
            msgState.support = res.data.support || null;
            reorgSetCount("tickets", msgState.ticketCounts ? msgState.ticketCounts.open : undefined); // reorg : pastille « SAV »
        }
        renderTicketsSupportState();
        filterAndRenderTickets();
    }

    function renderTicketsSupportState() {
        const el = document.getElementById("gst-tickets-group-state");
        if (!el) return;
        const s = msgState.support;
        if (!s) {
            el.textContent = "";
            return;
        }
        const select = document.getElementById("gst-tickets-target-select");
        const target = select ? select.value : s.target;
        const bot = s.bot_username ? `@${s.bot_username}` : "le bot";
        if (target === "group") {
            el.textContent = s.chat_set
                ? `✅ Groupe enregistré : ${s.chat_title || "groupe sans nom"}. Réponds avec « Répondre » sur une notification.`
                : `⚠ Aucun groupe : ajoute ${bot} à ton groupe de support et tapes-y /support (en attendant, notifications en privé).`;
        } else {
            el.textContent = `Les admins reçoivent chaque nouveau message en privé (ils doivent avoir démarré ${bot}). Répondre à la notification = répondre au client.`;
        }
    }

    // Pastilles « Ouverts / Fermés / Tous » : nombres réels du serveur et filtre actif (le même que les sous-onglets du haut)
    function syncTicketChips() {
        const counts = adState.ticketsError ? null : (msgState.ticketCounts || {
            open: adState.ticketsList.filter((t) => t.status !== "closed").length,
            closed: adState.ticketsList.filter((t) => t.status === "closed").length,
            all: adState.ticketsList.length
        });
        ["open", "closed", "all"].forEach((key) => {
            const el = document.getElementById(`gst-tickets-count-${key}`);
            if (el) el.textContent = counts ? String(Number(counts[key]) || 0) : "—";
        });
        document.querySelectorAll("#gst-pane-tickets .gst-filter-chip").forEach((chip) => {
            chip.classList.toggle("active", chip.dataset.ticketfilter === adState.ticketsFilter);
        });
    }

    function ticketClientName(t) {
        const name = String(t.first_name || "").trim();
        const user = String(t.username || "").trim();
        return name && user ? `${name} (@${user})` : (name || (user ? `@${user}` : `Client ${Number(t.user_id) || ""}`.trim()));
    }

    function filterAndRenderTickets() {
        const listContainer = document.getElementById("gst-tickets-list-container");
        syncTicketChips();
        if (!listContainer) return;
        if (adState.ticketsError) {
            renderAdminListError(listContainer, adState.ticketsError);
            return;
        }
        let tickets = [...adState.ticketsList];
        if (adState.ticketsFilter === "open") tickets = tickets.filter((t) => t.status !== "closed");
        else if (adState.ticketsFilter === "closed") tickets = tickets.filter((t) => t.status === "closed");

        if (!tickets.length) {
            const enabled = msgState.support ? msgState.support.enabled : true;
            listContainer.innerHTML = adState.ticketsList.length
                ? "<div class=\"gst-empty-placeholder\">Aucun ticket dans ce filtre.</div>"
                : `<div class="gst-empty-placeholder">Aucun ticket SAV pour l'instant.${enabled ? "" : " Active l'interrupteur pour que les clients puissent en ouvrir."}</div>`;
            return;
        }

        listContainer.innerHTML = tickets.map((t) => {
            const id = Number(t.id);
            const isOpen = t.status !== "closed";
            const last = t.last && typeof t.last === "object" ? t.last : null;
            const who = last ? (last.from === "admin" ? "↩️ Support" : last.from === "client" ? "👤 Client" : "ℹ️") : "";
            const text = last ? String(last.text || "").replace(/\s+/g, " ").trim() : "";
            const short = text.length > 90 ? `${text.slice(0, 90)}…` : text;
            const unread = Number(t.unread) || 0;
            return `
                <div class="gst-ticket-card gst-ticket-open-btn ${unread ? "has-unread" : ""}" role="button" tabindex="0" data-open-ticket="${id}">
                    <div class="gst-card-row-head">
                        <div>
                            <strong>Ticket #${id}${t.subject ? ` · ${escapeHtml(String(t.subject))}` : ""}</strong>
                            <div class="gst-order-meta">${escapeHtml(ticketClientName(t))} · ${escapeHtml(msgTime(t.updated_at || t.created_at))} · ${escapeHtml(msgPlural(Number(t.message_count) || 0, "message"))}</div>
                        </div>
                        <span class="gst-badge-status ${isOpen ? "in-stock" : "out-stock"}">${isOpen ? "En cours" : "Résolu"}</span>
                    </div>
                    ${short ? `<div class="gst-ticket-last">${escapeHtml(who)} : ${escapeHtml(short)}</div>` : ""}
                    ${unread ? `<span class="gst-ticket-unread">${unread > 1 ? `${unread} nouveaux messages` : "1 nouveau message"}</span>` : ""}
                </div>`;
        }).join("");
    }

    // Modale d'un ticket : créée à la première ouverture (fil, réponse, clôture / réouverture)
    function ticketModal() {
        let modal = document.getElementById("gst-modal-ticket");
        if (modal) return modal;
        modal = document.createElement("div");
        modal.className = "gst-modal-backdrop";
        modal.id = "gst-modal-ticket";
        modal.style.display = "none";
        modal.innerHTML = `
            <div class="gst-modal-dialog gst-modal-wide" role="dialog" aria-modal="true" aria-labelledby="gst-ticket-modal-title">
                <div class="gst-modal-head">
                    <strong id="gst-ticket-modal-title">Ticket</strong>
                    <button type="button" class="gst-btn-close-modal" data-ticket-close aria-label="Fermer">×</button>
                </div>
                <div class="gst-modal-body gst-ticket-modal-body">
                    <div class="gst-order-meta" id="gst-ticket-modal-meta"></div>
                    <div class="gst-convo" id="gst-ticket-thread"></div>
                </div>
                <div class="gst-modal-foot gst-ticket-reply">
                    <textarea class="gst-textarea" id="gst-ticket-reply-input" rows="3" maxlength="2000" placeholder="Ta réponse au client (envoyée par le bot)…"></textarea>
                    <div class="gst-msg-actions">
                        <button type="button" class="gst-btn-secondary" id="gst-ticket-status-btn"></button>
                        <button type="button" class="gst-btn-primary" id="gst-ticket-reply-btn">Envoyer la réponse</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener("click", (e) => {
            if (e.target === modal || e.target.closest("[data-ticket-close]")) closeTicketModal();
        });
        modal.querySelector("#gst-ticket-reply-btn").addEventListener("click", sendTicketReply);
        modal.querySelector("#gst-ticket-status-btn").addEventListener("click", toggleTicketStatus);
        return modal;
    }

    function closeTicketModal() {
        clearTimeout(msgState.ticketTimer);
        msgState.ticket = null;
        const modal = document.getElementById("gst-modal-ticket");
        if (modal) modal.style.display = "none";
    }

    function renderTicketModal() {
        const t = msgState.ticket;
        if (!t) return;
        const isOpen = t.status !== "closed";
        const title = document.getElementById("gst-ticket-modal-title");
        if (title) title.textContent = `Ticket #${Number(t.id)}${t.subject ? ` · ${t.subject}` : ""}`;
        const meta = document.getElementById("gst-ticket-modal-meta");
        if (meta) meta.textContent = `${ticketClientName(t)} · ID ${Number(t.user_id) || "?"} · ouvert le ${msgTime(t.created_at)} · ${isOpen ? "en cours" : "résolu"}${t.bot_kind === "backup" ? " · via le bot backup" : ""}`;
        const thread = document.getElementById("gst-ticket-thread");
        if (thread) {
            const messages = Array.isArray(t.messages) ? t.messages : [];
            thread.innerHTML = messages.length ? messages.map((m) => {
                const from = ["client", "admin", "system"].includes(m.from) ? m.from : "system";
                const author = from === "client" ? "Client" : from === "admin" ? `Support${m.by ? ` · ${m.by}` : ""}` : "Info";
                return `
                    <div class="gst-convo-msg from-${from}">
                        <div class="gst-convo-text">${escapeHtml(String(m.text || ""))}</div>
                        <div class="gst-convo-meta">${escapeHtml(author)} · ${escapeHtml(msgTime(m.ts))}</div>
                    </div>`;
            }).join("") : "<div class=\"gst-empty-placeholder\">Aucun message.</div>";
            thread.scrollTop = thread.scrollHeight;
        }
        const reply = document.getElementById("gst-ticket-reply-input");
        if (reply) {
            reply.disabled = !isOpen;
            reply.placeholder = isOpen ? "Ta réponse au client (envoyée par le bot)…" : "Ticket clos : rouvre-le pour répondre.";
        }
        const replyBtn = document.getElementById("gst-ticket-reply-btn");
        if (replyBtn) replyBtn.disabled = !isOpen || msgState.ticketBusy;
        const statusBtn = document.getElementById("gst-ticket-status-btn");
        if (statusBtn) {
            statusBtn.textContent = isOpen ? "✅ Clore le ticket" : "🔓 Rouvrir";
            statusBtn.disabled = msgState.ticketBusy;
        }
    }

    // onlyIfCurrent (rafraîchissement de la modale) : réponse ignorée si la modale a été fermée ou un autre ticket
    // ouvert pendant la requête ; sinon msgState.ticket redevenait l'ancien et la réponse partait au mauvais client
    async function fetchTicket(id, onlyIfCurrent) {
        const res = await adminRequest(`/admin/support/ticket?id=${encodeURIComponent(id)}`);
        if (!res.ok || !res.data.ticket) return res;
        if (onlyIfCurrent && (!msgState.ticket || Number(msgState.ticket.id) !== Number(id))) return { ok: false, stale: true };
        msgState.ticket = res.data.ticket;
        // ouvert = lu : la liste perd sa pastille « nouveau »
        adState.ticketsList = adState.ticketsList.map((t) => (Number(t.id) === Number(id) ? Object.assign({}, t, { unread: 0 }) : t));
        filterAndRenderTickets();
        return res;
    }

    async function openTicket(id) {
        const modal = ticketModal();
        const res = await fetchTicket(id);
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        modal.style.display = "flex";
        const reply = document.getElementById("gst-ticket-reply-input");
        if (reply) reply.value = "";
        renderTicketModal();
        // Nouveaux messages du client pendant que la modale est ouverte
        clearTimeout(msgState.ticketTimer);
        const pollId = ++msgState.ticketPoll; // un rafraîchissement encore en vol de l'ancien ticket s'arrête là
        const poll = async () => {
            if (pollId !== msgState.ticketPoll) return;
            if (!msgState.ticket || !isShown(modal) || !isShown(document.getElementById("admin-overlay"))) {
                if (!isShown(modal)) msgState.ticket = null;
                return;
            }
            const ticketId = msgState.ticket.id;
            const before = (msgState.ticket.messages || []).length;
            const again = await fetchTicket(ticketId, true);
            // vérifié APRÈS la requête : modale fermée ou autre ticket ouvert entre-temps → plus rien à faire ici
            if (again.stale || pollId !== msgState.ticketPoll || !isShown(modal)) return;
            if (again.ok && (msgState.ticket.messages || []).length !== before) renderTicketModal();
            msgState.ticketTimer = setTimeout(poll, 10000);
        };
        msgState.ticketTimer = setTimeout(poll, 10000);
    }

    function applyTicketUpdate(ticket) {
        if (!ticket) return;
        msgState.ticket = ticket;
        const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
        const last = messages[messages.length - 1] || null;
        const known = adState.ticketsList.some((t) => Number(t.id) === Number(ticket.id));
        const summary = { id: ticket.id, user_id: ticket.user_id, username: ticket.username, first_name: ticket.first_name, subject: ticket.subject, status: ticket.status, created_at: ticket.created_at, updated_at: ticket.updated_at, unread: 0, message_count: messages.length, last };
        adState.ticketsList = known ? adState.ticketsList.map((t) => (Number(t.id) === Number(ticket.id) ? summary : t)) : [summary, ...adState.ticketsList];
        if (msgState.ticketCounts) {
            msgState.ticketCounts.open = adState.ticketsList.filter((t) => t.status !== "closed").length;
            msgState.ticketCounts.closed = Math.max(0, (Number(msgState.ticketCounts.all) || 0) - msgState.ticketCounts.open);
        }
        renderTicketModal();
        filterAndRenderTickets();
    }

    async function sendTicketReply() {
        const t = msgState.ticket;
        const input = document.getElementById("gst-ticket-reply-input");
        const text = input ? input.value.trim() : "";
        if (!t || msgState.ticketBusy) return;
        if (!text) {
            showToast("La réponse est vide.", "error");
            return;
        }
        if (text.length > 2000) {
            showToast("Réponse trop longue (2000 caractères max).", "error");
            return;
        }
        msgState.ticketBusy = true;
        renderTicketModal();
        const res = await adminRequest("/admin/support/reply", { ticket_id: Number(t.id), message: text }, 20000);
        msgState.ticketBusy = false;
        if (!res.ok) {
            renderTicketModal();
            showToast(res.error, "error");
            return;
        }
        if (input) input.value = "";
        applyTicketUpdate(res.data.ticket);
        showToast(res.data.delivered ? "Réponse envoyée au client ✅" : "Réponse enregistrée, mais pas délivrée : le client a bloqué le bot.", res.data.delivered ? undefined : "error");
    }

    async function toggleTicketStatus() {
        const t = msgState.ticket;
        if (!t || msgState.ticketBusy) return;
        const next = t.status === "closed" ? "open" : "closed";
        msgState.ticketBusy = true;
        renderTicketModal();
        const res = await adminRequest("/admin/support/status", { ticket_id: Number(t.id), status: next }, 20000);
        msgState.ticketBusy = false;
        if (!res.ok) {
            renderTicketModal();
            showToast(res.error, "error");
            return;
        }
        applyTicketUpdate(res.data.ticket);
        const notice = res.data.delivered ? " (client prévenu)" : "";
        showToast(next === "closed" ? `Ticket #${Number(t.id)} clos${notice} 🎫` : `Ticket #${Number(t.id)} rouvert${notice} 🎫`);
    }

    // --- Autoclean (section de Réglages) : état réel du nettoyage, lu quand la section devient visible ---
    async function loadAutocleanStats() {
        const el = document.getElementById("gst-autoclean-stats");
        if (!el) return;
        const res = await adminRequest("/admin/messages/autoclean");
        if (!res.ok) {
            el.textContent = `⚠ ${res.error}`;
            return;
        }
        const d = res.data;
        const active = d.active || {};
        const parts = [];
        parts.push(active.client ? `messages des clients supprimés après ${(Number(active.client_delay_ms) || 0) / 1000} s` : "messages des clients gardés");
        const keep = Number(active.keep) || 0;
        parts.push(active.bot ? (keep > 1 ? `${keep} derniers messages du bot gardés par client` : "dernier message du bot gardé par client") : "messages du bot gardés");
        const done = Number(d.bot_deleted) + Number(d.client_deleted);
        el.textContent = `🧹 Actif sur le serveur : ${parts.join(", ")}. ${msgPlural(Number(d.tracked) || 0, "message")} du bot suivi${Number(d.tracked) > 1 ? "s" : ""}, ${msgPlural(done || 0, "suppression")} depuis le démarrage du bot${d.last_run ? ` (dernier passage ${msgTime(d.last_run)})` : ""}. Un changement de réglage s'applique en moins d'une minute.`;
    }

    function watchAutocleanSection() {
        const section = document.getElementById("gst-sec-autoclean");
        if (!section || msgState.autocleanObserver || typeof IntersectionObserver === "undefined") return;
        let last = 0;
        msgState.autocleanObserver = new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting) || Date.now() - last < 15000) return;
            last = Date.now();
            loadAutocleanStats();
        });
        msgState.autocleanObserver.observe(section);
        // Réglage modifié : l'état réel est relu une fois le serveur à jour
        section.addEventListener("change", () => setTimeout(() => {
            if (!isShown(document.getElementById("admin-overlay"))) return;
            last = 0;
            loadAutocleanStats();
        }, 65000));
    }

    // --- Événements (appelé une fois par bindAdminPanelEvents) ---
    function bindMessagesPanel() {
        const pane = document.getElementById("gst-pane-messages");
        const textarea = document.getElementById("gst-broadcast-msg-textarea");

        // Barres de format (composeur et formulaire d'un créneau)
        pane?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-msg-format]");
            if (!btn) return;
            const bar = btn.closest("[data-msg-format-target]");
            msgApplyFormat(bar ? document.getElementById(bar.dataset.msgFormatTarget) : null, btn.dataset.msgFormat);
        });

        // Composeur : type, média, texte, destinataires, bot backup
        document.querySelectorAll("#gst-msg-type-row [data-msgtype]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const type = btn.dataset.msgtype;
                if (type === msgState.composer.type) return;
                msgSetComposer({ type, media: "" });
            });
        });
        textarea?.addEventListener("input", () => renderMsgTextState(textarea, msgState.composer.type, msgState.composer.media, "gst-msg-char-count", "gst-msg-html-state", "gst-msg-preview"));
        document.getElementById("gst-msg-media-input")?.addEventListener("change", async function () {
            const file = this.files && this.files[0];
            if (!file) return;
            const type = msgState.composer.type;
            msgState.uploading = true;
            renderMsgComposer();
            try {
                const path = await msgUploadFile(file, type);
                if (msgState.composer.type === type) msgState.composer.media = path;
                showToast(type === "video" ? "Vidéo prête ✅" : "Image prête ✅");
            } catch (err) {
                showToast(err.message, "error");
            } finally {
                msgState.uploading = false;
                this.value = "";
                renderMsgComposer();
            }
        });
        document.getElementById("gst-msg-media-clear-btn")?.addEventListener("click", () => msgSetComposer({ media: "" }));
        document.querySelectorAll("#gst-msg-target-row [data-msgtarget]").forEach((btn) => {
            btn.addEventListener("click", () => {
                msgSetComposer({ target: btn.dataset.msgtarget });
                msgScheduleCount(0);
            });
        });
        document.getElementById("gst-msg-inactive-days")?.addEventListener("input", (e) => {
            const raw = e.target.value.trim();
            msgState.composer.days = raw === "" ? NaN : Number(raw);
            msgScheduleCount();
        });
        document.getElementById("gst-msg-city-select")?.addEventListener("change", (e) => {
            msgState.composer.city = e.target.value;
            msgScheduleCount(0);
        });
        document.getElementById("gst-broadcast-backup-toggle")?.addEventListener("change", (e) => {
            msgState.composer.backup = e.target.checked && msgState.backup.ready;
            renderMsgComposer();
            msgScheduleCount(0);
        });
        document.getElementById("gst-broadcast-send-btn")?.addEventListener("click", msgSendBroadcast);
        document.getElementById("gst-msg-test-btn")?.addEventListener("click", msgSendTest);

        // Modèles
        document.getElementById("gst-msg-save-template-btn")?.addEventListener("click", () => {
            const row = document.getElementById("gst-msg-template-save-row");
            if (!row) return;
            row.hidden = !row.hidden;
            const nameInput = document.getElementById("gst-msg-template-name");
            if (!row.hidden && nameInput) {
                if (!nameInput.value.trim() && textarea) nameInput.value = telegramPlainText(textarea.value).replace(/\s+/g, " ").trim().slice(0, 40);
                nameInput.focus();
            }
        });
        document.getElementById("gst-msg-template-confirm-btn")?.addEventListener("click", msgSaveTemplate);
        document.getElementById("gst-msg-template-name")?.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                msgSaveTemplate();
            }
        });
        document.getElementById("gst-msg-templates-list")?.addEventListener("click", (e) => {
            const load = e.target.closest("[data-tpl-load]");
            const del = e.target.closest("[data-tpl-delete]");
            if (load) msgLoadTemplate(Number(load.dataset.tplLoad));
            else if (del) msgDeleteTemplate(Number(del.dataset.tplDelete));
        });

        // Messages automatiques : interrupteur global (SETTINGS_FIELDS), liste, formulaire
        document.getElementById("gst-auto-msgs-toggle")?.addEventListener("change", renderAutoMessagesState);
        document.getElementById("gst-auto-add-slot-btn")?.addEventListener("click", () => openAutoEditor(null));
        const autoList = document.getElementById("gst-auto-slots-list");
        autoList?.addEventListener("click", (e) => {
            const edit = e.target.closest("[data-auto-edit]");
            const del = e.target.closest("[data-auto-delete]");
            if (edit) openAutoEditor(msgState.auto.find((a) => Number(a.id) === Number(edit.dataset.autoEdit)) || null);
            else if (del) deleteAutoMessage(Number(del.dataset.autoDelete));
        });
        autoList?.addEventListener("change", (e) => {
            const input = e.target.closest("[data-auto-toggle]");
            if (input) toggleAutoMessage(Number(input.dataset.autoToggle), input);
        });
        const editor = document.getElementById("gst-auto-editor");
        editor?.addEventListener("click", (e) => {
            if (!msgState.editor) return;
            const day = e.target.closest("[data-ed-day]");
            const type = e.target.closest("[data-ed-type]");
            if (day) {
                readAutoEditor();
                const d = Number(day.dataset.edDay);
                const days = msgState.editor.days;
                msgState.editor.days = days.includes(d) ? days.filter((x) => x !== d) : days.concat(d);
                renderAutoEditor();
            } else if (type) {
                readAutoEditor();
                if (msgState.editor.type !== type.dataset.edType) {
                    msgState.editor.type = type.dataset.edType;
                    msgState.editor.media = "";
                }
                renderAutoEditor();
            } else if (e.target.closest("[data-ed-clear-media]")) {
                readAutoEditor();
                msgState.editor.media = "";
                renderAutoEditor();
            } else if (e.target.closest("[data-ed-cancel]")) {
                closeAutoEditor();
            } else if (e.target.closest("[data-ed-save]")) {
                saveAutoEditor();
            }
        });
        editor?.addEventListener("input", (e) => {
            if (!msgState.editor) return;
            if (e.target.id === "gst-auto-ed-text") {
                msgState.editor.message = e.target.value;
                renderMsgTextState(e.target, msgState.editor.type, msgState.editor.media, "gst-auto-ed-count", "gst-auto-ed-html-state", null);
            }
        });
        editor?.addEventListener("change", async (e) => {
            if (!msgState.editor) return;
            if (e.target.id === "gst-auto-ed-target") {
                readAutoEditor();
                msgState.editor.target = e.target.value;
                renderAutoEditor();
            } else if (e.target.id === "gst-auto-ed-media") {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                readAutoEditor();
                const type = msgState.editor.type;
                msgState.editorUploading = true;
                renderAutoEditor();
                try {
                    const path = await msgUploadFile(file, type);
                    if (msgState.editor && msgState.editor.type === type) msgState.editor.media = path;
                    showToast(type === "video" ? "Vidéo prête ✅" : "Image prête ✅");
                } catch (err) {
                    showToast(err.message, "error");
                } finally {
                    msgState.editorUploading = false;
                    if (msgState.editor) renderAutoEditor();
                }
            }
        });

        // Tickets : actualiser, filtre, ouverture d'un ticket, destination des notifications
        document.getElementById("gst-tickets-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation des tickets SAV…", "info");
            loadAdminTicketsData();
        });
        document.querySelectorAll("#gst-pane-tickets .gst-filter-chip").forEach((btn) => {
            btn.addEventListener("click", () => {
                adState.ticketsFilter = btn.dataset.ticketfilter || "all";
                if (adState.activePage === "tickets") renderAdminSubtabs();
                filterAndRenderTickets();
            });
        });
        const ticketsList = document.getElementById("gst-tickets-list-container");
        ticketsList?.addEventListener("click", (e) => {
            const card = e.target.closest("[data-open-ticket]");
            if (card) openTicket(Number(card.dataset.openTicket));
        });
        ticketsList?.addEventListener("keydown", (e) => {
            const card = e.target.closest("[data-open-ticket]");
            if (!card || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            openTicket(Number(card.dataset.openTicket));
        });
        document.getElementById("gst-tickets-target-select")?.addEventListener("change", renderTicketsSupportState);
        document.getElementById("gst-tickets-toggle")?.addEventListener("change", () => setTimeout(loadAdminTicketsData, 1500));

        watchAutocleanSection();
    }

    // ===== CATALOGUE (gestion) : multi-ville, promotion globale, likes, options de commande (envoi postal, crypto),
    // groupe de réception et statuts des commandes, messages N-ème client. Données lues dans GET /admin/catalogue :
    // rien n'est affiché avant la réponse du serveur (aucune valeur factice) =====
    const ORDER_STATUS_UI = [
        ["accepted", "✅ Acceptée"], ["delivering", "🚚 En livraison"], ["delivered", "📦 Livrée"], ["cancelled", "❌ Annulée"]
    ];
    const ORDER_STATUS_BADGES = { new: "🆕 Nouvelle", accepted: "✅ Acceptée", delivering: "🚚 En livraison", delivered: "📦 Livrée", cancelled: "❌ Annulée" };
    const CATALOGUE_PRODUCT_SETTINGS = ["global_promo_enabled", "global_promo_percent", "global_promo_label", "likes_enabled"];
    const CAT_ADMIN_WEEKDAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
    const CRYPTO_COIN_RE = /^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,23}$/;
    const CRYPTO_ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{15,127}$/;
    // loaded : au moins une lecture réussie ; milestonesDraft : jalons en cours d'édition (dirty = pas enregistrés)
    const catPanel = {
        loaded: false, error: "", request: null, busy: false, cities: [], chats: [], milestones: [], milestonesDraft: [],
        milestonesDirty: false, likes: {}, likesTotal: 0, postalOptions: [], wallets: [], productsCity: "all",
        wizardCities: [], ordersStatus: "all"
    };

    // Saisie des réglages du catalogue refusée avant l'envoi (le serveur revérifie : catalogue_setting_value)
    function catalogueFieldError(field, value) {
        if (field.key === "global_promo_percent" && !(Number.isInteger(value) && value >= 1 && value <= 90)) {
            return "Promotion : pourcentage entier entre 1 et 90.";
        }
        if (field.key === "calendar_days" && !(Number.isInteger(value) && value >= 0 && value <= 30)) {
            return "Calendrier : entre 0 et 30 jours à l'avance.";
        }
        return "";
    }

    // Montant saisi (« 4,5 » accepté) : "" si vide, null s'il est invalide ou dépasse max
    function catalogueAmountInput(raw, max) {
        const s = String(raw == null ? "" : raw).trim().replace(",", ".");
        if (!s) return "";
        if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
        const n = Number(s);
        return n <= max ? Math.floor(n * 100 + 0.5) / 100 : null;
    }

    function catalogueJsonObject(raw) {
        if (raw && typeof raw === "object") return raw;
        try {
            const data = JSON.parse(String(raw || "{}"));
            return data && typeof data === "object" ? data : {};
        } catch (_) {
            return {};
        }
    }

    async function loadCataloguePanel() {
        if (!catPanel.request) {
            catPanel.request = adminRequest("/admin/catalogue").then((res) => {
                if (res.ok) applyCataloguePayload(res.data);
                else {
                    catPanel.error = res.error;
                    showToast(res.error, "error");
                }
                return res.ok;
            }).finally(() => { catPanel.request = null; });
        }
        await catPanel.request;
        renderCataloguePanel();
    }

    function applyCataloguePayload(data) {
        if (!data || typeof data !== "object") return;
        catPanel.loaded = true;
        catPanel.error = "";
        catPanel.cities = Array.isArray(data.cities) ? data.cities : [];
        catPanel.chats = Array.isArray(data.chats) ? data.chats : [];
        catPanel.milestones = Array.isArray(data.milestones) ? data.milestones : [];
        if (!catPanel.milestonesDirty) {
            catPanel.milestonesDraft = catPanel.milestones.map((m) => ({ n: String(m.n), message: String(m.message || "") }));
        }
        catPanel.likes = data.likes && typeof data.likes === "object" ? data.likes : {};
        catPanel.likesTotal = Number(data.likes_total) || 0;
        catPanel.postalOptions = Array.isArray(data.postal_options) ? data.postal_options : [];
        catPanel.wallets = Array.isArray(data.crypto_wallets) ? data.crypto_wallets : [];
    }

    function renderCataloguePanel() {
        renderCatalogueCities();
        renderCityFilterOptions();
        renderOrderChats();
        renderMilestones();
        renderPostalEditor();
        renderWalletsEditor();
        renderLikesTotal();
        renderPromoPreview();
        renderWizardCities();
        if (adState.activePage === "produits") filterAndRenderProducts();
    }

    // Promo et likes de l'onglet Produits : remplis depuis la config (comme le fait l'onglet Réglages pour les autres)
    function fillCatalogueProductSettings(adminCfg) {
        SETTINGS_FIELDS.filter((f) => CATALOGUE_PRODUCT_SETTINGS.includes(f.key)).forEach((field) => {
            const el = document.getElementById(field.id);
            if (!el || adState.settingsTimers[field.key] || adState.settingsSending[field.key] || document.activeElement === el) return;
            writeSettingField(field, el, Object.prototype.hasOwnProperty.call(adminCfg, field.key) ? adminCfg[field.key] : undefined);
            adState.settingsSaved[field.key] = readSettingField(field, el);
        });
        renderPromoPreview();
    }

    function renderPromoPreview() {
        const el = document.getElementById("gst-promo-preview");
        if (!el) return;
        const toggle = document.getElementById("gst-prods-global-promo-toggle");
        const pctEl = document.getElementById("gst-promo-percent");
        const labelEl = document.getElementById("gst-promo-label");
        const pct = Number(pctEl ? pctEl.value : "");
        if (!(Number.isInteger(pct) && pct >= 1 && pct <= 90)) {
            el.textContent = "Indique un pourcentage entier entre 1 et 90, puis active la promotion.";
            return;
        }
        const label = (labelEl && labelEl.value.trim()) || "Promo";
        el.textContent = `${toggle && toggle.checked ? "✅ Active" : "Inactive"} · ex. ${formatPrice(20)} → ${formatPrice(catRound2(20 * (100 - pct) / 100))} · ligne « ${label} -${pct}% » au panier, appliquée par le serveur.`;
    }

    function renderLikesTotal() {
        const el = document.getElementById("gst-likes-total");
        if (el) el.textContent = catPanel.loaded ? `Total : ♥ ${catPanel.likesTotal} like${catPanel.likesTotal > 1 ? "s" : ""}.` : "";
    }

    // ---- Multi-Ville (Réglages) ----
    function catalogueCityName(key) {
        const city = catPanel.cities.find((c) => c.key === key);
        return city ? city.name : key;
    }

    function renderCatalogueCities() {
        const list = document.getElementById("gst-cities-list");
        if (!list) return;
        const warning = document.getElementById("gst-multicity-warning");
        const toggle = document.getElementById("gst-multicity-toggle");
        if (!catPanel.loaded) {
            if (catPanel.error) renderAdminListError(list, catPanel.error);
            if (warning) warning.hidden = true;
            return;
        }
        if (warning) warning.hidden = !(toggle && toggle.checked && !catPanel.cities.some((c) => c.active));
        if (!catPanel.cities.length) {
            list.innerHTML = `<div class="gst-empty-placeholder">Aucune ville : ajoute la première ci-dessous.</div>`;
            return;
        }
        const chats = {};
        catPanel.chats.forEach((c) => { if (c.scope) chats[c.scope] = c; });
        list.innerHTML = catPanel.cities.map((c, i) => {
            const name = escapeHtml(String(c.name));
            const chat = chats[c.key];
            const users = Number(c.users) || 0;
            const products = Number(c.products) || 0;
            const meta = [
                `${users} client${users > 1 ? "s" : ""}`,
                `${products} produit${products > 1 ? "s" : ""} réservé${products > 1 ? "s" : ""}`,
                chat ? `💬 ${escapeHtml(chat.title || "groupe enregistré")}` : `groupe : /commandes ${escapeHtml(String(c.key))}`
            ].join(" · ");
            const fee = c.delivery_fee === null || c.delivery_fee === undefined ? "" : String(c.delivery_fee);
            return `
                <div class="gst-city-row gst-city-item${c.active ? "" : " is-off"}" data-city="${escapeHtml(String(c.key))}">
                    <div class="gst-city-main">
                        <span class="gst-city-name">📍 ${name}${c.active ? "" : ' <span class="gst-city-off-tag">masquée</span>'}</span>
                        <span class="gst-city-meta">${meta}</span>
                    </div>
                    <div class="gst-city-controls">
                        <input type="text" inputmode="decimal" class="gst-input gst-input-num-sm" data-city-fee value="${escapeHtml(fee)}" placeholder="Défaut" title="Frais de livraison (vide = frais par défaut)" aria-label="Frais de livraison de ${name}">
                        <label class="gst-switch" title="Proposée aux clients"><input type="checkbox" data-city-active ${c.active ? "checked" : ""} aria-label="${name} proposée aux clients"><span class="gst-slider"></span></label>
                        <button type="button" class="gst-prod-reorder-btn" data-city-move="up" aria-label="Monter ${name}" ${i === 0 ? "disabled" : ""}>▲</button>
                        <button type="button" class="gst-prod-reorder-btn" data-city-move="down" aria-label="Descendre ${name}" ${i === catPanel.cities.length - 1 ? "disabled" : ""}>▼</button>
                        <button type="button" class="gst-btn-icon-circ" data-city-rename aria-label="Renommer ${name}">✏️</button>
                        <button type="button" class="gst-btn-del-city" data-city-delete aria-label="Supprimer ${name}">×</button>
                    </div>
                </div>`;
        }).join("");
    }

    // Requête de la carte Multi-Ville : un enregistrement à la fois, liste et boutique rafraîchies au retour
    async function catalogueCityRequest(path, body, successMsg) {
        if (catPanel.busy) {
            showToast("Enregistrement en cours, patiente une seconde.", "info");
            return false;
        }
        catPanel.busy = true;
        try {
            const res = await adminRequest(path, body);
            if (!res.ok) {
                showToast(res.error, "error");
                return false;
            }
            applyCataloguePayload(res.data);
            if (res.data.config) applyUpdatedConfig(res.data.config);
            if (successMsg) showToast(successMsg);
            reloadShop(); // villes de la boutique (écran de choix, profil) à jour
            return true;
        } finally {
            catPanel.busy = false;
            renderCataloguePanel();
        }
    }

    function saveCatalogueCity(key, changes, successMsg) {
        const city = catPanel.cities.find((c) => c.key === key);
        if (!city) return Promise.resolve(false);
        const fee = city.delivery_fee === null || city.delivery_fee === undefined ? "" : city.delivery_fee;
        return catalogueCityRequest("/admin/cities/save", Object.assign({ key, name: city.name, delivery_fee: fee, active: city.active }, changes), successMsg);
    }

    async function addCatalogueCity() {
        const nameEl = document.getElementById("gst-new-city-input");
        const feeEl = document.getElementById("gst-new-city-fee");
        const name = (nameEl ? nameEl.value : "").trim().replace(/\s+/g, " ");
        if (!name || name.length > 40) {
            showToast("Nom de la ville : 1 à 40 caractères.", "error");
            return;
        }
        if (catPanel.cities.some((c) => String(c.name).toLowerCase() === name.toLowerCase())) {
            showToast(`La ville « ${name} » existe déjà.`, "error");
            return;
        }
        const fee = catalogueAmountInput(feeEl ? feeEl.value : "", 1000);
        if (fee === null) {
            showToast("Frais invalides : montant entre 0 et 1000, ou vide pour les frais par défaut.", "error");
            return;
        }
        const btn = document.getElementById("gst-add-city-btn");
        if (btn) btn.disabled = true;
        const ok = await catalogueCityRequest("/admin/cities/save", { name, delivery_fee: fee, active: true }, `Ville ajoutée : ${name} 📍`);
        if (btn) btn.disabled = false;
        if (ok) {
            if (nameEl) nameEl.value = "";
            if (feeEl) feeEl.value = "";
        }
    }

    function onCityListChange(e) {
        const row = e.target.closest("[data-city]");
        if (!row) return;
        const key = row.dataset.city;
        if (e.target.hasAttribute("data-city-fee")) {
            const fee = catalogueAmountInput(e.target.value, 1000);
            if (fee === null) {
                showToast("Frais invalides : montant entre 0 et 1000, ou vide pour les frais par défaut.", "error");
                renderCatalogueCities();
                return;
            }
            saveCatalogueCity(key, { delivery_fee: fee }, fee === "" ? "Frais par défaut pour cette ville 🚚" : "Frais de la ville enregistrés 🚚");
        } else if (e.target.hasAttribute("data-city-active")) {
            saveCatalogueCity(key, { active: e.target.checked }, e.target.checked ? "Ville proposée aux clients 📍" : "Ville masquée aux clients");
        }
    }

    function onCityListClick(e) {
        const btn = e.target.closest("button");
        const row = btn && btn.closest("[data-city]");
        if (!row) return;
        const key = row.dataset.city;
        if (btn.dataset.cityMove) catalogueCityRequest("/admin/cities/reorder", { key, direction: btn.dataset.cityMove }, "Ordre des villes mis à jour ↕️");
        else if (btn.hasAttribute("data-city-rename")) renameCatalogueCity(key);
        else if (btn.hasAttribute("data-city-delete")) confirmDeleteCatalogueCity(key);
    }

    function renameCatalogueCity(key) {
        const city = catPanel.cities.find((c) => c.key === key);
        if (!city) return;
        showConfirmModal({
            title: "Renommer la ville",
            emoji: "✏️",
            message: `<input type="text" class="gst-city-rename-input" id="gst-city-rename-input" maxlength="40" value="${escapeHtml(String(city.name))}" aria-label="Nouveau nom de la ville" autocomplete="off">`,
            confirmText: "Enregistrer",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: async () => {
                const input = document.getElementById("gst-city-rename-input");
                const name = (input ? input.value : "").trim().replace(/\s+/g, " ");
                if (!name || name.length > 40) {
                    showToast("Nom de la ville : 1 à 40 caractères.", "error");
                    return;
                }
                if (name !== city.name) await saveCatalogueCity(key, { name }, `Ville renommée : ${name}`);
            }
        });
    }

    function confirmDeleteCatalogueCity(key) {
        const city = catPanel.cities.find((c) => c.key === key);
        if (!city) return;
        const onlyHere = allProductsFromConfig(state.config || {})
            .filter((p) => Array.isArray(p.cities) && p.cities.length === 1 && p.cities[0] === key).length;
        const users = Number(city.users) || 0;
        showConfirmModal({
            title: "Supprimer la ville ?",
            emoji: "🗑️",
            message: `Supprimer <strong>« ${escapeHtml(String(city.name))} »</strong> ?<br><br>`
                + (users ? `Ses ${users} client${users > 1 ? "s" : ""} devront choisir une autre ville. ` : "")
                + (onlyHere ? `${onlyHere} produit${onlyHere > 1 ? "s" : ""} réservé${onlyHere > 1 ? "s" : ""} à cette seule ville ser${onlyHere > 1 ? "ont" : "a"} proposé${onlyHere > 1 ? "s" : ""} partout. ` : "")
                + "Son groupe de commandes est oublié ; les anciennes commandes gardent leur ville.<br><br>Pour seulement la cacher, coupe son interrupteur.",
            confirmText: "Oui, supprimer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: () => catalogueCityRequest("/admin/cities/delete", { key }, "Ville supprimée 🗑️")
        });
    }

    // ---- Produits : filtre par ville, villes et likes sur les cartes, villes dans l'assistant ----
    function renderCityFilterOptions() {
        const select = document.getElementById("gst-prods-city-select");
        if (!select) return;
        const current = catPanel.productsCity;
        select.innerHTML = `<option value="all">Toutes les villes</option>`
            + catPanel.cities.map((c) => `<option value="${escapeHtml(String(c.key))}">📍 ${escapeHtml(String(c.name))}${c.active ? "" : " (masquée)"}</option>`).join("");
        select.value = catPanel.cities.some((c) => c.key === current) ? current : "all";
        catPanel.productsCity = select.value;
    }

    function catalogueAdminCityMatch(p) {
        if (catPanel.productsCity === "all") return true;
        const cities = Array.isArray(p.cities) ? p.cities : [];
        return !cities.length || cities.includes(catPanel.productsCity);
    }

    function catalogueAdminProductBadges(p) {
        let html = "";
        const cities = Array.isArray(p.cities) ? p.cities : [];
        if (cities.length) html += `<span class="gst-badge-city">📍 ${escapeHtml(cities.map(catalogueCityName).join(", "))}</span>`;
        else if (catPanel.cities.length) html += `<span class="gst-badge-city is-all">🌍 Toutes les villes</span>`;
        const likes = Number(catPanel.likes[String(p.id)]) || 0;
        if (likes > 0) html += `<span class="gst-badge-likes">♥ ${likes}</span>`;
        return html;
    }

    function openCatalogueWizard(product) {
        catPanel.wizardCities = product && Array.isArray(product.cities) ? product.cities.map(String) : [];
        renderWizardCities();
        const info = document.getElementById("pw-likes-info");
        if (info) {
            const likes = product && product.id ? Number(catPanel.likes[String(product.id)]) || 0 : 0;
            info.textContent = product && product.id && catPanel.loaded
                ? `♥ ${likes} like${likes > 1 ? "s" : ""} reçu${likes > 1 ? "s" : ""} (compteur réel des clients).`
                : "";
        }
    }

    // Villes cochées qui existent encore (une ville supprimée entre-temps n'est jamais renvoyée)
    function catalogueWizardCities() {
        return catPanel.wizardCities.filter((k) => catPanel.cities.some((c) => c.key === k));
    }

    function renderWizardCities() {
        const box = document.getElementById("pw-cities");
        const caption = document.getElementById("pw-cities-caption");
        if (!box || !caption) return;
        if (!catPanel.loaded) {
            box.innerHTML = "";
            caption.textContent = catPanel.error ? "Villes indisponibles : celles du produit restent inchangées." : "Chargement des villes…";
            return;
        }
        if (!catPanel.cities.length) {
            box.innerHTML = "";
            caption.textContent = "Aucune ville : le produit est proposé partout. Ajoute des villes dans Catalogue › Villes.";
            return;
        }
        const selected = catalogueWizardCities();
        box.innerHTML = `<button type="button" class="gst-city-chip${selected.length ? "" : " active"}" data-pw-city="" aria-pressed="${!selected.length}">🌍 Toutes</button>`
            + catPanel.cities.map((c) => {
                const on = selected.includes(c.key);
                return `<button type="button" class="gst-city-chip${on ? " active" : ""}${c.active ? "" : " is-off"}" data-pw-city="${escapeHtml(String(c.key))}" aria-pressed="${on}">📍 ${escapeHtml(String(c.name))}</button>`;
            }).join("");
        caption.textContent = selected.length
            ? `Proposé seulement à : ${selected.map(catalogueCityName).join(", ")}.`
            : "Proposé dans toutes les villes.";
    }

    function onWizardCityClick(e) {
        const chip = e.target.closest("[data-pw-city]");
        if (!chip) return;
        const key = chip.dataset.pwCity;
        if (!key) catPanel.wizardCities = [];
        else if (catPanel.wizardCities.includes(key)) catPanel.wizardCities = catPanel.wizardCities.filter((k) => k !== key);
        else catPanel.wizardCities = catalogueWizardCities().concat(key);
        renderWizardCities();
    }

    // ---- Commandes : groupe de réception, envoi postal, adresses crypto, statuts ----
    function orderChatRow(chat, label, scope, emptyText) {
        if (!chat) {
            return `<div class="gst-chat-row is-empty"><span class="gst-chat-scope">${escapeHtml(label)}</span><span class="gst-chat-title">${escapeHtml(emptyText)}</span></div>`;
        }
        const when = chat.updated_at ? adminDate(chat.updated_at) : null;
        return `
            <div class="gst-chat-row">
                <span class="gst-chat-scope">${escapeHtml(label)}</span>
                <span class="gst-chat-title">💬 ${escapeHtml(String(chat.title || "Groupe enregistré"))}${chat.bot === "backup" ? " · bot backup" : ""}${when ? ` · depuis le ${when.toLocaleDateString("fr-FR")}` : ""}</span>
                <button type="button" class="gst-btn-danger-sm" data-chat-remove="${escapeHtml(scope)}">Retirer</button>
            </div>`;
    }

    function renderOrderChats() {
        const box = document.getElementById("gst-order-chats");
        if (!box) return;
        if (!catPanel.loaded) {
            if (catPanel.error) renderAdminListError(box, catPanel.error);
            return;
        }
        const general = catPanel.chats.find((c) => !c.scope);
        const rows = [orderChatRow(general, "🌍 Toutes les villes", "", "Aucun groupe : les commandes arrivent en privé aux admins.")];
        catPanel.chats.filter((c) => c.scope).forEach((c) => rows.push(orderChatRow(c, `📍 ${c.city_name || c.scope}`, c.scope, "")));
        box.innerHTML = rows.join("");
    }

    function confirmRemoveOrderChat(scope) {
        const chat = catPanel.chats.find((c) => (c.scope || "") === scope);
        if (!chat) return;
        showConfirmModal({
            title: "Retirer le groupe ?",
            emoji: "💬",
            message: `Le groupe <strong>« ${escapeHtml(String(chat.title || "Groupe"))} »</strong> ne recevra plus les commandes${scope ? ` de ${escapeHtml(String(chat.city_name || scope))}` : ""}. Tu pourras le réenregistrer avec /commandes.`,
            confirmText: "Oui, retirer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: () => catalogueCityRequest("/admin/order-chats/remove", { scope }, "Groupe retiré")
        });
    }

    function renderPostalEditor() {
        const list = document.getElementById("gst-postal-options-list");
        if (!list) return;
        if (!catPanel.loaded) {
            if (catPanel.error) renderAdminListError(list, catPanel.error);
            return;
        }
        list.innerHTML = catPanel.postalOptions.length
            ? catPanel.postalOptions.map((o, i) => `
                <div class="gst-list-editor-row">
                    <span class="gst-list-editor-main">📮 ${escapeHtml(String(o.label))}</span>
                    <span class="gst-list-editor-side">${Number(o.fee) > 0 ? escapeHtml(formatPrice(o.fee)) : "offert"}</span>
                    <button type="button" class="gst-btn-del-city" data-postal-delete="${i}" aria-label="Retirer ${escapeHtml(String(o.label))}">×</button>
                </div>`).join("")
            : `<div class="gst-empty-placeholder">Aucun type d'envoi : ajoute par exemple « Lettre suivie » ou « Colissimo ».</div>`;
    }

    function walletShort(address) {
        const a = String(address || "");
        return a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a;
    }

    function renderWalletsEditor() {
        const list = document.getElementById("gst-wallets-list");
        if (!list) return;
        if (!catPanel.loaded) {
            if (catPanel.error) renderAdminListError(list, catPanel.error);
            return;
        }
        list.innerHTML = catPanel.wallets.length
            ? catPanel.wallets.map((w, i) => `
                <div class="gst-list-editor-row">
                    <span class="gst-list-editor-main">🪙 ${escapeHtml(String(w.coin))}</span>
                    <code class="gst-list-editor-side" title="${escapeHtml(String(w.address))}">${escapeHtml(walletShort(w.address))}</code>
                    <button type="button" class="gst-btn-del-city" data-wallet-delete="${i}" aria-label="Retirer l'adresse ${escapeHtml(String(w.coin))}">×</button>
                </div>`).join("")
            : `<div class="gst-empty-placeholder">Aucune adresse : ajoute la monnaie et l'adresse de ton wallet.</div>`;
    }

    // Types d'envoi ou adresses crypto : la liste entière part dans /admin/settings/save (validée par le serveur)
    async function saveCatalogueList(key, list, successMsg) {
        if (catPanel.busy) {
            showToast("Enregistrement en cours, patiente une seconde.", "info");
            return false;
        }
        catPanel.busy = true;
        try {
            if (!await saveAdminSettings({ [key]: list })) return false;
            const saved = catalogueJsonList(((state.config && state.config.admin) || {})[key]);
            if (key === "postal_options") catPanel.postalOptions = saved;
            else catPanel.wallets = saved;
            showToast(successMsg);
            return true;
        } finally {
            catPanel.busy = false;
            renderPostalEditor();
            renderWalletsEditor();
        }
    }

    async function addPostalOption() {
        const labelEl = document.getElementById("gst-postal-new-label");
        const feeEl = document.getElementById("gst-postal-new-fee");
        const label = (labelEl ? labelEl.value : "").trim().replace(/\s+/g, " ");
        if (!catPanel.loaded) {
            showToast(catPanel.error || "Types d'envoi pas encore chargés, réessaie.", "error");
            return;
        }
        if (!label || label.length > 40) {
            showToast("Type d'envoi : nom de 1 à 40 caractères.", "error");
            return;
        }
        if (catPanel.postalOptions.some((o) => String(o.label).toLowerCase() === label.toLowerCase())) {
            showToast(`Le type d'envoi « ${label} » existe déjà.`, "error");
            return;
        }
        if (catPanel.postalOptions.length >= 6) {
            showToast("6 types d'envoi maximum.", "error");
            return;
        }
        const fee = catalogueAmountInput(feeEl ? feeEl.value : "", 1000);
        if (fee === null) {
            showToast("Frais d'envoi invalides : montant entre 0 et 1000.", "error");
            return;
        }
        const list = catPanel.postalOptions.map((o) => ({ label: o.label, fee: o.fee })).concat({ label, fee: fee === "" ? 0 : fee });
        if (await saveCatalogueList("postal_options", list, `Type d'envoi ajouté : ${label} 📮`)) {
            if (labelEl) labelEl.value = "";
            if (feeEl) feeEl.value = "";
        }
    }

    async function addWallet() {
        const coinEl = document.getElementById("gst-wallet-new-coin");
        const addressEl = document.getElementById("gst-wallet-new-address");
        const coin = (coinEl ? coinEl.value : "").trim().replace(/\s+/g, " ");
        const address = (addressEl ? addressEl.value : "").replace(/\s+/g, "");
        if (!catPanel.loaded) {
            showToast(catPanel.error || "Adresses pas encore chargées, réessaie.", "error");
            return;
        }
        if (!CRYPTO_COIN_RE.test(coin)) {
            showToast("Monnaie : 1 à 24 caractères (lettres, chiffres, espace, ( ) . _ -), ex. USDT (TRC20).", "error");
            return;
        }
        if (!CRYPTO_ADDRESS_RE.test(address)) {
            showToast("Adresse refusée : 16 à 128 caractères, lettres et chiffres, sans espace.", "error");
            return;
        }
        if (catPanel.wallets.some((w) => String(w.coin).toLowerCase() === coin.toLowerCase())) {
            showToast(`Une adresse ${coin} existe déjà : retire-la d'abord.`, "error");
            return;
        }
        if (catPanel.wallets.length >= 8) {
            showToast("8 adresses crypto maximum.", "error");
            return;
        }
        const list = catPanel.wallets.map((w) => ({ coin: w.coin, address: w.address })).concat({ coin, address });
        if (await saveCatalogueList("crypto_wallets", list, `Adresse ${coin} enregistrée 🪙`)) {
            if (coinEl) coinEl.value = "";
            if (addressEl) addressEl.value = "";
        }
    }

    function catalogueOrderStatusBadge(o) {
        const status = String(o.status || "");
        return ORDER_STATUS_BADGES[status] ? `<span class="gst-order-status-badge is-${status}">${ORDER_STATUS_BADGES[status]}</span>` : "";
    }

    function formatAdminSlot(slot) {
        const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(slot || ""));
        if (!m) return String(slot || "");
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return `${CAT_ADMIN_WEEKDAYS[d.getDay()]} ${m[3]}/${m[2]} à ${m[4]}:${m[5]}`;
    }

    // Ville, adresse, créneau et paiement d'une commande (colonnes ajoutées par le catalogue ; rien pour les anciennes)
    function catalogueOrderDetailsHtml(o) {
        const details = catalogueJsonObject(o.order_details);
        const lines = [];
        if (details.city_name) lines.push(`📍 ${escapeHtml(String(details.city_name))}`);
        if (o.delivery_address) lines.push(`🏠 ${escapeHtml(String(o.delivery_address))}`);
        if (o.postal_address) lines.push(`📮 ${details.postal_option ? `${escapeHtml(String(details.postal_option))} — ` : ""}${escapeHtml(String(o.postal_address))}`);
        if (o.slot) lines.push(`📅 ${escapeHtml(formatAdminSlot(o.slot))}`);
        if (details.payment_label) lines.push(`💳 ${escapeHtml(String(details.payment_label))}`);
        return lines.length ? `<div class="gst-order-details">${lines.map((l) => `<div>${l}</div>`).join("")}</div>` : "";
    }

    function catalogueOrderActionsHtml(o) {
        const status = String(o.status || "");
        const id = escapeHtml(String(o.id));
        return `<div class="gst-order-status-actions">${ORDER_STATUS_UI.map(([st, label]) => `<button type="button" class="gst-order-status-btn${st === status ? " active" : ""}" data-order-status="${st}" data-order-id="${id}" ${st === status ? "disabled" : ""}>${label}</button>`).join("")}</div>`;
    }

    // Même effet que les boutons du groupe de réception : messages du groupe mis à jour, client prévenu par le bot
    function changeOrderStatus(btn) {
        const id = btn.dataset.orderId;
        const status = btn.dataset.orderStatus;
        const label = (ORDER_STATUS_UI.find(([s]) => s === status) || [status, status])[1];
        const run = async () => {
            btn.disabled = true;
            const res = await adminRequest("/admin/orders/status", { order_id: Number(id), status });
            if (!res.ok) {
                showToast(res.error, "error");
                filterAndRenderOrders();
                return;
            }
            const order = adState.ordersList.find((o) => String(o.id) === String(id));
            if (order) {
                order.status = status;
                order.status_updated_at = Math.floor(Date.now() / 1000);
            }
            filterAndRenderOrders();
            showToast(res.data.changed === false ? `Commande #${id} : déjà « ${label} »` : `Commande #${id} : ${label} · le bot prévient le client`);
        };
        if (status !== "cancelled") {
            run();
            return;
        }
        showConfirmModal({
            title: "Annuler la commande ?",
            emoji: "❌",
            message: `La commande <strong>#${escapeHtml(String(id))}</strong> passe en « Annulée » et le bot prévient le client.`,
            confirmText: "Oui, annuler",
            cancelText: "Retour",
            isDanger: true,
            onConfirm: run
        });
    }

    // ---- Messages N-ème client ----
    function renderMilestonesStatus() {
        const saveBtn = document.getElementById("gst-milestones-save-btn");
        const status = document.getElementById("gst-milestones-status");
        if (saveBtn) saveBtn.disabled = !catPanel.loaded || !catPanel.milestonesDirty || catPanel.busy;
        if (!status) return;
        const count = catPanel.milestones.length;
        status.classList.toggle("is-dirty", catPanel.milestonesDirty);
        status.textContent = catPanel.milestonesDirty
            ? "Modifications non enregistrées"
            : (count ? `${count} jalon${count > 1 ? "s" : ""} actif${count > 1 ? "s" : ""}` : "");
    }

    function renderMilestones() {
        const list = document.getElementById("gst-milestones-list");
        if (!list) return;
        if (!catPanel.loaded) {
            if (catPanel.error) renderAdminListError(list, catPanel.error);
            renderMilestonesStatus();
            return;
        }
        const draft = catPanel.milestonesDraft;
        list.innerHTML = draft.length
            ? draft.map((m, i) => `
                <div class="gst-milestone-card" data-ms-idx="${i}">
                    <div class="gst-card-row-head">
                        <label class="gst-milestone-num">Commande n° <input type="number" class="gst-input gst-input-num-sm" data-ms-field="n" min="1" max="100000" step="1" inputmode="numeric" value="${escapeHtml(String(m.n))}"></label>
                        <button type="button" class="gst-btn-del-icon" data-ms-delete="${i}" aria-label="Supprimer ce jalon">🗑️</button>
                    </div>
                    <textarea class="gst-textarea" rows="3" maxlength="1000" data-ms-field="message" placeholder="Ex : 🎉 Merci {prenom} pour ta {n}e commande !">${escapeHtml(String(m.message))}</textarea>
                </div>`).join("")
            : `<div class="gst-empty-placeholder">Aucun jalon : ajoute le premier (ex. la 5e commande).</div>`;
        renderMilestonesStatus();
    }

    function onMilestoneInput(e) {
        const field = e.target.dataset.msField;
        const card = e.target.closest("[data-ms-idx]");
        const item = card ? catPanel.milestonesDraft[Number(card.dataset.msIdx)] : null;
        if (!field || !item) return;
        item[field] = e.target.value;
        catPanel.milestonesDirty = true;
        renderMilestonesStatus();
    }

    function addMilestone() {
        if (!catPanel.loaded) {
            showToast(catPanel.error || "Jalons pas encore chargés, réessaie.", "error");
            return;
        }
        if (catPanel.milestonesDraft.length >= 20) {
            showToast("20 jalons maximum.", "error");
            return;
        }
        const last = catPanel.milestonesDraft.reduce((max, m) => Math.max(max, Number(m.n) || 0), 0);
        catPanel.milestonesDraft.push({ n: String(last ? last + 5 : 5), message: "" });
        catPanel.milestonesDirty = true;
        renderMilestones();
        const areas = document.querySelectorAll('#gst-milestones-list textarea[data-ms-field="message"]');
        if (areas.length) areas[areas.length - 1].focus();
    }

    async function saveMilestones() {
        const items = [];
        const seen = new Set();
        for (const m of catPanel.milestonesDraft) {
            const raw = String(m.n).trim();
            const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
            if (!(n >= 1 && n <= 100000)) {
                showToast("Jalon : numéro de commande entre 1 et 100000.", "error");
                return;
            }
            if (seen.has(n)) {
                showToast(`Deux jalons pour la commande n° ${n}.`, "error");
                return;
            }
            seen.add(n);
            const message = String(m.message || "").trim();
            if (!message || message.length > 1000) {
                showToast(`Jalon n° ${n} : message de 1 à 1000 caractères.`, "error");
                return;
            }
            items.push({ n, message });
        }
        if (catPanel.busy) return;
        catPanel.busy = true;
        renderMilestonesStatus();
        try {
            const res = await adminRequest("/admin/milestones/save", { milestones: items });
            if (!res.ok) {
                showToast(res.error, "error");
                return;
            }
            catPanel.milestonesDirty = false;
            applyCataloguePayload(res.data);
            renderMilestones();
            showToast(items.length ? "Jalons enregistrés 🎯" : "Plus aucun jalon N-ème client");
        } finally {
            catPanel.busy = false;
            renderMilestonesStatus();
        }
    }

    function bindCataloguePanel() {
        // Multi-Ville
        document.getElementById("gst-add-city-btn")?.addEventListener("click", addCatalogueCity);
        ["gst-new-city-input", "gst-new-city-fee"].forEach((id) => {
            document.getElementById(id)?.addEventListener("keydown", (e) => {
                if (e.key === "Enter") addCatalogueCity();
            });
        });
        const cityList = document.getElementById("gst-cities-list");
        if (cityList) {
            cityList.addEventListener("change", onCityListChange);
            cityList.addEventListener("click", onCityListClick);
        }
        document.getElementById("gst-multicity-toggle")?.addEventListener("change", renderCatalogueCities);

        // Produits : filtre par ville, aperçu de la promotion, villes de l'assistant
        document.getElementById("gst-prods-city-select")?.addEventListener("change", (e) => {
            catPanel.productsCity = e.target.value || "all";
            filterAndRenderProducts();
        });
        ["gst-prods-global-promo-toggle", "gst-promo-percent", "gst-promo-label"].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener("input", renderPromoPreview);
            el.addEventListener("change", renderPromoPreview);
        });
        document.getElementById("pw-cities")?.addEventListener("click", onWizardCityClick);

        // Commandes : groupe de réception, types d'envoi, adresses crypto, statuts
        document.getElementById("gst-order-chats")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-chat-remove]");
            if (btn) confirmRemoveOrderChat(btn.dataset.chatRemove);
        });
        document.getElementById("gst-postal-add-btn")?.addEventListener("click", addPostalOption);
        document.getElementById("gst-postal-options-list")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-postal-delete]");
            if (!btn) return;
            const list = catPanel.postalOptions.filter((_, i) => i !== Number(btn.dataset.postalDelete)).map((o) => ({ label: o.label, fee: o.fee }));
            saveCatalogueList("postal_options", list, "Type d'envoi retiré");
        });
        document.getElementById("gst-wallet-add-btn")?.addEventListener("click", addWallet);
        document.getElementById("gst-wallets-list")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-wallet-delete]");
            if (!btn) return;
            const wallet = catPanel.wallets[Number(btn.dataset.walletDelete)];
            if (!wallet) return;
            showConfirmModal({
                title: "Retirer l'adresse ?",
                emoji: "🪙",
                message: `L'adresse <strong>${escapeHtml(String(wallet.coin))}</strong> ne sera plus proposée au panier.`,
                confirmText: "Oui, retirer",
                cancelText: "Annuler",
                isDanger: true,
                onConfirm: () => saveCatalogueList("crypto_wallets",
                    catPanel.wallets.filter((w) => w !== wallet).map((w) => ({ coin: w.coin, address: w.address })), "Adresse retirée")
            });
        });
        const statusChips = document.getElementById("gst-orders-status-chips");
        if (statusChips) {
            statusChips.addEventListener("click", (e) => {
                const chip = e.target.closest("[data-orderstatus]");
                if (!chip) return;
                catPanel.ordersStatus = chip.dataset.orderstatus || "all";
                statusChips.querySelectorAll("[data-orderstatus]").forEach((c) => c.classList.toggle("active", c === chip));
                filterAndRenderOrders();
            });
        }
        document.getElementById("gst-orders-cards-list")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-order-status]");
            if (btn && !btn.disabled) changeOrderStatus(btn);
        });

        // Messages N-ème client
        document.getElementById("gst-milestones-add-btn")?.addEventListener("click", addMilestone);
        document.getElementById("gst-milestones-save-btn")?.addEventListener("click", saveMilestones);
        const milestones = document.getElementById("gst-milestones-list");
        if (milestones) {
            milestones.addEventListener("input", onMilestoneInput);
            milestones.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-ms-delete]");
                if (!btn) return;
                catPanel.milestonesDraft.splice(Number(btn.dataset.msDelete), 1);
                catPanel.milestonesDirty = true;
                renderMilestones();
            });
        }
    }

    // ===== FIDÉLITÉ (Réglages › Rang, Roue, Concours ; interrupteurs Avis dans SETTINGS_FIELDS) =====
    // Interrupteurs et nombres : lignes de SETTINGS_FIELDS (rank_enabled, referral_points, wheel_enabled,
    // wheel_cooldown_hours, wheel_notify_target, reviews_*). Listes (rangs, barème, lots) : éditeurs ci-dessous,
    // enregistrés par /admin/settings/save (validés par willy.py). Classement, historique de la roue et concours :
    // routes /admin/fidelite/…. Rien n'est écrit en dur : tout vient du serveur, et une liste jamais lue ne peut pas
    // être enregistrée (elle écraserait la vraie).
    const fidAdmin = {
        loaded: false, error: "", tiers: [], rewards: [], prizes: [], dirty: { tiers: false, rewards: false, prizes: false },
        notify: null, stats: null, orderRequired: false,
        leaderboard: null, leaderboardError: "", q: "", searchTimer: null, leaderboardSeq: 0,
        history: null, historyError: "",
        contests: null, contestsError: "", entriesOpen: false, pastEntries: {}, editingContestId: null
    };
    const FID_LIST_KEYS = { tiers: "rank_tiers", rewards: "rank_rewards", prizes: "wheel_prizes" };
    const FID_LIST_MAX = { tiers: 10, rewards: 10, prizes: 12 };
    const FID_LIST_IDS = { tiers: "gst-rank-tiers-list", rewards: "gst-rank-rewards-list", prizes: "gst-wheel-prizes-list" };
    const FID_WHEEL_KINDS = [
        { kind: "none", label: "Perdu" },
        { kind: "text", label: "Lot à remettre" },
        { kind: "percent", label: "Réduction %" },
        { kind: "amount", label: "Réduction (montant)" },
        { kind: "points", label: "Points fidélité" }
    ];
    const FID_ANNOUNCE_LABELS = { participants: "gagnant + participants", all: "gagnant + tous les clients", none: "gagnant seulement" };

    function fidDate(seconds, withTime) {
        const n = Number(seconds);
        if (!Number.isFinite(n) || n <= 0) return "—";
        const d = new Date(n * 1000);
        return withTime ? d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : d.toLocaleDateString("fr-FR");
    }

    function bindFidelitePanel() {
        // Éditeurs de listes : ajout, saisie (délégation), retrait d'une ligne, enregistrement
        Object.keys(FID_LIST_IDS).forEach((list) => {
            const box = document.getElementById(FID_LIST_IDS[list]);
            if (!box) return;
            box.addEventListener("input", (e) => fidEditRow(list, e.target, false));
            box.addEventListener("change", (e) => fidEditRow(list, e.target, true));
            box.addEventListener("click", (e) => {
                const del = e.target.closest("[data-fid-del]");
                if (!del) return;
                fidAdmin[list].splice(Number(del.dataset.fidDel), 1);
                fidAdmin.dirty[list] = true;
                renderFidList(list);
            });
        });
        document.getElementById("gst-rank-tier-add-btn")?.addEventListener("click", () => fidAddRow("tiers"));
        document.getElementById("gst-rank-reward-add-btn")?.addEventListener("click", () => fidAddRow("rewards"));
        document.getElementById("gst-wheel-add-prize-btn")?.addEventListener("click", () => fidAddRow("prizes"));
        document.getElementById("gst-rank-tiers-save-btn")?.addEventListener("click", () => fidSaveList("tiers"));
        document.getElementById("gst-rank-rewards-save-btn")?.addEventListener("click", () => fidSaveList("rewards"));
        document.getElementById("gst-wheel-save-prizes-btn")?.addEventListener("click", () => fidSaveList("prizes"));

        // Délai de la roue : les pastilles remplissent le champ heures, enregistré comme les autres réglages
        document.querySelectorAll("#gst-wheel-cooldown-chips [data-hours]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const field = SETTINGS_FIELDS.find((f) => f.key === "wheel_cooldown_hours");
                const input = field ? document.getElementById(field.id) : null;
                if (!input) return;
                input.value = btn.dataset.hours;
                fidSyncCooldownChips();
                saveSettingField(field, false);
            });
        });
        document.getElementById("gst-wheel-custom-hours")?.addEventListener("input", fidSyncCooldownChips);
        document.getElementById("gst-wheel-notify-select")?.addEventListener("change", fidRenderNotify);
        document.getElementById("gst-reviews-order-req-toggle")?.addEventListener("change", (e) => {
            fidAdmin.orderRequired = e.target.checked;
            fidSyncReviewDelay();
        });

        // Classement : recherche (serveur), actualisation, ajustement des points
        document.getElementById("gst-rank-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation du classement...", "info");
            fidLoadSummary();
            fidLoadLeaderboard();
        });
        document.getElementById("gst-rank-search-input")?.addEventListener("input", (e) => {
            fidAdmin.q = e.target.value.trim();
            clearTimeout(fidAdmin.searchTimer);
            fidAdmin.searchTimer = setTimeout(fidLoadLeaderboard, 350);
        });
        document.getElementById("gst-rank-leaderboard")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-fid-adjust]");
            if (btn) fidAdjustPoints(Number(btn.dataset.fidAdjust));
        });

        // Roue : historique
        document.getElementById("gst-wheel-history-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation de l'historique...", "info");
            fidLoadWheelHistory();
        });

        // Concours : création / modification, tirage, annulation, participants
        document.getElementById("gst-contest-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation des concours...", "info");
            fidLoadContests();
        });
        document.getElementById("gst-contest-save-btn")?.addEventListener("click", fidSaveContest);
        document.getElementById("gst-contest-cancel-edit-btn")?.addEventListener("click", () => fidResetContestForm(true));
        document.getElementById("gst-contest-form-box")?.addEventListener("toggle", (e) => {
            if (e.target.open && !fidAdmin.editingContestId && !document.getElementById("gst-contest-title")?.value) fidResetContestForm(false);
        });
        document.getElementById("gst-contest-active")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-contest-action]");
            if (btn) fidContestAction(btn.dataset.contestAction);
        });
        document.getElementById("gst-contest-history")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-contest-entries]");
            if (btn) fidTogglePastEntries(Number(btn.dataset.contestEntries));
        });
    }

    // Pages Rang & parrainage et Roue & concours (onglet Clients) : tout est relu à chaque ouverture
    async function loadFidelitePanel() {
        await Promise.all([fidLoadSummary(), fidLoadLeaderboard(), fidLoadWheelHistory(), fidLoadContests()]);
    }

    async function fidLoadSummary() {
        const res = await adminRequest("/admin/fidelite/summary");
        if (!res.ok || !res.data.settings) {
            fidAdmin.error = res.error || "Réglages fidélité indisponibles, réessaie.";
            if (!fidAdmin.loaded) Object.keys(FID_LIST_IDS).forEach(renderFidList);
            renderFidStats();
            return;
        }
        const d = res.data;
        const s = d.settings;
        fidAdmin.error = "";
        // Modification en cours (pas encore enregistrée) : gardée
        if (!fidAdmin.dirty.tiers) {
            fidAdmin.tiers = (Array.isArray(s.rank_tiers) ? s.rank_tiers : []).map((t) => ({
                emoji: String(t.emoji || ""), name: String(t.name || ""), min_points: String(t.min_points)
            }));
        }
        if (!fidAdmin.dirty.rewards) {
            fidAdmin.rewards = (Array.isArray(s.rank_rewards) ? s.rank_rewards : []).map((r) => ({
                points: String(r.points), amount: String(r.amount)
            }));
        }
        if (!fidAdmin.dirty.prizes) {
            fidAdmin.prizes = (Array.isArray(s.wheel_prizes) ? s.wheel_prizes : []).map((p) => ({
                label: String(p.label || ""), kind: String(p.kind || "text"),
                value: ["percent", "amount", "points"].includes(p.kind) ? String(p.value) : "",
                probability: String(p.probability)
            }));
        }
        fidAdmin.notify = d.notify || null;
        fidAdmin.stats = d.stats || null;
        fidAdmin.loaded = true;
        Object.keys(FID_LIST_IDS).forEach(renderFidList);
        renderFidStats();
        fidRenderNotify();
        fidSyncCooldownChips(Number(s.wheel_cooldown_hours));
        const orderReq = document.getElementById("gst-reviews-order-req-toggle");
        fidAdmin.orderRequired = orderReq ? orderReq.checked : false;
        fidSyncReviewDelay();
    }

    function renderFidStats() {
        const st = fidAdmin.stats;
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = st ? String(v) : "—";
        };
        set("gst-rank-stat-accounts", st && st.accounts);
        set("gst-rank-stat-referrals", st && st.referrals);
        set("gst-rank-stat-points", st && st.points);
    }

    // Destination des notifications : état réel du groupe enregistré par /fidelite
    function fidRenderNotify() {
        const el = document.getElementById("gst-wheel-notify-status");
        const select = document.getElementById("gst-wheel-notify-select");
        if (!el || !select) return;
        const n = fidAdmin.notify;
        if (select.value === "none") {
            el.textContent = "Aucune notification : les gains restent visibles dans l'historique ci-dessous.";
        } else if (select.value === "group") {
            if (!n) el.textContent = "État du groupe indisponible : actualise la section.";
            else if (n.chat_set) el.textContent = `✅ Groupe enregistré : « ${n.chat_title || "sans nom"} ». Retape /fidelite dans un autre groupe pour le remplacer.`;
            else el.textContent = "⚠️ Aucun groupe enregistré : ajoute le bot au groupe puis tape /fidelite dedans (en étant admin). En attendant, les admins sont prévenus en privé.";
        } else {
            el.textContent = "Les admins (liste blanche reliée et ADMIN_IDS) reçoivent chaque gain en privé : ils doivent avoir démarré le bot.";
        }
    }

    function fidSyncCooldownChips(fromServer) {
        const input = document.getElementById("gst-wheel-custom-hours");
        if (input && Number.isFinite(fromServer) && fromServer > 0 && document.activeElement !== input && !adState.settingsTimers.wheel_cooldown_hours) {
            input.value = String(fromServer);
        }
        const hours = input ? Number(input.value) : NaN;
        document.querySelectorAll("#gst-wheel-cooldown-chips [data-hours]").forEach((btn) => {
            btn.classList.toggle("active", Number(btn.dataset.hours) === hours);
        });
    }

    function fidSyncReviewDelay() {
        const group = document.getElementById("gst-reviews-delay-group");
        if (group) group.classList.toggle("gst-fid-dimmed", !fidAdmin.orderRequired);
    }

    // ── Éditeurs de listes ──
    function fidAddRow(list) {
        if (!fidAdmin.loaded) {
            showToast(fidAdmin.error || "Réglages fidélité pas encore lus : patiente ou actualise.", "error");
            return;
        }
        if (fidAdmin[list].length >= FID_LIST_MAX[list]) {
            showToast(`${FID_LIST_MAX[list]} lignes maximum.`, "error");
            return;
        }
        const blank = {
            tiers: { emoji: "", name: "", min_points: "" },
            rewards: { points: "", amount: "" },
            prizes: { label: "", kind: "text", value: "", probability: "" }
        }[list];
        fidAdmin[list].push(blank);
        fidAdmin.dirty[list] = true;
        renderFidList(list);
        const inputs = document.querySelectorAll(`#${FID_LIST_IDS[list]} [data-index="${fidAdmin[list].length - 1}"]`);
        if (inputs.length) inputs[0].focus();
    }

    function fidEditRow(list, el, committed) {
        const i = Number(el.dataset.index);
        const field = el.dataset.field;
        const row = fidAdmin[list][i];
        if (!row || !field) return;
        row[field] = el.value;
        fidAdmin.dirty[list] = true;
        if (list === "prizes") {
            if (field === "kind" && committed) renderFidList(list);
            else renderFidPrizeTotal();
        }
        fidMarkDirty(list);
    }

    function fidMarkDirty(list) {
        const btnId = { tiers: "gst-rank-tiers-save-btn", rewards: "gst-rank-rewards-save-btn", prizes: "gst-wheel-save-prizes-btn" }[list];
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.toggle("gst-fid-unsaved", fidAdmin.dirty[list]);
    }

    function renderFidList(list) {
        const box = document.getElementById(FID_LIST_IDS[list]);
        if (!box) return;
        fidMarkDirty(list);
        if (!fidAdmin.loaded) {
            if (fidAdmin.error) renderAdminListError(box, fidAdmin.error);
            else box.innerHTML = `<div class="gst-empty-placeholder">Chargement…</div>`;
            if (list === "prizes") renderFidPrizeTotal();
            return;
        }
        const rows = fidAdmin[list];
        const attr = (i, field) => `data-index="${i}" data-field="${field}"`;
        const del = (i) => `<button type="button" class="gst-btn-remove-sm" data-fid-del="${i}" aria-label="Retirer cette ligne">✕</button>`;
        let html = "";
        if (list === "tiers") {
            html = rows.map((t, i) => `
                <div class="gst-prize-row gst-fid-row">
                    <input type="text" class="gst-input-num-sm" ${attr(i, "emoji")} maxlength="8" placeholder="🥇" value="${escapeHtml(t.emoji)}" aria-label="Emoji du rang">
                    <input type="text" class="gst-input-sm" ${attr(i, "name")} maxlength="30" placeholder="Nom du rang (ex : Or)" value="${escapeHtml(t.name)}" aria-label="Nom du rang">
                    <input type="number" class="gst-input-pct" ${attr(i, "min_points")} min="0" max="100000" step="1" inputmode="numeric" placeholder="0" value="${escapeHtml(t.min_points)}" aria-label="Points cumulés nécessaires"> pts
                    ${del(i)}
                </div>`).join("");
            if (!rows.length) html = `<div class="gst-empty-placeholder">Aucun rang : le profil affiche seulement les points.</div>`;
        } else if (list === "rewards") {
            html = rows.map((r, i) => `
                <div class="gst-prize-row gst-fid-row">
                    <input type="number" class="gst-input-pct" ${attr(i, "points")} min="1" max="100000" step="1" inputmode="numeric" placeholder="10" value="${escapeHtml(r.points)}" aria-label="Points dépensés"> pts →
                    <input type="number" class="gst-input-pct" ${attr(i, "amount")} min="0.01" max="10000" step="0.01" inputmode="decimal" placeholder="5" value="${escapeHtml(r.amount)}" aria-label="Réduction"> ${escapeHtml(currencyLabel())} de réduction
                    ${del(i)}
                </div>`).join("");
            if (!rows.length) html = `<div class="gst-empty-placeholder">Aucun palier : les points ne peuvent pas encore être dépensés.</div>`;
        } else {
            html = rows.map((p, i) => {
                const withValue = ["percent", "amount", "points"].includes(p.kind);
                const unit = p.kind === "percent" ? "%" : p.kind === "points" ? "pts" : escapeHtml(currencyLabel());
                const options = FID_WHEEL_KINDS.map((k) => `<option value="${k.kind}"${k.kind === p.kind ? " selected" : ""}>${escapeHtml(k.label)}</option>`).join("");
                return `
                <div class="gst-fid-prize">
                    <div class="gst-prize-row">
                        <input type="text" class="gst-input-sm" ${attr(i, "label")} maxlength="40" placeholder="Nom du lot (ex : −10 % sur ta commande)" value="${escapeHtml(p.label)}" aria-label="Nom du lot">
                        <input type="number" class="gst-input-pct" ${attr(i, "probability")} min="0.01" max="100" step="0.01" inputmode="decimal" placeholder="10" value="${escapeHtml(p.probability)}" aria-label="Probabilité en %"> %
                        ${del(i)}
                    </div>
                    <div class="gst-prize-row">
                        <select class="gst-select-sm" ${attr(i, "kind")} aria-label="Type de lot">${options}</select>
                        ${withValue ? `<input type="number" class="gst-input-pct" ${attr(i, "value")} min="${p.kind === "amount" ? "0.01" : "1"}" step="${p.kind === "amount" ? "0.01" : "1"}" inputmode="decimal" value="${escapeHtml(p.value)}" aria-label="Valeur du lot"> ${unit}` : ""}
                    </div>
                </div>`;
            }).join("");
            if (!rows.length) html = `<div class="gst-empty-placeholder">Aucun lot : la roue ne peut pas être activée.</div>`;
        }
        box.innerHTML = html;
        if (list === "prizes") renderFidPrizeTotal();
    }

    // Somme en centièmes de % (comme willy.py) : pas d'erreur d'arrondi des décimales
    function fidPrizeTotal() {
        return fidAdmin.prizes.reduce((sum, p) => sum + Math.round((Number(p.probability) || 0) * 100), 0);
    }

    function renderFidPrizeTotal() {
        const el = document.getElementById("gst-wheel-total-sum");
        if (!el) return;
        if (!fidAdmin.loaded || !fidAdmin.prizes.length) {
            el.textContent = "";
            return;
        }
        const total = fidPrizeTotal();
        el.textContent = total === 10000 ? "Total : 100 % ✓" : `Total : ${(total / 100).toLocaleString("fr-FR")} % ⚠️ il doit faire exactement 100 %`;
        el.classList.toggle("gst-fid-warn", total !== 10000);
    }

    // Valeurs envoyées telles que saisies (nombres convertis) : willy.py valide et renvoie un message clair sinon
    function fidListPayload(list) {
        const num = (v) => (String(v).trim() === "" ? null : Number(String(v).replace(",", ".")));
        if (list === "tiers") return fidAdmin.tiers.map((t) => ({ emoji: t.emoji.trim(), name: t.name.trim(), min_points: num(t.min_points) }));
        if (list === "rewards") return fidAdmin.rewards.map((r) => ({ points: num(r.points), amount: num(r.amount) }));
        return fidAdmin.prizes.map((p) => ({
            label: p.label.trim(), kind: p.kind,
            value: ["percent", "amount", "points"].includes(p.kind) ? num(p.value) : 0,
            probability: num(p.probability)
        }));
    }

    async function fidSaveList(list) {
        if (!fidAdmin.loaded) {
            showToast(fidAdmin.error || "Réglages fidélité pas encore lus : actualise avant d'enregistrer.", "error");
            return;
        }
        if (list === "prizes" && fidAdmin.prizes.length && fidPrizeTotal() !== 10000) {
            showToast(`Total des probabilités : ${(fidPrizeTotal() / 100).toLocaleString("fr-FR")} % — il doit faire exactement 100 %.`, "error");
            return;
        }
        const btn = document.getElementById({ tiers: "gst-rank-tiers-save-btn", rewards: "gst-rank-rewards-save-btn", prizes: "gst-wheel-save-prizes-btn" }[list]);
        if (btn) btn.disabled = true;
        const ok = await saveAdminSettings({ [FID_LIST_KEYS[list]]: fidListPayload(list) });
        if (btn) btn.disabled = false;
        if (!ok) return;
        fidAdmin.dirty[list] = false;
        showToast({ tiers: "Rangs enregistrés 👑", rewards: "Barème enregistré 🎁", prizes: "Lots de la roue enregistrés 🎡" }[list]);
        await fidLoadSummary();
        if (list === "tiers") fidLoadLeaderboard();
    }

    // ── Classement et ajustement des points ──
    async function fidLoadLeaderboard() {
        const seq = ++fidAdmin.leaderboardSeq;
        const res = await adminRequest(`/admin/fidelite/leaderboard?q=${encodeURIComponent(fidAdmin.q)}`);
        if (seq !== fidAdmin.leaderboardSeq) return; // une recherche plus récente est partie
        if (!res.ok || !Array.isArray(res.data.items)) {
            fidAdmin.leaderboard = null;
            fidAdmin.leaderboardError = res.error || "Classement indisponible, réessaie.";
        } else {
            fidAdmin.leaderboard = res.data.items;
            fidAdmin.leaderboardError = "";
        }
        renderFidLeaderboard();
    }

    function fidPersonName(p) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
        if (p.username) return name ? `${name} (@${p.username})` : `@${p.username}`;
        return name || `ID ${p.user_id}`;
    }

    function renderFidLeaderboard() {
        const box = document.getElementById("gst-rank-leaderboard");
        if (!box) return;
        if (!fidAdmin.leaderboard) {
            renderAdminListError(box, fidAdmin.leaderboardError || "Chargement du classement…");
            return;
        }
        const items = fidAdmin.leaderboard;
        if (!items.length) {
            box.innerHTML = `<div class="gst-empty-placeholder">${fidAdmin.q ? "Aucun client trouvé." : "Aucun point gagné pour l'instant."}</div>`;
            return;
        }
        box.innerHTML = items.map((p, i) => {
            const rank = p.rank ? `${escapeHtml(p.rank.emoji || "")} ${escapeHtml(p.rank.name || "")}` : "";
            return `
            <div class="gst-cat-row">
                <span class="gst-cat-emoji gst-fid-pos">${fidAdmin.q ? "👤" : `#${i + 1}`}</span>
                <div class="gst-cat-info">
                    <div class="gst-cat-name">${escapeHtml(fidPersonName(p))}</div>
                    <div class="gst-cat-meta">🎟️ ${escapeHtml(p.code)} · 👥 ${Number(p.referrals) || 0} filleul${p.referrals > 1 ? "s" : ""}${rank ? ` · ${rank}` : ""} · ID ${escapeHtml(String(p.user_id))}</div>
                </div>
                <div class="gst-fid-points"><strong>${Number(p.points_total) || 0}</strong><span>solde ${Number(p.points) || 0}</span></div>
                <button type="button" class="gst-btn-secondary-sm" data-fid-adjust="${escapeHtml(String(p.user_id))}" aria-label="Ajuster les points">±</button>
            </div>`;
        }).join("");
    }

    function fidAdjustPoints(userId) {
        const p = (fidAdmin.leaderboard || []).find((x) => x.user_id === userId);
        if (!p) return;
        showConfirmModal({
            title: "Ajuster les points",
            emoji: "⭐",
            message: `<strong>${escapeHtml(fidPersonName(p))}</strong><br>Solde : ${Number(p.points) || 0} pt · cumul : ${Number(p.points_total) || 0} pt
                <input type="number" class="gst-fid-modal-input" id="gst-fid-delta" step="1" inputmode="numeric" placeholder="Points à ajouter (ex : 5) ou retirer (ex : -3)">
                <input type="text" class="gst-fid-modal-input" id="gst-fid-reason" maxlength="120" placeholder="Motif (facultatif)">
                <label class="gst-fid-modal-check"><input type="checkbox" id="gst-fid-notify" checked> Prévenir le client par le bot</label>`,
            confirmText: "Enregistrer",
            cancelText: "Annuler",
            isDanger: false,
            onConfirm: async () => {
                const delta = Number(document.getElementById("gst-fid-delta")?.value);
                const reason = (document.getElementById("gst-fid-reason")?.value || "").trim();
                const notify = Boolean(document.getElementById("gst-fid-notify")?.checked);
                if (!Number.isInteger(delta) || delta === 0) {
                    showToast("Entre un nombre entier de points, positif ou négatif (pas 0).", "error");
                    return;
                }
                const res = await adminRequest("/admin/fidelite/points", { user_id: userId, delta, reason, notify });
                if (!res.ok) {
                    showToast(res.error, "error");
                    return;
                }
                showToast(`Points enregistrés : solde ${res.data.points} pt ⭐`);
                fidLoadLeaderboard();
                fidLoadSummary();
            }
        });
    }

    // ── Historique de la roue ──
    async function fidLoadWheelHistory() {
        const res = await adminRequest("/admin/fidelite/wheel/history");
        if (!res.ok || !Array.isArray(res.data.items)) {
            fidAdmin.history = null;
            fidAdmin.historyError = res.error || "Historique indisponible, réessaie.";
        } else {
            fidAdmin.history = res.data.items;
            fidAdmin.historyError = "";
        }
        renderFidWheelHistory();
    }

    function renderFidWheelHistory() {
        const box = document.getElementById("gst-wheel-history-list");
        if (!box) return;
        if (!fidAdmin.history) {
            renderAdminListError(box, fidAdmin.historyError || "Chargement de l'historique…");
            return;
        }
        if (!fidAdmin.history.length) {
            box.innerHTML = `<div class="gst-empty-placeholder">Aucun tour de roue pour l'instant.</div>`;
            return;
        }
        const now = Date.now() / 1000;
        box.innerHTML = fidAdmin.history.map((s) => {
            let codeState = "";
            if (s.code) {
                const state = s.used ? "utilisé ✓" : (s.expires_at && s.expires_at < now ? "expiré" : "pas encore utilisé");
                codeState = ` · 🎟️ ${escapeHtml(s.code)} (${state})`;
            }
            const icon = s.prize_kind === "none" ? "➖" : s.prize_kind === "points" ? "⭐" : s.code ? "🎟️" : "🎁";
            return `
            <div class="gst-cat-row">
                <span class="gst-cat-emoji">${icon}</span>
                <div class="gst-cat-info">
                    <div class="gst-cat-name">${escapeHtml(s.prize_label)}</div>
                    <div class="gst-cat-meta">${escapeHtml(s.name)} · ${fidDate(s.created_at, true)}${codeState}</div>
                </div>
            </div>`;
        }).join("");
    }

    // ── Concours ──
    async function fidLoadContests() {
        const res = await adminRequest("/admin/fidelite/contests");
        if (!res.ok || !("active" in res.data)) {
            fidAdmin.contests = null;
            fidAdmin.contestsError = res.error || "Concours indisponibles, réessaie.";
        } else {
            fidAdmin.contests = res.data;
            fidAdmin.contestsError = "";
        }
        renderFidContests();
    }

    function renderFidContests() {
        const activeBox = document.getElementById("gst-contest-active");
        const historyBox = document.getElementById("gst-contest-history");
        const formBox = document.getElementById("gst-contest-form-box");
        const data = fidAdmin.contests;
        if (!data) {
            renderAdminListError(activeBox, fidAdmin.contestsError || "Chargement des concours…");
            renderAdminListError(historyBox, fidAdmin.contestsError || "Chargement…");
            if (formBox) formBox.style.display = "none";
            return;
        }
        const c = data.active;
        // Un seul concours à la fois : le formulaire de création n'apparaît que sans concours en cours (ou pour le modifier)
        if (formBox) formBox.style.display = !c || fidAdmin.editingContestId ? "" : "none";
        if (activeBox) {
            if (!c) {
                activeBox.innerHTML = `<div class="gst-empty-placeholder">Aucun concours en cours : crée-en un ci-dessous.</div>`;
            } else {
                const open = Date.now() / 1000 < c.ends_at;
                const entries = (data.entries || []).map((e) => `
                    <div class="gst-cat-row"><span class="gst-cat-emoji">${e.source === "bot" ? "🤖" : "🛍️"}</span>
                        <div class="gst-cat-info"><div class="gst-cat-name">${escapeHtml(e.name)}</div>
                        <div class="gst-cat-meta">ID ${escapeHtml(String(e.user_id))} · ${fidDate(e.created_at, true)}</div></div></div>`).join("");
                activeBox.innerHTML = `
                    <div class="gst-fid-contest">
                        <div class="gst-card-row-head">
                            <strong>${escapeHtml(c.title)}</strong>
                            <span class="gst-badge-status">${open ? "En cours" : "Participations closes"}</span>
                        </div>
                        <div class="gst-order-summary">🏆 ${escapeHtml(c.prize)}</div>
                        ${c.description ? `<p class="gst-caption">${escapeHtml(c.description)}</p>` : ""}
                        <div class="gst-order-meta">Fin : ${fidDate(c.ends_at, true)} · ${c.auto_draw ? "tirage automatique" : "tirage manuel"} · annonce : ${escapeHtml(FID_ANNOUNCE_LABELS[c.announce] || c.announce)}</div>
                        <div class="gst-review-actions">
                            <button type="button" class="gst-btn-secondary-sm" data-contest-action="entries">👥 Participants (${Number(c.participants) || 0})</button>
                            <button type="button" class="gst-btn-secondary-sm" data-contest-action="edit">✏️ Modifier</button>
                            <button type="button" class="gst-btn-success-sm" data-contest-action="draw">🎲 Tirer au sort</button>
                            <button type="button" class="gst-btn-danger-sm" data-contest-action="cancel">✕ Annuler</button>
                        </div>
                        <div class="gst-cat-list gst-fid-entries" ${fidAdmin.entriesOpen ? "" : "hidden"}>${entries || `<div class="gst-empty-placeholder">Aucun participant pour l'instant.</div>`}</div>
                    </div>`;
            }
        }
        if (historyBox) {
            const past = data.past || [];
            historyBox.innerHTML = past.length ? past.map((p) => {
                const result = p.status === "cancelled" ? "Annulé" : p.winner_name ? `🏆 ${escapeHtml(p.winner_name)}` : "Aucun participant";
                const list = fidAdmin.pastEntries[p.id];
                const listHtml = list === undefined ? "" : list === null
                    ? `<div class="gst-empty-placeholder gst-load-error">Participants indisponibles.</div>`
                    : (list.length ? list.map((e) => `<div class="gst-cat-meta">• ${escapeHtml(e.name)} (ID ${escapeHtml(String(e.user_id))})</div>`).join("") : `<div class="gst-cat-meta">Aucun participant.</div>`);
                return `
                <div class="gst-ticket-card">
                    <div class="gst-card-row-head"><strong>${escapeHtml(p.title)}</strong><span class="gst-order-meta">${fidDate(p.drawn_at || p.ends_at)}</span></div>
                    <div class="gst-order-summary">🎁 ${escapeHtml(p.prize)} · ${result}</div>
                    <div class="gst-review-actions"><button type="button" class="gst-btn-secondary-sm" data-contest-entries="${Number(p.id)}">👥 ${Number(p.participants) || 0} participant${p.participants > 1 ? "s" : ""}</button></div>
                    ${listHtml}
                </div>`;
            }).join("") : `<div class="gst-empty-placeholder">Aucun concours terminé.</div>`;
        }
    }

    async function fidTogglePastEntries(id) {
        if (fidAdmin.pastEntries[id] !== undefined) {
            delete fidAdmin.pastEntries[id];
            renderFidContests();
            return;
        }
        const res = await adminRequest(`/admin/fidelite/contest/entries?contest_id=${encodeURIComponent(id)}`);
        if (!res.ok) showToast(res.error, "error");
        fidAdmin.pastEntries[id] = res.ok && Array.isArray(res.data.entries) ? res.data.entries : null;
        renderFidContests();
    }

    function fidLocalInputValue(seconds) {
        const d = new Date(seconds * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // Formulaire vide (création) ; close : referme l'accordéon
    function fidResetContestForm(close) {
        fidAdmin.editingContestId = null;
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.value = v;
        };
        set("gst-contest-title", "");
        set("gst-contest-desc", "");
        set("gst-contest-prize", "");
        // Fin proposée : dans 7 jours à l'heure pile (modifiable)
        const inAWeek = new Date(Date.now() + 7 * 86400000);
        inAWeek.setMinutes(0, 0, 0);
        set("gst-contest-ends", fidLocalInputValue(inAWeek.getTime() / 1000));
        set("gst-contest-announce", "participants");
        const auto = document.getElementById("gst-contest-auto");
        if (auto) auto.checked = true;
        const title = document.getElementById("gst-contest-form-title");
        if (title) title.innerHTML = "➕ <strong>Nouveau concours</strong>";
        const save = document.getElementById("gst-contest-save-btn");
        if (save) save.textContent = "Créer le concours";
        const box = document.getElementById("gst-contest-form-box");
        if (box && close) box.open = false;
        renderFidContests();
    }

    function fidEditContest(c) {
        fidAdmin.editingContestId = c.id;
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.value = v;
        };
        set("gst-contest-title", c.title);
        set("gst-contest-desc", c.description || "");
        set("gst-contest-prize", c.prize);
        set("gst-contest-ends", fidLocalInputValue(c.ends_at));
        set("gst-contest-announce", c.announce || "participants");
        const auto = document.getElementById("gst-contest-auto");
        if (auto) auto.checked = c.auto_draw !== false;
        const title = document.getElementById("gst-contest-form-title");
        if (title) title.innerHTML = "✏️ <strong>Modifier le concours</strong>";
        const save = document.getElementById("gst-contest-save-btn");
        if (save) save.textContent = "Enregistrer les modifications";
        renderFidContests();
        const box = document.getElementById("gst-contest-form-box");
        if (box) {
            box.open = true;
            box.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    async function fidSaveContest() {
        const value = (id) => (document.getElementById(id)?.value || "").trim();
        const endsRaw = value("gst-contest-ends");
        const endsAt = endsRaw ? Math.floor(new Date(endsRaw).getTime() / 1000) : NaN;
        const body = {
            title: value("gst-contest-title"),
            description: value("gst-contest-desc"),
            prize: value("gst-contest-prize"),
            ends_at: endsAt,
            auto_draw: Boolean(document.getElementById("gst-contest-auto")?.checked),
            announce: value("gst-contest-announce") || "participants"
        };
        if (!body.title || !body.prize) {
            showToast("Le titre et le lot du concours sont obligatoires.", "error");
            return;
        }
        if (!Number.isFinite(endsAt) || endsAt <= Date.now() / 1000) {
            showToast("Date de fin : choisis une date à venir.", "error");
            return;
        }
        if (fidAdmin.editingContestId) body.contest_id = fidAdmin.editingContestId;
        const btn = document.getElementById("gst-contest-save-btn");
        if (btn) btn.disabled = true;
        const res = await adminRequest("/admin/fidelite/contest/save", body);
        if (btn) btn.disabled = false;
        if (!res.ok) {
            showToast(res.error, "error");
            return;
        }
        showToast(fidAdmin.editingContestId ? "Concours modifié ✏️" : "Concours créé : il apparaît dans le profil de la boutique et avec /concours 🎁");
        fidResetContestForm(true);
        await fidLoadContests();
    }

    function fidContestAction(action) {
        const c = fidAdmin.contests && fidAdmin.contests.active;
        if (!c) return;
        if (action === "entries") {
            fidAdmin.entriesOpen = !fidAdmin.entriesOpen;
            renderFidContests();
        } else if (action === "edit") {
            fidEditContest(c);
        } else if (action === "draw") {
            const options = Object.keys(FID_ANNOUNCE_LABELS).map((k) => `<option value="${k}"${k === c.announce ? " selected" : ""}>Annonce : ${escapeHtml(FID_ANNOUNCE_LABELS[k])}</option>`).join("");
            showConfirmModal({
                title: "Tirer au sort ?",
                emoji: "🎲",
                message: `Le serveur tire un gagnant parmi les <strong>${Number(c.participants) || 0}</strong> participant(s) de « ${escapeHtml(c.title)} » ; le concours se termine et le gagnant est prévenu par le bot.
                    <select class="gst-fid-modal-input" id="gst-fid-announce">${options}</select>`,
                confirmText: "Tirer au sort",
                cancelText: "Annuler",
                isDanger: false,
                onConfirm: async () => {
                    const announce = document.getElementById("gst-fid-announce")?.value || c.announce;
                    const res = await adminRequest("/admin/fidelite/contest/draw", { contest_id: c.id, announce });
                    if (!res.ok) {
                        showToast(res.error, "error");
                    } else {
                        const w = res.data.contest && res.data.contest.winner_name;
                        showToast(w ? `🏆 Gagnant : ${w}` : "Aucun participant : concours terminé sans gagnant.", w ? undefined : "info");
                    }
                    fidAdmin.entriesOpen = false;
                    await fidLoadContests();
                }
            });
        } else if (action === "cancel") {
            showConfirmModal({
                title: "Annuler le concours ?",
                emoji: "✕",
                message: `« ${escapeHtml(c.title)} » sera retiré de la boutique et du bot, sans tirage. Cette action est irréversible.`,
                confirmText: "Oui, annuler",
                cancelText: "Retour",
                isDanger: true,
                onConfirm: async () => {
                    const res = await adminRequest("/admin/fidelite/contest/cancel", { contest_id: c.id });
                    if (res.ok) showToast("Concours annulé");
                    else showToast(res.error, "error");
                    await fidLoadContests();
                }
            });
        }
    }

    // Photo jointe à un avis (boutique et modération) : fichier /uploads/ du serveur uniquement
    function fidReviewPhotoHtml(r) {
        const src = r && typeof r.photo === "string" && r.photo ? safeMediaUrl(resolveMediaUrl(r.photo, "image")) : "";
        return src ? `<img class="loyalty-review-photo" src="${escapeHtml(src)}" alt="" loading="lazy">` : "";
    }

    // ===== RÉORGANISATION : tableau de bord (Accueil), menu des Réglages, pastilles « à traiter » =====
    // Accueil : GET /admin/dashboard (willy.py, section Réorganisation), relu à chaque ouverture et chaque minute.
    // Menu des Réglages : résumés tirés des états déjà chargés par les sections (réglages enregistrés, bot backup,
    // état du bot…) : un état pas encore lu s'affiche « … », jamais une valeur supposée.
    const reorg = {
        dash: null,
        dashError: "",
        dashRequest: null,
        dashTimer: null,
        // Éléments à traiter : dernier compte connu (tableau de bord ou liste de la page), null = inconnu
        counts: { verifications: null, reviews: null, tickets: null, ordersNew: null }
    };
    const DASH_REFRESH_MS = 60000;
    // Contrôles d'accès (ACCESS_FLAG_KEYS de willy.py) : libellé et page de réglage
    const ACCESS_CONTROL_UI = {
        closed_mode_enabled: { label: "Mode fermé", page: "mode-ferme" },
        closed_schedule_enabled: { label: "Horaires", page: "mode-ferme" },
        mobile_only: { label: "Mobile uniquement", page: "mobile" },
        vpn_required: { label: "Anti-VPN", page: "vpn" },
        backup_bot_enabled: { label: "Bot backup obligatoire", page: "backup" },
        channel_mandatory: { label: "Canal obligatoire", page: "canal" },
        cni_required: { label: "CNI + selfie", page: "verifications" },
        approval_required: { label: "Approbation", page: "verifications" }
    };
    // À traiter (Accueil) : compte, page et filtre de la liste à l'arrivée
    const DASH_TODO = [
        { key: "verifications", icon: "🪪", title: "Vérifications en attente", sub: "CNI + selfie et approbations à décider", page: "verifications", anchor: "gst-cni-pending-list" },
        { key: "ordersNew", icon: "🆕", title: "Commandes à accepter", sub: "Nouvelles commandes, pas encore acceptées", page: "commandes", filter: "orders:new" },
        { key: "tickets", icon: "🎫", title: "Tickets SAV ouverts", sub: "Clients qui attendent une réponse", page: "tickets", filter: "tickets:open" },
        { key: "reviews", icon: "⭐", title: "Avis à modérer", sub: "Publiés dans la boutique après ta validation", page: "avis" }
    ];

    // Page Avis : réglages lus d'abord, puis la synthèse fidélité, qui lit l'interrupteur « avis après une commande »
    // pour griser ou non le délai (en parallèle, elle pouvait lire l'interrupteur avant son remplissage)
    async function loadAvisSettings() {
        await loadAdminSettingsData();
        await fidLoadSummary();
    }

    // Loaders de l'état du bot (GET /admin/bot/status) : sans toast d'erreur (menu) ou avec (page du réglage)
    function loadBotStatusQuiet() {
        return loadBotStatus(true);
    }

    function loadBotStatusData() {
        return loadBotStatus(false);
    }

    function dashInt(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }

    function dashPlural(n, word, plural) {
        return `${n} ${n > 1 ? (plural || `${word}s`) : word}`;
    }

    function dashSetText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // « 3 min », « 2 h 05 », « 4 j 3 h »
    function dashDuration(seconds) {
        const s = Math.max(0, Math.floor(Number(seconds) || 0));
        if (s < 60) return "moins d'une minute";
        const m = Math.floor(s / 60);
        if (m < 60) return `${m} min`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")}`;
        return `${Math.floor(h / 24)} j ${h % 24} h`;
    }

    function dashHost(url) {
        try {
            return new URL(String(url || "")).host;
        } catch (_) {
            return "";
        }
    }

    // ----- Pastilles « à traiter » : onglets Ventes et Clients, pastilles des pages, Accueil -----
    function reorgSetCount(key, value) {
        const n = dashInt(value);
        if (!(key in reorg.counts) || reorg.counts[key] === n) return;
        reorg.counts[key] = n;
        renderAdminBadges();
    }

    function adminPageBadge(pageKey) {
        const c = reorg.counts;
        const n = { commandes: c.ordersNew, verifications: c.verifications, avis: c.reviews, tickets: c.tickets }[pageKey];
        return Number(n) || 0;
    }

    function setNavBadge(tabKey, count) {
        const el = document.getElementById(`gst-nav-badge-${tabKey}`);
        if (!el) return;
        el.hidden = !(count > 0);
        el.textContent = count > 99 ? "99+" : String(count);
        el.setAttribute("aria-label", `${count} à traiter`);
    }

    function renderAdminBadges() {
        const c = reorg.counts;
        setNavBadge("ventes", Number(c.ordersNew) || 0);
        setNavBadge("clients", (Number(c.verifications) || 0) + (Number(c.reviews) || 0) + (Number(c.tickets) || 0));
        if (["catalogue", "ventes", "clients"].includes(adState.activeTab)) renderAdminSubtabs();
        if (adState.activePage === "accueil") renderDashTodo();
    }

    // Après les loaders d'une page : comptes relus par la page, résumés du menu des Réglages
    function adminPageLoaded(pageKey) {
        if (pageKey === "reglages" && adState.activePage === "reglages") renderSettingsMenu();
        renderAdminBadges();
    }

    // ----- Accueil : tableau de bord -----
    async function loadAdminDashboard() {
        if (!reorg.dashRequest) {
            // « Aujourd'hui » = depuis minuit à l'heure du téléphone (le serveur vérifie la valeur)
            const since = new Date().setHours(0, 0, 0, 0);
            reorg.dashRequest = adminRequest(`/admin/dashboard?since=${since}`).finally(() => {
                reorg.dashRequest = null;
            });
        }
        const res = await reorg.dashRequest;
        if (res.ok && res.data.today && res.data.system) {
            reorg.dash = res.data;
            reorg.dashError = "";
            // CRM coupé : page Fiches clients masquée dès l'Accueil (même règle que /admin/bot/status)
            if (typeof res.data.system.crm_enabled === "boolean") applyCrmVisibility(res.data.system.crm_enabled);
            const p = res.data.pending || {};
            reorg.counts.verifications = dashInt(p.verifications);
            reorg.counts.reviews = dashInt(p.reviews);
            reorg.counts.tickets = dashInt(p.tickets_open);
            reorg.counts.ordersNew = dashInt(p.orders_new);
        } else {
            // 404 sans JSON (willy.py pas encore redémarré après la mise à jour) : fetchWriteApi le signale comme une
            // connexion impossible (statut 0), d'où le même message dans les deux cas
            reorg.dashError = res.status === 404 || res.status === 0
                ? "Tableau de bord indisponible. Si le reste de la gestion répond, redémarre le bot (menu •••) pour l'activer ; sinon vérifie ta connexion."
                : (res.error || "Tableau de bord indisponible, réessaie.");
        }
        if (adState.activePage === "accueil") renderDashboard();
        renderAdminBadges();
    }

    function renderDashboard() {
        const user = getTelegramUser();
        const first = user && user.first_name ? plainText(String(user.first_name)).trim().slice(0, 40) : "";
        dashSetText("gst-dash-hello", first ? `Bonjour ${first} 👋` : "Bonjour 👋");
        const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        dashSetText("gst-dash-date", today.charAt(0).toUpperCase() + today.slice(1));
        const err = document.getElementById("gst-dash-error");
        if (err) {
            err.textContent = reorg.dashError;
            err.hidden = !reorg.dashError;
        }
        renderDashKpis();
        renderDashTotals();
        renderDashTodo();
        renderDashSystem();
        renderDashClosedShortcut();
        const at = reorg.dash ? new Date(Number(reorg.dash.generated_at) * 1000) : null;
        dashSetText("gst-dash-updated", at && !Number.isNaN(at.getTime())
            ? `Mis à jour à ${at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · actualisé chaque minute`
            : "");
    }

    // Commandes, chiffre d'affaires et panier moyen du jour (annulées exclues), comparés à hier
    function renderDashKpis() {
        const t = reorg.dash && reorg.dash.today;
        dashSetText("gst-dash-kpi-orders", t ? String(dashInt(t.orders) || 0) : "—");
        dashSetText("gst-dash-kpi-revenue", t ? formatPrice(t.revenue) : "—");
        dashSetText("gst-dash-kpi-avg", t ? formatPrice(t.avg_basket) : "—");
        const note = (id, text, tone) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            el.className = `gst-kpi-note${tone ? ` is-${tone}` : ""}`;
        };
        if (!t) {
            ["gst-dash-kpi-orders-note", "gst-dash-kpi-revenue-note", "gst-dash-kpi-avg-note"].forEach((id) => note(id, "", ""));
            return;
        }
        const orders = dashInt(t.orders) || 0;
        const dOrders = orders - (dashInt(t.yesterday_orders) || 0);
        note("gst-dash-kpi-orders-note", dOrders ? `${dOrders > 0 ? "+" : "−"}${Math.abs(dOrders)} vs hier` : "= hier", dOrders > 0 ? "up" : dOrders < 0 ? "down" : "");
        const dRevenue = Math.round(((Number(t.revenue) || 0) - (Number(t.yesterday_revenue) || 0)) * 100) / 100;
        note("gst-dash-kpi-revenue-note", dRevenue ? `${dRevenue > 0 ? "+" : "−"}${formatPrice(Math.abs(dRevenue))} vs hier` : "= hier", dRevenue > 0 ? "up" : dRevenue < 0 ? "down" : "");
        const cancelled = dashInt(t.cancelled) || 0;
        note("gst-dash-kpi-avg-note", cancelled
            ? `${dashPlural(cancelled, "annulée")} non comptée${cancelled > 1 ? "s" : ""}`
            : orders ? `sur ${dashPlural(orders, "commande")}` : "aucune commande", cancelled ? "down" : "");
    }

    // Base : clients du bot et produits (dont épuisés), sous les chiffres du jour
    function renderDashTotals() {
        const t = reorg.dash && reorg.dash.totals;
        if (!t) {
            dashSetText("gst-dash-totals", "");
            return;
        }
        const out = dashInt(t.out_of_stock) || 0;
        dashSetText("gst-dash-totals", `${dashPlural(dashInt(t.users) || 0, "client")} · ${dashPlural(dashInt(t.products) || 0, "produit")}${out ? ` (${dashPlural(out, "épuisé")})` : ""}`);
    }

    function renderDashTodo() {
        const box = document.getElementById("gst-dash-todo");
        if (!box) return;
        const pending = (reorg.dash && reorg.dash.pending) || {};
        const system = (reorg.dash && reorg.dash.system) || {};
        let total = 0;
        let known = true;
        box.innerHTML = DASH_TODO.map((item) => {
            const n = reorg.counts[item.key];
            if (n === null) known = false;
            else total += n;
            let sub = item.sub;
            if (item.key === "tickets") {
                const unread = dashInt(pending.tickets_unread) || 0;
                if (system.tickets_enabled === false && !n) sub = "Tickets SAV désactivés";
                else if (unread) sub = `${dashPlural(unread, "message")} non lu${unread > 1 ? "s" : ""}`;
            } else if (item.key === "ordersNew") {
                const inProgress = dashInt(pending.orders_in_progress) || 0;
                if (inProgress) sub = `${dashPlural(inProgress, "autre")} en cours (acceptée${inProgress > 1 ? "s" : ""} ou en livraison)`;
            }
            if (n === 0) sub = "Rien en attente";
            const cls = n === null ? "" : n > 0 ? " is-alert" : " is-done";
            // Demandes en attente : la page s'ouvre directement sur leur liste
            const anchor = n > 0 && item.anchor ? item.anchor : "";
            return `
                <button type="button" class="gst-dash-row${cls}" data-gst-goto="${item.page}"${item.filter ? ` data-gst-filter="${item.filter}"` : ""}${anchor ? ` data-gst-anchor="${anchor}"` : ""}>
                    <span class="gst-dash-row-icon" aria-hidden="true">${item.icon}</span>
                    <span class="gst-dash-row-text">
                        <span class="gst-dash-row-title">${escapeHtml(item.title)}</span>
                        <span class="gst-dash-row-sub">${escapeHtml(sub)}</span>
                    </span>
                    <span class="gst-dash-count">${n === null ? "—" : n > 0 ? (n > 99 ? "99+" : n) : "✓"}</span>
                    <span class="gst-chevron" aria-hidden="true">›</span>
                </button>`;
        }).join("");
        dashSetText("gst-dash-todo-note", !known ? "" : total ? `${total} à traiter` : "Tout est à jour ✓");
    }

    // Bot principal, bot backup, lien de la mini-app, boutique ouverte ou fermée, contrôles d'accès actifs
    function renderDashSystem() {
        const box = document.getElementById("gst-dash-system");
        if (!box) return;
        const s = reorg.dash && reorg.dash.system;
        if (!s) {
            box.innerHTML = `<div class="gst-empty-placeholder${reorg.dashError ? " gst-load-error" : ""}">${escapeHtml(reorg.dashError || "Chargement…")}</div>`;
            return;
        }
        const row = (r) => {
            const inner = `
                <span class="gst-dot is-${r.tone}" aria-hidden="true"></span>
                <span class="gst-dash-row-text">
                    <span class="gst-dash-row-title">${escapeHtml(r.title)}</span>
                    <span class="gst-dash-row-sub">${escapeHtml(r.sub)}</span>
                </span>`;
            return r.page
                ? `<button type="button" class="gst-dash-row" data-gst-goto="${r.page}">${inner}<span class="gst-chevron" aria-hidden="true">›</span></button>`
                : `<div class="gst-dash-row is-static">${inner}</div>`;
        };
        const rows = [];
        const main = s.main_bot || {};
        const mainName = telegramHandle(main.username);
        rows.push(row({
            tone: main.online ? "ok" : "bad",
            title: "Bot principal",
            sub: main.online ? `${mainName ? `@${mainName} · ` : ""}en ligne depuis ${dashDuration(main.uptime)}` : "Hors ligne : redémarre le bot",
            page: "profil-bot"
        }));
        const b = s.backup || {};
        const backupName = telegramHandle(b.username) ? `@${telegramHandle(b.username)} · ` : "";
        rows.push(row(!b.configured
            ? { tone: "off", title: "Bot backup", sub: "Non configuré", page: "backup" }
            : !b.running
                ? { tone: "bad", title: "Bot backup", sub: `${backupName}arrêté`, page: "backup" }
                : b.active
                    ? { tone: "warn", title: "Bot backup", sub: `${backupName}bascule active : il sert la boutique`, page: "backup" }
                    : { tone: "ok", title: "Bot backup", sub: `${backupName}en marche, en réserve${b.required ? " · obligatoire" : ""}`, page: "backup" }));
        const t = s.tunnel || {};
        const host = dashHost(t.url);
        rows.push(row(t.running && host
            ? { tone: t.menu_synced ? "ok" : "warn", title: "Lien de la mini-app", sub: `${host} · ${t.menu_synced ? "actif, bouton du bot à jour" : "actif, bouton du bot en cours de mise à jour"}` }
            : { tone: "bad", title: "Lien de la mini-app", sub: "Tunnel Cloudflare arrêté : il est relancé tout seul, sinon redémarre le bot" }));
        const a = s.access || {};
        const sched = a.schedule || {};
        rows.push(row(a.closed_now
            ? { tone: "bad", title: "Boutique fermée", sub: `${a.closed_manual ? "Mode fermé activé" : "Hors des horaires d'ouverture"}${a.reopen_at ? ` · réouverture à ${a.reopen_at}` : ""}`, page: "mode-ferme" }
            : { tone: "ok", title: "Boutique ouverte", sub: sched.enabled && sched.open && sched.close ? `Horaires ${sched.open} → ${sched.close}` : "Aucune fermeture programmée", page: "mode-ferme" }));
        if (s.orders_enabled === false) rows.push(row({ tone: "warn", title: "Commandes désactivées", sub: "Le panier affiche « Commandes fermées »", page: "options-commande" }));
        const active = (Array.isArray(a.active) ? a.active : []).filter((k) => ACCESS_CONTROL_UI[k]);
        rows.push(`
            <div class="gst-dash-row is-static gst-dash-access">
                <span class="gst-dot is-${active.length ? "on" : "off"}" aria-hidden="true"></span>
                <span class="gst-dash-row-text">
                    <span class="gst-dash-row-title">Contrôles d'accès</span>
                    <span class="gst-dash-row-sub">${active.length ? `${dashPlural(active.length, "actif")} · les admins passent tout` : "Aucun : boutique ouverte à tous"}</span>
                    ${active.length ? `<span class="gst-dash-chips">${active.map((k) => `<button type="button" class="gst-dash-chip" data-gst-goto="${ACCESS_CONTROL_UI[k].page}">${escapeHtml(ACCESS_CONTROL_UI[k].label)}</button>`).join("")}</span>` : ""}
                </span>
            </div>`);
        box.innerHTML = rows.join("");
    }

    // Raccourci « Mode fermé » : libellé selon le mode fermé manuel (closed_mode_enabled) lu par le tableau de bord
    function renderDashClosedShortcut() {
        const btn = document.getElementById("gst-dash-closed-btn");
        const a = reorg.dash && reorg.dash.system && reorg.dash.system.access;
        const closed = Boolean(a && a.closed_manual);
        dashSetText("gst-dash-closed-icon", closed ? "🔓" : "🔒");
        dashSetText("gst-dash-closed-label", !a ? "Mode fermé" : closed ? "Rouvrir la boutique" : "Fermer la boutique");
        if (btn) btn.classList.toggle("is-on", closed);
    }

    // Même enregistrement que l'interrupteur de Réglages › Mode fermé (SETTINGS_FIELDS : validation, relecture de l'accès)
    function toggleClosedFromDashboard() {
        const field = SETTINGS_FIELDS.find((f) => f.key === "closed_mode_enabled");
        const el = field ? document.getElementById(field.id) : null;
        const a = reorg.dash && reorg.dash.system && reorg.dash.system.access;
        if (!field || !el || !a) {
            showToast("État de la boutique pas encore lu : réessaie dans un instant.", "error");
            loadAdminDashboard();
            return;
        }
        const closing = !a.closed_manual;
        const apply = async () => {
            adState.settingsSaved[field.key] = !closing; // valeur que le serveur vient de donner
            el.checked = closing;
            refreshFieldDependents(field);
            await saveSettingField(field, false);
            loadAdminDashboard();
        };
        if (!closing) {
            apply();
            return;
        }
        showConfirmModal({
            title: "Fermer la boutique ?",
            emoji: "🔒",
            message: "Les clients voient tout de suite l'écran de fermeture à la place du catalogue (titre et message de Réglages › Mode fermé). Tu la rouvres d'un geste ici.",
            confirmText: "Oui, fermer",
            cancelText: "Annuler",
            isDanger: true,
            onConfirm: apply
        });
    }

    function dashNewProduct() {
        openAdminPage("produits");
        openProductWizard(null);
    }

    function startDashboardTimer() {
        if (reorg.dashTimer) return;
        reorg.dashTimer = setInterval(() => {
            if (adState.activePage !== "accueil" || document.visibilityState !== "visible" || !isShown(document.getElementById("admin-overlay"))) return;
            loadAdminDashboard();
        }, DASH_REFRESH_MS);
    }

    // ----- Menu des Réglages : résumé de l'état réel de chaque réglage -----
    // tone : on (actif), off (coupé), warn (à surveiller), bad (bloquant), "" (neutre)
    function reglagesSummary(pageKey) {
        const saved = adState.settingsSaved;
        const known = (key) => Object.prototype.hasOwnProperty.call(saved, key);
        const loading = { text: "…", tone: "" };
        const onOff = (key, onText, offText) => (!known(key) ? loading
            : saved[key] ? { text: onText || "Activé", tone: "on" } : { text: offText || "Désactivé", tone: "off" });
        switch (pageKey) {
            case "general": {
                const name = saved.name || (state.config && state.config.restaurant && state.config.restaurant.name) || "";
                return { text: name ? `${name} · logo, thème, intro` : "Logo, nom, thème, intro", tone: "" };
            }
            case "image-fond":
                if (!known("background_image")) return loading;
                return { text: `${saved.background_image ? "Image personnalisée" : "Fond d'origine"}${saved.background_hide_desktop ? " · masquée sur ordinateur" : ""}`, tone: "" };
            case "musique": {
                if (!known("music_enabled")) return loading;
                if (!saved.music_enabled) return { text: "Désactivée", tone: "off" };
                if (!adState.musicLoaded) return { text: "Activée", tone: "on" };
                const n = adState.musicTracks.length;
                return n ? { text: `Activée · ${dashPlural(n, "musique")}`, tone: "on" } : { text: "Activée · playlist vide", tone: "warn" };
            }
            case "devise":
                return saved.currency ? { text: saved.currency, tone: "" } : loading;
            case "reseaux": {
                if (!known("telegram_username")) return loading;
                const nets = SOCIAL_NETWORKS.filter((n) => saved[n.key]).length;
                const parts = [saved.telegram_username ? `@${saved.telegram_username}` : "Telegram non réglé"];
                if (nets) parts.push(`+ ${nets} réseau${nets > 1 ? "x" : ""}`);
                if (saved.contact_tab_enabled === false) parts.push("onglet Contact masqué");
                return { text: parts.join(" · "), tone: saved.telegram_username ? "" : "warn" };
            }
            case "mode-ferme": {
                const info = adState.closedInfo;
                if (info && info.now) return { text: `Fermée${info.reopenAt ? ` · réouverture à ${info.reopenAt}` : ""}`, tone: "bad" };
                if (!known("closed_mode_enabled")) return loading;
                if (saved.closed_schedule_enabled) return { text: `Ouverte · horaires ${saved.closed_schedule_open} → ${saved.closed_schedule_close}`, tone: "on" };
                return { text: "Ouverte", tone: "on" };
            }
            case "start": {
                const s = adState.startSaved;
                if (!s) return { text: "Message, photo et boutons de bienvenue", tone: "" };
                const n = parseStartButtons(s.start_buttons).length;
                return { text: `${s.welcome_message ? "Message personnalisé" : "Message par défaut"}${n ? ` · ${dashPlural(n, "bouton")}` : ""}`, tone: "" };
            }
            case "diffusion":
                if (!known("auto_messages_enabled")) return { text: "Broadcast, modèles, messages auto", tone: "" };
                return saved.auto_messages_enabled ? { text: "Broadcast · messages auto activés", tone: "on" } : { text: "Broadcast · messages auto coupés", tone: "" };
            case "autoclean":
                return onOff("autoclean_enabled");
            case "profil-bot":
                return { text: adState.mainBotUsername ? `@${adState.mainBotUsername} · nom et descriptions` : "Nom et descriptions publics", tone: "" };
            case "logs": {
                if (!known("tg_logs_enabled")) return loading;
                if (!saved.tg_logs_enabled) return { text: "Désactivés", tone: "off" };
                const logs = botPanel.status && botPanel.status.logs;
                if (!logs) return { text: "Activés", tone: "on" };
                return logs.chat_set
                    ? { text: `Activés · ${plainText(String(logs.chat_title || "canal enregistré")).slice(0, 40)}`, tone: "on" }
                    : { text: "Activés · aucun canal enregistré", tone: "warn" };
            }
            case "mobile":
                return onOff("mobile_only");
            case "vpn":
                return onOff("vpn_required");
            case "canal":
                if (!known("channel_mandatory")) return loading;
                if (saved.channel_mandatory) return { text: "Canal obligatoire actif", tone: "on" };
                return { text: saved.channel_link ? "Lien du canal réglé · non obligatoire" : "Aucun canal", tone: "off" };
            case "backup": {
                const b = adState.backup;
                if (!b.loaded) return b.error ? { text: "État indisponible", tone: "warn" } : loading;
                if (!b.tokenSet) return { text: "Non configuré", tone: "off" };
                const name = b.username ? `@${b.username}` : "Bot backup";
                if (!b.running) return { text: `${name} · arrêté`, tone: "bad" };
                if (b.active) return { text: `${name} · bascule active`, tone: "warn" };
                return { text: `${name} · en réserve${saved.backup_bot_enabled ? " · obligatoire" : ""}`, tone: "on" };
            }
            case "admins": {
                if (!known("name")) return loading;
                const n = adState.whitelist.length;
                return { text: n ? `${dashPlural(n, "accès donné", "accès donnés")}` : "Aucun accès ajouté", tone: "" };
            }
            case "crm":
                return onOff("crm_enabled", "Actif", "Désactivé");
            case "important":
                return { text: "À lire avant de toucher au profil public", tone: "" };
            default:
                return { text: "", tone: "" };
        }
    }

    function renderSettingsMenu() {
        const menu = document.getElementById("gst-settings-menu");
        if (!menu) return;
        menu.innerHTML = REGLAGES_SECTIONS.map((g) => `
            <div class="gst-menu-group">
                <div class="gst-menu-group-title">${escapeHtml(g.group)}</div>
                <div class="gst-menu-list">
                    ${g.items.map((it) => {
                        const st = it.page ? reglagesSummary(it.page) : reglagesActionSummary(it.action);
                        const target = it.page ? `data-gst-goto="${it.page}"` : `data-gst-action="${it.action}"`;
                        return `
                    <button type="button" class="gst-menu-row${it.action ? " is-action" : ""}" ${target}>
                        <span class="gst-menu-icon" aria-hidden="true">${it.icon}</span>
                        <span class="gst-menu-text">
                            <span class="gst-menu-title">${escapeHtml(it.title)}</span>
                            <span class="gst-menu-state${st.tone ? ` is-${st.tone}` : ""}">${escapeHtml(st.text)}</span>
                        </span>
                        <span class="gst-chevron" aria-hidden="true">›</span>
                    </button>`;
                    }).join("")}
                </div>
            </div>`).join("");
    }

    function reglagesActionSummary(action) {
        return action === "restart" ? { text: "Si le bot ne répond plus · le lien de la mini-app change", tone: "" } : { text: "", tone: "" };
    }

    // ----- Liens [data-gst-goto] (Accueil, menu des Réglages) : page, puis filtre de la liste (data-gst-filter) -----
    function applyAdminListFilter(filter) {
        if (filter === "orders:new") {
            catPanel.ordersStatus = "new";
            document.querySelectorAll("#gst-orders-status-chips [data-orderstatus]").forEach((c) => c.classList.toggle("active", c.dataset.orderstatus === "new"));
        } else if (filter === "tickets:open") {
            adState.ticketsFilter = "open";
            document.querySelectorAll("#gst-pane-tickets .gst-filter-chip").forEach((c) => c.classList.toggle("active", c.dataset.ticketfilter === "open"));
        }
    }

    function onAdminGotoClick(event) {
        const action = event.target.closest("[data-gst-action]");
        if (action) {
            if (action.dataset.gstAction === "restart") confirmAdminRestart();
            return;
        }
        const link = event.target.closest("[data-gst-goto]");
        if (!link) return;
        const filter = link.dataset.gstFilter || "";
        openAdminPage(link.dataset.gstGoto, { anchor: link.dataset.gstAnchor || "", before: () => applyAdminListFilter(filter) });
    }

    // --- Événements (appelé une fois par bindAdminPanelEvents) ---
    function bindReorgPanel() {
        // Accueil et menu des Réglages : lignes qui mènent à une page
        document.getElementById("gst-main-body")?.addEventListener("click", onAdminGotoClick);
        document.getElementById("gst-dash-refresh-btn")?.addEventListener("click", () => {
            showToast("Actualisation du tableau de bord…", "info");
            loadAdminDashboard();
        });
        document.getElementById("gst-dash-new-product-btn")?.addEventListener("click", dashNewProduct);
        document.getElementById("gst-dash-broadcast-btn")?.addEventListener("click", () => openAdminPage("diffusion"));
        document.getElementById("gst-dash-closed-btn")?.addEventListener("click", toggleClosedFromDashboard);

        // Accès rapide : recherche, résultat choisi (Entrée = premier résultat), fond de la modale
        const quickInput = document.getElementById("gst-quick-search-input");
        quickInput?.addEventListener("input", () => populateQuickListDrawer(quickInput.value));
        quickInput?.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            runQuickEntry(0);
        });
        document.getElementById("gst-quick-list-links")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-ql-index]");
            if (btn) runQuickEntry(Number(btn.dataset.qlIndex));
        });
        document.getElementById("gst-modal-quick-list")?.addEventListener("click", (e) => {
            if (e.target === e.currentTarget) closeQuickListDrawer();
        });

        // Filtres des listes qui étaient dans l'ancienne barre du haut : mode de commande, clients actifs
        document.getElementById("gst-orders-type-chips")?.addEventListener("click", (e) => {
            const chip = e.target.closest("[data-ordertype]");
            if (!chip) return;
            adState.ordersFilter = chip.dataset.ordertype || "all";
            e.currentTarget.querySelectorAll("[data-ordertype]").forEach((c) => c.classList.toggle("active", c === chip));
            filterAndRenderOrders();
        });
        document.getElementById("gst-users-filter-chips")?.addEventListener("click", (e) => {
            const chip = e.target.closest("[data-usersfilter]");
            if (!chip) return;
            adState.usersFilter = chip.dataset.usersfilter || "all";
            e.currentTarget.querySelectorAll("[data-usersfilter]").forEach((c) => c.classList.toggle("active", c === chip));
            filterAndRenderUsers();
        });

        startDashboardTimer();
        renderDashboard();
        renderSettingsMenu();
    }

    // ===== FIN ADMIN PANEL =====

    const music = { audio: new Audio(), tracks: [], index: 0, errors: 0, resumeOnShow: false, autostart: null };

    function getMusicPlaylist() {
        if (!shopMusicEnabled()) return [];  // bot : interrupteur Musique coupé → lecteur absent de la boutique
        try {
            const list = JSON.parse((state.config && state.config.admin && state.config.admin.music_playlist) || "[]");
            return Array.isArray(list) ? list.filter((t) => t && t.url) : [];
        } catch (_) {
            return [];
        }
    }

    function renderMusicPlayer() {
        if (!els.musicPlayer) return;
        const track = music.tracks[music.index];
        els.musicPlayer.hidden = !music.tracks.length;
        els.musicPlayer.classList.toggle("playing", !music.audio.paused);
        els.musicPlayer.classList.toggle("muted", music.audio.muted);
        els.musicTitle.textContent = track ? (track.title || `Piste ${music.index + 1}`) : "";
        els.musicPlay.setAttribute("aria-label", music.audio.paused ? "Lecture" : "Pause");
    }

    function loadMusicTrack(index) {
        music.index = (index + music.tracks.length) % music.tracks.length;
        music.audio.src = cleanMediaUrl(music.tracks[music.index].url, "audio");
        renderMusicPlayer();
    }

    function playMusic() {
        // Écran d'accès affiché : pas de musique derrière (elle repart quand la boutique s'ouvre)
        if (!music.tracks.length || accessLocked()) return Promise.resolve();
        if (!music.audio.getAttribute("src")) loadMusicTrack(music.index);
        return music.audio.play().catch(() => {});
    }

    function cancelMusicAutostart() {
        if (music.autostart) document.removeEventListener("pointerup", music.autostart, true);
        music.autostart = null;
    }

    function syncMusicPlaylist() {
        const currentUrl = music.tracks[music.index] ? music.tracks[music.index].url : "";
        music.tracks = getMusicPlaylist();
        const kept = music.tracks.findIndex((t) => t.url === currentUrl);
        if (kept >= 0) {
            music.index = kept;
        } else {
            music.audio.pause();
            music.audio.removeAttribute("src");
            music.index = 0;
        }
        renderMusicPlayer();
    }

    function startMusicPlayer() {
        syncMusicPlaylist();
        if (!music.tracks.length || accessLocked() || localStorage.getItem("gh-music-paused")) return;
        playMusic().then(() => {
            if (!music.audio.paused) return;
            music.autostart = (e) => {
                if (e.target.closest && e.target.closest("#music-player")) return;
                cancelMusicAutostart();
                playMusic();
            };
            document.addEventListener("pointerup", music.autostart, true);
        });
    }

    function bindMusicPlayer() {
        if (!els.musicPlayer) return;
        const savedVolume = parseFloat(localStorage.getItem("gh-music-volume"));
        music.audio.volume = 0.5;
        els.musicVolume.hidden = music.audio.volume !== 0.5;
        music.audio.volume = Number.isFinite(savedVolume) ? savedVolume : 0.6;
        music.audio.muted = localStorage.getItem("gh-music-muted") === "1";
        els.musicVolume.value = music.audio.volume;

        ["play", "pause", "volumechange"].forEach((evt) => music.audio.addEventListener(evt, renderMusicPlayer));
        music.audio.addEventListener("play", () => localStorage.removeItem("gh-music-paused"));
        music.audio.addEventListener("playing", () => { music.errors = 0; });
        music.audio.addEventListener("ended", () => {
            loadMusicTrack(music.index + 1);
            playMusic();
        });
        music.audio.addEventListener("error", () => {
            if (!music.audio.getAttribute("src")) return;
            if (++music.errors >= music.tracks.length) {
                // un tour complet sans piste lisible : on s'arrête vraiment (le prochain Lecture recharge la piste)
                music.errors = 0;
                music.audio.pause();
                music.audio.removeAttribute("src");
                renderMusicPlayer();
                return;
            }
            loadMusicTrack(music.index + 1);
            playMusic();
        });

        els.musicToggle.addEventListener("click", () => {
            els.musicPlayer.classList.toggle("open");
            if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        });
        els.musicPlay.addEventListener("click", () => {
            cancelMusicAutostart();
            if (music.audio.paused) {
                playMusic();
            } else {
                music.audio.pause();
                localStorage.setItem("gh-music-paused", "1");
            }
        });
        els.musicPrev.addEventListener("click", () => {
            cancelMusicAutostart();
            if (music.audio.currentTime > 3) music.audio.currentTime = 0;
            else loadMusicTrack(music.index - 1);
            playMusic();
        });
        els.musicNext.addEventListener("click", () => {
            cancelMusicAutostart();
            loadMusicTrack(music.index + 1);
            playMusic();
        });
        els.musicMute.addEventListener("click", () => {
            music.audio.muted = !music.audio.muted;
            localStorage.setItem("gh-music-muted", music.audio.muted ? "1" : "0");
        });
        els.musicVolume.addEventListener("input", () => {
            music.audio.volume = Number(els.musicVolume.value);
            music.audio.muted = false;
            localStorage.setItem("gh-music-volume", els.musicVolume.value);
            localStorage.setItem("gh-music-muted", "0");
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden && !music.audio.paused) {
                music.resumeOnShow = true;
                music.audio.pause();
            } else if (!document.hidden && music.resumeOnShow) {
                music.resumeOnShow = false;
                playMusic();
            }
        });
        document.addEventListener("play", (e) => {
            if (e.target.tagName === "VIDEO" && !e.target.muted) music.audio.pause();
        }, true);
    }

    // ===== APPARENCE DE LA BOUTIQUE (réglages theme_color, background_image, logo_url, animated_bg, loader_style) =====
    // Logo réglé (/uploads/…) pour l'en-tête, l'intro et les aperçus du panel ; sinon logo.png
    function shopLogoSrc(path) {
        return safeMediaUrl(resolveMediaUrl(path || "", "image")) || "logo.png";
    }

    function applyShopLogo(path) {
        const src = shopLogoSrc(path);
        document.querySelectorAll(".brand-logo, .intro-logo, .contact-hero-logo, #gst-logo-img, .gst-loader-logo-img").forEach((img) => {
            // Fichier introuvable (logo remplacé depuis la dernière visite, voir applyStoredIntroAppearance) : logo par défaut
            img.onerror = src === "logo.png" ? null : () => {
                img.onerror = null;
                img.src = "logo.png";
            };
            // Même image (chemin relatif ou adresse complète) : pas de rechargement, donc pas de clignotement
            if (img.getAttribute("src") !== src && img.src !== new URL(src, window.location.href).href) img.src = src;
        });
    }

    // Image de fond réglée : remplace seulement background.png, sous le même dégradé sombre,
    // en cover et centrée (body.has-custom-bg dans style.css) ; vide = fond par défaut
    function applyShopBackgroundImage(path) {
        path = shopBackgroundPath(path);  // bot : image de la source de démarrage, aucune image sur ordinateur si réglé
        const src = path ? safeMediaUrl(resolveMediaUrl(path, "image")) : "";
        document.body.classList.toggle("has-custom-bg", Boolean(src));
        if (src) document.body.style.setProperty("--shop-bg-image", `url("${src}")`);
        else document.body.style.removeProperty("--shop-bg-image");
    }

    // Chaque réglage est appliqué à part : une valeur abîmée garde l'apparence par défaut au lieu de casser la boutique
    function applyShopAppearance(cfg) {
        const adminCfg = (cfg && cfg.admin) || {};
        [
            () => {
                applyBrandColor(adminCfg.theme_color);
                rememberThemeColor(adminCfg.theme_color);
            },
            () => applyShopBackgroundImage(adminCfg.background_image),
            () => applyShopLogo(adminCfg.logo_url),
            () => applyStoreAnimatedBg(adminCfg.animated_bg),
            () => applyStoreIntroLoader(adminCfg.loader_style),
            () => rememberIntroAppearance(adminCfg, (cfg && cfg.restaurant) || {})
        ].forEach((apply) => {
            try {
                apply();
            } catch (err) {
                console.warn("Apparence non appliquée :", err);
            }
        });
    }

    // Loader et logo de la dernière visite, posés dès l'exécution du script : l'intro les montre pendant
    // le chargement de la config, au lieu de les recevoir juste avant de disparaître
    const INTRO_STORAGE_KEY = "gh_intro_v1";

    function rememberIntroAppearance(adminCfg, restaurant) {
        try {
            localStorage.setItem(INTRO_STORAGE_KEY, JSON.stringify({
                loader: safeLoaderName(adminCfg.loader_style),
                logo: uploadedPath(adminCfg.logo_url),
                name: restaurant && typeof restaurant.name === "string" ? restaurant.name.trim().slice(0, 60) : ""
            }));
        } catch (_) { }
    }

    function applyStoredIntroAppearance() {
        // Apparence écrite dans la page par le serveur d'abord (toujours à jour), sinon celle de la dernière visite
        const look = pageAppearance();
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(INTRO_STORAGE_KEY) || "null");
        } catch (_) { }
        if (!saved || typeof saved !== "object") saved = {};
        try {
            const loader = look.loader_style || saved.loader;
            if (loader) applyStoreIntroLoader(loader);
            const logo = look.logo_url || saved.logo;
            if (logo) applyShopLogo(logo);
            // Fond animé lancé tout de suite, sans attendre /config (applyShopAppearance le confirme ensuite)
            if (look.animated_bg) applyStoreAnimatedBg(look.animated_bg);
        } catch (_) { }
    }

    // ===== BOT (boutique) : interrupteur Musique, image de fond par source de démarrage ou masquée sur ordinateur =====
    // Réglages de config.admin (/config) : music_enabled, background_hide_desktop et background_targets ([{source, image}],
    // source = paramètre du lien t.me/<bot>?startapp=<source>). getMusicPlaylist et applyShopBackgroundImage s'en servent.
    const START_SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const START_SOURCE_STORAGE_KEY = "gh_start_source_v1";
    const MOBILE_TELEGRAM_PLATFORMS = ["android", "android_x", "ios"];

    function initBotShop() {
        rememberStartSource();
    }

    // Musique activée ? Clé jamais enregistrée : oui (interrupteur coché par défaut dans la gestion)
    function shopMusicEnabled() {
        const adm = (state.config && state.config.admin) || {};
        return !Object.prototype.hasOwnProperty.call(adm, "music_enabled") || adm.music_enabled === "" || isOn(adm.music_enabled);
    }

    // Paramètre du lien qui a ouvert la boutique (Telegram le donne dans initDataUnsafe.start_param), "" sinon
    function telegramStartParam() {
        const raw = tg && tg.initDataUnsafe && typeof tg.initDataUnsafe.start_param === "string" ? tg.initDataUnsafe.start_param.trim() : "";
        return START_SOURCE_RE.test(raw) ? raw : "";
    }

    // La source du client est gardée : ses visites suivantes (bouton du bot, menu) gardent l'image de sa source
    function rememberStartSource() {
        const source = telegramStartParam();
        if (!source) return;
        try {
            localStorage.setItem(START_SOURCE_STORAGE_KEY, source);
        } catch (_) { }
    }

    function shopStartSource() {
        const fresh = telegramStartParam();
        if (fresh) return fresh;
        try {
            const saved = localStorage.getItem(START_SOURCE_STORAGE_KEY) || "";
            return START_SOURCE_RE.test(saved) ? saved : "";
        } catch (_) {
            return "";
        }
    }

    // [{source, image}] enregistrés (texte JSON de config.admin ou tableau de /admin/bot/status) ; entrées invalides ignorées
    function parseBackgroundTargets(value) {
        let list = value;
        if (typeof list === "string") {
            try {
                list = JSON.parse(list || "[]");
            } catch (_) {
                list = [];
            }
        }
        if (!Array.isArray(list)) return [];
        return list
            .filter((t) => t && START_SOURCE_RE.test(String(t.source || "")) && uploadedPath(t.image))
            .map((t) => ({ source: String(t.source), image: uploadedPath(t.image) }));
    }

    // Image de la source (sans tenir compte de la casse, comme le serveur qui refuse deux sources « Promo » et « promo »)
    function backgroundTargetFor(source, targets) {
        if (!source) return "";
        const key = source.toLowerCase();
        const hit = targets.find((t) => t.source.toLowerCase() === key);
        return hit ? hit.image : "";
    }

    function isMobileTelegram() {
        return MOBILE_TELEGRAM_PLATFORMS.includes(telegramPlatform());
    }

    // Image de fond à afficher (/uploads/… ou "" = fond d'origine) : celle de la source du client si l'admin en a réglé
    // une, sinon l'image générale. « Masquer sur ordinateur » hors téléphone : aucune image (body.shop-bg-off, access.css)
    function shopBackgroundPath(path) {
        const adm = (state.config && state.config.admin) || {};
        const hidden = isOn(adm.background_hide_desktop) && !isMobileTelegram();
        document.body.classList.toggle("shop-bg-off", hidden);
        if (hidden) return "";
        return backgroundTargetFor(shopStartSource(), parseBackgroundTargets(adm.background_targets)) || path;
    }

    // ===== SUPPORT CLIENT : tickets SAV depuis l'onglet Contact (« Signaler un problème », équipe Messages) =====
    // Routes de willy.py (initData signée + accès autorisé, comme une commande) : GET /support/ticket,
    // POST /support/ticket/open, /support/ticket/message, /support/ticket/close. La carte n'existe que si tickets_enabled.
    const SUPPORT_TEXT_MAX = 1000;
    const SUPPORT_SUBJECT_MAX = 80;
    const SUPPORT_POLL_MS = 15000;
    const SUPPORT_TEXTS = {
        fr: {
            title: "Support", desc: "Une question sur une commande ou une livraison ? Écris-nous : la réponse arrive ici et dans Telegram.",
            open: "💬 Contacter le support", subject: "Sujet (facultatif)", subjectPh: "Ex : ma commande de samedi",
            message: "Ton message", messagePh: "Explique ta demande…", send: "Envoyer", cancel: "Annuler",
            ticket: "Ticket #{id}", statusOpen: "En cours", statusClosed: "Clos", you: "Toi", staff: "Support", info: "Info",
            replyPh: "Ajoute un message…", close: "Clore le ticket", newTicket: "Nouveau ticket", refresh: "Actualiser",
            loading: "Chargement…", error: "Support injoignable, réessaie dans un instant.", sent: "Message envoyé au support ✅",
            opened: "Ticket ouvert ✅ Le support te répond ici et dans Telegram.", closed: "Ticket clos.",
            closedHint: "Ce ticket est clos. Ouvre-en un nouveau si besoin.", botHint: "Tu peux aussi écrire /sav au bot.",
            tooLong: "Message trop long (1000 caractères max).", empty: "Écris d'abord ton message.",
            confirmClose: "Clore ce ticket ? Tu pourras en ouvrir un nouveau.", waiting: "En attente de la réponse du support.",
            answered: "Le support t'a répondu.", unavailable: "Le support est fermé pour le moment."
        },
        en: {
            title: "Support", desc: "A question about an order or a delivery? Write to us: the answer arrives here and in Telegram.",
            open: "💬 Contact support", subject: "Subject (optional)", subjectPh: "E.g. my Saturday order",
            message: "Your message", messagePh: "Describe your request…", send: "Send", cancel: "Cancel",
            ticket: "Ticket #{id}", statusOpen: "Open", statusClosed: "Closed", you: "You", staff: "Support", info: "Info",
            replyPh: "Add a message…", close: "Close ticket", newTicket: "New ticket", refresh: "Refresh",
            loading: "Loading…", error: "Support unreachable, try again in a moment.", sent: "Message sent to support ✅",
            opened: "Ticket opened ✅ Support answers here and in Telegram.", closed: "Ticket closed.",
            closedHint: "This ticket is closed. Open a new one if needed.", botHint: "You can also type /sav to the bot.",
            tooLong: "Message too long (1000 characters max).", empty: "Write your message first.",
            confirmClose: "Close this ticket? You can open a new one later.", waiting: "Waiting for support's answer.",
            answered: "Support answered you.", unavailable: "Support is closed for now."
        },
        de: {
            title: "Support", desc: "Eine Frage zu einer Bestellung oder Lieferung? Schreib uns: Die Antwort kommt hier und in Telegram.",
            open: "💬 Support kontaktieren", subject: "Betreff (optional)", subjectPh: "Z. B. meine Bestellung vom Samstag",
            message: "Deine Nachricht", messagePh: "Beschreibe dein Anliegen…", send: "Senden", cancel: "Abbrechen",
            ticket: "Ticket #{id}", statusOpen: "Offen", statusClosed: "Geschlossen", you: "Du", staff: "Support", info: "Info",
            replyPh: "Nachricht hinzufügen…", close: "Ticket schließen", newTicket: "Neues Ticket", refresh: "Aktualisieren",
            loading: "Wird geladen…", error: "Support nicht erreichbar, versuch es gleich nochmal.", sent: "Nachricht an den Support gesendet ✅",
            opened: "Ticket eröffnet ✅ Der Support antwortet hier und in Telegram.", closed: "Ticket geschlossen.",
            closedHint: "Dieses Ticket ist geschlossen. Eröffne bei Bedarf ein neues.", botHint: "Du kannst dem Bot auch /sav schreiben.",
            tooLong: "Nachricht zu lang (max. 1000 Zeichen).", empty: "Schreib zuerst deine Nachricht.",
            confirmClose: "Dieses Ticket schließen? Du kannst später ein neues eröffnen.", waiting: "Warte auf die Antwort des Supports.",
            answered: "Der Support hat dir geantwortet.", unavailable: "Der Support ist gerade geschlossen."
        }
    };
    // view : « button » (repliée), « form » (nouveau ticket), « thread » (ticket ouvert ou dernier ticket clos)
    const supportUi = { view: "button", ticket: null, loaded: false, loading: false, busy: false, cfg: null, timer: null, error: "", seen: false };

    function supportT(key, params) {
        const dict = SUPPORT_TEXTS[state.language] || SUPPORT_TEXTS.fr;
        let text = dict[key] || SUPPORT_TEXTS.fr[key] || key;
        Object.keys(params || {}).forEach((k) => { text = text.replace(`{${k}}`, String(params[k])); });
        return text;
    }

    function supportEnabled() {
        return Boolean(state.config && state.config.admin && isOn(state.config.admin.tickets_enabled));
    }

    // Appel au serveur de la boutique (tunnel ou page servie par willy.py) : l'initData ne part jamais ailleurs
    async function supportRequest(path, body) {
        const bases = getWriteApiBases().filter(isTrustedServerBase);
        const initData = getAdminInitData();
        const platform = telegramPlatform();
        for (const base of bases) {
            const options = body === undefined
                ? { cache: "no-store", headers: Object.assign({ "X-Telegram-Init-Data": initData }, platform ? { "X-Telegram-Platform": platform } : {}) }
                : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, body, { init_data: initData, platform })) };
            try {
                const resp = await fetchWithTimeout(`${base}${path}`, options, 12000);
                const data = await readJsonIfAny(resp);
                if (data) return { ok: resp.ok && data.success !== false, status: resp.status, data };
            } catch (_) { }
        }
        return { ok: false, status: 0, data: null };
    }

    // Réponse refusée : écran d'accès (403 avec gate), support fermé, ou message d'erreur du serveur
    function supportFailure(res) {
        const data = res.data || {};
        if (res.status === 403 && applyGateRefusal(data)) return true;
        if (data.support_closed) {
            supportUi.ticket = null;
            supportUi.view = "button";
            showToast(supportT("unavailable"), "error");
            renderSupportCard(true);
            return true;
        }
        showToast(typeof data.error === "string" && data.error ? data.error : supportT("error"), "error");
        return false;
    }

    async function supportLoad(silent) {
        if (supportUi.loading) return;
        supportUi.loading = true;
        if (!silent) renderSupportCard();
        const res = await supportRequest("/support/ticket");
        supportUi.loading = false;
        if (!res.ok) {
            supportUi.error = silent ? supportUi.error : supportT("error");
            if (!silent) supportFailure(res);
            renderSupportCard();
            return;
        }
        supportUi.error = "";
        supportUi.loaded = true;
        supportUi.ticket = res.data.enabled !== false && res.data.ticket ? res.data.ticket : null;
        if (supportUi.view === "button" && supportUi.ticket && supportUi.ticket.status === "open") supportUi.view = "thread";
        renderSupportCard();
    }

    function supportMessagesHtml(ticket) {
        const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
        return messages.map((m) => {
            const from = m.from === "client" ? "client" : m.from === "admin" ? "admin" : "system";
            const who = from === "client" ? supportT("you") : from === "admin" ? supportT("staff") : supportT("info");
            const when = Number(m.ts) ? new Date(Number(m.ts) * 1000).toLocaleString(getLocaleCode(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
            return `<div class="support-bubble from-${from}"><div class="support-bubble-text">${escapeHtml(String(m.text || ""))}</div><div class="support-bubble-meta">${escapeHtml(who)}${when ? ` · ${escapeHtml(when)}` : ""}</div></div>`;
        }).join("");
    }

    // force : nouveau rendu même si la config n'a pas changé (sinon la saisie en cours est gardée)
    function renderSupportCard(force) {
        const card = document.getElementById("support-card");
        const body = document.getElementById("support-body");
        if (!card || !body) return;
        const enabled = supportEnabled();
        card.hidden = !enabled;
        // onglet Contact : repliée (vue « button »), la carte laisse la place à la ligne « Signaler un problème »
        card.classList.toggle("is-idle", supportUi.view === "button");
        const title = document.getElementById("support-title");
        const desc = document.getElementById("support-desc");
        if (title) title.textContent = supportT("title");
        if (desc) desc.textContent = supportT("desc");
        if (!enabled) {
            body.innerHTML = "";
            return;
        }
        // Saisie en cours dans la carte : gardée telle quelle (le rendu repart du même état)
        const draft = body.querySelector("[data-support-text]");
        const subjectDraft = body.querySelector("[data-support-subject]");
        const keep = !force && draft ? { text: draft.value, subject: subjectDraft ? subjectDraft.value : "", focus: document.activeElement === draft } : null;
        const t = supportUi.ticket;
        let html = "";
        if (supportUi.view === "button") {
            const status = t && t.status === "open"
                ? `<p class="support-status">${escapeHtml(supportT("ticket", { id: Number(t.id) }))} · ${escapeHtml(supportT("statusOpen"))}</p>` : "";
            html = `${status}<div class="inline-actions"><button class="btn primary" type="button" data-support-action="open">${escapeHtml(supportUi.loading ? supportT("loading") : supportT("open"))}</button></div>
                <p class="support-hint">${escapeHtml(supportT("botHint"))}</p>`;
        } else if (supportUi.view === "form") {
            html = `
                <label class="support-label" for="support-subject">${escapeHtml(supportT("subject"))}</label>
                <input class="support-input" id="support-subject" type="text" maxlength="${SUPPORT_SUBJECT_MAX}" placeholder="${escapeHtml(supportT("subjectPh"))}" data-support-subject>
                <label class="support-label" for="support-text">${escapeHtml(supportT("message"))}</label>
                <textarea class="support-input" id="support-text" rows="4" maxlength="${SUPPORT_TEXT_MAX}" placeholder="${escapeHtml(supportT("messagePh"))}" data-support-text></textarea>
                <p class="support-count" data-support-count>0/${SUPPORT_TEXT_MAX}</p>
                <div class="inline-actions">
                    <button class="btn ghost" type="button" data-support-action="cancel">${escapeHtml(supportT("cancel"))}</button>
                    <button class="btn primary" type="button" data-support-action="create" ${supportUi.busy ? "disabled" : ""}>${escapeHtml(supportT("send"))}</button>
                </div>`;
        } else if (t) {
            const isOpen = t.status === "open";
            const messages = Array.isArray(t.messages) ? t.messages : [];
            const last = messages[messages.length - 1];
            const hint = isOpen ? (last && last.from === "admin" ? supportT("answered") : supportT("waiting")) : supportT("closedHint");
            html = `
                <div class="support-head">
                    <strong>${escapeHtml(supportT("ticket", { id: Number(t.id) }))}${t.subject ? ` · ${escapeHtml(String(t.subject))}` : ""}</strong>
                    <span class="support-pill ${isOpen ? "is-open" : "is-closed"}">${escapeHtml(isOpen ? supportT("statusOpen") : supportT("statusClosed"))}</span>
                    <button class="refresh-chip" type="button" data-support-action="refresh" aria-label="${escapeHtml(supportT("refresh"))}">↻</button>
                </div>
                <div class="support-thread" data-support-thread>${supportMessagesHtml(t)}</div>
                <p class="support-hint">${escapeHtml(hint)}</p>
                ${isOpen ? `
                <textarea class="support-input" rows="3" maxlength="${SUPPORT_TEXT_MAX}" placeholder="${escapeHtml(supportT("replyPh"))}" aria-label="${escapeHtml(supportT("replyPh"))}" data-support-text></textarea>
                <p class="support-count" data-support-count>0/${SUPPORT_TEXT_MAX}</p>
                <div class="inline-actions">
                    <button class="btn ghost" type="button" data-support-action="close" ${supportUi.busy ? "disabled" : ""}>${escapeHtml(supportT("close"))}</button>
                    <button class="btn primary" type="button" data-support-action="reply" ${supportUi.busy ? "disabled" : ""}>${escapeHtml(supportT("send"))}</button>
                </div>` : `
                <div class="inline-actions"><button class="btn primary" type="button" data-support-action="new">${escapeHtml(supportT("newTicket"))}</button></div>`}`;
        } else {
            // fil demandé sans ticket (clos puis supprimé, ou pas encore chargé) : formulaire d'un nouveau ticket
            supportUi.view = "form";
            renderSupportCard(force);
            return;
        }
        if (supportUi.error && supportUi.view === "button") html += `<p class="support-hint is-error">${escapeHtml(supportUi.error)}</p>`;
        body.innerHTML = html;
        const thread = body.querySelector("[data-support-thread]");
        if (thread) thread.scrollTop = thread.scrollHeight;
        if (keep) {
            const text = body.querySelector("[data-support-text]");
            const subject = body.querySelector("[data-support-subject]");
            if (text) {
                text.value = keep.text;
                if (keep.focus) text.focus();
            }
            if (subject) subject.value = keep.subject;
        }
        supportUpdateCount();
    }

    function supportUpdateCount() {
        const body = document.getElementById("support-body");
        const text = body && body.querySelector("[data-support-text]");
        const count = body && body.querySelector("[data-support-count]");
        if (text && count) count.textContent = `${text.value.length}/${SUPPORT_TEXT_MAX}`;
    }

    function supportReadText() {
        const body = document.getElementById("support-body");
        const text = body && body.querySelector("[data-support-text]");
        const value = text ? text.value.trim() : "";
        if (!value) {
            showToast(supportT("empty"), "error");
            if (text) text.focus();
            return null;
        }
        if (value.length > SUPPORT_TEXT_MAX) {
            showToast(supportT("tooLong"), "error");
            return null;
        }
        return value;
    }

    async function supportSend(path, body, successKey) {
        if (supportUi.busy) return;
        supportUi.busy = true;
        renderSupportCard();
        const res = await supportRequest(path, body);
        supportUi.busy = false;
        if (!res.ok) {
            if (res.data && res.data.no_ticket) {
                supportUi.ticket = null;
                supportUi.view = "form";
            }
            supportFailure(res);
            renderSupportCard();
            return false;
        }
        supportUi.ticket = res.data.ticket || supportUi.ticket;
        supportUi.view = "thread";
        renderSupportCard(true);
        showToast(supportT(successKey));
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        return true;
    }

    async function onSupportAction(event) {
        const btn = event.target.closest("[data-support-action]");
        if (!btn) return;
        const action = btn.dataset.supportAction;
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        if (action === "open") {
            if (!supportUi.loaded) await supportLoad(false);
            if (!supportUi.loaded) return;
            supportUi.view = supportUi.ticket && supportUi.ticket.status === "open" ? "thread" : "form";
            renderSupportCard(true);
            const field = document.querySelector("#support-body [data-support-text]");
            if (field && supportUi.view === "form") field.focus();
        } else if (action === "cancel") {
            supportUi.view = "button";
            renderSupportCard(true);
        } else if (action === "new") {
            supportUi.view = "form";
            renderSupportCard(true);
        } else if (action === "refresh") {
            supportLoad(false);
        } else if (action === "create") {
            const text = supportReadText();
            if (text === null) return;
            const subjectEl = document.querySelector("#support-body [data-support-subject]");
            const subject = subjectEl ? subjectEl.value.trim().slice(0, SUPPORT_SUBJECT_MAX) : "";
            await supportSend("/support/ticket/open", { subject, message: text }, "opened");
        } else if (action === "reply") {
            const text = supportReadText();
            if (text === null) return;
            await supportSend("/support/ticket/message", { message: text }, "sent");
        } else if (action === "close") {
            showConfirmModal({
                title: supportT("close"),
                emoji: "🎫",
                message: escapeHtml(supportT("confirmClose")),
                confirmText: supportT("close"),
                cancelText: supportT("cancel"),
                isDanger: false,
                onConfirm: () => supportSend("/support/ticket/close", {}, "closed")
            });
        }
    }

    // Onglet Contact affiché : ticket en cours chargé tout de suite (la carte repliée n'est pas visible pour l'IntersectionObserver)
    function supportPreload() {
        if (supportUi.seen || !supportEnabled() || accessLocked()) return;
        supportUi.seen = true;
        supportLoad(true);
    }

    // « Signaler un problème » : ticket SAV (formulaire, ou fil du ticket en cours) si le support est ouvert, sinon Telegram
    async function contactReportProblem() {
        if (contactUi.reportBusy) return;
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        if (!supportEnabled()) {
            openTelegramContact();
            return;
        }
        const row = els.contactReportBtn;
        contactUi.reportBusy = true;
        if (row) row.classList.add("is-loading");
        try {
            supportUi.seen = true;
            // chargement déjà lancé (onglet ouvert) : on attend sa réponse plutôt que d'en lancer un second
            for (let i = 0; supportUi.loading && i < 100; i += 1) await new Promise((resolve) => setTimeout(resolve, 150));
            if (!supportUi.loaded) await supportLoad(false);
            if (!supportUi.loaded || !supportEnabled()) return;
            if (supportUi.view === "button") { // une saisie déjà ouverte n'est pas effacée
                supportUi.view = supportUi.ticket && supportUi.ticket.status === "open" ? "thread" : "form";
                renderSupportCard(true);
            }
            const card = document.getElementById("support-card");
            if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
            const field = document.querySelector("#support-body [data-support-text]");
            if (field && supportUi.view === "form") field.focus({ preventScroll: true });
        } finally {
            contactUi.reportBusy = false;
            if (row) row.classList.remove("is-loading");
        }
    }

    // Config relue (retour sur l'app, toutes les 45 s…) : la carte suit tickets_enabled ; fil du ticket ouvert rafraîchi
    function syncSupportCard() {
        if (state.config !== supportUi.cfg) {
            supportUi.cfg = state.config;
            renderSupportCard();
        }
    }

    function scheduleSupportPoll() {
        clearTimeout(supportUi.timer);
        supportUi.timer = setTimeout(() => {
            const visible = document.visibilityState === "visible" && document.body.dataset.page === "info";
            if (visible && supportEnabled() && supportUi.view === "thread" && supportUi.ticket && supportUi.ticket.status === "open" && !supportUi.busy) {
                supportLoad(true);
            }
            scheduleSupportPoll();
        }, SUPPORT_POLL_MS);
    }

    function initMessagesShop() {
        const card = document.getElementById("support-card");
        if (!card) return;
        card.addEventListener("click", onSupportAction);
        card.addEventListener("input", supportUpdateCount);
        supportUi.cfg = state.config;
        renderSupportCard();
        setInterval(syncSupportCard, 1500);
        scheduleSupportPoll();
        // Première fois que la carte est visible : le ticket en cours (s'il y en a un) est affiché tout de suite
        if (typeof IntersectionObserver !== "undefined") {
            const observer = new IntersectionObserver((entries) => {
                if (!entries.some((e) => e.isIntersecting) || supportUi.seen || !supportEnabled()) return;
                supportUi.seen = true;
                supportLoad(true);
            });
            observer.observe(card);
        }
        // Bouton « 💬 Voir le ticket » d'une réponse du support dans Telegram (?support=1) : onglet Contact, ticket ouvert
        // (seen posé avant switchPage : supportPreload ne lance pas un chargement silencieux qui bloquerait celui-ci)
        try {
            if (new URLSearchParams(window.location.search).get("support") === "1" && supportEnabled() && !accessLocked()) {
                supportUi.seen = true;
                switchPage("info");
                supportLoad(false).then(() => {
                    if (!supportUi.loaded) return;
                    supportUi.view = supportUi.ticket ? "thread" : "form";
                    renderSupportCard(true);
                    card.scrollIntoView({ behavior: "smooth", block: "start" });
                });
            }
        } catch (_) { }
    }

    // ===== CATALOGUE (boutique) : multi-ville, promotion globale, likes, options de commande =====
    // willy.py décide : /config donne les villes (config.cities), la ville du client, le catalogue filtré et les likes
    // (config.catalogue) ; /save-order recalcule chaque commande (prix en base, promo, frais) et peut la refuser.
    const CATALOGUE_I18N = {
        fr: {
            cityTitle: "Choisis ta ville",
            cityMessage: "Le catalogue et les frais de livraison dépendent de ta ville. Tu pourras la changer depuis ton profil.",
            cityCurrent: "Actuelle",
            cityClose: "Fermer",
            citySaving: "Enregistrement…",
            citySaved: "Ville enregistrée : {city}",
            cityError: "Ville non enregistrée, réessaie.",
            cityMine: "Ma ville",
            cityChange: "Changer",
            cityNone: "Aucune ville choisie",
            cityLine: "Ville : {city}",
            headerProduct: "produit",
            headerProducts: "produits",
            headerCategory: "catégorie",
            headerCategories: "catégories",
            headerOnline: "En ligne",
            like: "J'aime",
            unlike: "Je n'aime plus",
            liked: "Aimé",
            likeTelegram: "Ouvre la boutique depuis Telegram pour aimer un produit.",
            likeError: "Like non enregistré, réessaie.",
            likesCount: "{count} j'aime",
            promoDefault: "Promo",
            promoLine: "{label} -{pct}% : -{amount}",
            postal: "Envoi postal",
            postalOption: "Type d'envoi",
            postalAddress: "Adresse postale",
            postalPlaceholder: "Nom, numéro et rue, code postal, ville",
            postalFree: "offert",
            postalFeeLine: "Envoi : {fee}",
            alertPostalOption: "Choisis un type d'envoi.",
            alertPostalAddress: "Adresse postale trop courte : nom, numéro et rue, code postal et ville.",
            slotLabel: "Date et heure souhaitées",
            slotToday: "Aujourd'hui",
            slotTomorrow: "Demain",
            slotLine: "Créneau : {slot}",
            payLabel: "Paiement",
            payCash: "Espèces",
            paymentLine: "Paiement : {method}",
            walletTitle: "Adresse de paiement {coin}",
            walletCopy: "Copier",
            walletCopied: "Adresse copiée 📋",
            walletCopyFailed: "Copie impossible : sélectionne l'adresse à la main.",
            walletHint: "Envoie le montant exact une fois la commande validée : un admin confirme la réception. L'adresse t'est aussi envoyée par le bot.",
            paymentInfoCrypto: "Espèces ou crypto ({coins}).",
            totalUpdated: "Total recalculé par la boutique : {total}"
        },
        en: {
            cityTitle: "Choose your city",
            cityMessage: "The menu and delivery fees depend on your city. You can change it later from your profile.",
            cityCurrent: "Current",
            cityClose: "Close",
            citySaving: "Saving…",
            citySaved: "City saved: {city}",
            cityError: "City not saved, try again.",
            cityMine: "My city",
            cityChange: "Change",
            cityNone: "No city selected",
            cityLine: "City: {city}",
            headerProduct: "product",
            headerProducts: "products",
            headerCategory: "category",
            headerCategories: "categories",
            headerOnline: "Online",
            like: "Like",
            unlike: "Unlike",
            liked: "Liked",
            likeTelegram: "Open the shop from Telegram to like a product.",
            likeError: "Like not saved, try again.",
            likesCount: "{count} likes",
            promoDefault: "Promo",
            promoLine: "{label} -{pct}%: -{amount}",
            postal: "Postal",
            postalOption: "Shipping type",
            postalAddress: "Postal address",
            postalPlaceholder: "Name, street, postcode, city",
            postalFree: "free",
            postalFeeLine: "Shipping: {fee}",
            alertPostalOption: "Choose a shipping type.",
            alertPostalAddress: "Postal address too short: name, street, postcode and city.",
            slotLabel: "Preferred date and time",
            slotToday: "Today",
            slotTomorrow: "Tomorrow",
            slotLine: "Slot: {slot}",
            payLabel: "Payment",
            payCash: "Cash",
            paymentLine: "Payment: {method}",
            walletTitle: "{coin} payment address",
            walletCopy: "Copy",
            walletCopied: "Address copied 📋",
            walletCopyFailed: "Copy failed: select the address manually.",
            walletHint: "Send the exact amount once the order is placed: an admin confirms receipt. The bot also sends you the address.",
            paymentInfoCrypto: "Cash or crypto ({coins}).",
            totalUpdated: "Total recalculated by the shop: {total}"
        },
        de: {
            cityTitle: "Wähle deine Stadt",
            cityMessage: "Angebot und Liefergebühren hängen von deiner Stadt ab. Du kannst sie später im Profil ändern.",
            cityCurrent: "Aktuell",
            cityClose: "Schließen",
            citySaving: "Wird gespeichert…",
            citySaved: "Stadt gespeichert: {city}",
            cityError: "Stadt nicht gespeichert, versuche es erneut.",
            cityMine: "Meine Stadt",
            cityChange: "Ändern",
            cityNone: "Keine Stadt gewählt",
            cityLine: "Stadt: {city}",
            headerProduct: "Produkt",
            headerProducts: "Produkte",
            headerCategory: "Kategorie",
            headerCategories: "Kategorien",
            headerOnline: "Online",
            like: "Gefällt mir",
            unlike: "Gefällt mir nicht mehr",
            liked: "Gefällt dir",
            likeTelegram: "Öffne den Shop über Telegram, um ein Produkt zu liken.",
            likeError: "Like nicht gespeichert, versuche es erneut.",
            likesCount: "{count} Likes",
            promoDefault: "Promo",
            promoLine: "{label} -{pct}%: -{amount}",
            postal: "Postversand",
            postalOption: "Versandart",
            postalAddress: "Postanschrift",
            postalPlaceholder: "Name, Straße, PLZ, Stadt",
            postalFree: "gratis",
            postalFeeLine: "Versand: {fee}",
            alertPostalOption: "Wähle eine Versandart.",
            alertPostalAddress: "Postanschrift zu kurz: Name, Straße, PLZ und Stadt.",
            slotLabel: "Gewünschtes Datum und Uhrzeit",
            slotToday: "Heute",
            slotTomorrow: "Morgen",
            slotLine: "Termin: {slot}",
            payLabel: "Zahlung",
            payCash: "Bar",
            paymentLine: "Zahlung: {method}",
            walletTitle: "{coin}-Zahlungsadresse",
            walletCopy: "Kopieren",
            walletCopied: "Adresse kopiert 📋",
            walletCopyFailed: "Kopieren fehlgeschlagen: markiere die Adresse von Hand.",
            walletHint: "Sende den genauen Betrag nach der Bestellung: ein Admin bestätigt den Eingang. Der Bot schickt dir die Adresse auch.",
            paymentInfoCrypto: "Bar oder Krypto ({coins}).",
            totalUpdated: "Gesamtbetrag vom Shop neu berechnet: {total}"
        }
    };
    // city : ville du client lue dans /config (gardée quand la gestion remplace la config) ; payment : « cash » ou
    // « crypto:<index>:<monnaie> » ; picker : écran de choix affiché (closable : ouvert depuis le profil)
    const catalogue = {
        city: "", cities: [], hiddenCategories: [], likes: {}, myLikes: new Set(), likeBusy: new Set(),
        payment: "cash", pickerOpen: false, pickerClosable: false, cityBusy: false
    };

    function ct(key, params) {
        const dict = CATALOGUE_I18N[state.language] || CATALOGUE_I18N.fr;
        const template = dict[key] || CATALOGUE_I18N.fr[key] || key;
        if (!params) return template;
        return Object.keys(params).reduce((acc, k) => acc.split(`{${k}}`).join(String(params[k])), template);
    }

    // Arrondi au centime identique à celui de willy.py (cat_round2)
    function catRound2(x) {
        return Math.floor(x * 100 + 0.5) / 100;
    }

    function catalogueAdminCfg() {
        return (state.config && state.config.admin) || {};
    }

    // Partie propre au client de /config : absente des configs renvoyées à la gestion, l'état précédent est alors gardé
    function readCatalogueConfig(cfg) {
        const data = cfg && cfg.catalogue;
        if (!data || typeof data !== "object") return;
        catalogue.city = typeof data.city === "string" ? data.city : "";
        catalogue.cities = Array.isArray(cfg.cities)
            ? cfg.cities.filter((c) => c && typeof c.key === "string" && typeof c.name === "string")
            : [];
        catalogue.hiddenCategories = Array.isArray(data.hidden_categories) ? data.hidden_categories.map(String) : [];
        catalogue.likes = data.likes && typeof data.likes === "object" ? data.likes : {};
        catalogue.myLikes = new Set(Array.isArray(data.my_likes) ? data.my_likes.map(Number) : []);
    }

    // ---- Multi-ville ----
    function multicityActive() {
        return isOn(catalogueAdminCfg().multicity_enabled) && catalogue.cities.length > 0;
    }

    function currentCity() {
        return catalogue.cities.find((c) => c.key === catalogue.city) || null;
    }

    // Produit proposé dans la ville du client (aucune ville = partout) ; sans multi-ville ou sans ville : tous
    function catalogueProductVisible(product) {
        if (!multicityActive() || !catalogue.city) return true;
        const cities = product && Array.isArray(product.cities) ? product.cities : [];
        return !cities.length || cities.includes(catalogue.city);
    }

    // Catégorie masquée quand tous ses produits sont réservés à d'autres villes (une catégorie vide reste affichée)
    function catalogueCategoryVisible(catId) {
        if (!multicityActive() || !catalogue.city) return true;
        if (catalogue.hiddenCategories.includes(catId)) return false;
        const products = state.products.filter((p) => p.category === catId);
        return !products.length || products.some(catalogueProductVisible);
    }

    // Frais de livraison de la ville du client s'ils sont réglés, sinon les frais par défaut
    function catalogueCityFee(defaultFee) {
        const city = multicityActive() ? currentCity() : null;
        if (city && city.delivery_fee !== null && city.delivery_fee !== undefined) return Math.max(0, toPrice(city.delivery_fee));
        return defaultFee;
    }

    function cityPickerNeeded() {
        return multicityActive() && !catalogue.city && Boolean(getAdminInitData())
            && !(state.access && state.access.allowed === false);
    }

    function renderCityPicker() {
        const card = document.getElementById("city-card");
        if (!card) return;
        const shopName = plainText(String((state.config && state.config.restaurant && state.config.restaurant.name) || "")) || "GreenHouse 68";
        const logo = shopLogoSrc(catalogueAdminCfg().logo_url);
        card.innerHTML = `
            <div class="access-emblem" aria-hidden="true">
                <span class="access-emblem-icon">📍</span>
                <img class="access-logo" src="${escapeHtml(logo)}" alt="">
            </div>
            <p class="access-kicker">${escapeHtml(shopName)}</p>
            <h2 class="access-title" id="city-title">${escapeHtml(ct("cityTitle"))}</h2>
            <p class="access-message">${escapeHtml(ct("cityMessage"))}</p>
            <div class="city-options">
                ${catalogue.cities.map((c) => `
                    <button class="city-option${c.key === catalogue.city ? " is-current" : ""}" data-city-key="${escapeHtml(c.key)}" type="button">
                        <span class="city-option-name"><span aria-hidden="true">📍</span> ${escapeHtml(c.name)}</span>
                        ${c.key === catalogue.city ? `<span class="city-option-tag">${escapeHtml(ct("cityCurrent"))}</span>` : ""}
                    </button>`).join("")}
            </div>
            ${catalogue.pickerClosable ? `<div class="access-actions"><button class="btn ghost access-btn" data-city-close type="button">${escapeHtml(ct("cityClose"))}</button></div>` : ""}
            <p class="access-status" aria-live="polite"></p>`;
        card.setAttribute("aria-labelledby", "city-title");
        const img = card.querySelector(".access-logo");
        if (img) img.onerror = () => {
            img.onerror = null;
            img.src = "logo.png";
        };
    }

    // closable : ouvert depuis le profil (bouton Fermer) ; sinon choix obligatoire (premier lancement)
    function openCityPicker(closable) {
        const screen = document.getElementById("city-screen");
        if (!screen || !catalogue.cities.length) return;
        catalogue.pickerOpen = true;
        catalogue.pickerClosable = Boolean(closable);
        renderCityPicker();
        screen.classList.remove("is-leaving");
        screen.hidden = false;
        document.body.classList.add("city-locked");
        if (els.detailOverlay && els.detailOverlay.style.display === "block") closeProductDetail();
    }

    function closeCityPicker() {
        const screen = document.getElementById("city-screen");
        if (!catalogue.pickerOpen || !screen) return;
        catalogue.pickerOpen = false;
        document.body.classList.remove("city-locked");
        screen.classList.add("is-leaving");
        setTimeout(() => {
            if (catalogue.pickerOpen) return;
            screen.hidden = true;
            screen.classList.remove("is-leaving");
        }, 380);
    }

    // Ville enregistrée par le serveur (POST /catalogue/city, initData signée), puis catalogue de la ville rechargé
    async function chooseCity(key) {
        const city = catalogue.cities.find((c) => c.key === key);
        if (!city || catalogue.cityBusy) return;
        const card = document.getElementById("city-card");
        const status = card ? card.querySelector(".access-status") : null;
        const buttons = card ? card.querySelectorAll("button") : [];
        catalogue.cityBusy = true;
        buttons.forEach((b) => { b.disabled = true; });
        if (status) status.textContent = ct("citySaving");
        try {
            const resp = await fetchWriteApi("/catalogue/city", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), platform: telegramPlatform(), city_key: key })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success) {
                catalogue.city = key;
                closeCityPicker();
                showToast(ct("citySaved", { city: city.name }));
                if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
                await reloadShop();
                return;
            }
            if (resp.status === 403 && applyGateRefusal(data)) {
                closeCityPicker();
                return;
            }
            const error = (data && data.error) || ct("cityError");
            showToast(error, "error");
            if (status && status.isConnected) status.textContent = error;
            // Ville retirée entre-temps : la liste à jour arrive avec la config
            if (resp.status === 404) reloadShop();
        } catch (_) {
            showToast(ct("cityError"), "error");
            if (status && status.isConnected) status.textContent = ct("cityError");
        } finally {
            catalogue.cityBusy = false;
            buttons.forEach((b) => { b.disabled = false; });
        }
    }

    function renderProfileCity() {
        const card = document.getElementById("profile-city-card");
        if (!card) return;
        const show = multicityActive() && Boolean(getAdminInitData());
        card.hidden = !show;
        if (!show) return;
        const city = currentCity();
        const title = document.getElementById("profile-city-title");
        const change = document.getElementById("profile-city-change");
        const name = document.getElementById("profile-city-name");
        if (title) title.textContent = ct("cityMine");
        if (change) change.textContent = ct("cityChange");
        if (name) name.textContent = city ? `📍 ${city.name}` : ct("cityNone");
    }

    // ---- En-tête de la boutique : pastille « en ligne », compteur du catalogue, ville du client ----
    // Boutique ouverte = ni fermeture manuelle ni fermeture programmée (closed_state de willy.py). Config de la gestion :
    // closed_now (admin_status_fields) ; sinon closed_mode_enabled, et pour l'horaire la dernière décision du serveur
    // (gate « closed » d'un client bloqué, access.bypassed d'un admin)
    function shopOnlineNow() {
        const adm = catalogueAdminCfg();
        if (typeof adm.closed_now === "boolean") return !adm.closed_now;
        if (isOn(adm.closed_mode_enabled)) return false;
        if (!isOn(adm.closed_schedule_enabled)) return true;
        const access = state.access || readAccess(null);
        return !((access.gate && access.gate.code === "closed") || access.bypassed.includes("closed"));
    }

    function renderShopHeader() {
        // Pastille « en ligne » : celle du logo et toute autre .shop-online-dot de la page (ex. carte Contact)
        const online = shopOnlineNow();
        document.querySelectorAll(".shop-online-dot").forEach((dot) => {
            dot.hidden = !online;
            dot.setAttribute("aria-label", ct("headerOnline"));
            dot.title = ct("headerOnline");
        });
        // Compteur : produits et catégories affichés (même filtre ville que la grille et les onglets) ; rien si vide
        const products = state.products.filter(catalogueProductVisible).length;
        const categories = state.categories.filter(catalogueCategoryVisible).length;
        const pill = document.getElementById("shop-stats-pill");
        const text = document.getElementById("shop-stats-text");
        if (pill) pill.hidden = products === 0;
        if (text && products) {
            text.innerHTML = `<strong>${products}</strong> ${escapeHtml(ct(products === 1 ? "headerProduct" : "headerProducts"))}`
                + (categories ? `<span class="shop-stats-sep" aria-hidden="true">·</span><strong>${categories}</strong> ${escapeHtml(ct(categories === 1 ? "headerCategory" : "headerCategories"))}` : "");
        }
        // Ville du client (option Villes active) et « changer » qui rouvre l'écran de choix ; mêmes conditions que le profil
        const row = document.getElementById("shop-city-row");
        const showCity = multicityActive() && Boolean(getAdminInitData());
        if (row) {
            row.hidden = !showCity;
            if (showCity) {
                const city = currentCity();
                const name = document.getElementById("shop-city-name");
                const change = document.getElementById("shop-city-change");
                if (name) name.textContent = city ? city.name : ct("cityNone");
                if (change) {
                    change.textContent = ct("cityChange");
                    change.setAttribute("aria-label", `${ct("cityChange")} — ${ct("cityMine")}`);
                }
            }
        }
        const meta = document.getElementById("shop-meta");
        if (meta) meta.hidden = (!pill || pill.hidden) && (!row || row.hidden);
    }

    // Appelé à chaque application de la config (applyShopTexts) : profil, écran de choix obligatoire si besoin
    function applyCatalogueShop() {
        renderProfileCity();
        renderShopHeader(); // en-tête : pastille en ligne, compteur produits/catégories, ville + « changer »
        if (cityPickerNeeded()) {
            if (!catalogue.pickerOpen) openCityPicker(false);
            else renderCityPicker();
        } else if (catalogue.pickerOpen) {
            if (catalogue.pickerClosable && multicityActive() && !(state.access && state.access.allowed === false)) renderCityPicker();
            else closeCityPicker();
        }
    }

    // ---- Promotion globale (affichage ; la réduction est appliquée par le serveur sur le total) ----
    function promoPercent() {
        const adm = catalogueAdminCfg();
        if (!isOn(adm.global_promo_enabled)) return 0;
        const raw = String(adm.global_promo_percent == null ? "" : adm.global_promo_percent).trim();
        const pct = /^\d+$/.test(raw) ? Number(raw) : 0;
        return pct >= 1 && pct <= 90 ? pct : 0;
    }

    function promoLabel() {
        return plainText(String(catalogueAdminCfg().global_promo_label || "")).slice(0, 30) || ct("promoDefault");
    }

    function promoPrice(price) {
        const pct = promoPercent();
        return pct ? catRound2(toPrice(price) * (100 - pct) / 100) : toPrice(price);
    }

    function cataloguePriceChip(start) {
        const pct = promoPercent();
        // montant et devise insécables : seul l'espace après « Dès » peut passer à la ligne
        const nb = (v) => formatPrice(v).replace(/ (?=\S+$)/, "\u00a0");
        if (!pct || start <= 0) return `<span class="price-chip">${t("fromPrice", { price: nb(start) })}</span>`;
        return `<span class="price-chip price-chip-promo"><s class="price-old">${nb(start)}</s> ${t("fromPrice", { price: nb(promoPrice(start)) })}</span>`;
    }

    // Prix d'un palier dans la fiche produit : barré + prix remisé pendant la promotion
    function cataloguePriceHtml(price) {
        if (!promoPercent()) return formatPrice(price);
        return `<s class="price-old">${formatPrice(price)}</s> ${formatPrice(promoPrice(price))}`;
    }

    function catalogueDisplayPrice(price) {
        return formatPrice(promoPrice(price));
    }

    // ---- Likes ----
    function likesEnabled() {
        return isOn(catalogueAdminCfg().likes_enabled);
    }

    function likeCount(pid) {
        return Math.max(0, Number(catalogue.likes[String(pid)]) || 0);
    }

    // Cœur SVG : contour, plein une fois aimé ; partagé par le bouton rond et la pastille « ♥ N » des cartes
    const LIKE_HEART_SVG = `<svg class="like-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.5C12 20.5 3 15 3 9.2 3 6.3 5.2 4.2 7.8 4.2c1.8 0 3.3 1 4.2 2.5.9-1.5 2.4-2.5 4.2-2.5 2.6 0 4.8 2.1 4.8 5 0 5.8-9 11.3-9 11.3z"/></svg>`;

    // Bouton rond (haut à droite de l'image) : aimer / ne plus aimer
    function likeButtonHtml(pid) {
        const liked = catalogue.myLikes.has(Number(pid));
        return `<button class="card-like-btn${liked ? " is-liked" : ""}" data-like-pid="${escapeHtml(String(pid))}" type="button" aria-pressed="${liked}" aria-label="${escapeHtml(ct(liked ? "unlike" : "like"))}">${LIKE_HEART_SVG}</button>`;
    }

    // Pastille « ♥ N » (likes de tous les clients), masquée tant que personne n'a aimé le produit
    function likeCountHtml(pid) {
        const count = likeCount(pid);
        return `<span class="card-like-count" data-like-count-pid="${escapeHtml(String(pid))}" role="img" aria-label="${escapeHtml(ct("likesCount", { count }))}"${count > 0 ? "" : " hidden"}>${LIKE_HEART_SVG}<span class="like-count" aria-hidden="true">${count}</span></span>`;
    }

    // Carte produit : pastilles en bas de l'image (promotion « -X% », likes « ♥ N ») et cœur rond en haut à droite
    function catalogueCardExtras(product) {
        const pct = promoPercent();
        const likes = likesEnabled() && Boolean(product) && product.id != null;
        const pills = (pct ? `<span class="promo-pill">-${pct}%</span>` : "") + (likes ? likeCountHtml(product.id) : "");
        return (pills ? `<div class="card-media-pills">${pills}</div>` : "") + (likes ? likeButtonHtml(product.id) : "");
    }

    function renderDetailLike(product) {
        const btn = document.getElementById("detail-like-btn");
        if (!btn) return;
        const show = likesEnabled() && Boolean(product) && product.id != null;
        btn.hidden = !show;
        if (!show) return;
        const pid = Number(product.id);
        const liked = catalogue.myLikes.has(pid);
        btn.dataset.likePid = String(pid);
        btn.classList.toggle("is-liked", liked);
        btn.setAttribute("aria-pressed", String(liked));
        btn.innerHTML = `<span class="like-heart" aria-hidden="true">${liked ? "♥" : "♡"}</span><span class="like-count">${likeCount(pid)}</span><span class="like-word">${escapeHtml(ct(liked ? "liked" : "like"))}</span>`;
    }

    function refreshLikeButtons(pid) {
        const liked = catalogue.myLikes.has(pid);
        document.querySelectorAll(".card-like-btn[data-like-pid]").forEach((btn) => {
            if (Number(btn.dataset.likePid) !== pid) return;
            btn.classList.toggle("is-liked", liked);
            btn.setAttribute("aria-pressed", String(liked));
            btn.setAttribute("aria-label", ct(liked ? "unlike" : "like"));
        });
        // Pastilles « ♥ N » des cartes : compteur à jour, masquées à 0
        document.querySelectorAll(".card-like-count[data-like-count-pid]").forEach((pill) => {
            if (Number(pill.dataset.likeCountPid) !== pid) return;
            const count = likeCount(pid);
            pill.hidden = count <= 0;
            pill.setAttribute("aria-label", ct("likesCount", { count }));
            const num = pill.querySelector(".like-count");
            if (num) num.textContent = String(count);
        });
        if (state.selectedProduct && Number(state.selectedProduct.id) === pid) renderDetailLike(state.selectedProduct);
    }

    // Like / retrait (POST /catalogue/like, initData signée) : affiché tout de suite, corrigé par la réponse du serveur
    async function toggleProductLike(rawPid) {
        const pid = Number(rawPid);
        if (!Number.isInteger(pid) || pid <= 0 || catalogue.likeBusy.has(pid)) return;
        if (!getAdminInitData()) {
            showToast(ct("likeTelegram"), "info");
            return;
        }
        const wasLiked = catalogue.myLikes.has(pid);
        const before = likeCount(pid);
        const apply = (liked, count) => {
            if (liked) catalogue.myLikes.add(pid);
            else catalogue.myLikes.delete(pid);
            catalogue.likes[String(pid)] = Math.max(0, count);
            refreshLikeButtons(pid);
        };
        apply(!wasLiked, before + (wasLiked ? -1 : 1));
        // petit « pop » du cœur des cartes quand le produit vient d'être aimé
        if (!wasLiked) document.querySelectorAll(`.card-like-btn[data-like-pid="${pid}"]`).forEach((b) => replayAnimationClass(b, "is-popping"));
        if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
        catalogue.likeBusy.add(pid);
        try {
            const resp = await fetchWriteApi("/catalogue/like", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), platform: telegramPlatform(), product_id: pid, liked: !wasLiked })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success) {
                apply(data.liked === true, Number(data.count) || 0);
                return;
            }
            apply(wasLiked, before);
            if (resp.status === 403 && applyGateRefusal(data)) return;
            showToast((data && data.error) || ct("likeError"), "error");
        } catch (_) {
            apply(wasLiked, before);
            showToast(ct("likeError"), "error");
        } finally {
            catalogue.likeBusy.delete(pid);
        }
    }

    // ---- Panier : envoi postal, créneau, paiement, montants ----
    // Types d'envoi [{label, fee}] et adresses crypto [{coin, address}] réglés dans la gestion (JSON validé par willy.py)
    function catalogueJsonList(raw) {
        if (Array.isArray(raw)) return raw;
        try {
            const list = JSON.parse(String(raw || "[]"));
            return Array.isArray(list) ? list : [];
        } catch (_) {
            return [];
        }
    }

    function cataloguePostalOptions(raw) {
        return catalogueJsonList(raw)
            .filter((o) => o && typeof o.label === "string" && o.label.trim())
            .map((o) => ({ label: plainText(o.label).slice(0, 40), fee: Math.max(0, toPrice(o.fee)) }));
    }

    function catalogueWallets(raw) {
        return catalogueJsonList(raw)
            .filter((w) => w && typeof w.coin === "string" && typeof w.address === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{15,127}$/.test(w.address))
            .map((w) => ({ coin: plainText(w.coin).slice(0, 24), address: w.address }));
    }

    function catalogueCalendarDays(raw) {
        const value = String(raw == null ? "" : raw).trim();
        return /^\d+$/.test(value) && Number(value) <= 30 ? Number(value) : 7;
    }

    function catalogueSelectedPostalFee(s) {
        const select = document.getElementById("cart-postal-option");
        const option = s.postalOptions[Number(select ? select.value : 0) || 0];
        return option ? catRound2(option.fee) : 0;
    }

    // Prix unitaire actuel d'une ligne du panier, même règle que willy.py (product_tier_prices / order_line_price) :
    // prix retrait en mode « pickup », sinon prix livraison. Le unitPrice gardé à l'ajout n'est qu'un repli (produit
    // absent de la config, palier retiré : le serveur refusera la ligne). Sans ce recalcul, un changement de mode ou
    // de prix laissait un total affiché (et un fidelite_total) différent de celui du serveur
    function cartLineUnitPrice(item) {
        const product = cartLineProduct(item);
        if (!product) return toPrice(item.unitPrice);
        const entries = getQtyEntries(product, state.orderType);
        const entry = item.weight === null || item.weight === undefined
            ? entries.find((e) => !e.tier)
            : entries.find((e) => e.tier && Math.abs(e.qty - Number(item.weight)) < 1e-9);
        return entry && entry.price > 0 ? entry.price : toPrice(item.unitPrice);
    }

    // Montants du panier, calculés comme willy.py (catalogue_order_totals) qui refait le calcul à la commande
    function cartTotals() {
        const subtotal = catRound2(state.cart.reduce((sum, i) => sum + catRound2(cartLineUnitPrice(i) * i.quantity), 0));
        const pct = promoPercent();
        const discount = pct ? catRound2(subtotal * pct / 100) : 0;
        const goods = catRound2(subtotal - discount);
        const fee = state.cart.length ? deliveryFeeFor(goods) : 0;
        return { subtotal, pct, discount, goods, fee, total: catRound2(goods + fee) };
    }

    function renderCataloguePromoLine(totals) {
        const line = document.getElementById("cart-promo-line");
        if (!line) return;
        const show = state.cart.length > 0 && totals.discount > 0;
        line.hidden = !show;
        if (show) line.textContent = ct("promoLine", { label: promoLabel(), pct: totals.pct, amount: formatPrice(totals.discount) });
    }

    function catalogueSummaryExtras(totals) {
        const extras = [];
        if (totals.discount > 0) extras.push(ct("promoLine", { label: promoLabel(), pct: totals.pct, amount: formatPrice(totals.discount) }));
        if (totals.fee > 0) extras.push(state.orderType === "postal" ? ct("postalFeeLine", { fee: formatPrice(totals.fee) }) : t("deliveryFeeLine", { fee: formatPrice(totals.fee) }));
        return extras;
    }

    function catalogueOrderTypeLabel(type) {
        if (type === "pickup") return t("pickup");
        if (type === "postal") return ct("postal");
        return t("delivery");
    }

    function localDateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // Dates du créneau : aujourd'hui + le nombre de jours réglé ; heures passées grisées pour aujourd'hui
    function renderSlotDates(s) {
        const select = document.getElementById("cart-slot-date");
        if (!select) return;
        const today = new Date();
        const key = `${localDateKey(today)}|${s.calendarDays}|${state.language}`;
        if (select.dataset.key !== key) {
            const previous = select.value;
            const fmt = new Intl.DateTimeFormat(getLocaleCode(), { weekday: "short", day: "2-digit", month: "2-digit" });
            const options = [];
            for (let i = 0; i <= s.calendarDays; i++) {
                const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
                const label = i === 0 ? ct("slotToday") : (i === 1 ? ct("slotTomorrow") : fmt.format(d));
                options.push(`<option value="${localDateKey(d)}">${escapeHtml(label)}</option>`);
            }
            select.innerHTML = options.join("");
            select.dataset.key = key;
            if (previous && [...select.options].some((o) => o.value === previous)) select.value = previous;
        }
        if (els.pickupTime) els.pickupTime.min = select.value === localDateKey(today) ? currentTimeHHMM() : "";
    }

    function selectedWallet(s) {
        const m = /^crypto:(\d+):(.+)$/.exec(catalogue.payment);
        if (!m) return null;
        const wallet = s.wallets[Number(m[1])];
        return wallet && wallet.coin === m[2] ? { index: Number(m[1]), wallet } : null;
    }

    function renderPaymentOptions(s) {
        const group = document.getElementById("cart-pay-group");
        if (!group) return;
        group.hidden = !s.crypto;
        if (!s.crypto || !selectedWallet(s)) catalogue.payment = "cash";
        if (!s.crypto) return;
        const label = document.getElementById("cart-pay-label");
        if (label) label.textContent = ct("payLabel");
        const options = [{ value: "cash", label: `💵 ${ct("payCash")}` }]
            .concat(s.wallets.map((w, i) => ({ value: `crypto:${i}:${w.coin}`, label: `🪙 ${w.coin}` })));
        const box = document.getElementById("cart-pay-options");
        if (box) {
            box.innerHTML = options.map((o) => {
                const active = o.value === catalogue.payment;
                return `<button class="pay-option${active ? " active" : ""}" data-pay="${escapeHtml(o.value)}" type="button" role="radio" aria-checked="${active}">${escapeHtml(o.label)}</button>`;
            }).join("");
        }
        const walletBox = document.getElementById("cart-wallet");
        const chosen = selectedWallet(s);
        if (walletBox) {
            walletBox.hidden = !chosen;
            walletBox.innerHTML = chosen ? `
                <p class="cart-wallet-title">${escapeHtml(ct("walletTitle", { coin: chosen.wallet.coin }))}</p>
                <div class="cart-wallet-row">
                    <code class="cart-wallet-address">${escapeHtml(chosen.wallet.address)}</code>
                    <button class="btn ghost cart-wallet-copy" data-copy-wallet type="button">${escapeHtml(ct("walletCopy"))}</button>
                </div>
                <p class="cart-wallet-hint">${escapeHtml(ct("walletHint"))}</p>` : "";
        }
    }

    // Panier selon les réglages Commandes (appelé par applyOrderOptions) : envoi postal, créneau, paiement, panier fermé
    function renderCatalogueCheckout(s) {
        const postalBtn = document.getElementById("service-postal-btn");
        if (postalBtn) {
            postalBtn.hidden = !s.postal;
            postalBtn.textContent = ct("postal");
        }
        const postalGroup = document.getElementById("cart-postal-group");
        if (postalGroup) postalGroup.hidden = state.orderType !== "postal";
        const select = document.getElementById("cart-postal-option");
        if (select) {
            const key = `${JSON.stringify(s.postalOptions)}|${currentCity() ? currentCity().key : ""}|${currencyLabel()}|${state.language}`;
            if (select.dataset.key !== key) {
                const previous = select.value;
                select.innerHTML = s.postalOptions.map((o, i) => `<option value="${i}">${escapeHtml(o.label)} — ${o.fee > 0 ? formatPrice(o.fee) : escapeHtml(ct("postalFree"))}</option>`).join("");
                select.dataset.key = key;
                if (previous !== "" && Number(previous) < s.postalOptions.length) select.value = previous;
            }
        }
        const texts = { "cart-postal-option-label": ct("postalOption"), "cart-postal-address-label": ct("postalAddress") };
        Object.keys(texts).forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = texts[id];
        });
        const postalAddress = document.getElementById("cart-postal-address");
        if (postalAddress) postalAddress.placeholder = ct("postalPlaceholder");
        if (els.pickupLabel) els.pickupLabel.textContent = ct("slotLabel");
        renderSlotDates(s);
        renderPaymentOptions(s);
        const note = document.getElementById("cart-closed-note");
        if (note) {
            note.hidden = s.ordersEnabled;
            note.textContent = t("ordersClosedToast");
        }
        // Moyens de paiement acceptés : ligne « Paiement » de l'onglet Contact (renderContactCard)
    }

    // Champs du mode choisi, vérifiés comme le fera willy.py : { error } ou { fields, lines } (lignes du message Telegram)
    function catalogueCheckoutFields(s) {
        const fields = {};
        const lines = [];
        const city = multicityActive() ? currentCity() : null;
        if (city) lines.push(ct("cityLine", { city: city.name }));
        if (state.orderType === "delivery") {
            const address = plainText(els.deliveryAddress.value || "");
            if (address.length < 10) return { error: t("alertAddress") };
            fields.address = address;
            lines.push(`${t("deliveryAddress")}: ${address}`);
        } else if (state.orderType === "postal") {
            const select = document.getElementById("cart-postal-option");
            const index = select ? Number(select.value) : NaN;
            const option = Number.isInteger(index) ? s.postalOptions[index] : null;
            if (!option) return { error: ct("alertPostalOption") };
            const addressEl = document.getElementById("cart-postal-address");
            const address = plainText(addressEl ? addressEl.value : "");
            if (address.length < 15) return { error: ct("alertPostalAddress") };
            Object.assign(fields, { postal_option: index, postal_label: option.label, postal_address: address });
            lines.push(`${ct("postal")} : ${option.label}`, `${ct("postalAddress")} : ${address}`);
        }
        if (s.calendar && state.orderType !== "postal") {
            const dateEl = document.getElementById("cart-slot-date");
            const date = dateEl ? dateEl.value : "";
            const time = plainText(els.pickupTime.value || "");
            if (!date || !time) return { error: t("alertPickupTime") };
            if (date === localDateKey(new Date()) && time < currentTimeHHMM()) return { error: t("alertPickupPast") };
            Object.assign(fields, { slot_date: date, slot_time: time });
            const dateLabel = dateEl && dateEl.selectedOptions[0] ? dateEl.selectedOptions[0].textContent : date;
            lines.push(ct("slotLine", { slot: `${dateLabel} ${time}` }));
        }
        const chosen = s.crypto ? selectedWallet(s) : null;
        if (chosen) {
            Object.assign(fields, { payment: "crypto", payment_index: chosen.index, payment_coin: chosen.wallet.coin });
            lines.push(ct("paymentLine", { method: chosen.wallet.coin }));
        } else {
            fields.payment = "cash";
            if (s.crypto) lines.push(ct("paymentLine", { method: ct("payCash") }));
        }
        return { fields, lines };
    }

    // Commande enregistrée : total et récapitulatif recalculés par le serveur (prix en base, promo, frais)
    function applyServerOrder(order, saved) {
        const data = saved && saved.data;
        if (!data || typeof data !== "object") return;
        const total = Number(data.total);
        if (Number.isFinite(total) && total > 0) order.total = total;
        if (typeof data.summary === "string" && data.summary.trim()) order.summary = data.summary.trim();
        if (data.price_changed === true) showToast(ct("totalUpdated", { total: formatPrice(order.total) }), "info");
    }

    function initCatalogueShop() {
        // Cœurs et boutons panier des cartes : pris avant le clic de la carte (qui ouvrirait la fiche produit)
        if (els.productGrid) {
            els.productGrid.addEventListener("click", (e) => {
                const cartBtn = e.target.closest("[data-cart-pid]");
                if (cartBtn) {
                    e.stopPropagation();
                    e.preventDefault();
                    addFromProductCard(cartBtn.dataset.cartPid, cartBtn);
                    return;
                }
                const btn = e.target.closest("[data-like-pid]");
                if (!btn) return;
                e.stopPropagation();
                e.preventDefault();
                toggleProductLike(btn.dataset.likePid);
            }, true);
        }
        const detailLike = document.getElementById("detail-like-btn");
        if (detailLike) detailLike.addEventListener("click", () => toggleProductLike(detailLike.dataset.likePid));
        // Écran de choix de la ville et « Changer » du profil
        const cityScreen = document.getElementById("city-screen");
        if (cityScreen) {
            cityScreen.addEventListener("click", (e) => {
                const option = e.target.closest("[data-city-key]");
                if (option) chooseCity(option.dataset.cityKey);
                else if (e.target.closest("[data-city-close]")) closeCityPicker();
            });
        }
        const changeCity = document.getElementById("profile-city-change");
        if (changeCity) changeCity.addEventListener("click", () => openCityPicker(true));
        // « changer » de l'en-tête : même écran de choix que le profil (fermable)
        const headerCity = document.getElementById("shop-city-change");
        if (headerCity) headerCity.addEventListener("click", () => {
            if (accessLocked()) return;
            if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
            openCityPicker(true);
        });
        // Panier : type d'envoi (frais), date du créneau (heures passées), paiement, copie de l'adresse crypto
        const postalSelect = document.getElementById("cart-postal-option");
        if (postalSelect) postalSelect.addEventListener("change", renderCart);
        const slotDate = document.getElementById("cart-slot-date");
        if (slotDate) slotDate.addEventListener("change", applyOrderOptions);
        const payOptions = document.getElementById("cart-pay-options");
        if (payOptions) {
            payOptions.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-pay]");
                if (!btn) return;
                catalogue.payment = btn.dataset.pay;
                if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
                applyOrderOptions();
            });
        }
        const walletBox = document.getElementById("cart-wallet");
        if (walletBox) {
            walletBox.addEventListener("click", async (e) => {
                if (!e.target.closest("[data-copy-wallet]")) return;
                const chosen = selectedWallet(orderSettings());
                if (!chosen) return;
                const ok = await copyTextToClipboard(chosen.wallet.address);
                showToast(ok ? ct("walletCopied") : ct("walletCopyFailed"), ok ? undefined : "error");
            });
        }
    }

    // ===== FIDÉLITÉ — BOUTIQUE (profil : rang, parrainage, codes, roue, concours ; panier : avantages ; avis) =====
    // Tout vient de POST /fidelite/me (initData vérifiée, accès autorisé). Rien n'est décidé ici que willy.py ne
    // revérifie : tour de roue tiré par le serveur, réduction recalculée et points débités à /save-order,
    // parrainage et participation contrôlés côté serveur. Les cartes sont créées par le script (pas de HTML en dur).
    const fid = {
        me: null, loading: null, lastLoad: 0, clockOffset: 0, flagsKey: "",
        selection: { points: 0, code: "" }, spinning: false, rotation: 0, lastWin: null,
        startRefTried: false, reviewPhoto: "", reviewPhotoBusy: false, reviewPreviewUrl: "", dom: false, slotHtml: {}, wheelOpen: false
    };
    const FID_REFRESH_MS = 15000;
    const FID_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
    const FID_TEXTS = {
        fr: {
            loyaltyTitle: "Fidélité", pts: "pts", pointsTotal: "{n} pts cumulés", rankNone: "Pas encore de rang",
            nextRank: "Encore {n} pts pour {rank}", maxRank: "Rang maximum atteint 🎉", myCode: "Mon code parrain",
            copyLink: "Copier le lien", share: "Partager", linkCopied: "Lien copié !", copyFailed: "Copie impossible : recopie le code à la main.",
            referrals: "{n} filleul(s)", referralHint: "Chaque nouveau client qui utilise ton code te rapporte {n} point(s).",
            shareText: "Rejoins la boutique avec mon lien 🎁", enterCode: "Tu as un code parrain ?", codePlaceholder: "Code à 6 caractères",
            validate: "Valider", rewardsTitle: "Tes points en réductions", rewardLine: "{points} pts → −{amount}",
            rewardsHint: "À choisir dans ton panier.", codesTitle: "Mes codes de réduction", codeUntil: "jusqu'au {date}",
            wheelTitle: "Roue de la fortune", wheelAvailable: "Un spin disponible — tente ta chance !", spin: "Tourner la roue", spinning: "La roue tourne…", nextSpin: "Prochain tour dans {wait}",
            wheelReady: "Un tour t'attend !", wheelWon: "Gagné : {label} 🎉", wheelLost: "Pas de chance cette fois…",
            wheelCode: "Ton code {code} t'attend dans ton panier (jusqu'au {date}).", wheelPoints: "Solde : {n} points.",
            wheelManual: "Le bot t'a envoyé les détails pour récupérer ton lot.", contestTitle: "Jeu concours",
            contestEnds: "Fin le {date}", contestClosed: "Participations closes : tirage au sort bientôt", participants: "{n} participant(s)",
            join: "Participer", joined: "Tu participes ✓", reviewsTitle: "Avis", reviewLeave: "Laisser un avis",
            cartTitle: "Avantages fidélité", cartNone: "Aucun", cartPoints: "Utiliser mes points ({n} pts)", cartCodes: "Code gagné",
            cartDiscount: "Réduction : −{amount} (au lieu de {total})", orderApplied: "Réduction fidélité appliquée : −{amount}",
            orderMissing: "Réduction non appliquée : la commande est enregistrée au prix normal.",
            orderLine: "Fidélité : −{amount}", orderUnverified: "Réduction non vérifiée (serveur injoignable) : réessaie dans un instant.",
            photoAdd: "📷 Ajouter une photo", photoChange: "📷 Changer la photo", photoRemove: "Retirer", photoSending: "Envoi de la photo…",
            photoReady: "Photo prête : elle sera publiée avec ton avis après validation.", photoTooBig: "Photo trop lourde (5 Mo max).",
            photoType: "Format accepté : JPEG, PNG ou WebP.", reviewSent: "Merci ! Ton avis sera publié après validation.",
            reviewNotSent: "Avis non envoyé : réessaie dans un instant.", reviewsOff: "Les avis sont désactivés pour le moment.",
            networkError: "Connexion impossible, réessaie.", day: "j", hour: "h", minute: "min"
        },
        en: {
            loyaltyTitle: "Loyalty", pts: "pts", pointsTotal: "{n} pts earned", rankNone: "No rank yet",
            nextRank: "{n} more pts for {rank}", maxRank: "Top rank reached 🎉", myCode: "My referral code",
            copyLink: "Copy link", share: "Share", linkCopied: "Link copied!", copyFailed: "Copy failed: write the code down.",
            referrals: "{n} referral(s)", referralHint: "Every new customer using your code earns you {n} point(s).",
            shareText: "Join the shop with my link 🎁", enterCode: "Got a referral code?", codePlaceholder: "6-character code",
            validate: "Apply", rewardsTitle: "Your points as discounts", rewardLine: "{points} pts → −{amount}",
            rewardsHint: "Pick one in your cart.", codesTitle: "My discount codes", codeUntil: "until {date}",
            wheelTitle: "Wheel of fortune", wheelAvailable: "A spin is available — try your luck!", spin: "Spin the wheel", spinning: "Spinning…", nextSpin: "Next spin in {wait}",
            wheelReady: "A spin is waiting for you!", wheelWon: "You won: {label} 🎉", wheelLost: "No luck this time…",
            wheelCode: "Your code {code} is waiting in your cart (until {date}).", wheelPoints: "Balance: {n} points.",
            wheelManual: "The bot sent you how to get your prize.", contestTitle: "Giveaway",
            contestEnds: "Ends {date}", contestClosed: "Entries closed: draw coming soon", participants: "{n} participant(s)",
            join: "Enter", joined: "You're in ✓", reviewsTitle: "Reviews", reviewLeave: "Leave a review",
            cartTitle: "Loyalty perks", cartNone: "None", cartPoints: "Use my points ({n} pts)", cartCodes: "Won code",
            cartDiscount: "Discount: −{amount} (instead of {total})", orderApplied: "Loyalty discount applied: −{amount}",
            orderMissing: "Discount not applied: the order was saved at the normal price.",
            orderLine: "Loyalty: −{amount}", orderUnverified: "Discount not verified (server unreachable): try again in a moment.",
            photoAdd: "📷 Add a photo", photoChange: "📷 Change photo", photoRemove: "Remove", photoSending: "Uploading photo…",
            photoReady: "Photo ready: it will be published with your review once approved.", photoTooBig: "Photo too large (5 MB max).",
            photoType: "Accepted formats: JPEG, PNG or WebP.", reviewSent: "Thanks! Your review will be published once approved.",
            reviewNotSent: "Review not sent: try again in a moment.", reviewsOff: "Reviews are disabled for now.",
            networkError: "Connection failed, try again.", day: "d", hour: "h", minute: "min"
        },
        de: {
            loyaltyTitle: "Treue", pts: "Pkt", pointsTotal: "{n} Pkt gesammelt", rankNone: "Noch kein Rang",
            nextRank: "Noch {n} Pkt bis {rank}", maxRank: "Höchster Rang erreicht 🎉", myCode: "Mein Empfehlungscode",
            copyLink: "Link kopieren", share: "Teilen", linkCopied: "Link kopiert!", copyFailed: "Kopieren fehlgeschlagen: Code abschreiben.",
            referrals: "{n} Empfehlung(en)", referralHint: "Jeder neue Kunde mit deinem Code bringt dir {n} Punkt(e).",
            shareText: "Komm mit meinem Link in den Shop 🎁", enterCode: "Hast du einen Empfehlungscode?", codePlaceholder: "Code mit 6 Zeichen",
            validate: "Einlösen", rewardsTitle: "Deine Punkte als Rabatt", rewardLine: "{points} Pkt → −{amount}",
            rewardsHint: "Im Warenkorb auswählen.", codesTitle: "Meine Rabattcodes", codeUntil: "bis {date}",
            wheelTitle: "Glücksrad", wheelAvailable: "Eine Drehung verfügbar — versuch dein Glück!", spin: "Rad drehen", spinning: "Das Rad dreht sich…", nextSpin: "Nächste Drehung in {wait}",
            wheelReady: "Eine Drehung wartet auf dich!", wheelWon: "Gewonnen: {label} 🎉", wheelLost: "Diesmal kein Glück…",
            wheelCode: "Dein Code {code} wartet im Warenkorb (bis {date}).", wheelPoints: "Guthaben: {n} Punkte.",
            wheelManual: "Der Bot hat dir die Details zu deinem Gewinn geschickt.", contestTitle: "Gewinnspiel",
            contestEnds: "Ende {date}", contestClosed: "Teilnahme geschlossen: Auslosung bald", participants: "{n} Teilnehmer",
            join: "Teilnehmen", joined: "Du nimmst teil ✓", reviewsTitle: "Bewertungen", reviewLeave: "Bewertung schreiben",
            cartTitle: "Treuevorteile", cartNone: "Keiner", cartPoints: "Meine Punkte nutzen ({n} Pkt)", cartCodes: "Gewonnener Code",
            cartDiscount: "Rabatt: −{amount} (statt {total})", orderApplied: "Treuerabatt angewendet: −{amount}",
            orderMissing: "Rabatt nicht angewendet: Bestellung zum Normalpreis gespeichert.",
            orderLine: "Treue: −{amount}", orderUnverified: "Rabatt nicht geprüft (Server nicht erreichbar): gleich nochmal versuchen.",
            photoAdd: "📷 Foto hinzufügen", photoChange: "📷 Foto ändern", photoRemove: "Entfernen", photoSending: "Foto wird gesendet…",
            photoReady: "Foto bereit: es wird mit deiner Bewertung nach Freigabe veröffentlicht.", photoTooBig: "Foto zu groß (max. 5 MB).",
            photoType: "Erlaubt: JPEG, PNG oder WebP.", reviewSent: "Danke! Deine Bewertung erscheint nach Freigabe.",
            reviewNotSent: "Bewertung nicht gesendet: gleich nochmal versuchen.", reviewsOff: "Bewertungen sind derzeit deaktiviert.",
            networkError: "Verbindung fehlgeschlagen, nochmal versuchen.", day: "T", hour: "Std", minute: "Min"
        }
    };

    function fidT(key, params) {
        const dict = FID_TEXTS[state.language] || FID_TEXTS.fr;
        const template = dict[key] || FID_TEXTS.fr[key] || key;
        if (!params) return template;
        return Object.keys(params).reduce((acc, k) => acc.split(`{${k}}`).join(String(params[k])), template);
    }

    function fidRound(n) {
        return Math.round((Number(n) || 0) * 100) / 100;
    }

    function fidNow() {
        return Date.now() / 1000 + fid.clockOffset;
    }

    function fidWait(seconds) {
        let s = Math.max(0, Math.round(seconds));
        const d = Math.floor(s / 86400);
        s -= d * 86400;
        const h = Math.floor(s / 3600);
        const m = Math.max(d || h ? 0 : 1, Math.floor((s - h * 3600) / 60));
        if (d) return h ? `${d} ${fidT("day")} ${h} ${fidT("hour")}` : `${d} ${fidT("day")}`;
        if (h) return m ? `${h} ${fidT("hour")} ${m} ${fidT("minute")}` : `${h} ${fidT("hour")}`;
        return `${m} ${fidT("minute")}`;
    }

    function fidDay(seconds) {
        return new Date(Number(seconds) * 1000).toLocaleDateString(getLocaleCode(), { day: "2-digit", month: "2-digit", year: "numeric" });
    }

    // Interrupteurs lus dans /config (clé jamais enregistrée = valeur par défaut, comme willy.py)
    function fidFlags() {
        const adm = (state.config && state.config.admin) || {};
        const flag = (k, d) => (Object.prototype.hasOwnProperty.call(adm, k) && adm[k] !== "" ? isOn(adm[k]) : d);
        return {
            rank: flag("rank_enabled", false), wheel: flag("wheel_enabled", false), reviews: flag("reviews_enabled", true),
            tab: flag("reviews_tab_enabled", true), photos: flag("reviews_photos_enabled", false)
        };
    }

    // Appel client signé (initData + plateforme, comme /save-order) : { ok, data } ou { ok:false, error, gated }
    async function fidPost(path, body, timeoutMs) {
        if (!getAdminInitData()) return { ok: false, error: "" };
        try {
            const resp = await fetchWriteApi(path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, body || {}, { init_data: getAdminInitData(), platform: telegramPlatform() }))
            }, timeoutMs || 8000);
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success !== false) return { ok: true, data };
            if (resp.status === 403 && applyGateRefusal(data)) return { ok: false, gated: true, error: "" };
            return { ok: false, status: resp.status, error: (data && data.error) || fidT("networkError") };
        } catch (_) {
            return { ok: false, status: 0, error: fidT("networkError") };
        }
    }

    function initFideliteShop() {
        try {
            fidEnsureDom();
            // Profil, panier ou avis ouverts : données relues (au plus toutes les 15 s)
            document.querySelectorAll('.tab-btn[data-page="profile"], .tab-btn[data-page="cart"], .tab-btn[data-page="reviews"]').forEach((btn) => {
                btn.addEventListener("click", () => fidRefresh(false));
            });
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") fidRefresh(false);
            });
            fideliteApplyConfig();
            fidRefresh(true);
            // Roue (profil) : temps restant et pastille « tour disponible » tenus à jour pendant que le profil est affiché
            setInterval(() => {
                if (document.visibilityState === "visible" && document.body.dataset.page === "profile" && !fid.spinning) fidRenderProfile();
            }, 30000);
        } catch (err) {
            console.warn("Fidélité :", err);
        }
    }

    function fidRefresh(force) {
        if (fid.loading) return fid.loading;
        if (!force && Date.now() - fid.lastLoad < FID_REFRESH_MS) return Promise.resolve();
        if (!getAdminInitData() || (state.access && state.access.allowed === false)) return Promise.resolve();
        fid.loading = (async () => {
            const res = await fidPost("/fidelite/me", {});
            fid.lastLoad = Date.now();
            if (res.ok) fidSetMe(res.data);
        })().finally(() => { fid.loading = null; });
        return fid.loading;
    }

    function fidSetMe(data) {
        fid.me = data;
        if (Number.isFinite(Number(data.now))) fid.clockOffset = Number(data.now) - Date.now() / 1000;
        fidRenderAll();
        fidTryStartReferral();
    }

    function fidRenderAll() {
        fidRenderProfile();
        fidRenderReviewForm();
        renderCart();
    }

    // Lien t.me/<bot>?startapp=ref_<CODE> (paramètre signé dans l'initData) : code proposé une fois, si le compte est nouveau
    function fidTryStartReferral() {
        if (fid.startRefTried || !fid.me || !fid.me.account || !fid.me.account.can_enter_code) return;
        const param = tg && tg.initDataUnsafe && typeof tg.initDataUnsafe.start_param === "string" ? tg.initDataUnsafe.start_param : "";
        if (!/^ref_[A-Za-z0-9]{6}$/.test(param)) return;
        fid.startRefTried = true;
        fidApplyReferral(param, true);
    }

    function fidEnsureDom() {
        if (fid.dom) return;
        const profileWrap = document.querySelector("#page-profile .profile-page-wrap");
        if (profileWrap && !document.getElementById("loyalty-zone")) {
            const zone = document.createElement("div");
            zone.className = "loyalty-zone";
            zone.id = "loyalty-zone";
            zone.innerHTML = ["rank", "codes", "wheel", "contest", "review"].map((k) => `<div id="loyalty-slot-${k}"></div>`).join("");
            // Avant la carte Notifications (sinon avant Mes Commandes) : roue et concours restent au-dessus des alertes
            const anchor = profileWrap.querySelector(":scope > .profile-watch-card") || profileWrap.querySelector(":scope > .profile-orders-card");
            profileWrap.insertBefore(zone, anchor || null);
            zone.addEventListener("click", fidOnZoneClick);
            zone.addEventListener("submit", fidOnZoneSubmit);
        }
        const cartContent = document.getElementById("cart-content");
        if (cartContent && !document.getElementById("loyalty-cart")) {
            const box = document.createElement("div");
            box.className = "card panel loyalty-cart";
            box.id = "loyalty-cart";
            box.hidden = true;
            const row = cartContent.querySelector(".checkout-row");
            cartContent.insertBefore(box, row || null);
            box.addEventListener("click", fidOnCartClick);
        }
        if (els.reviewForm && !document.getElementById("loyalty-review-note")) {
            const note = document.createElement("div");
            note.className = "card panel empty-state loyalty-review-note";
            note.id = "loyalty-review-note";
            note.dataset.emoji = "⭐";
            note.hidden = true;
            els.reviewForm.insertAdjacentElement("afterend", note);
            const photo = document.createElement("div");
            photo.className = "loyalty-photo";
            photo.id = "loyalty-photo-box";
            photo.hidden = true;
            photo.innerHTML = `
                <input type="file" id="loyalty-photo-input" accept="image/jpeg,image/png,image/webp" hidden>
                <div class="loyalty-photo-row">
                    <button type="button" class="btn ghost loyalty-photo-btn" id="loyalty-photo-pick"></button>
                    <button type="button" class="btn ghost loyalty-photo-remove" id="loyalty-photo-remove" hidden></button>
                </div>
                <img class="loyalty-photo-preview" id="loyalty-photo-preview" alt="" hidden>
                <p class="muted loyalty-photo-status" id="loyalty-photo-status"></p>`;
            els.reviewForm.insertBefore(photo, els.reviewSubmitBtn || null);
            const input = photo.querySelector("#loyalty-photo-input");
            photo.querySelector("#loyalty-photo-pick").addEventListener("click", () => input.click());
            photo.querySelector("#loyalty-photo-remove").addEventListener("click", fidClearReviewPhoto);
            input.addEventListener("change", () => {
                const file = input.files && input.files[0];
                input.value = "";
                if (file) fidUploadReviewPhoto(file);
            });
            // Formulaire remis à zéro après l'envoi (bindActions) : la photo part avec l'avis, puis est oubliée
            els.reviewForm.addEventListener("reset", () => setTimeout(fidClearReviewPhoto, 0));
        }
        fid.dom = Boolean(document.getElementById("loyalty-zone") && document.getElementById("loyalty-cart"));
    }

    // Appelé par applyShopTexts (chaque rechargement de /config, changement de langue, réglage modifié dans la gestion)
    function fideliteApplyConfig() {
        try {
            fidEnsureDom();
            const f = fidFlags();
            const tabOff = !f.reviews || !f.tab;
            if (els.bottomNav) els.bottomNav.classList.toggle("reviews-tab-off", tabOff);
            const page = document.getElementById("page-reviews");
            // Onglet masqué mais avis ouverts : la page n'affiche que le formulaire (bouton « Laisser un avis » du profil)
            if (page) page.classList.toggle("loyalty-form-only", tabOff && f.reviews);
            if (!f.reviews && document.body.dataset.page === "reviews") switchPage("home");
            fidSyncNav();
            const key = JSON.stringify(f);
            if (fid.flagsKey && key !== fid.flagsKey) fidRefresh(true);
            fid.flagsKey = key;
            fidRenderProfile();
            fidRenderReviewForm();
        } catch (err) {
            console.warn("Fidélité :", err);
        }
    }

    // Position de l'indicateur de la barre du bas parmi les onglets affichés (onglet Avis masquable)
    function fideliteNavIndex(tab, index) {
        const shown = [...els.tabs].filter((b) => getComputedStyle(b).display !== "none");
        const i = shown.indexOf(tab);
        if (els.bottomNav) els.bottomNav.classList.toggle("loyalty-nav-off", i < 0);
        return i < 0 ? index : i;
    }

    function fidSyncNav() {
        const tabs = [...els.tabs];
        const active = tabs.find((b) => b.classList.contains("active"));
        if (active && els.bottomNav) els.bottomNav.style.setProperty("--nav-index", fideliteNavIndex(active, tabs.indexOf(active)));
    }

    // ── Profil ──
    function fidRenderProfile() {
        if (!document.getElementById("loyalty-zone")) return;
        const me = fid.me;
        const f = fidFlags();
        // Carte redessinée seulement si son contenu change (un code parrain en cours de saisie n'est pas effacé)
        const slot = (k, html) => {
            const el = document.getElementById(`loyalty-slot-${k}`);
            if (!el || fid.slotHtml[k] === html) return;
            fid.slotHtml[k] = html;
            el.innerHTML = html;
        };
        slot("rank", me && me.account ? fidRankHtml(me) : "");
        slot("codes", me && Array.isArray(me.codes) && me.codes.length ? fidCodesHtml(me.codes) : "");
        const wheelOn = Boolean(me && me.wheel && me.wheel.enabled && me.wheel.prizes.length);
        if (!wheelOn) fid.wheelOpen = false; // roue coupée dans la gestion : repliée la prochaine fois
        if (!fid.spinning) slot("wheel", wheelOn ? fidWheelCardHtml(me.wheel) : "");
        slot("contest", me && me.contest ? fidContestHtml(me.contest) : "");
        slot("review", f.reviews && !f.tab ? `
            <article class="card panel loyalty-card">
                <div class="profile-section-head"><h4>⭐ ${escapeHtml(fidT("reviewsTitle"))}</h4></div>
                <button class="btn primary loyalty-wide-btn" data-fid-action="review" type="button">${escapeHtml(fidT("reviewLeave"))}</button>
            </article>` : "");
    }

    function fidRankHtml(me) {
        const a = me.account;
        const tiers = Array.isArray(me.tiers) ? me.tiers : [];
        const rank = me.rank;
        const next = me.next_rank;
        let progress = "";
        if (next) {
            const from = rank ? Number(rank.min_points) : 0;
            const pct = Math.max(4, Math.min(100, Math.round(((a.points_total - from) / Math.max(1, next.min_points - from)) * 100)));
            progress = `<div class="loyalty-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
                <p class="muted">${escapeHtml(fidT("nextRank", { n: next.min_points - a.points_total, rank: `${next.emoji || ""} ${next.name}`.trim() }))}</p>`;
        } else if (tiers.length) {
            progress = `<p class="muted">${escapeHtml(fidT("maxRank"))}</p>`;
        }
        const rewards = (me.rewards || []).map((r) => `<li>${escapeHtml(fidT("rewardLine", { points: r.points, amount: formatPrice(r.amount) }))}</li>`).join("");
        return `
            <article class="card panel loyalty-card loyalty-rank">
                <div class="profile-section-head">
                    <h4>⭐ ${escapeHtml(fidT("loyaltyTitle"))}</h4>
                    <span class="loyalty-chip">${rank ? `${escapeHtml(rank.emoji || "")} ${escapeHtml(rank.name)}` : escapeHtml(fidT("rankNone"))}</span>
                </div>
                <div class="loyalty-points">
                    <span class="loyalty-points-value">${Number(a.points) || 0}</span>
                    <span class="loyalty-points-unit">${escapeHtml(fidT("pts"))}</span>
                    <span class="muted loyalty-points-total">${escapeHtml(fidT("pointsTotal", { n: Number(a.points_total) || 0 }))}</span>
                </div>
                ${progress}
                <div class="loyalty-code-box">
                    <div>
                        <p class="muted">${escapeHtml(fidT("myCode"))}</p>
                        <p class="loyalty-code">${escapeHtml(a.code)}</p>
                        <p class="muted">${escapeHtml(fidT("referrals", { n: Number(a.referrals) || 0 }))}</p>
                    </div>
                    <div class="loyalty-code-actions">
                        <button class="btn ghost" data-fid-action="copy" type="button">${escapeHtml(fidT("copyLink"))}</button>
                        <button class="btn primary" data-fid-action="share" type="button" ${a.link ? "" : "disabled"}>${escapeHtml(fidT("share"))}</button>
                    </div>
                </div>
                <p class="muted">${escapeHtml(fidT("referralHint", { n: Number(me.referral_points) || 1 }))}</p>
                ${a.can_enter_code ? `
                <form class="loyalty-ref-form" data-fid-form="referral" autocomplete="off">
                    <label for="loyalty-ref-input">${escapeHtml(fidT("enterCode"))}</label>
                    <div class="loyalty-ref-row">
                        <input id="loyalty-ref-input" name="code" maxlength="20" placeholder="${escapeHtml(fidT("codePlaceholder"))}" autocapitalize="characters">
                        <button class="btn primary" type="submit">${escapeHtml(fidT("validate"))}</button>
                    </div>
                </form>` : ""}
                ${rewards ? `<div class="loyalty-rewards"><p class="loyalty-subtitle">${escapeHtml(fidT("rewardsTitle"))}</p><ul>${rewards}</ul><p class="muted">${escapeHtml(fidT("rewardsHint"))}</p></div>` : ""}
            </article>`;
    }

    function fidCodeValue(c) {
        return c.kind === "percent" ? `−${Number(c.value)} %` : `−${formatPrice(c.value)}`;
    }

    function fidCodesHtml(codes) {
        return `
            <article class="card panel loyalty-card">
                <div class="profile-section-head"><h4>🎟️ ${escapeHtml(fidT("codesTitle"))}</h4></div>
                <div class="loyalty-code-list">${codes.map((c) => `
                    <div class="loyalty-code-row">
                        <span class="loyalty-code small">${escapeHtml(c.code)}</span>
                        <span><strong>${escapeHtml(fidCodeValue(c))}</strong> · ${escapeHtml(c.label || "")}</span>
                        <span class="muted">${c.expires_at ? escapeHtml(fidT("codeUntil", { date: fidDay(c.expires_at) })) : ""}</span>
                    </div>`).join("")}</div>
                <p class="muted">${escapeHtml(fidT("rewardsHint"))}</p>
            </article>`;
    }

    function fidWheelHtml(prizes) {
        const n = prizes.length;
        const seg = 360 / n;
        const color = (p, i) => {
            if (p.kind === "none") return "var(--bg-soft)";
            if (n % 2 === 1 && i === n - 1) return "rgba(var(--accent-rgb), 0.45)";
            return i % 2 === 0 ? "rgba(var(--accent-rgb), 0.82)" : "var(--card-2)";
        };
        const stops = prizes.map((p, i) => `${color(p, i)} ${(i * seg).toFixed(3)}deg ${((i + 1) * seg).toFixed(3)}deg`).join(", ");
        const labels = prizes.map((p, i) => `<span class="loyalty-wheel-label" style="--a:${((i + 0.5) * seg).toFixed(3)}deg">${escapeHtml(p.label)}</span>`).join("");
        return `
            <div class="loyalty-wheel">
                <div class="loyalty-wheel-pointer" aria-hidden="true"></div>
                <div class="loyalty-wheel-disc" id="loyalty-wheel-disc" style="background: conic-gradient(${stops}); transform: rotate(${fid.rotation.toFixed(2)}deg)">${labels}</div>
                <div class="loyalty-wheel-hub" aria-hidden="true">🎡</div>
            </div>`;
    }

    // Icône de la carte Roue (pièce), traits en currentColor
    const FID_WHEEL_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.4-1-1.5-1.7-2.8-1.7-1.6 0-2.8.9-2.8 2.1 0 2.9 5.6 1.6 5.6 4.6 0 1.2-1.2 2.2-2.8 2.2-1.4 0-2.5-.7-2.9-1.8M12 6v1.5M12 16.5V18"/></svg>';

    // Roue (profil) : ligne compacte (icône, titre, « un spin disponible » ou temps restant, chevron, pastille quand un
    // tour attend) ; la roue existante se déplie dessous au toucher et reste ouverte pendant qu'elle tourne
    function fidWheelCardHtml(w) {
        const wait = w.next_spin_at ? w.next_spin_at - fidNow() : 0;
        const ready = wait <= 0;
        const open = fid.wheelOpen || fid.spinning;
        let result = "";
        if (fid.lastWin) {
            const r = fid.lastWin;
            result = `<p class="loyalty-wheel-result">${escapeHtml(r.title)}</p>${r.detail ? `<p class="muted">${escapeHtml(r.detail)}</p>` : ""}`;
        }
        const sub = ready ? fidT("wheelAvailable") : fidT("nextSpin", { wait: fidWait(wait) });
        return `
            <article class="card panel loyalty-card loyalty-wheel-card${open ? " is-open" : ""}">
                <button class="wheel-entry" data-fid-action="wheel-toggle" type="button" aria-expanded="${open ? "true" : "false"}">
                    <span class="wheel-entry-icon" aria-hidden="true">${FID_WHEEL_ICON}${ready ? `<span class="wheel-entry-dot"></span>` : ""}</span>
                    <span class="wheel-entry-text">
                        <strong>${escapeHtml(fidT("wheelTitle"))}</strong>
                        <span class="wheel-entry-sub${ready ? " is-ready" : ""}">${escapeHtml(sub)}</span>
                    </span>
                    <span class="wheel-entry-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
                </button>
                ${open ? `
                <div class="loyalty-wheel-body">
                    ${fidWheelHtml(w.prizes)}
                    <button class="btn primary loyalty-wide-btn" data-fid-action="spin" type="button" ${ready && !fid.spinning ? "" : "disabled"}>${escapeHtml(fid.spinning ? fidT("spinning") : fidT("spin"))}</button>
                    ${result}
                </div>` : ""}
            </article>`;
    }

    function fidContestHtml(c) {
        const open = c.open && fidNow() < c.ends_at;
        return `
            <article class="card panel loyalty-card loyalty-contest">
                <div class="profile-section-head">
                    <h4>🎁 ${escapeHtml(fidT("contestTitle"))}</h4>
                    <span class="loyalty-chip">${escapeHtml(open ? fidT("contestEnds", { date: fidDay(c.ends_at) }) : fidT("contestClosed"))}</span>
                </div>
                <h3 class="loyalty-contest-title">${escapeHtml(c.title)}</h3>
                <p class="loyalty-contest-prize">🏆 ${escapeHtml(c.prize)}</p>
                ${c.description ? `<p class="muted">${escapeHtml(c.description)}</p>` : ""}
                <div class="loyalty-contest-foot">
                    <span class="muted">👥 ${escapeHtml(fidT("participants", { n: Number(c.participants) || 0 }))}</span>
                    ${c.joined ? `<span class="loyalty-chip loyalty-chip-ok">${escapeHtml(fidT("joined"))}</span>`
                        : `<button class="btn primary" data-fid-action="join" data-contest-id="${Number(c.id)}" type="button" ${open ? "" : "disabled"}>${escapeHtml(fidT("join"))}</button>`}
                </div>
            </article>`;
    }

    function fidOnZoneClick(e) {
        const btn = e.target.closest("[data-fid-action]");
        if (!btn || btn.disabled) return;
        const action = btn.dataset.fidAction;
        const a = fid.me && fid.me.account;
        if (action === "copy" && a) {
            copyTextToClipboard(a.link || a.code).then((ok) => showToast(ok ? fidT("linkCopied") : fidT("copyFailed"), ok ? undefined : "error"));
        } else if (action === "share" && a && a.link) {
            const url = `https://t.me/share/url?url=${encodeURIComponent(a.link)}&text=${encodeURIComponent(fidT("shareText"))}`;
            if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
            else window.open(url, "_blank");
        } else if (action === "wheel-toggle") {
            if (fid.spinning) return;
            fid.wheelOpen = !fid.wheelOpen;
            fidRenderProfile();
            if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
            const body = fid.wheelOpen ? document.querySelector("#loyalty-slot-wheel .loyalty-wheel-body") : null;
            if (body && body.scrollIntoView) body.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else if (action === "spin") {
            fidSpin();
        } else if (action === "join") {
            fidJoinContest(Number(btn.dataset.contestId), btn);
        } else if (action === "review") {
            switchPage("reviews");
        }
    }

    function fidOnZoneSubmit(e) {
        const form = e.target.closest("[data-fid-form='referral']");
        if (!form) return;
        e.preventDefault();
        const input = form.querySelector("input[name='code']");
        const code = input ? input.value.trim() : "";
        if (code) fidApplyReferral(code, false, form);
    }

    async function fidApplyReferral(code, silent, form) {
        const btn = form ? form.querySelector("button[type='submit']") : null;
        if (btn) btn.disabled = true;
        const res = await fidPost("/fidelite/referral", { code });
        if (btn) btn.disabled = false;
        if (res.ok) {
            showToast(res.data.message || "✓");
            fid.lastLoad = Date.now();
            fidSetMe(res.data);
        } else if (!silent && res.error) {
            showToast(res.error, "error");
        }
    }

    async function fidJoinContest(contestId, btn) {
        if (btn) btn.disabled = true;
        const res = await fidPost("/fidelite/contest/join", { contest_id: contestId });
        if (res.ok) {
            showToast(res.data.message || fidT("joined"));
            if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        } else {
            if (btn) btn.disabled = false;
            if (res.error) showToast(res.error, "error");
        }
        fidRefresh(true);
    }

    async function fidSpin() {
        const me = fid.me;
        if (fid.spinning || !me || !me.wheel) return;
        fid.spinning = true;
        fid.lastWin = null;
        const btn = document.querySelector('#loyalty-slot-wheel [data-fid-action="spin"]');
        if (btn) {
            btn.disabled = true;
            btn.textContent = fidT("spinning");
        }
        const res = await fidPost("/fidelite/wheel/spin", {}, 10000);
        if (!res.ok) {
            fid.spinning = false;
            fid.slotHtml.wheel = ""; // bouton modifié à la main ci-dessus : la carte est redessinée
            if (res.error) showToast(res.error, "error");
            fidRenderProfile();
            fidRefresh(true);
            return;
        }
        const d = res.data;
        const prizes = Array.isArray(d.prizes) && d.prizes.length ? d.prizes : me.wheel.prizes;
        // Lots relus sur le serveur (modifiés depuis l'affichage ?) : la roue est redessinée avant de tourner
        if (JSON.stringify(prizes) !== JSON.stringify(me.wheel.prizes)) {
            me.wheel.prizes = prizes;
            const slot = document.getElementById("loyalty-slot-wheel");
            if (slot) slot.innerHTML = fid.slotHtml.wheel = fidWheelCardHtml(me.wheel);
        }
        const disc = document.getElementById("loyalty-wheel-disc");
        const seg = 360 / prizes.length;
        const center = (Number(d.index) + 0.5) * seg;
        const jitter = (Math.random() - 0.5) * seg * 0.6;
        const base = fid.rotation - (fid.rotation % 360);
        fid.rotation = base + 360 * 6 + ((360 - center) % 360) + jitter;
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const duration = reduce ? 600 : 4800;
        if (disc) {
            disc.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0.7, 0.1, 1)`;
            requestAnimationFrame(() => { disc.style.transform = `rotate(${fid.rotation.toFixed(2)}deg)`; });
        }
        await new Promise((resolve) => setTimeout(resolve, duration + 250));
        fid.spinning = false;
        const prize = d.prize || {};
        if (prize.kind === "none") {
            fid.lastWin = { title: fidT("wheelLost"), detail: "" };
        } else {
            let detail = fidT("wheelManual");
            if (d.code) detail = fidT("wheelCode", { code: d.code, date: fidDay(d.expires_at) });
            else if (prize.kind === "points") detail = fidT("wheelPoints", { n: Number(d.points) || 0 });
            fid.lastWin = { title: fidT("wheelWon", { label: prize.label || "" }), detail };
            if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        }
        showToast(fid.lastWin.title, prize.kind === "none" ? "info" : undefined);
        me.wheel.next_spin_at = Number(d.next_spin_at) || 0;
        fidRenderProfile();
        fidRefresh(true);
    }

    // ── Panier ──
    function fidSelectionDiscount(total, sel) {
        const me = fid.me || {};
        const reward = sel.points ? (me.rewards || []).find((r) => r.points === sel.points) : null;
        const code = sel.code ? (me.codes || []).find((c) => c.code === sel.code) : null;
        const t = fidRound(total);
        let discount = 0;
        if (code && code.kind === "percent") discount += fidRound(t * Number(code.value) / 100);
        else if (code && code.kind === "amount") discount += Number(code.value) || 0;
        if (reward) discount += Number(reward.amount) || 0;
        discount = fidRound(discount);
        return { discount, final: fidRound(t - discount) };
    }

    // Sélection encore valable (solde, palier ou code toujours là, total couvert) ; sinon rien
    function fidValidSelection(total) {
        const me = fid.me;
        const sel = { points: 0, code: "" };
        if (!me) return sel;
        if (fid.selection.points && me.rank_enabled && me.account) {
            const r = (me.rewards || []).find((x) => x.points === fid.selection.points);
            if (r && r.points <= me.account.points) sel.points = r.points;
        }
        if (fid.selection.code && (me.codes || []).some((c) => c.code === fid.selection.code)) sel.code = fid.selection.code;
        if ((sel.points || sel.code) && fidSelectionDiscount(total, sel).final <= 0) return { points: 0, code: "" };
        return sel;
    }

    // Appelé par renderCart avec le total affiché (frais de livraison compris)
    function fideliteRenderCart(total) {
        try {
            fidEnsureDom();
            const box = document.getElementById("loyalty-cart");
            if (!box) return;
            const me = fid.me;
            const rewards = me && me.rank_enabled && me.account ? (me.rewards || []) : [];
            const codes = me && Array.isArray(me.codes) ? me.codes : [];
            if (!rewards.length && !codes.length) {
                box.hidden = true;
                box.innerHTML = "";
                fid.selection = { points: 0, code: "" };
                return;
            }
            fid.selection = fidValidSelection(total);
            const sel = fid.selection;
            const balance = me.account ? Number(me.account.points) || 0 : 0;
            const chip = (active, attrs, label, disabled) => `<button type="button" class="loyalty-chip-btn${active ? " active" : ""}" ${attrs} ${disabled ? "disabled" : ""}>${escapeHtml(label)}</button>`;
            let html = `<h4 class="loyalty-cart-title">🎁 ${escapeHtml(fidT("cartTitle"))}</h4>`;
            if (rewards.length) {
                html += `<p class="muted">${escapeHtml(fidT("cartPoints", { n: balance }))}</p><div class="loyalty-chips">`
                    + chip(!sel.points, 'data-fid-points="0"', fidT("cartNone"), false)
                    + rewards.map((r) => chip(sel.points === r.points, `data-fid-points="${Number(r.points)}"`,
                        fidT("rewardLine", { points: r.points, amount: formatPrice(r.amount) }),
                        r.points > balance || fidSelectionDiscount(total, { points: r.points, code: sel.code }).final <= 0)).join("")
                    + `</div>`;
            }
            if (codes.length) {
                html += `<p class="muted">${escapeHtml(fidT("cartCodes"))}</p><div class="loyalty-chips">`
                    + chip(!sel.code, 'data-fid-code=""', fidT("cartNone"), false)
                    + codes.map((c) => chip(sel.code === c.code, `data-fid-code="${escapeHtml(c.code)}"`, `${c.code} · ${fidCodeValue(c)}`,
                        fidSelectionDiscount(total, { points: sel.points, code: c.code }).final <= 0)).join("")
                    + `</div>`;
            }
            const d = fidSelectionDiscount(total, sel);
            if (d.discount > 0) {
                html += `<p class="loyalty-cart-line">${escapeHtml(fidT("cartDiscount", { amount: formatPrice(d.discount), total: formatPrice(total) }))}</p>`;
                if (els.cartTotal) els.cartTotal.textContent = formatPrice(d.final);
            }
            box.innerHTML = html;
            box.hidden = false;
        } catch (err) {
            console.warn("Fidélité (panier) :", err);
        }
    }

    function fidOnCartClick(e) {
        const btn = e.target.closest("[data-fid-points], [data-fid-code]");
        if (!btn || btn.disabled) return;
        if (btn.hasAttribute("data-fid-points")) fid.selection.points = Number(btn.dataset.fidPoints) || 0;
        else fid.selection.code = btn.dataset.fidCode || "";
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        renderCart();
    }

    // Champs ajoutés à la commande (onCheckout) : palier de points, code gagné et total réduit attendu ; le serveur recalcule
    function fideliteCheckoutFields(total) {
        const sel = fidValidSelection(total);
        if (!sel.points && !sel.code) return {};
        return { points_used: sel.points || 0, promo_code: sel.code || "", fidelite_total: fidSelectionDiscount(total, sel).final };
    }

    function fidOrderUsesLoyalty(order) {
        return Boolean(order && (order.points_used || order.promo_code));
    }

    // Commande enregistrée (persistOrderToServer) : total réduit confirmé par le serveur, sinon prix normal
    function fideliteOrderSaved(order, data) {
        if (fidOrderUsesLoyalty(order)) {
            const info = data && data.fidelite;
            if (info && info.applied && Number.isFinite(Number(info.total))) {
                order.total = Number(info.total);
                order.fidelite = { discount: Number(info.discount) || 0, points: Number(info.points_used) || 0, code: info.promo_code || "" };
                showToast(fidT("orderApplied", { amount: formatPrice(order.fidelite.discount) }));
            } else {
                showToast(fidT("orderMissing"), "error");
            }
        }
        fid.selection = { points: 0, code: "" };
        fidRefresh(true);
    }

    // Commande refusée ou non vérifiée alors qu'un avantage était demandé : rien ne part, le panier reste
    function fideliteOrderBlocked(order, data) {
        if (!fidOrderUsesLoyalty(order)) return false;
        showToast((data && data.error) || fidT("orderUnverified"), "error");
        fidRefresh(true);
        return true;
    }

    // Ligne ajoutée au message Telegram de la commande
    function fideliteOrderNote(order) {
        if (!order || !order.fidelite || !order.fidelite.discount) return "";
        const parts = [];
        if (order.fidelite.points) parts.push(`${order.fidelite.points} ${fidT("pts")}`);
        if (order.fidelite.code) parts.push(order.fidelite.code);
        return `\n🎁 ${fidT("orderLine", { amount: formatPrice(order.fidelite.discount) })}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }

    // ── Avis ──
    function fidRenderReviewForm() {
        const note = document.getElementById("loyalty-review-note");
        const photoBox = document.getElementById("loyalty-photo-box");
        if (!els.reviewForm || !note) return;
        const f = fidFlags();
        const r = fid.me && fid.me.reviews;
        let reason = "";
        if (!f.reviews) reason = fidT("reviewsOff");
        else if (r && !r.can_review) reason = r.reason || fidT("reviewsOff");
        els.reviewForm.hidden = Boolean(reason);
        note.hidden = !reason;
        note.textContent = reason;
        if (photoBox) {
            const photos = f.photos && (!r || r.photos !== false);
            photoBox.hidden = !photos;
            if (!photos && fid.reviewPhoto) fidClearReviewPhoto();
            fidRenderPhotoBox();
        }
    }

    function fidRenderPhotoBox() {
        const pick = document.getElementById("loyalty-photo-pick");
        const remove = document.getElementById("loyalty-photo-remove");
        const preview = document.getElementById("loyalty-photo-preview");
        const status = document.getElementById("loyalty-photo-status");
        if (!pick) return;
        pick.textContent = fid.reviewPhoto ? fidT("photoChange") : fidT("photoAdd");
        pick.disabled = fid.reviewPhotoBusy;
        if (remove) {
            remove.textContent = fidT("photoRemove");
            remove.hidden = !fid.reviewPhoto || fid.reviewPhotoBusy;
        }
        if (preview) {
            if (fid.reviewPreviewUrl) preview.src = fid.reviewPreviewUrl;
            else preview.removeAttribute("src");
            preview.hidden = !fid.reviewPreviewUrl;
        }
        if (status) status.textContent = fid.reviewPhotoBusy ? fidT("photoSending") : (fid.reviewPhoto ? fidT("photoReady") : "");
        if (els.reviewSubmitBtn) els.reviewSubmitBtn.disabled = fid.reviewPhotoBusy;
    }

    function fidClearReviewPhoto() {
        if (fid.reviewPreviewUrl) URL.revokeObjectURL(fid.reviewPreviewUrl);
        fid.reviewPreviewUrl = "";
        fid.reviewPhoto = "";
        fidRenderPhotoBox();
    }

    // Photo envoyée tout de suite (multipart : init_data, platform puis le fichier) ; le chemin part avec l'avis
    async function fidUploadReviewPhoto(file) {
        if (!/^image\/(jpeg|png|webp)$/i.test(file.type || "")) {
            showToast(fidT("photoType"), "error");
            return;
        }
        if (file.size > FID_PHOTO_MAX_BYTES) {
            showToast(fidT("photoTooBig"), "error");
            return;
        }
        fidClearReviewPhoto();
        fid.reviewPhotoBusy = true;
        fid.reviewPreviewUrl = URL.createObjectURL(file);
        fidRenderPhotoBox();
        const form = new FormData();
        form.append("init_data", getAdminInitData());
        form.append("platform", telegramPlatform());
        form.append("file", file, file.name || "photo");
        let error = fidT("networkError");
        try {
            const resp = await fetchWriteApi("/fidelite/review-photo", { method: "POST", body: form }, 30000);
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success && typeof data.path === "string") {
                fid.reviewPhoto = data.path;
                error = "";
            } else if (resp.status === 403 && applyGateRefusal(data)) {
                error = "";
            } else if (data && data.error) {
                error = data.error;
            }
        } catch (_) { }
        fid.reviewPhotoBusy = false;
        if (!fid.reviewPhoto) {
            if (fid.reviewPreviewUrl) URL.revokeObjectURL(fid.reviewPreviewUrl);
            fid.reviewPreviewUrl = "";
        }
        fidRenderPhotoBox();
        if (error) showToast(error, "error");
    }

    // Champs ajoutés à l'avis envoyé (addReview)
    function fideliteReviewExtras() {
        return fid.reviewPhoto ? { photo: fid.reviewPhoto } : {};
    }

    // ===== ALERTES — BOUTIQUE (profil › Notifications : nouveaux produits, promotions) =====
    // Préférences lues par POST /watch/prefs et enregistrées dès qu'un interrupteur bouge (POST /watch/save) :
    // initData signée, accès autorisé et limite de fréquence vérifiés par willy.py, qui seul envoie les messages du
    // bot. Alertes coupées par défaut ; carte masquée hors de Telegram, accès refusé ou serveur injoignable.
    const watch = { prefs: null, loading: null, lastLoad: 0, busy: {}, bound: false };
    const WATCH_REFRESH_MS = 15000;
    const WATCH_KINDS = ["new_products", "promos"];

    function watchAvailable() {
        return Boolean(getAdminInitData()) && !(state.access && state.access.allowed === false);
    }

    function initWatchShop() {
        try {
            const card = document.getElementById("profile-watch-card");
            if (!card || watch.bound) return;
            watch.bound = true;
            card.addEventListener("change", (e) => {
                const input = e.target.closest("input[data-watch-kind]");
                if (input) watchSave(input.dataset.watchKind, input.checked, input);
            });
            // Profil ouvert ou mini-app revenue au premier plan : préférences relues (au plus toutes les 15 s)
            document.querySelectorAll('.tab-btn[data-page="profile"]').forEach((btn) => {
                btn.addEventListener("click", () => watchRefresh(false));
            });
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") watchRefresh(false);
            });
            watchApplyConfig();
            watchRefresh(true);
        } catch (err) {
            console.warn("Alertes :", err);
        }
    }

    function watchRefresh(force) {
        if (watch.loading) return watch.loading;
        if (!force && Date.now() - watch.lastLoad < WATCH_REFRESH_MS) return Promise.resolve();
        if (!watchAvailable()) {
            watchRender();
            return Promise.resolve();
        }
        watch.loading = (async () => {
            const res = await fidPost("/watch/prefs", {});
            watch.lastLoad = Date.now();
            if (res.ok && res.data && res.data.prefs) watch.prefs = res.data.prefs;
            watchRender();
        })().finally(() => { watch.loading = null; });
        return watch.loading;
    }

    async function watchSave(kind, enabled, input) {
        if (!WATCH_KINDS.includes(kind) || watch.busy[kind]) return;
        watch.busy[kind] = true;
        input.disabled = true;
        const res = await fidPost("/watch/save", { kind, enabled });
        watch.busy[kind] = false;
        input.disabled = false;
        if (res.ok && res.data && res.data.prefs) {
            watch.prefs = res.data.prefs;
            watch.lastLoad = Date.now();
            showToast(enabled ? t("watchOn") : t("watchOff"), enabled ? undefined : "info");
            if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
            // Client inconnu des bots (jamais de /start) : Telegram propose d'autoriser leurs messages (Bot API 6.9+)
            const user = getTelegramUser();
            if (enabled && res.data.reach === false && !(user && user.allows_write_to_pm === true)
                && tg && typeof tg.requestWriteAccess === "function" && tgSupports("6.9")) {
                try {
                    tg.requestWriteAccess((granted) => {
                        if (!granted) showToast(t("watchNeedBot"), "info");
                    });
                } catch (_) { }
            }
        } else if (res.error) {
            showToast(res.error, "error");
        }
        watchRender(); // interrupteur réaligné sur l'état enregistré (échec = position d'avant)
    }

    // Appelé par applyShopTexts (rechargement de /config, changement de langue) et au démarrage
    function watchApplyConfig() {
        try {
            const texts = {
                "watch-title": "watchTitle", "watch-subtitle": "watchSubtitle", "watch-new-title": "watchNewTitle",
                "watch-new-desc": "watchNewDesc", "watch-promo-title": "watchPromoTitle", "watch-promo-desc": "watchPromoDesc",
                "watch-hint": "watchHint"
            };
            Object.keys(texts).forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.textContent = t(texts[id]);
            });
            // Accès autorisé après coup (écran d'accès levé) : préférences relues (au plus toutes les 15 s)
            if (watch.bound && !watch.prefs && watchAvailable()) watchRefresh(false);
            watchRender();
        } catch (err) {
            console.warn("Alertes :", err);
        }
    }

    function watchRender() {
        const card = document.getElementById("profile-watch-card");
        if (!card) return;
        card.hidden = !watchAvailable() || !watch.prefs;
        const prefs = watch.prefs || {};
        card.querySelectorAll("input[data-watch-kind]").forEach((input) => {
            if (!watch.busy[input.dataset.watchKind]) input.checked = prefs[input.dataset.watchKind] === true;
        });
    }

    async function bootstrap() {
        try {
            // Lecture du CloudStorage pendant le chargement de la config (adresse du tunnel changée = localStorage vide)
            const cloudRestore = restoreFromCloudStorage();
            await loadConfig();
            await cloudRestore;
            loadLocal();
            cloud.localLoaded = true;
            await syncReviewsFromLocalApi();
            renderUser();
            refreshAdminAccess();
            renderCategories();
            renderProducts();
            renderCart();
            renderHistory();
            renderReviews();
            renderProfileStats();
            renderLanguageSelection();
            applyTranslations();
            attachNavigation();
            bindActions();
            initCatalogueShop(); // catalogue : likes, choix de la ville, options du panier
            bindMusicPlayer();
            initBotShop();
            initFideliteShop(); // fidelite : profil (rang, parrainage, roue, concours), panier et avis
            initWatchShop(); // alertes : carte Notifications du profil (nouveaux produits, promotions)
            // Accès refusé par le serveur : écran d'accès sous l'intro (le catalogue n'a pas été envoyé)
            applyAccessState();
            initMessagesShop(); // équipe Messages : carte Support (tickets SAV) de l'onglet Contact
        } catch (error) {
            document.body.innerHTML = `<div style="padding:20px;color:#fff">Erreur: ${escapeHtml(error.message)}</div>`;
            return;
        }

        // Apparence choisie dans la gestion (thème, fond, logo, loader) : hors du try, jamais bloquante
        applyShopAppearance(state.config);
        document.addEventListener("visibilitychange", syncBgAnimation);
        // Mini-app mise en arrière-plan ou fermée : la copie du panier part tout de suite
        document.addEventListener("visibilitychange", () => {
            if (document.hidden && cloud.timer) mirrorToCloudStorage();
        });

        if (els.introSub) els.introSub.textContent = "Chargement de la boutique...";
        setTimeout(() => {
            if (els.introSub) els.introSub.textContent = "Préparation de la carte...";
        }, 400);
        setTimeout(() => {
            if (els.introSub) els.introSub.textContent = "Ouverture du menu...";
        }, 850);
        setTimeout(() => {
            document.body.classList.add("app-ready", "app-entering");
            setTimeout(() => document.body.classList.remove("app-entering"), 900);
            startMusicPlayer();
        }, 1200);

        // Auto refresh silencieux quand l'utilisateur réouvre ou revient sur l'application Telegram
        // (l'écran d'accès disparaît tout seul dès que le serveur autorise l'accès)
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") reloadShop();
        });

        window.addEventListener("focus", () => {
            reloadShop();
        });

        // Synchronisation périodique automatique (toutes les 45 secondes)
        setInterval(() => {
            if (document.visibilityState === "visible") reloadShop();
        }, 45000);
    }

    applyStoredIntroAppearance();
    // script.js est chargé après les premières images (index.html) : la page est souvent déjà prête
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap);
    else bootstrap();
})();
