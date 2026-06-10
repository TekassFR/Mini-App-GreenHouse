(function () {
    "use strict";

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    function getHashParam(name) {
        const raw = String(window.location.hash || "").replace(/^#/, "");
        if (!raw) return "";
        const params = new URLSearchParams(raw);
        return String(params.get(name) || "").toLowerCase();
    }

    function isTelegramMobileClient() {
        return true; // Désactivé temporairement pour le rework / développement sur PC

        const referrer = String(document.referrer || "").toLowerCase();
        const fromWebTelegram = referrer.includes("web.telegram.org");
        if (fromWebTelegram) return false;

        const ua = (navigator.userAgent || "").toLowerCase();
        const looksDesktopUA = /windows|macintosh|linux x86_64|telegramdesktop|electron/.test(ua);
        if (looksDesktopUA) return false;

        // Autorise uniquement la MiniApp ouverte dans Telegram mobile natif.
        if (!tg) return false;

        const platform = typeof tg.platform === "string" ? tg.platform.toLowerCase() : "";
        if (platform.startsWith("web")) return false;
        if (platform.includes("desktop") || platform.includes("tdesktop")) return false;

        const hashPlatform = getHashParam("tgWebAppPlatform");
        if (hashPlatform.startsWith("web") || hashPlatform.includes("desktop") || hashPlatform.includes("tdesktop")) return false;

        const effectivePlatform = hashPlatform || platform;
        const isTelegramNativeMobile = effectivePlatform === "android" || effectivePlatform === "ios";
        if (!isTelegramNativeMobile) return false;

        // Garde-fou supplementaire: il faut un user Telegram charge.
        const user = tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
        if (!user || !Number.isFinite(Number(user.id))) return false;

        // Double verification par user-agent mobile.
        const isMobileUA = /android|iphone|ipad|ipod|mobile/.test(ua);
        return isMobileUA;
    }

    function renderDesktopBlockedScreen() {
        document.body.innerHTML = `
            <div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b1110;color:#f2fff8;font-family:Segoe UI,Tahoma,sans-serif;text-align:center;">
                <div style="max-width:520px;border:1px solid rgba(168,255,207,0.2);border-radius:16px;padding:22px;background:rgba(9,17,13,0.86);">
                    <h1 style="margin:0 0 10px;font-size:1.4rem;">Acces mobile uniquement</h1>
                    <p style="margin:0;color:#c7d5cc;line-height:1.5;">Cette mini app Telegram est reservee au client mobile Telegram. Ouvre-la depuis Telegram sur ton telephone.</p>
                </div>
            </div>
        `;
    }

    // Blocage immediat pour eviter tout affichage desktop, meme avant bootstrap.
    if (!isTelegramMobileClient()) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", renderDesktopBlockedScreen, { once: true });
        } else {
            renderDesktopBlockedScreen();
        }
        return;
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
        selectedPrice: 0,
        detailMedia: "image",
        reviews: [],
        orders: [],
        language: "fr",
        storageScope: "guest"
    };

    // URL du bot local — uniquement pour les écritures (approve, save, delete). Les lectures utilisent les fichiers JSON statiques.
    const LOCAL_API_BASE = "http://localhost:3000";

    function normalizeApiBase(base) {
        let raw = String(base || "").trim();
        if (!raw) return "";
        if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
        return raw.replace(/\/+$/, "");
    }

    function getStoredWriteApiBase() {
        try {
            return normalizeApiBase(localStorage.getItem("gh_write_api_base") || "");
        } catch (_) {
            return "";
        }
    }

    function setStoredWriteApiBase(base) {
        try {
            const normalized = normalizeApiBase(base);
            if (!normalized) localStorage.removeItem("gh_write_api_base");
            else localStorage.setItem("gh_write_api_base", normalized);
        } catch (_) {}
    }

    function getWriteApiBases() {
        const storedBase = getStoredWriteApiBase();
        const configuredBase = state && state.config && state.config.admin && state.config.admin.api_base
            ? normalizeApiBase(state.config.admin.api_base)
            : "";
        const originBase = window.location && /^https?:/i.test(String(window.location.origin || ""))
            ? normalizeApiBase(window.location.origin)
            : "";
        const fallbackBase = normalizeApiBase(LOCAL_API_BASE);
        return Array.from(new Set([configuredBase, storedBase, originBase, fallbackBase].filter(Boolean)));
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

    async function fetchWriteApi(path, options, allowPromptFallback) {
        const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
        const bases = getWriteApiBases();
        let lastError = null;

        for (const base of bases) {
            const url = `${base}${normalizedPath}`;
            try {
                const resp = await fetch(url, options);
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

        if (allowPromptFallback) {
            const userInput = window.prompt(
                "Serveur API introuvable.\nColle l'URL du bot (ex: http://192.168.1.20:3000)",
                getStoredWriteApiBase() || "http://192.168.1.20:3000"
            );
            const manualBase = normalizeApiBase(userInput || "");
            if (manualBase) {
                setStoredWriteApiBase(manualBase);
                const manualUrl = `${manualBase}${normalizedPath}`;
                try {
                    const manualResp = await fetch(manualUrl, options);
                    if (manualResp.ok) return manualResp;
                    const contentType = String(manualResp.headers.get("content-type") || "").toLowerCase();
                    if (contentType.includes("application/json")) return manualResp;
                    lastError = new Error(`HTTP ${manualResp.status}`);
                } catch (error) {
                    lastError = error;
                }
            }
        }

        throw lastError || new Error("API d'écriture indisponible");
    }

    const els = {
        intro: document.getElementById("intro-screen"),
        introSub: document.getElementById("intro-sub"),
        brandSubtitle: document.getElementById("brand-subtitle"),
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
        profileLanguageTitle: document.getElementById("profile-language-title"),
        profileOrdersTitle: document.getElementById("profile-orders-title"),
        languageGrid: document.getElementById("language-grid"),
        profileAdminCard: document.getElementById("profile-admin-card"),
        adminPanelBtn: document.getElementById("admin-panel-btn"),
        adminOverlay: document.getElementById("admin-overlay"),
        adminCloseBtn: document.getElementById("admin-close-btn"),
        adminTabBtns: document.querySelectorAll(".admin-tab-btn"),
        adminTabReviews: document.getElementById("admin-tab-reviews"),
        adminTabOrders: document.getElementById("admin-tab-orders"),
        adminReviewsPending: document.getElementById("admin-reviews-pending"),
        adminOrdersAll: document.getElementById("admin-orders-all"),
        adminTabProducts: document.getElementById("admin-tab-products"),
        adminTabCategories: document.getElementById("admin-tab-categories"),
        adminProductsContent: document.getElementById("admin-products-content"),
        adminCategoriesContent: document.getElementById("admin-categories-content"),

        infoTitle: document.getElementById("info-title"),
        infoDesc: document.getElementById("info-desc"),
        infoDeliveryTitle: document.getElementById("info-delivery-title"),
        infoHoursLabel: document.getElementById("info-hours-label"),
        infoDelayLabel: document.getElementById("info-delay-label"),
        infoZoneLabel: document.getElementById("info-zone-label"),
        infoContactTitle: document.getElementById("info-contact-title"),
        infoContactUsername: document.getElementById("info-contact-username"),
        infoPaymentTitle: document.getElementById("info-payment-title"),
        infoPaymentDesc: document.getElementById("info-payment-desc"),
        contactBtn: document.getElementById("contact-btn"),
        channelBtn: document.getElementById("channel-btn"),

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
        detailTeleBtn: document.getElementById("detail-tele-btn")
    };

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
            navInfo: "Infos",
            categoryAll: "Tous",
            categoryKeyLabel: "Categorie",
            categoryTypeLabel: "Type",
            badgeNew: "Nouveau",
            badgePromo: "Promo",
            fromPrice: "Des {price}",
            view: "Voir",
            cartTitle: "Panier",
            cartDesc: "Finalise ta commande en quelques secondes.",
            cartEmpty: "Panier vide.",
            delivery: "Livraison",
            pickup: "Sur place",
            deliveryAddress: "Adresse de livraison",
            pickupTime: "Heure d'arrivee",
            deliveryPlaceholder: "Ex: 10 rue de Paris, 54000 Nancy",
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
            profileOrders: "Mes Commandes",
            statOrders: "Commandes",
            statSpent: "Depense",
            statMember: "Membre depuis",
            memberSincePhrase: "Membre depuis {month} {year}",
            profileNoOrders: "Aucune commande pour le moment.",
            infoTitle: "Infos",
            infoDesc: "Horaires, contact et paiement.",
            deliveryTitle: "Livraison",
            hours: "Horaires:",
            delay: "Delai:",
            zone: "Zone:",
            contact: "Contact",
            contactBtn: "Contacter",
            channelBtn: "Canal",
            payment: "Paiement",
            cashOnly: "Paiement en especes uniquement.",
            detailBack: "← Retour",
            detailQty: "Selectionner la Quantite",
            add: "Ajouter",
            slidePrev: "Media precedent",
            slideNext: "Media suivant",
            muteLabel: "Couper le son",
            unmuteLabel: "Activer le son",
            alertSelectQty: "Selectionne une quantite.",
            alertCartEmpty: "Panier vide.",
            alertAddress: "Adresse trop courte.",
            alertPickupTime: "Selectionne une heure d'arrivee.",
            alertReview: "Remplis le nom et le message.",
            askProduct: "Salut, je veux ce produit: {name}",
            orderText: "Nouvelle commande #{id}\nType: {type}\nDetails: {summary}\nTotal: {total}"
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
            navInfo: "Info",
            categoryAll: "All",
            categoryKeyLabel: "Category",
            categoryTypeLabel: "Type",
            badgeNew: "New",
            badgePromo: "Promo",
            fromPrice: "From {price}",
            view: "View",
            cartTitle: "Cart",
            cartDesc: "Complete your order in seconds.",
            cartEmpty: "Cart is empty.",
            delivery: "Delivery",
            pickup: "Pickup",
            deliveryAddress: "Delivery address",
            pickupTime: "Pickup time",
            deliveryPlaceholder: "Ex: 10 Rue de Paris, 54000 Nancy",
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
            profileOrders: "My Orders",
            statOrders: "Orders",
            statSpent: "Spent",
            statMember: "Member since",
            memberSincePhrase: "Member since {month} {year}",
            profileNoOrders: "No order yet.",
            infoTitle: "Info",
            infoDesc: "Schedule, contact and payment.",
            deliveryTitle: "Delivery",
            hours: "Hours:",
            delay: "Delay:",
            zone: "Area:",
            contact: "Contact",
            contactBtn: "Contact",
            channelBtn: "Channel",
            payment: "Payment",
            cashOnly: "Cash payment only.",
            detailBack: "← Back",
            detailQty: "Select Quantity",
            add: "Add",
            slidePrev: "Previous media",
            slideNext: "Next media",
            muteLabel: "Mute",
            unmuteLabel: "Unmute",
            alertSelectQty: "Select a quantity.",
            alertCartEmpty: "Cart is empty.",
            alertAddress: "Address is too short.",
            alertPickupTime: "Select a pickup time.",
            alertReview: "Fill name and message.",
            askProduct: "Hi, I want this product: {name}",
            orderText: "New order #{id}\nType: {type}\nDetails: {summary}\nTotal: {total}"
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
            navInfo: "Infos",
            categoryAll: "Alle",
            categoryKeyLabel: "Kategorie",
            categoryTypeLabel: "Typ",
            badgeNew: "Neu",
            badgePromo: "Promo",
            fromPrice: "Ab {price}",
            view: "Ansehen",
            cartTitle: "Warenkorb",
            cartDesc: "Bestellung in Sekunden abschliessen.",
            cartEmpty: "Warenkorb ist leer.",
            delivery: "Lieferung",
            pickup: "Abholung",
            deliveryAddress: "Lieferadresse",
            pickupTime: "Abholzeit",
            deliveryPlaceholder: "Bsp: 10 Rue de Paris, 54000 Nancy",
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
            profileOrders: "Meine Bestellungen",
            statOrders: "Bestellungen",
            statSpent: "Ausgaben",
            statMember: "Mitglied seit",
            memberSincePhrase: "Mitglied seit {month} {year}",
            profileNoOrders: "Noch keine Bestellung.",
            infoTitle: "Infos",
            infoDesc: "Zeiten, Kontakt und Zahlung.",
            deliveryTitle: "Lieferung",
            hours: "Zeiten:",
            delay: "Dauer:",
            zone: "Gebiet:",
            contact: "Kontakt",
            contactBtn: "Kontakt",
            channelBtn: "Kanal",
            payment: "Zahlung",
            cashOnly: "Nur Barzahlung.",
            detailBack: "← Zurueck",
            detailQty: "Menge waehlen",
            add: "Hinzufuegen",
            slidePrev: "Vorheriges Medium",
            slideNext: "Naechstes Medium",
            muteLabel: "Ton aus",
            unmuteLabel: "Ton an",
            alertSelectQty: "Bitte Menge waehlen.",
            alertCartEmpty: "Warenkorb ist leer.",
            alertAddress: "Adresse ist zu kurz.",
            alertPickupTime: "Bitte Abholzeit waehlen.",
            alertReview: "Name und Nachricht ausfuellen.",
            askProduct: "Hallo, ich moechte dieses Produkt: {name}",
            orderText: "Neue Bestellung #{id}\nTyp: {type}\nDetails: {summary}\nGesamt: {total}"
        }
    };

    function sanitize(input) {
        if (typeof input !== "string") return "";
        return input.replace(/[<>"'&]/g, "").trim();
    }

    function isAdmin() {
        const user = getTelegramUser();
        if (!user || !user.username) return false;
        const whitelist = (state.config && state.config.admin && Array.isArray(state.config.admin.whitelist))
            ? state.config.admin.whitelist
            : [];
        const normalizedList = whitelist.map((u) => String(u).replace(/^@/, "").toLowerCase());
        return normalizedList.includes(user.username.replace(/^@/, "").toLowerCase());
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
            return acc.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(params[paramKey]));
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

    function formatEUR(value) {
        return `${toPrice(value).toFixed(2)} EUR`;
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

    function getQtyEntries(product) {
        const custom = product.customPrices || {};
        const entries = Object.entries(custom)
            .map(([qtyRaw, priceData]) => {
                const qty = parseFloat(String(qtyRaw).replace(",", "."));
                if (!Number.isFinite(qty) || qty <= 0) return null;

                if (typeof priceData === "object" && priceData !== null) {
                    const delivery = toPrice(priceData.delivery);
                    const pickup = toPrice(priceData.pickup);
                    const price = state.orderType === "pickup" ? pickup : delivery;
                    return { qty, price: price || delivery || pickup || 0 };
                }

                return { qty, price: toPrice(priceData) };
            })
            .filter(Boolean)
            .sort((a, b) => a.qty - b.qty);

        if (entries.length) return entries;
        return [{ qty: 1, price: toPrice(product.price) }];
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
    }

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
            state.cart = Array.isArray(cart) ? cart : [];
            state.orders = Array.isArray(orders) ? orders : [];
            state.reviews = Array.isArray(reviews) ? reviews : [];
            state.language = ["fr", "en", "de"].includes(language) ? language : "fr";

            // One-time migration from legacy non-scoped keys to user-scoped keys.
            if (!scopedCartRaw || !scopedOrdersRaw || !scopedReviewsRaw || !scopedLanguageRaw) {
                saveLocal();
            }
        } catch (_) {
            state.cart = [];
            state.orders = [];
            state.reviews = [];
            state.language = "fr";
        }
    }

    function normalizeReviewEntry(review) {
        if (!review || typeof review !== "object") return null;
        const author = sanitize(String(review.author || "")).trim();
        const message = sanitize(String(review.message || "")).trim();
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
            telegramUsername: review.telegramUsername ? sanitize(String(review.telegramUsername)) : null
        };
    }

    async function syncReviewsFromLocalApi() {
        try {
            const resp = await fetch(`./reviews.json?t=${Date.now()}`, { cache: "no-store" });
            if (!resp.ok) return false;
            const data = await resp.json();
            // Supporte l'ancien format (tableau plat) et le nouveau {pending, approved}
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

    async function persistReviewToLocalApi(review) {
        try {
            const resp = await fetchWriteApi("/save-review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(review)
            });
            return resp.ok;
        } catch (_) {
            return false;
        }
    }

    async function loadConfig() {
        const resp = await fetch(`./config.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("config.json introuvable");
        const cfg = await resp.json();
        state.config = cfg;
        if (cfg && cfg.admin && cfg.admin.api_base) {
            setStoredWriteApiBase(cfg.admin.api_base);
        }
        state.products = allProductsFromConfig(cfg);
        state.categories = Object.keys((cfg && cfg.categories) || {});
    }

    function renderUser() {
        const user = getTelegramUser();
        const firstName = sanitize((user && user.first_name) || "Utilisateur");
        const username = user && user.username ? `@${sanitize(user.username)}` : "-";
        const greetingName = user && user.username ? `@${sanitize(user.username)}` : firstName;
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

        const adminUser = state.config && state.config.admin ? state.config.admin.telegram_username : "GreenHouse682";
        els.infoContactUsername.textContent = `Telegram: @${adminUser}`;

        // Afficher le bouton admin si l'utilisateur est dans la whitelist
        if (els.profileAdminCard) {
            els.profileAdminCard.style.display = isAdmin() ? "block" : "none";
        }
    }

    function renderCategories() {
        if (!els.categoryTabs) return;

        const allActive = state.category === "all" ? "active" : "";
        let html = `<button class="category-tab-btn ${allActive}" data-category="all" role="tab" aria-selected="${state.category === "all" ? "true" : "false"}">
            <span class="tab-emoji">📦</span>
            <span class="tab-text">${t("categoryAll")}</span>
        </button>`;

        html += state.categories
            .map((catId) => {
                const meta = getCategoryMeta(catId);
                const label = sanitize(meta.name || catId);
                const emoji = sanitize(meta.emoji || "🌿");
                const active = state.category === catId ? "active" : "";
                return `<button class="category-tab-btn ${active}" data-category="${catId}" role="tab" aria-selected="${state.category === catId ? "true" : "false"}">
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
        const img = sanitize(product.image || "");
        const name = sanitize(product.name || "Product");
        const desc = sanitize(product.description || "");
        const categoryMeta = getCategoryMeta(product.category);
        const categoryName = sanitize(categoryMeta.name || product.category || "Categorie");
        const shortDesc = desc || categoryName;
        const start = getStartingPrice(product);

        let badge = "";
        if (product.isNew) badge = `<span class="badge new">${t("badgeNew")}</span>`;
        else if (product.isPromo) badge = `<span class="badge promo">${t("badgePromo")}</span>`;

        return `
            <article class="product-card" data-product-id="${product.id}">
                <div class="product-media">
                    <img src="${img}" alt="${name}" loading="lazy" referrerpolicy="no-referrer">
                    <span class="status-dot" aria-hidden="true"></span>
                    ${badge}
                    <div class="product-media-tools" aria-hidden="true">🍃 🛡️ 🌿</div>
                </div>
                <div class="product-body">
                    <h3 class="product-title">${name}</h3>
                    <p class="product-desc">⌂ ${shortDesc}</p>
                    <span class="price-chip">${t("fromPrice", { price: formatEUR(start) })}</span>
                </div>
            </article>
        `;
    }

    function renderProducts() {
        const source = state.category === "all"
            ? state.products
            : state.products.filter((p) => p.category === state.category);

        els.productGrid.innerHTML = source.map(productCardTemplate).join("");
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

        els.tabs.forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.page === pageName);
        });

        if (pageName === "cart") renderCart();
        if (pageName === "history") renderHistory();
        if (pageName === "reviews") renderReviews();
        if (pageName === "profile") renderProfileStats();
    }

    function attachNavigation() {
        els.tabs.forEach((btn) => {
            btn.addEventListener("click", () => switchPage(btn.dataset.page));
        });
    }

    function renderCart() {
        if (!state.cart.length) {
            els.cartEmptyState.style.display = "block";
            els.cartContent.style.display = "none";
            els.cartEmptyState.textContent = t("cartEmpty");
            els.cartTotal.textContent = formatEUR(0);
            renderProfileStats();
            return;
        }

        els.cartEmptyState.style.display = "none";
        els.cartContent.style.display = "grid";

        let total = 0;
        const rows = state.cart.map((item) => {
            const line = toPrice(item.unitPrice) * item.quantity;
            total += line;
            return `
                <div class="cart-row">
                    <div>
                        <h4>${sanitize(item.name)}</h4>
                        <p class="muted">${formatEUR(item.unitPrice)}${t("unitSuffix")}</p>
                    </div>
                    <div class="cart-controls">
                        <button class="qty-btn" data-id="${item.id}" data-op="minus" type="button">-</button>
                        <span>${item.quantity}</span>
                        <button class="qty-btn" data-id="${item.id}" data-op="plus" type="button">+</button>
                    </div>
                </div>
            `;
        });

        els.cartItems.innerHTML = rows.join("");
        els.cartTotal.textContent = formatEUR(total);

        els.cartItems.querySelectorAll(".qty-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = parseInt(btn.dataset.id, 10);
                const op = btn.dataset.op;
                changeQty(id, op === "plus" ? 1 : -1);
            });
        });

        renderProfileStats();
    }

    function changeQty(productId, delta) {
        const item = state.cart.find((c) => c.id === productId);
        if (!item) return;
        item.quantity += delta;
        if (item.quantity <= 0) {
            state.cart = state.cart.filter((c) => c.id !== productId);
        }
        saveLocal();
        renderCart();
    }

    function addToCart(product, qty, price) {
        const existing = state.cart.find((c) => c.id === product.id && c.unitPrice === price);
        if (existing) {
            existing.quantity += qty;
        } else {
            state.cart.push({
                id: product.id,
                name: product.name,
                quantity: qty,
                unitPrice: price,
                category: product.category
            });
        }
        saveLocal();
        renderCart();
        renderProfileStats();
    }

    function renderHistory() {
        if (!state.orders.length) {
            els.historyList.innerHTML = `<div class="card panel">${t("noOrder")}</div>`;
            return;
        }

        const html = state.orders
            .slice()
            .reverse()
            .map((order) => {
                const date = new Date(order.timestamp).toLocaleString(getLocaleCode());
                const orderTypeText = order.type === "pickup" ? t("pickup") : t("delivery");
                return `
                    <article class="card panel">
                        <h3>${t("orderWord")} #${order.id}</h3>
                        <p class="muted">${date} - ${orderTypeText}</p>
                        <p><strong>${t("total")}:</strong> ${formatEUR(order.total)}</p>
                        <p class="muted">${sanitize(order.summary)}</p>
                    </article>
                `;
            })
            .join("");

        els.historyList.innerHTML = html;
    }

    function renderReviews() {
        if (!state.reviews.length) {
            els.reviewList.innerHTML = `<div class="card panel">${t("noReview")}</div>`;
            els.reviewRating.textContent = "4.9 / 5";
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
                    <h4>${sanitize(r.author)} - ${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</h4>
                    <p>${sanitize(r.message)}</p>
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
            telegramUsername: currentUser && currentUser.username ? sanitize(currentUser.username) : null
        };

        state.reviews.push(review);
        saveLocal();
        renderReviews();

        const serverSaved = await persistReviewToLocalApi(review);
        if (serverSaved) {
            await syncReviewsFromLocalApi();
            renderReviews();
        }
    }

    function renderProfileStats() {
        els.profileOrderCount.textContent = String(state.orders.length);
        const spent = state.orders.reduce((sum, order) => sum + toPrice(order.total), 0);
        els.profileTotalSpent.textContent = formatEUR(spent).replace(".00", "");
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
                return `<div class="profile-order-line"><span>#${order.id} - ${date}</span><strong>${formatEUR(order.total)}</strong></div>`;
            })
            .join("");
    }

    function renderLanguageSelection() {
        if (!els.languageGrid) return;
        els.languageGrid.querySelectorAll(".lang-option").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.lang === state.language);
        });
    }

    function applyTranslations() {
        document.documentElement.lang = state.language;

        if (els.introSub) els.introSub.textContent = t("introSub");
        if (els.brandSubtitle) els.brandSubtitle.textContent = t("brandSubtitle");

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
        if (els.checkoutBtn) els.checkoutBtn.textContent = t("checkout");

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
        if (els.profileLanguageTitle) els.profileLanguageTitle.textContent = t("profileLanguage");
        if (els.profileOrdersTitle) els.profileOrdersTitle.textContent = t("profileOrders");

        if (els.infoTitle) els.infoTitle.textContent = t("infoTitle");
        if (els.infoDesc) els.infoDesc.textContent = t("infoDesc");
        if (els.infoDeliveryTitle) els.infoDeliveryTitle.textContent = t("deliveryTitle");
        if (els.infoHoursLabel) els.infoHoursLabel.textContent = t("hours");
        if (els.infoDelayLabel) els.infoDelayLabel.textContent = t("delay");
        if (els.infoZoneLabel) els.infoZoneLabel.textContent = t("zone");
        if (els.infoContactTitle) els.infoContactTitle.textContent = t("contact");
        if (els.contactBtn) els.contactBtn.textContent = t("contactBtn");
        if (els.channelBtn) els.channelBtn.textContent = t("channelBtn");
        if (els.infoPaymentTitle) els.infoPaymentTitle.textContent = t("payment");
        if (els.infoPaymentDesc) els.infoPaymentDesc.textContent = t("cashOnly");

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
    }

    function getPlayableVideo(video) {
        if (!video) return "";
        const v = String(video).trim();
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

    function buildMediaSlides(product) {
        const slides = [];
        const gallery = Array.isArray(product.gallery) ? product.gallery : [];

        gallery.forEach((item) => {
            if (!item) return;
            if (typeof item === "string") {
                slides.push({ type: "image", src: sanitize(item) });
                return;
            }
            const type = item.type === "video" ? "video" : "image";
            const src = type === "video" ? getPlayableVideo(item.src || "") : sanitize(item.src || "");
            if (!src) return;
            if (type === "video") {
                const fallbackThumb = sanitize(product.image || "");
                const thumb = sanitize(item.thumb || item.poster || getVideoPreviewImage(src) || fallbackThumb);
                slides.push({ type, src, thumb, fallbackThumb });
                return;
            }
            slides.push({ type, src });
        });

        if (product.image) slides.unshift({ type: "image", src: sanitize(product.image) });
        const videoUrl = getPlayableVideo(product.video);
        if (videoUrl) {
            const fallbackThumb = sanitize(product.image || "");
            const thumb = sanitize(getVideoPreviewImage(videoUrl) || fallbackThumb);
            slides.push({ type: "video", src: videoUrl, thumb, fallbackThumb });
        }

        const dedup = [];
        const seen = new Set();
        slides.forEach((slide) => {
            const key = `${slide.type}:${slide.src}`;
            if (!slide.src || seen.has(key)) return;
            seen.add(key);
            dedup.push(slide);
        });

        return dedup.length ? dedup : [{ type: "image", src: "https://picsum.photos/seed/fallback-red/900/700" }];
    }

    function renderDetailCarousel() {
        if (!detailSlides.length) return;

        els.detailMediaTrack.innerHTML = detailSlides
            .map((slide, idx) => {
                if (slide.type === "video") {
                    return `<article class="slide-item" data-slide-index="${idx}"><video class="slide-video" playsinline preload="metadata" src="${slide.src}"></video></article>`;
                }
                return `<article class="slide-item" data-slide-index="${idx}"><img class="slide-image" src="${slide.src}" alt="Media produit ${idx + 1}" loading="lazy" referrerpolicy="no-referrer"></article>`;
            })
            .join("");

        els.detailThumbs.innerHTML = detailSlides
            .map((slide, idx) => {
                const marker = slide.type === "video" ? "▶" : "";
                const thumbMedia = slide.type === "video"
                    ? (slide.thumb
                        ? `<img src="${slide.thumb}" alt="Miniature video ${idx + 1}" loading="lazy" referrerpolicy="no-referrer" data-fallback="${slide.fallbackThumb || ""}">`
                        : `<video src="${slide.src}" muted playsinline preload="metadata"></video>`)
                    : `<img src="${slide.src}" alt="Miniature ${idx + 1}" loading="lazy" referrerpolicy="no-referrer">`;
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

        els.detailSlideCount.textContent = `${detailSlideIndex + 1} / ${detailSlides.length}`;
        pauseAllSlideVideos();

        const activeType = detailSlides[detailSlideIndex].type;
        if (activeType === "video") {
            const activeVideo = els.detailMediaTrack.querySelector(`.slide-item[data-slide-index="${detailSlideIndex}"] video`);
            if (activeVideo) activeVideo.play().catch(() => {});
            if (els.detailMuteBtn) {
                els.detailMuteBtn.disabled = false;
                els.detailMuteBtn.style.opacity = "1";
            }
        } else if (els.detailMuteBtn) {
            els.detailMuteBtn.disabled = true;
            els.detailMuteBtn.style.opacity = "0.45";
            els.detailMuteBtn.textContent = "🔈";
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

    function openProductDetail(product) {
        state.selectedProduct = product;
        state.selectedQty = null;
        state.selectedPrice = 0;
        state.detailMedia = "image";
        detailSlides = buildMediaSlides(product);
        detailSlideIndex = 0;

        const categoryMeta = getCategoryMeta(product.category);
        els.detailName.textContent = sanitize(product.name || "Product");
        els.detailDescription.textContent = sanitize(product.description || "");
        els.detailCategoryChip.textContent = `${sanitize(categoryMeta.emoji || "📦")} ${sanitize(categoryMeta.name || product.category)}`;
        els.detailBrandImage.src = sanitize(product.image || "https://picsum.photos/seed/brand-red/260/260");

        renderDetailCarousel();

        renderDetailQuantities(product);
        els.detailOverlay.scrollTop = 0;
        els.detailOverlay.style.display = "block";
        document.body.style.overflow = "hidden";
        document.body.classList.add("detail-open");
    }

    function closeProductDetail() {
        els.detailOverlay.style.display = "none";
        pauseAllSlideVideos();
        detailSlides = [];
        els.detailMediaTrack.innerHTML = "";
        els.detailThumbs.innerHTML = "";
        document.body.style.overflow = "";
        document.body.classList.remove("detail-open");
    }

    function renderDetailQuantities(product) {
        const entries = getQtyEntries(product);
        els.detailQtyGrid.innerHTML = entries
            .map((entry, idx) => `
                <button class="qty-card ${idx === 0 ? "active" : ""}" data-qty="${entry.qty}" data-price="${entry.price}" type="button">
                    <div class="qty-label">${entry.qty}G</div>
                    <div class="qty-price">${toPrice(entry.price).toFixed(2)}€</div>
                </button>
            `)
            .join("");

        const first = entries[0];
        state.selectedQty = first.qty;
        state.selectedPrice = first.price;
        els.detailSelectedPrice.textContent = formatEUR(state.selectedPrice);

        els.detailQtyGrid.querySelectorAll(".qty-card").forEach((card) => {
            card.addEventListener("click", () => {
                els.detailQtyGrid.querySelectorAll(".qty-card").forEach((c) => c.classList.remove("active"));
                card.classList.add("active");
                state.selectedQty = parseFloat(card.dataset.qty);
                state.selectedPrice = parseFloat(card.dataset.price);
                els.detailSelectedPrice.textContent = formatEUR(state.selectedPrice);
            });
        });
    }

    function onCheckout() {
        if (!state.cart.length) {
            alert(t("alertCartEmpty"));
            return;
        }

        const total = state.cart.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
        if (state.orderType === "delivery") {
            const address = sanitize(els.deliveryAddress.value || "");
            if (address.length < 10) {
                alert(t("alertAddress"));
                return;
            }
        } else {
            const time = sanitize(els.pickupTime.value || "");
            if (!time) {
                alert(t("alertPickupTime"));
                return;
            }
        }

        const orderId = state.orders.length + 1;
        const summary = state.cart.map((i) => `${sanitize(i.name)} x${i.quantity}`).join(", ");
        const currentUser = getTelegramUser();
        state.orders.push({
            id: orderId,
            type: state.orderType,
            total,
            summary,
            items: JSON.parse(JSON.stringify(state.cart)),
            timestamp: Date.now(),
            telegramUserId: currentUser && Number.isFinite(Number(currentUser.id)) ? Number(currentUser.id) : null,
            telegramUsername: currentUser && currentUser.username ? sanitize(currentUser.username) : null
        });

        const username = state.config && state.config.admin ? state.config.admin.telegram_username : "GreenHouse682";
        const text = encodeURIComponent(t("orderText", {
            id: orderId,
            type: state.orderType === "pickup" ? t("pickup") : t("delivery"),
            summary,
            total: formatEUR(total)
        }));
        const url = `https://t.me/${username}?text=${text}`;

        if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
        else window.open(url, "_blank");

        const savedOrder = state.orders[state.orders.length - 1];
        void persistOrderToServer(savedOrder);

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
                els.serviceSwitch.querySelectorAll(".service-btn").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                state.orderType = btn.dataset.service;
                const isDelivery = state.orderType === "delivery";
                els.deliveryFieldGroup.style.display = isDelivery ? "grid" : "none";
                els.pickupFieldGroup.style.display = isDelivery ? "none" : "grid";
            });
        });

        els.contactBtn.addEventListener("click", () => {
            const username = state.config && state.config.admin ? state.config.admin.telegram_username : "GreenHouse682";
            const url = `https://t.me/${username}`;
            if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
            else window.open(url, "_blank");
        });

        els.channelBtn.addEventListener("click", () => {
            const link = state.config && state.config.admin ? state.config.admin.channel_link : "https://t.me/+my0XrYsNth80OGE0";
            if (tg && tg.openLink) tg.openLink(link);
            else window.open(link, "_blank");
        });

        els.reviewForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const author = sanitize(els.reviewAuthor.value || "");
            const stars = Math.max(1, Math.min(5, parseInt(els.reviewStars.value, 10) || 5));
            const message = sanitize(els.reviewMessage.value || "");
            if (!author || !message) {
                alert(t("alertReview"));
                return;
            }
            void addReview(author, stars, message);
            els.reviewForm.reset();
            els.reviewStars.value = "5";
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
            if (!state.selectedProduct || !state.selectedQty || !state.selectedPrice) {
                alert(t("alertSelectQty"));
                return;
            }
            addToCart(state.selectedProduct, state.selectedQty, state.selectedPrice);
            closeProductDetail();
        });

        if (els.detailMuteBtn) {
            els.detailMuteBtn.addEventListener("click", toggleActiveVideoMute);
        }

        if (els.detailTeleBtn) {
            els.detailTeleBtn.addEventListener("click", () => {
                const username = state.config && state.config.admin ? state.config.admin.telegram_username : "GreenHouse682";
                const productName = state.selectedProduct ? sanitize(state.selectedProduct.name) : "product";
                const url = `https://t.me/${username}?text=${encodeURIComponent(t("askProduct", { name: productName }))}`;
                if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
                else window.open(url, "_blank");
            });
        }

        els.detailOverlay.addEventListener("click", (e) => {
            if (e.target === els.detailOverlay) closeProductDetail();
        });

        if (els.languageGrid) {
            els.languageGrid.addEventListener("click", (event) => {
                const target = event.target.closest(".lang-option");
                if (!target) return;
                const nextLang = target.dataset.lang;
                if (!["fr", "en", "de"].includes(nextLang)) return;
                if (nextLang === state.language) return;
                state.language = nextLang;
                renderLanguageSelection();
                applyTranslations();
                saveLocal();
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

        els.adminTabBtns.forEach((btn) => {
            btn.addEventListener("click", () => switchAdminTab(btn.dataset.adminTab));
        });
    }

    // ===== ADMIN PANEL =====

    function openAdminPanel() {
        if (els.adminOverlay) {
            els.adminOverlay.style.display = "block";
            document.body.style.overflow = "hidden";
            switchAdminTab("reviews");
            loadAdminReviews();
        }
    }

    function closeAdminPanel() {
        if (els.adminOverlay) {
            els.adminOverlay.style.display = "none";
            document.body.style.overflow = "";
        }
    }

    function switchAdminTab(tabName) {
        els.adminTabBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.adminTab === tabName);
        });
        if (els.adminTabReviews) els.adminTabReviews.classList.toggle("active", tabName === "reviews");
        if (els.adminTabOrders) els.adminTabOrders.classList.toggle("active", tabName === "orders");
        if (els.adminTabProducts) els.adminTabProducts.classList.toggle("active", tabName === "products");
        if (els.adminTabCategories) els.adminTabCategories.classList.toggle("active", tabName === "categories");
        if (tabName === "orders") loadAdminOrders();
        if (tabName === "products") loadAdminProducts();
        if (tabName === "categories") loadAdminCategories();
    }

    function getAdminUsername() {
        const user = getTelegramUser();
        return user && user.username ? user.username : "";
    }

    async function loadAdminReviews() {
        if (!els.adminReviewsPending) return;
        els.adminReviewsPending.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            const resp = await fetch(`./reviews.json?t=${Date.now()}`, { cache: "no-store" });
            if (!resp.ok) {
                els.adminReviewsPending.innerHTML = `<div class="admin-empty">Aucun avis en attente ✓</div>`;
                return;
            }
            const data = await resp.json();
            const pending = Array.isArray(data.pending) ? data.pending : [];
            if (!pending.length) {
                els.adminReviewsPending.innerHTML = `<div class="admin-empty">Aucun avis en attente ✓</div>`;
                return;
            }
            els.adminReviewsPending.innerHTML = pending.map((r) => {
                const rawStars = Math.max(1, Math.min(5, r.stars || 5));
                const stars = "★".repeat(rawStars) + "☆".repeat(5 - rawStars);
                const date = new Date(r.timestamp || Date.now()).toLocaleString("fr-FR");
                const handle = r.telegramUsername ? ` · @${sanitize(r.telegramUsername)}` : "";
                return `
                    <div class="admin-review-card">
                        <div class="admin-review-header">
                            <span class="admin-review-author">${sanitize(r.author || "Anonyme")}</span>
                            <span class="admin-review-stars">${stars}</span>
                        </div>
                        <p class="admin-review-msg">${sanitize(r.message || "")}</p>
                        <div class="admin-review-meta">${date}${handle}</div>
                        <div class="admin-review-actions">
                            <button class="admin-btn-approve" data-ts="${r.timestamp}" type="button">✓ Approuver</button>
                            <button class="admin-btn-reject" data-ts="${r.timestamp}" type="button">✗ Refuser</button>
                        </div>
                    </div>
                `;
            }).join("");

            els.adminReviewsPending.querySelectorAll(".admin-btn-approve").forEach((btn) => {
                btn.addEventListener("click", () => adminApproveReview(Number(btn.dataset.ts)));
            });
            els.adminReviewsPending.querySelectorAll(".admin-btn-reject").forEach((btn) => {
                btn.addEventListener("click", () => adminRejectReview(Number(btn.dataset.ts)));
            });
        } catch (_) {
            els.adminReviewsPending.innerHTML = `<div class="admin-empty">Aucun avis en attente ✓</div>`;
        }
    }

    async function adminApproveReview(timestamp) {
        try {
            const resp = await fetchWriteApi("/admin/reviews/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), timestamp })
            });
            if (resp.ok) {
                await syncReviewsFromLocalApi();
                renderReviews();
                await loadAdminReviews();
            }
        } catch (_) {}
    }

    async function adminRejectReview(timestamp) {
        try {
            const resp = await fetchWriteApi("/admin/reviews/reject", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), timestamp })
            });
            if (resp.ok) await loadAdminReviews();
        } catch (_) {}
    }

    async function loadAdminOrders() {
        if (!els.adminOrdersAll) return;
        els.adminOrdersAll.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            const resp = await fetch(`./orders.json?t=${Date.now()}`, { cache: "no-store" });
            if (!resp.ok) {
                els.adminOrdersAll.innerHTML = `<div class="admin-empty">Aucune commande enregistrée.</div>`;
                return;
            }
            const data = await resp.json();
            // orders.json est un tableau direct, trié du plus récent au plus ancien
            const orders = Array.isArray(data) ? [...data].reverse() : [];
            if (!orders.length) {
                els.adminOrdersAll.innerHTML = `<div class="admin-empty">Aucune commande enregistrée.</div>`;
                return;
            }
            els.adminOrdersAll.innerHTML = `<button class="admin-refresh-btn" id="admin-orders-refresh-btn" type="button">↻ Actualiser</button>` +
                orders.map((o) => {
                    const date = new Date(o.timestamp || Date.now()).toLocaleString("fr-FR");
                    const typeLabel = o.type === "pickup" ? "Sur place" : "Livraison";
                    const user = o.telegramUsername ? `@${sanitize(o.telegramUsername)}` : (o.telegramUserId ? `ID ${o.telegramUserId}` : "Anonyme");
                    return `
                        <div class="admin-order-card">
                            <div class="admin-order-header">
                                <span class="admin-order-id">Commande #${o.id}</span>
                                <span class="admin-order-total">${toPrice(o.total).toFixed(2)} EUR</span>
                            </div>
                            <span class="admin-order-type">${typeLabel}</span>
                            <p class="admin-order-summary">${sanitize(o.summary || "")}</p>
                            <span class="admin-order-user">👤 ${user}</span>
                            <span class="admin-order-date">📅 ${date}</span>
                        </div>
                    `;
                }).join("");
            const refreshBtnEl = document.getElementById("admin-orders-refresh-btn");
            if (refreshBtnEl) refreshBtnEl.addEventListener("click", loadAdminOrders);
        } catch (_) {
            els.adminOrdersAll.innerHTML = `<div class="admin-empty">Aucune commande enregistrée.</div>`;
        }
    }

    async function persistOrderToServer(order) {
        try {
            await fetchWriteApi("/save-order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(order)
            });
        } catch (_) {}
    }

    // ===== ADMIN PRODUITS =====

    async function loadAdminProducts() {
        if (!els.adminProductsContent) return;
        els.adminProductsContent.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            let cfg = state.config && typeof state.config === "object" ? state.config : null;
            const cfgResp = await fetch(`./config.json?t=${Date.now()}`, { cache: "no-store" });
            if (cfgResp.ok) {
                cfg = await cfgResp.json();
            }
            if (!cfg) throw new Error("config indisponible");
            const categories = cfg.categories || {};
            const products = cfg.products || {};
            const allProducts = [];
            for (const [catKey, prods] of Object.entries(products)) {
                for (const p of prods) allProducts.push({ ...p, category: catKey });
            }
            const catNames = {};
            for (const [key, cat] of Object.entries(categories)) catNames[key] = `${cat.emoji || ""} ${cat.name}`;
            let html = `<button class="admin-add-btn" id="admin-add-product-btn" type="button">+ Ajouter un produit</button>`;
            if (!allProducts.length) {
                html += `<div class="admin-empty">Aucun produit.</div>`;
            } else {
                html += allProducts.map((p) => `
                    <div class="admin-product-card">
                        <div class="admin-product-header">
                            <span class="admin-product-name">${sanitize(p.name || "")}</span>
                            <span class="admin-product-price">${(p.price || 0).toFixed(2)} €</span>
                        </div>
                        <span class="admin-product-cat">${sanitize(catNames[p.category] || p.category)}</span>
                        <div class="admin-review-actions">
                            <button class="admin-btn-edit" data-pid="${p.id}" type="button">✏️ Modifier</button>
                            <button class="admin-btn-reject" data-pid="${p.id}" type="button">🗑 Supprimer</button>
                        </div>
                    </div>`).join("");
            }
            els.adminProductsContent.innerHTML = html;
            const addBtn = document.getElementById("admin-add-product-btn");
            if (addBtn) addBtn.addEventListener("click", () => showAdminProductForm(null, cfg));
            els.adminProductsContent.querySelectorAll(".admin-btn-edit[data-pid]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const pid = Number(btn.dataset.pid);
                    const product = allProducts.find((p) => p.id === pid);
                    if (product) showAdminProductForm(product, cfg);
                });
            });
            els.adminProductsContent.querySelectorAll(".admin-btn-reject[data-pid]").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    if (!confirm("Supprimer ce produit ?")) return;
                    await adminDeleteProduct(Number(btn.dataset.pid));
                });
            });
        } catch (_) {
            els.adminProductsContent.innerHTML = `<div class="admin-empty">Impossible de charger les produits.<br>Réessaie dans quelques secondes.</div>`;
        }
    }

    function showAdminProductForm(product, cfg) {
        const categories = cfg.categories || {};
        const isEdit = !!product;
        const catOptions = Object.entries(categories).map(([key, cat]) =>
            `<option value="${sanitize(key)}" ${product && product.category === key ? "selected" : ""}>${sanitize(cat.emoji || "")} ${sanitize(cat.name)}</option>`
        ).join("");
        const customPricesStr = product && product.customPrices ? JSON.stringify(product.customPrices, null, 2) : "";
        const formHtml = `
            <div class="admin-form-wrap">
                <button class="admin-form-back-btn" id="admin-product-form-back" type="button">← Retour</button>
                <h3 class="admin-form-title">${isEdit ? "✏️ Modifier le produit" : "➕ Nouveau produit"}</h3>
                <form id="admin-product-form" autocomplete="off">
                    <label class="admin-label">Nom *<input class="admin-input" id="apf-name" type="text" maxlength="100" value="${sanitize(product ? product.name : "")}" required></label>
                    <label class="admin-label">Description<textarea class="admin-input admin-textarea" id="apf-desc" maxlength="500">${sanitize(product ? (product.description || "") : "")}</textarea></label>
                    <label class="admin-label">Catégorie *<select class="admin-input" id="apf-cat">${catOptions}</select></label>
                    <label class="admin-label">Prix de base (€) *<input class="admin-input" id="apf-price" type="number" step="0.01" min="0" value="${product ? (product.price || 0) : ""}" required></label>
                    <label class="admin-label">Prix personnalisés (JSON)<span class="admin-hint">Ex: {"1.5": 20, "3.5": 50, "10": 110}</span><textarea class="admin-input admin-textarea" id="apf-custom" rows="4">${customPricesStr}</textarea></label>
                    <label class="admin-label">Image (URL)<input class="admin-input" id="apf-img" type="text" value="${sanitize(product ? (product.image || "") : "")}"></label>
                    <label class="admin-label">Vidéo (URL, optionnel)<input class="admin-input" id="apf-video" type="text" value="${sanitize(product ? (product.video || "") : "")}"></label>
                    <label class="admin-label">Emoji<input class="admin-input" id="apf-emoji" type="text" maxlength="8" value="${sanitize(product ? (product.emoji || "📦") : "📦")}"></label>
                    <div class="admin-check-row">
                        <label class="admin-check-label"><input type="checkbox" id="apf-new" ${product && product.isNew ? "checked" : ""}> Nouveau</label>
                        <label class="admin-check-label"><input type="checkbox" id="apf-promo" ${product && product.isPromo ? "checked" : ""}> Promo</label>
                    </div>
                    ${isEdit ? `<input type="hidden" id="apf-id" value="${product.id}">` : ""}
                    <button class="admin-form-submit" type="submit">${isEdit ? "💾 Sauvegarder" : "➕ Ajouter"}</button>
                </form>
            </div>`;
        if (els.adminProductsContent) els.adminProductsContent.innerHTML = formHtml;
        document.getElementById("admin-product-form-back").addEventListener("click", loadAdminProducts);
        document.getElementById("admin-product-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const nameVal = document.getElementById("apf-name").value.trim();
            const catVal = document.getElementById("apf-cat").value;
            const priceVal = parseFloat(document.getElementById("apf-price").value) || 0;
            if (!nameVal || !catVal) return;
            let customPrices = {};
            const cpRaw = document.getElementById("apf-custom").value.trim();
            if (cpRaw) { try { customPrices = JSON.parse(cpRaw); } catch (_) { alert("Prix personnalisés: JSON invalide"); return; } }
            const productData = {
                name: nameVal,
                description: document.getElementById("apf-desc").value.trim(),
                category: catVal,
                price: priceVal,
                customPrices,
                image: document.getElementById("apf-img").value.trim(),
                video: document.getElementById("apf-video").value.trim(),
                emoji: document.getElementById("apf-emoji").value.trim() || "📦",
                isNew: document.getElementById("apf-new").checked,
                isPromo: document.getElementById("apf-promo").checked,
            };
            const idEl = document.getElementById("apf-id");
            if (idEl) productData.id = Number(idEl.value);
            await adminSaveProduct(productData);
        });
    }

    async function adminSaveProduct(productData) {
        try {
            const resp = await fetchWriteApi("/admin/products/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), product: productData })
            }, true);
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                await loadConfig();
                renderCategories();
                renderProducts();
                await loadAdminProducts();
            } else {
                alert((data && data.error) || `Erreur lors de la sauvegarde (HTTP ${resp.status}).`);
            }
        } catch (error) {
            alert("Impossible de contacter le serveur.");
        }
    }

    async function adminDeleteProduct(productId) {
        try {
            const resp = await fetchWriteApi("/admin/products/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), product_id: productId })
            }, true);
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                await loadConfig();
                renderCategories();
                renderProducts();
                await loadAdminProducts();
            } else {
                alert((data && data.error) || `Erreur lors de la suppression (HTTP ${resp.status}).`);
            }
        } catch (error) {
            alert("Impossible de contacter le serveur.");
        }
    }

    // ===== ADMIN CATÉGORIES =====

    async function loadAdminCategories() {
        if (!els.adminCategoriesContent) return;
        els.adminCategoriesContent.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            let cfg = state.config && typeof state.config === "object" ? state.config : null;
            const cfgResp = await fetch(`./config.json?t=${Date.now()}`, { cache: "no-store" });
            if (cfgResp.ok) {
                cfg = await cfgResp.json();
            }
            if (!cfg) throw new Error("config indisponible");
            const categories = cfg.categories || {};
            const products = cfg.products || {};
            let html = `<button class="admin-add-btn" id="admin-add-cat-btn" type="button">+ Ajouter une catégorie</button>`;
            const catEntries = Object.entries(categories);
            if (!catEntries.length) {
                html += `<div class="admin-empty">Aucune catégorie.</div>`;
            } else {
                html += catEntries.map(([key, cat]) => {
                    const count = (products[key] || []).length;
                    return `
                    <div class="admin-product-card">
                        <div class="admin-product-header">
                            <span class="admin-product-name">${sanitize(cat.emoji || "")} ${sanitize(cat.name || key)}</span>
                            <span class="admin-product-price">${count} produit${count !== 1 ? "s" : ""}</span>
                        </div>
                        <span class="admin-cat-key">clé: ${sanitize(key)}</span>
                        <div class="admin-review-actions">
                            <button class="admin-btn-edit" data-ckey="${sanitize(key)}" type="button">✏️ Modifier</button>
                            <button class="admin-btn-reject" data-ckey="${sanitize(key)}" type="button">🗑 Supprimer</button>
                        </div>
                    </div>`;
                }).join("");
            }
            els.adminCategoriesContent.innerHTML = html;
            const addBtn = document.getElementById("admin-add-cat-btn");
            if (addBtn) addBtn.addEventListener("click", () => showAdminCategoryForm(null, null));
            els.adminCategoriesContent.querySelectorAll(".admin-btn-edit[data-ckey]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const key = btn.dataset.ckey;
                    const cat = categories[key];
                    if (cat) showAdminCategoryForm(key, cat);
                });
            });
            els.adminCategoriesContent.querySelectorAll(".admin-btn-reject[data-ckey]").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const key = btn.dataset.ckey;
                    const count = (products[key] || []).length;
                    const msg = count > 0 ? `Supprimer "${key}" et ses ${count} produit(s) ?` : `Supprimer la catégorie "${key}" ?`;
                    if (!confirm(msg)) return;
                    await adminDeleteCategory(key);
                });
            });
        } catch (_) {
            els.adminCategoriesContent.innerHTML = `<div class="admin-empty">Impossible de charger les catégories.<br>Réessaie dans quelques secondes.</div>`;
        }
    }

    function showAdminCategoryForm(key, cat) {
        const isEdit = !!key;
        const formHtml = `
            <div class="admin-form-wrap">
                <button class="admin-form-back-btn" id="admin-cat-form-back" type="button">← Retour</button>
                <h3 class="admin-form-title">${isEdit ? "✏️ Modifier la catégorie" : "➕ Nouvelle catégorie"}</h3>
                <form id="admin-cat-form" autocomplete="off">
                    ${isEdit
                        ? `<input type="hidden" id="acf-key" value="${sanitize(key)}">`
                        : `<label class="admin-label">Clé (slug) *<span class="admin-hint">Minuscules, pas d'espaces (ex: hash)</span><input class="admin-input" id="acf-key" type="text" maxlength="30" required></label>`
                    }
                    <label class="admin-label">Nom *<input class="admin-input" id="acf-name" type="text" maxlength="50" value="${sanitize(cat ? cat.name : "")}" required></label>
                    <label class="admin-label">Emoji<input class="admin-input" id="acf-emoji" type="text" maxlength="8" value="${sanitize(cat ? (cat.emoji || "📦") : "📦")}"></label>
                    <label class="admin-label">Description<input class="admin-input" id="acf-desc" type="text" maxlength="200" value="${sanitize(cat ? (cat.description || "") : "")}"></label>
                    <button class="admin-form-submit" type="submit">${isEdit ? "💾 Sauvegarder" : "➕ Ajouter"}</button>
                </form>
            </div>`;
        if (els.adminCategoriesContent) els.adminCategoriesContent.innerHTML = formHtml;
        document.getElementById("admin-cat-form-back").addEventListener("click", loadAdminCategories);
        document.getElementById("admin-cat-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const catKey = document.getElementById("acf-key").value.trim().toLowerCase().replace(/\s+/g, "_");
            const catName = document.getElementById("acf-name").value.trim();
            if (!catKey || !catName) return;
            await adminSaveCategory({
                key: catKey,
                name: catName,
                emoji: document.getElementById("acf-emoji").value.trim() || "📦",
                description: document.getElementById("acf-desc").value.trim(),
            });
        });
    }

    async function adminSaveCategory(catData) {
        try {
            const resp = await fetchWriteApi("/admin/categories/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), ...catData })
            }, true);
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                await loadConfig();
                renderCategories();
                renderProducts();
                await loadAdminCategories();
            } else {
                alert((data && data.error) || `Erreur lors de la sauvegarde (HTTP ${resp.status}).`);
            }
        } catch (error) {
            alert("Impossible de contacter le serveur.");
        }
    }

    async function adminDeleteCategory(key) {
        try {
            const resp = await fetchWriteApi("/admin/categories/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tg_username: getAdminUsername(), key })
            }, true);
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                await loadConfig();
                renderCategories();
                renderProducts();
                await loadAdminCategories();
            } else {
                alert((data && data.error) || `Erreur lors de la suppression (HTTP ${resp.status}).`);
            }
        } catch (error) {
            alert("Impossible de contacter le serveur.");
        }
    }

    // ===== FIN ADMIN PANEL =====

    async function bootstrap() {
        if (!isTelegramMobileClient()) {
            renderDesktopBlockedScreen();
            return;
        }

        try {
            await loadConfig();
            loadLocal();
            await syncReviewsFromLocalApi();
            renderUser();
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
        } catch (error) {
            document.body.innerHTML = `<div style="padding:20px;color:#fff">Erreur: ${sanitize(error.message)}</div>`;
            return;
        }

        setTimeout(() => {
            document.body.classList.add("app-ready");
        }, 900);
    }

    document.addEventListener("DOMContentLoaded", bootstrap);
})();
