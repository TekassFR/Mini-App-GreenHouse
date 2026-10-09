(function () {
    "use strict";

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    const introTitle = document.querySelector(".intro-card h1");
    if (introTitle) {
        const letters = [...introTitle.textContent.trim()].map((ch, i) => {
            const span = document.createElement("span");
            span.textContent = ch === " " ? " " : ch;
            span.style.setProperty("--i", i);
            return span;
        });
        introTitle.replaceChildren(...letters);
        introTitle.classList.add("split");
    }

    function applyBrandColor() {
        const meta = document.querySelector('meta[name="brand-color"]');
        const hex = meta ? meta.content.trim() : "";
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

    applyBrandColor();

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

    // URL de repli locale (vide par défaut, la configuration Neon admin_settings.api_base prévaut)
    const LOCAL_API_BASE = "";

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
        } catch (_) { }
    }

    function getWriteApiBases() {
        const configuredBase = state && state.config && state.config.admin && state.config.admin.api_base
            ? normalizeApiBase(state.config.admin.api_base)
            : "";
        const storedBase = getStoredWriteApiBase();
        const originBase = window.location && /^https?:/i.test(String(window.location.origin || ""))
            ? normalizeApiBase(window.location.origin)
            : "";

        return Array.from(new Set([configuredBase, storedBase, originBase].filter(b => typeof b === "string" && b !== "" && !b.includes("ngrok"))));
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
        const reqHeaders = Object.assign({ "ngrok-skip-browser-warning": "69420" }, (options && options.headers) || {});
        const reqOpts = Object.assign({}, options || {}, { headers: reqHeaders });
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
        adminTabSettings: document.getElementById("admin-tab-settings"),
        adminProductsContent: document.getElementById("admin-products-content"),
        adminCategoriesContent: document.getElementById("admin-categories-content"),
        adminSettingsContent: document.getElementById("admin-settings-content"),

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
        detailFullscreenBtn: document.getElementById("detail-fullscreen-btn"),
        detailTeleBtn: document.getElementById("detail-tele-btn")
    };

    function getPrimaryTelegramUsername() {
        if (!state.config || !state.config.admin || !state.config.admin.telegram_username) {
            return "GreenHouse682"; // Valeur par défaut si la configuration n'est pas disponible
        }
        const parts = state.config.admin.telegram_username.split(/[\s,]+/);
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
        return state.adminVerified === true;
    }

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
        updateCartBadge();
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
        updateCartBadge();
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

    async function persistReviewToLocalApi(review) {
        try {
            const resp = await fetchWriteApi("/save-review", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, review, { init_data: getAdminInitData() }))
            });
            return resp.ok;
        } catch (_) {
            return false;
        }
    }

    async function loadConfig() {
        const bases = getWriteApiBases();
        let cfg = null;

        // 1. Charger la configuration LIVE depuis le serveur VPS (ngrok)
        for (const base of bases) {
            if (!base) continue;
            try {
                const resp = await fetchWithTimeout(`${base}/config?t=${Date.now()}`, { cache: "no-store" }, 4000);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && typeof data === "object" && (data.products || data.categories || data.restaurant)) {
                        cfg = data;
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

        // 3. Si toujours rien: garder le state actuel si déjà chargé (évite d'écraser avec données figées)
        if (!cfg) {
            if (state.config && typeof state.config === "object") {
                return;
            }
            // Dernier recours absolu: config.json statique Vercel
            try {
                const resp = await fetchWithTimeout(`./config.json?t=${Date.now()}`, { cache: "no-store" }, 3000);
                if (resp.ok) cfg = await resp.json();
            } catch (_) {}
            if (!cfg) throw new Error("Impossible de charger la boutique, réessaie dans un instant.");
        }

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

        const adminUserRaw = state.config && state.config.admin ? state.config.admin.telegram_username : "GreenHouse682";
        const formattedAdmins = adminUserRaw.split(/[\s,]+/).map((u) => `@${u}`).join(" / ");
        els.infoContactUsername.textContent = `Telegram: ${formattedAdmins}`;

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
                return `<button class="category-tab-btn ${active}" data-category="${sanitize(catId)}" role="tab" aria-selected="${state.category === catId ? "true" : "false"}">
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
        const rawImg = cleanMediaUrl(product.image || "", "image");
        const rawVideo = cleanMediaUrl(product.video || "", "video");
        const name = sanitize(product.name || "Product");
        const desc = sanitize(product.description || "");
        const categoryMeta = getCategoryMeta(product.category);
        const categoryName = sanitize(categoryMeta.name || product.category || "Categorie");
        const shortDesc = desc || categoryName;
        const start = getStartingPrice(product);

        let badge = "";
        if (product.isNew) badge = `<span class="badge new">${t("badgeNew")}</span>`;
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
            <article class="product-card" data-product-id="${product.id}">
                <div class="product-media">
                    ${mediaHtml}
                    ${badge}
                    ${videoBadge}
                </div>
                <div class="product-body">
                    <h3 class="product-title">${name}</h3>
                    <p class="product-desc">${shortDesc}</p>
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
            if (isActive) document.getElementById("bottom-nav").style.setProperty("--nav-index", index);
        });

        const previousPage = document.body.dataset.page;
        if (previousPage && previousPage !== pageName && tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        document.body.dataset.page = pageName;
        window.scrollTo(0, 0);

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
            els.historyList.innerHTML = `<div class="card panel empty-state" data-emoji="🧾">${t("noOrder")}</div>`;
            return;
        }

        const html = state.orders
            .slice()
            .reverse()
            .map((order) => {
                const date = new Date(order.timestamp).toLocaleString(getLocaleCode());
                const orderTypeText = order.type === "pickup" ? t("pickup") : t("delivery");
                return `
                    <article class="card panel order-card">
                        <div class="order-card-head">
                            <h3>${t("orderWord")} #${order.id}</h3>
                            <span class="order-card-total">${formatEUR(order.total)}</span>
                        </div>
                        <p class="muted">${date} · ${orderTypeText}</p>
                        <p class="order-card-summary">${sanitize(order.summary)}</p>
                    </article>
                `;
            })
            .join("");

        els.historyList.innerHTML = html;
    }

    function renderReviews() {
        if (!state.reviews.length) {
            els.reviewList.innerHTML = `<div class="card panel empty-state" data-emoji="💬">${t("noReview")}</div>`;
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
                    <div class="review-item-head">
                        <h4>${sanitize(r.author)}</h4>
                        <span class="review-item-stars">${"★".repeat(r.stars)}<span class="off">${"★".repeat(5 - r.stars)}</span></span>
                    </div>
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
        const shopCfg = state.config || {};
        if (els.brandSubtitle) els.brandSubtitle.textContent = (shopCfg.restaurant && shopCfg.restaurant.slogan) || t("brandSubtitle");
        if (!els.tickerDefault && els.tickerTexts[0]) els.tickerDefault = els.tickerTexts[0].textContent;
        const tickerText = shopCfg.admin && shopCfg.admin.ticker_text ? `${shopCfg.admin.ticker_text} ✦` : els.tickerDefault;
        els.tickerTexts.forEach((span) => { span.textContent = tickerText; });

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

        const apiBase = (state && state.config && state.config.admin && state.config.admin.api_base) || getStoredWriteApiBase() || "";
        const cleanBase = apiBase.replace(/\/+$/, "");

        const candidates = [];
        if (url.startsWith("/uploads/")) {
            if (cleanBase && !cleanBase.includes("ngrok")) {
                candidates.push(`${cleanBase}${url}`);
            }
            candidates.push(url);
        } else if (/^https?:\/\//i.test(url)) {
            candidates.push(url);
            const m = url.match(/\/uploads\/[^\/?#]+/i);
            if (m) {
                if (cleanBase && !cleanBase.includes("ngrok")) candidates.push(`${cleanBase}${m[0]}`);
                candidates.push(m[0]);
            }
        } else {
            candidates.push(url);
        }

        const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
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

        const apiBase = (state && state.config && state.config.admin && state.config.admin.api_base) || getStoredWriteApiBase() || "";
        const cleanBase = apiBase.replace(/\/+$/, "");

        const candidates = [];
        if (cleanUrl.startsWith("/uploads/")) {
            if (cleanBase && !cleanBase.includes("ngrok")) {
                candidates.push(`${cleanBase}${cleanUrl}`);
            }
            candidates.push(cleanUrl);
        } else if (/^https?:\/\//i.test(cleanUrl)) {
            candidates.push(cleanUrl);
            const m = cleanUrl.match(/\/uploads\/[^\/?#]+/i);
            if (m) {
                if (cleanBase && !cleanBase.includes("ngrok")) candidates.push(`${cleanBase}${m[0]}`);
                candidates.push(m[0]);
            }
        } else {
            candidates.push(cleanUrl);
        }

        const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));
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

        // Convertir les liens absolus ngrok / cloudflare en /uploads/ (relayés proprement par Vercel sans avertissement)
        if (/^https?:\/\/[^\/]*(ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i.test(s)) {
            s = s.replace(/^https?:\/\/[^\/]*(ngrok|cloudflare|trycloudflare)[^\/]*\/uploads\//i, "/uploads/");
        }

        return s;
    }

    function buildMediaSlides(product) {
        const slides = [];
        const gallery = Array.isArray(product.gallery) ? product.gallery : [];
        const cleanImg = cleanMediaUrl(product.image || "", "image");
        const cleanVid = cleanMediaUrl(product.video || "", "video");

        gallery.forEach((item) => {
            if (!item) return;
            if (typeof item === "string") {
                const c = cleanMediaUrl(item, "image");
                if (c) slides.push({ type: c.startsWith("data:video/") ? "video" : "image", src: sanitize(c) });
                return;
            }
            const type = item.type === "video" ? "video" : "image";
            const src = type === "video" ? getPlayableVideo(cleanMediaUrl(item.src || "", "video")) : sanitize(cleanMediaUrl(item.src || "", "image"));
            if (!src) return;
            if (type === "video") {
                const fallbackThumb = sanitize(cleanImg);
                const thumb = sanitize(cleanMediaUrl(item.thumb || item.poster || getVideoPreviewImage(src) || fallbackThumb, "image"));
                slides.push({ type, src, thumb, fallbackThumb });
                return;
            }
            slides.push({ type, src });
        });

        const videoUrl = getPlayableVideo(cleanVid);
        if (videoUrl) {
            const fallbackThumb = sanitize(cleanImg);
            const thumb = sanitize(cleanMediaUrl(getVideoPreviewImage(videoUrl) || fallbackThumb, "image"));
            slides.push({ type: "video", src: videoUrl, thumb, fallbackThumb });
        }
        if (cleanImg && !cleanImg.startsWith("data:video/")) {
            slides.push({ type: "image", src: sanitize(cleanImg) });
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
        state.selectedPrice = 0;
        state.detailMedia = "image";
        detailSlides = buildMediaSlides(product);
        detailSlideIndex = 0;

        const categoryMeta = getCategoryMeta(product.category);
        els.detailName.textContent = sanitize(product.name || "Product");
        els.detailDescription.textContent = sanitize(product.description || "");
        els.detailCategoryChip.textContent = `${sanitize(categoryMeta.emoji || "📦")} ${sanitize(categoryMeta.name || product.category)}`;
        if (product.image) {
            attachImageSource(els.detailBrandImage, product.image);
        } else {
            els.detailBrandImage.src = "";
            els.detailBrandImage.style.display = "none";
        }

        renderDetailQuantities(product);
        els.detailOverlay.scrollTop = 0;
        els.detailOverlay.style.display = "block";
        document.body.style.overflow = "hidden";
        document.body.classList.add("detail-open");

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
    }

    function showToast(message) {
        const existing = document.getElementById("gh-toast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.id = "gh-toast";
        toast.className = "gh-toast";
        toast.innerHTML = `
            <span class="toast-icon">✓</span>
            <span class="toast-message">${message}</span>
        `;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add("visible");
        });

        setTimeout(() => {
            toast.classList.remove("visible");
            toast.addEventListener("transitionend", () => {
                toast.remove();
            }, { once: true });
        }, 2500);
    }

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
                <h3 class="gh-modal-title">${sanitize(title)}</h3>
                <div class="gh-modal-message">${message}</div>
                <div class="gh-modal-actions">
                    <button type="button" class="gh-modal-btn gh-modal-btn-cancel" id="gh-modal-cancel">${sanitize(cancelText)}</button>
                    <button type="button" class="gh-modal-btn gh-modal-btn-confirm ${isDanger ? 'danger' : ''}" id="gh-modal-confirm">${sanitize(confirmText)}</button>
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

        const username = getPrimaryTelegramUsername();
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
            const username = getPrimaryTelegramUsername();
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
            if (!state.selectedProduct || !state.selectedQty || !state.selectedPrice) {
                alert(t("alertSelectQty"));
                return;
            }
            addToCart(state.selectedProduct, state.selectedQty, state.selectedPrice);
            const name = sanitize(state.selectedProduct.name);
            const qty = state.selectedQty;
            showToast(`${name} (${qty}G) ajouté au panier ! 🛒`);
            closeProductDetail();
        });

        if (els.detailMuteBtn) {
            els.detailMuteBtn.addEventListener("click", toggleActiveVideoMute);
        }

        if (els.detailTeleBtn) {
            els.detailTeleBtn.addEventListener("click", () => {
                const username = getPrimaryTelegramUsername();
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
            const isActive = btn.dataset.adminTab === tabName;
            btn.classList.toggle("active", isActive);
            if (isActive) btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        });
        if (els.adminTabReviews) els.adminTabReviews.classList.toggle("active", tabName === "reviews");
        if (els.adminTabOrders) els.adminTabOrders.classList.toggle("active", tabName === "orders");
        if (els.adminTabProducts) els.adminTabProducts.classList.toggle("active", tabName === "products");
        if (els.adminTabCategories) els.adminTabCategories.classList.toggle("active", tabName === "categories");
        if (els.adminTabSettings) els.adminTabSettings.classList.toggle("active", tabName === "settings");

        if (tabName === "reviews") loadAdminReviews();
        if (tabName === "orders") loadAdminOrders();
        if (tabName === "products") loadAdminProducts();
        if (tabName === "categories") loadAdminCategories();
        if (tabName === "settings") loadAdminSettings();
    }

    function getAdminInitData() {
        return (tg && tg.initData) || "";
    }

    async function loadAdminReviews() {
        if (!els.adminReviewsPending) return;
        els.adminReviewsPending.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            const resp = await fetch(`./reviews.json?t=${Date.now()}`, { cache: "no-store" });
            let pending = [];
            let approved = [];
            if (resp.ok) {
                const data = await resp.json();
                pending = Array.isArray(data.pending) ? data.pending : [];
                approved = Array.isArray(data.approved) ? data.approved : [];
            }

            let html = "";
            if (pending.length > 0) {
                html += `<h4 class="admin-section-title">En attente · ${pending.length}</h4>`;
                html += pending.map((r) => {
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
                                <button class="admin-btn-approve" data-ts="${r.timestamp}" type="button">Publier</button>
                                <button class="admin-btn-reject" data-ts="${r.timestamp}" type="button">Refuser</button>
                            </div>
                        </div>
                    `;
                }).join("");
            } else {
                html += `<div class="admin-empty">Aucun avis en attente</div>`;
            }

            if (approved.length > 0) {
                html += `<h4 class="admin-section-title">Publiés · ${approved.length}</h4>`;
                html += approved.slice().reverse().map((r) => {
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
                            <button class="admin-btn-delete-approved" data-ts="${r.timestamp}" type="button">Retirer de la boutique</button>
                        </div>
                    `;
                }).join("");
            }

            els.adminReviewsPending.innerHTML = html;

            els.adminReviewsPending.querySelectorAll(".admin-btn-approve").forEach((btn) => {
                btn.addEventListener("click", () => adminApproveReview(Number(btn.dataset.ts)));
            });
            els.adminReviewsPending.querySelectorAll(".admin-btn-reject").forEach((btn) => {
                btn.addEventListener("click", () => adminRejectReview(Number(btn.dataset.ts)));
            });
            els.adminReviewsPending.querySelectorAll(".admin-btn-delete-approved").forEach((btn) => {
                btn.addEventListener("click", () => adminDeleteApprovedReview(Number(btn.dataset.ts)));
            });
        } catch (_) {
            els.adminReviewsPending.innerHTML = `<div class="admin-empty">Erreur chargement des avis.</div>`;
        }
    }

    async function adminApproveReview(timestamp) {
        try {
            const resp = await fetchWriteApi("/admin/reviews/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), timestamp })
            });
            if (resp.ok) {
                showToast("Avis approuvé et publié ! ⭐");
                await syncReviewsFromLocalApi();
                renderReviews();
                await loadAdminReviews();
            }
        } catch (_) {
            showToast("Erreur lors de l'approbation");
        }
    }

    async function adminRejectReview(timestamp) {
        try {
            const resp = await fetchWriteApi("/admin/reviews/reject", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), timestamp })
            });
            if (resp.ok) {
                showToast("Avis refusé");
                await loadAdminReviews();
            }
        } catch (_) {
            showToast("Erreur lors du refus");
        }
    }

    async function adminDeleteApprovedReview(timestamp) {
        if (!confirm("Supprimer cet avis publié ?")) return;
        try {
            const resp = await fetchWriteApi("/admin/reviews/delete-approved", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), timestamp })
            }, true);
            if (resp.ok) {
                showToast("Avis supprimé ! 🗑️");
                await syncReviewsFromLocalApi();
                renderReviews();
                await loadAdminReviews();
            }
        } catch (_) {
            showToast("Erreur lors de la suppression");
        }
    }

    async function loadAdminOrders() {
        if (!els.adminOrdersAll) return;
        els.adminOrdersAll.innerHTML = `<div class="admin-empty">Chargement des commandes...</div>`;
        try {
            let orders = [];
            try {
                const resp = await fetchWriteApi("/admin/orders", { headers: { "X-Telegram-Init-Data": getAdminInitData() } });
                if (resp && resp.ok) {
                    const data = await resp.json();
                    if (data && Array.isArray(data.orders)) {
                        orders = data.orders;
                    }
                }
            } catch (_) {}

            if (!orders.length) {
                try {
                    const resp = await fetch(`./orders.json?t=${Date.now()}`, { cache: "no-store" });
                    if (resp && resp.ok) {
                        const data = await resp.json();
                        if (Array.isArray(data)) orders = data;
                    }
                } catch (_) {}
            }

            if (!orders.length) {
                els.adminOrdersAll.innerHTML = `<div class="admin-empty">Aucune commande enregistrée.</div>`;
                return;
            }

            const sortedOrders = [...orders].reverse();
            els.adminOrdersAll.innerHTML = `<button class="admin-refresh-btn" id="admin-orders-refresh-btn" type="button">Actualiser</button>` +
                sortedOrders.map((o) => {
                    const date = new Date(o.timestamp || Date.now()).toLocaleString("fr-FR");
                    const typeLabel = o.type === "pickup" ? "Sur place" : "Livraison";
                    const user = o.telegramUsername || o.telegram_username ? `@${sanitize(o.telegramUsername || o.telegram_username)}` : (o.telegramUserId || o.telegram_user_id ? `ID ${o.telegramUserId || o.telegram_user_id}` : "Anonyme");
                    return `
                        <div class="admin-order-card">
                            <div class="admin-order-header">
                                <span class="admin-order-id">Commande #${o.id}</span>
                                <span class="admin-order-total">${toPrice(o.total).toFixed(2)} EUR</span>
                            </div>
                            <span class="admin-order-type">${typeLabel}</span>
                            <p class="admin-order-summary">${sanitize(o.summary || "")}</p>
                            <span class="admin-order-user">${user} · ${date}</span>
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
                body: JSON.stringify(Object.assign({}, order, { init_data: getAdminInitData() }))
            });
        } catch (_) { }
    }

    // ===== ADMIN PRODUITS =====

    async function loadAdminProducts() {
        if (!els.adminProductsContent) return;
        els.adminProductsContent.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            // Toujours recharger la config fraîche depuis le serveur
            await loadConfig();
            const cfg = state.config;
            if (!cfg) throw new Error("config indisponible");
            const categories = cfg.categories || {};
            const products = cfg.products || {};
            const catNames = {};
            for (const [key, cat] of Object.entries(categories)) catNames[key] = cat.name;

            let html = `<div class="admin-group"><button class="admin-add-btn" id="admin-add-product-btn" type="button">Ajouter un produit…</button></div>`;

            let totalProds = 0;
            for (const [catKey, prods] of Object.entries(products)) {
                if (!Array.isArray(prods) || !prods.length) continue;
                totalProds += prods.length;
                html += `<h4 class="admin-section-title">${sanitize(catNames[catKey] || catKey)} · ${prods.length}</h4><div class="admin-group">`;
                html += prods.map((p, idx) => {
                    const isFirst = idx === 0;
                    const isLast = idx === prods.length - 1;
                    const thumb = p.image ? `<img class="admin-product-thumb" src="${sanitize(p.image)}" alt="">` : `<span class="admin-product-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.2rem;">${sanitize(p.emoji || "📦")}</span>`;
                    const details = [`${(p.price || 0).toFixed(2)} €`, p.isPromo ? "Promo" : "", p.isNew ? "Nouveau" : ""].filter(Boolean).join(" · ");
                    return `
                    <div class="admin-product-card">
                        <div class="admin-reorder-btns">
                            <button class="admin-btn-reorder" data-pid="${p.id}" data-cat="${sanitize(catKey)}" data-dir="up" type="button" aria-label="Monter" ${isFirst ? "disabled" : ""}>▲</button>
                            <button class="admin-btn-reorder" data-pid="${p.id}" data-cat="${sanitize(catKey)}" data-dir="down" type="button" aria-label="Descendre" ${isLast ? "disabled" : ""}>▼</button>
                        </div>
                        <button class="admin-btn-edit" data-pid="${p.id}" type="button">
                            ${thumb}
                            <span class="admin-row-text">
                                <span class="admin-product-name">${sanitize(p.name || "")}</span>
                                <span class="admin-product-cat">${details}</span>
                            </span>
                            <span class="admin-chevron" aria-hidden="true"></span>
                        </button>
                    </div>`;
                }).join("") + `</div>`;
            }

            if (!totalProds) {
                html += `<div class="admin-empty">Aucun produit dans le catalogue.</div>`;
            }

            els.adminProductsContent.innerHTML = html;

            const allProductsList = [];
            for (const [catKey, prods] of Object.entries(products)) {
                if (Array.isArray(prods)) {
                    for (const p of prods) allProductsList.push({ ...p, category: catKey });
                }
            }

            const addBtn = document.getElementById("admin-add-product-btn");
            // { once: true } : le listener se supprime automatiquement après le 1er clic
            // Cela évite l'accumulation de listeners lors des re-rendus successifs
            if (addBtn) addBtn.addEventListener("click", () => showAdminProductForm(null, cfg), { once: true });

            els.adminProductsContent.querySelectorAll(".admin-btn-edit[data-pid]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const pid = String(btn.dataset.pid || "").trim();
                    const product = allProductsList.find((p) => String(p.id).trim() === pid);
                    if (product) showAdminProductForm(product, cfg);
                }, { once: true });
            });

            els.adminProductsContent.querySelectorAll(".admin-btn-reorder").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const pid = String(btn.dataset.pid || "").trim();
                    const cat = btn.dataset.cat;
                    const dir = btn.dataset.dir;
                    btn.disabled = true;
                    await adminReorderProduct(cat, pid, dir);
                }, { once: true });
            });

        } catch (_) {
            els.adminProductsContent.innerHTML = `<div class="admin-empty">Impossible de charger les produits.<br>Réessaie dans quelques secondes.</div>`;
        }
    }

    function applyUpdatedConfig(cfg) {
        if (cfg && typeof cfg === "object") {
            state.config = cfg;
            state.products = allProductsFromConfig(cfg);
            state.categories = Object.keys(cfg.categories || {});
        }
    }

    async function adminReorderProduct(category, productId, direction) {
        try {
            const resp = await fetchWriteApi("/admin/products/reorder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), category, product_id: productId, direction })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Ordre mis à jour ↕️");
                renderProducts();
                await loadAdminProducts();
            } else {
                showToast((data && data.error) || "Erreur réorganisation", "error");
            }
        } catch (_) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    // Le quick tunnel Cloudflare coupe les envois au-delà de 100 Mo : on refuse avant d'envoyer
    const MAX_UPLOAD_MB = 95;
    const SESSION_EXPIRED_MSG = "Session expirée : ferme et rouvre la mini-app, puis réessaie.";
    // Le serveur n'accepte l'initData Telegram que pendant 1 h après l'ouverture de la mini-app
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

    // Les fichiers partent uniquement vers le VPS par le tunnel : Vercel refuse les gros envois (404/413)
    function getUploadApiBase() {
        const configured = state.config && state.config.admin ? normalizeApiBase(state.config.admin.api_base) : "";
        return [configured, getStoredWriteApiBase()].find((b) => b && !b.includes("ngrok")) || "";
    }

    function uploadExtension(file) {
        const m = /\.([a-z0-9]{2,5})$/i.exec(file.name || "");
        return m ? m[1].toLowerCase() : (UPLOAD_EXT_BY_MIME[file.type] || "bin");
    }

    function uploadFileViaXhr(url, formData, onProgress, timeoutMs) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
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

    // Envoie le fichier au VPS et renvoie son chemin /uploads/… ; sinon lève une erreur au message lisible
    async function uploadMediaFile(file, onProgress) {
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
            throw new Error(`Fichier trop lourd : ${Math.ceil(file.size / (1024 * 1024))} Mo (${MAX_UPLOAD_MB} Mo max). Raccourcis la vidéo ou filme en 1080p.`);
        }
        if (adminSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
        const base = getUploadApiBase();
        if (!base) throw new Error("Serveur introuvable : ferme et rouvre la mini-app.");

        const formData = new FormData();
        formData.append("file", file, `up_${Date.now()}.${uploadExtension(file)}`);
        // 90 s de conversion côté serveur + l'envoi lui-même à 150 Ko/s au pire
        const timeoutMs = 90000 + Math.round(file.size / 150);
        return uploadFileViaXhr(`${base}/admin/upload`, formData, onProgress, timeoutMs);
    }

    // Bloque le champ fichier et le bouton d'enregistrement du formulaire tant qu'un envoi est en cours
    function setUploadBusy(fileInputEl, busy) {
        fileInputEl.disabled = busy;
        if (!busy) fileInputEl.value = "";
        const form = fileInputEl.closest("form");
        if (!form) return;
        const pending = Math.max(0, (Number(form.dataset.pendingUploads) || 0) + (busy ? 1 : -1));
        form.dataset.pendingUploads = String(pending);
        form.querySelectorAll('button[type="submit"]').forEach((btn) => { btn.disabled = pending > 0; });
    }

    async function handleAdminFileUpload(fileInputEl, targetUrlInputId, statusElId) {
        const file = fileInputEl.files && fileInputEl.files[0];
        if (!file) return;

        const statusEl = document.getElementById(statusElId);
        const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
        const isVideo = targetUrlInputId === "apf-video" || (file.type && file.type.startsWith("video/"));
        const kind = isVideo ? "vidéo" : "photo";
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);

        setUploadBusy(fileInputEl, true);
        setStatus(`⏳ Envoi ${kind} : 0% (0.0/${sizeMb} Mo)...`);
        try {
            const uploadedUrl = await uploadMediaFile(file, (percent, loadedMb, totalMb) => {
                if (percent < 99) setStatus(`⏳ Envoi ${kind} : ${percent}% (${loadedMb}/${totalMb} Mo)...`);
                else setStatus(isVideo ? "⚙️ Conversion de la vidéo sur le serveur..." : "⚙️ Enregistrement du fichier sur le serveur...");
            });
            const targetInput = document.getElementById(targetUrlInputId);
            if (targetInput) {
                targetInput.value = uploadedUrl;
                targetInput.dispatchEvent(new Event("input"));
            }
            setStatus(isVideo ? "✅ Vidéo envoyée, pense à enregistrer" : "✅ Photo envoyée, pense à enregistrer");
            showToast(isVideo ? "Vidéo envoyée ! 🎬" : "Photo envoyée ! 🚀");
        } catch (err) {
            setStatus(`❌ ${err.message}`);
            showToast(err.message, "error");
        } finally {
            setUploadBusy(fileInputEl, false);
        }
    }

    function parseCustomPricesInput(rawStr) {
        if (!rawStr || !rawStr.trim()) return {};
        const text = rawStr.trim();
        // 1. Si format JSON valide fourni par l'utilisateur
        if (text.startsWith("{")) {
            try { return JSON.parse(text); } catch (_) {}
        }
        // 2. Format simplifié ultra intuitif : "10: 80", "10 = 80", "10:80, 20:150"
        const result = {};
        const lines = text.split(/[\n,;]+/);
        for (const line of lines) {
            const parts = line.split(/[:=]+/).map(s => s.trim());
            if (parts.length === 2 && parts[0] && parts[1]) {
                const key = parts[0];
                const val = parseFloat(parts[1]);
                if (!isNaN(val)) {
                    result[key] = val;
                }
            }
        }
        return result;
    }

    function formatCustomPricesForEdit(cpObj) {
        if (!cpObj || typeof cpObj !== "object") return "";
        const entries = Object.entries(cpObj);
        if (!entries.length) return "";
        return entries.map(([qty, price]) => `${qty}: ${price}`).join("\n");
    }

    function showAdminProductForm(product, cfg) {
        const categories = cfg.categories || {};
        const isEdit = !!product;
        const catOptions = Object.entries(categories).map(([key, cat]) =>
            `<option value="${sanitize(key)}" ${product && product.category === key ? "selected" : ""}>${sanitize(cat.emoji || "")} ${sanitize(cat.name)}</option>`
        ).join("");
        const customPricesStr = product && product.customPrices ? formatCustomPricesForEdit(product.customPrices) : "";
        const formHtml = `
            <div class="admin-form-wrap">
                <button class="admin-form-back-btn" id="admin-product-form-back" type="button">‹ Produits</button>
                <h3 class="admin-form-title">${isEdit ? "Modifier le produit" : "Nouveau produit"}</h3>
                <form id="admin-product-form" autocomplete="off">
                    <label class="admin-label">Nom *<input class="admin-input" id="apf-name" type="text" maxlength="100" value="${sanitize(product ? product.name : "")}" required></label>
                    <label class="admin-label">Description<textarea class="admin-input admin-textarea" id="apf-desc" maxlength="500">${sanitize(product ? (product.description || "") : "")}</textarea></label>
                    <label class="admin-label">Catégorie *<select class="admin-input" id="apf-cat">${catOptions}</select></label>
                    <label class="admin-label">Prix de base (€) *<input class="admin-input" id="apf-price" type="number" step="0.01" min="0" value="${product ? (product.price || 0) : ""}" required></label>
                    <label class="admin-label">Prix par quantité<span class="admin-hint">Ex: 10: 80 (Quantité: Prix, une par ligne)</span><textarea class="admin-input admin-textarea" id="apf-custom" rows="4" placeholder="10: 80&#10;20: 150&#10;50: 350">${customPricesStr}</textarea></label>
                    
                    <div class="admin-field">
                        <span class="admin-field-label">Photo</span>
                        <input class="admin-input" id="apf-img" type="text" placeholder="Choisis une photo ci-dessous" value="${sanitize(product ? (product.image || "") : "")}">
                        <div class="admin-upload-box">
                            <label class="admin-upload-btn" for="apf-img-file">Choisir une photo…</label>
                            <input type="file" id="apf-img-file" accept="image/*" style="display:none;">
                            <span class="admin-upload-status" id="apf-img-status"></span>
                        </div>
                    </div>

                    <div class="admin-field">
                        <span class="admin-field-label">Vidéo (optionnel)</span>
                        <input class="admin-input" id="apf-video" type="text" placeholder="Choisis une vidéo ci-dessous (95 Mo max)" value="${sanitize(product ? (product.video || "") : "")}">
                        <div class="admin-upload-box">
                            <label class="admin-upload-btn" for="apf-video-file">Choisir une vidéo…</label>
                            <input type="file" id="apf-video-file" accept="video/*" style="display:none;">
                            <span class="admin-upload-status" id="apf-video-status"></span>
                        </div>
                        <div id="apf-video-preview" style="margin-top:8px;"></div>
                    </div>

                    <label class="admin-label">Emoji<input class="admin-input" id="apf-emoji" type="text" maxlength="8" value="${sanitize(product ? (product.emoji || "📦") : "📦")}"></label>
                    <div class="admin-toggles-grid">
                        <label class="admin-toggle-card toggle-new">
                            <input type="checkbox" id="apf-new" ${product && product.isNew ? "checked" : ""}>
                            <div class="toggle-card-body">
                                <div class="toggle-card-info">
                                    <div class="toggle-text-block">
                                        <span class="toggle-title">Nouveau</span>
                                        <span class="toggle-desc">Badge « Nouveau »</span>
                                    </div>
                                </div>
                                <div class="admin-switch"><span class="admin-switch-slider"></span></div>
                            </div>
                        </label>
                        <label class="admin-toggle-card toggle-promo">
                            <input type="checkbox" id="apf-promo" ${product && product.isPromo ? "checked" : ""}>
                            <div class="toggle-card-body">
                                <div class="toggle-card-info">
                                    <div class="toggle-text-block">
                                        <span class="toggle-title">Promo</span>
                                        <span class="toggle-desc">Badge « En promo »</span>
                                    </div>
                                </div>
                                <div class="admin-switch"><span class="admin-switch-slider"></span></div>
                            </div>
                        </label>
                    </div>
                    ${isEdit ? `<input type="hidden" id="apf-id" value="${product.id}">` : ""}
                    <button class="admin-form-submit" type="submit">${isEdit ? "Enregistrer" : "Ajouter le produit"}</button>
                </form>
                ${isEdit ? `<button class="admin-form-delete" id="apf-delete" type="button">Supprimer le produit</button>` : ""}
            </div>`;
        if (els.adminProductsContent) els.adminProductsContent.innerHTML = formHtml;
        document.getElementById("admin-product-form-back").addEventListener("click", loadAdminProducts);

        const deleteBtn = document.getElementById("apf-delete");
        if (deleteBtn) {
            deleteBtn.addEventListener("click", () => {
                showConfirmModal({
                    title: "Supprimer le produit ?",
                    emoji: product.emoji || "🗑️",
                    message: `Es-tu sûr de vouloir supprimer définitivement <strong>« ${sanitize(product.name || "")} »</strong> ? Cette action est irréversible.`,
                    confirmText: "Oui, supprimer",
                    cancelText: "Annuler",
                    isDanger: true,
                    onConfirm: async () => {
                        deleteBtn.disabled = true;
                        await adminDeleteProduct(String(product.id));
                    }
                });
            });
        }

        const imgFileInput = document.getElementById("apf-img-file");
        if (imgFileInput) {
            imgFileInput.addEventListener("change", function () {
                handleAdminFileUpload(this, "apf-img", "apf-img-status");
            });
        }

        const videoFileInput = document.getElementById("apf-video-file");
        if (videoFileInput) {
            videoFileInput.addEventListener("change", function () {
                handleAdminFileUpload(this, "apf-video", "apf-video-status");
            });
        }

        function updateAdminVideoPreview(val) {
            const previewEl = document.getElementById("apf-video-preview");
            if (!previewEl) return;
            const url = getPlayableVideo(String(val || "").trim());
            if (!url) {
                previewEl.innerHTML = "";
                return;
            }
            previewEl.innerHTML = `
                <div style="margin:4px 0 10px;">
                    <div style="font-size:0.75rem; color:var(--muted); margin-bottom:6px;">Aperçu</div>
                    <video id="apf-preview-video-el" controls playsinline webkit-playsinline style="width:100%; max-height:180px; border-radius:8px; background:#000; display:block;" onerror="this.parentElement.innerHTML='<div style=\\'color:#f87171;font-size:0.75rem;padding:6px;\\'>⚠️ Impossible de charger cette vidéo. Vérifie l\\'URL ou utilise un lien MP4 direct.</div>';"></video>
                </div>
            `;
            const vEl = document.getElementById("apf-preview-video-el");
            if (vEl) attachVideoSource(vEl, url);
        }

        const videoInputEl = document.getElementById("apf-video");
        if (videoInputEl) {
            videoInputEl.addEventListener("input", function () {
                updateAdminVideoPreview(this.value);
            });
            if (videoInputEl.value.trim()) {
                updateAdminVideoPreview(videoInputEl.value.trim());
            }
        }

        document.getElementById("admin-product-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const nameVal = document.getElementById("apf-name").value.trim();
            const catVal = document.getElementById("apf-cat").value;
            const priceVal = parseFloat(document.getElementById("apf-price").value) || 0;
            if (!nameVal || !catVal) return;
            const cpRaw = document.getElementById("apf-custom").value.trim();
            const customPrices = parseCustomPricesInput(cpRaw);
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
                body: JSON.stringify({ init_data: getAdminInitData(), product: productData })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Produit sauvegardé ! 📦");
                renderCategories();
                renderProducts();
                await loadAdminProducts();
            } else {
                showToast(resp.status === 403 ? SESSION_EXPIRED_MSG : (data && data.error) || `Erreur lors de la sauvegarde (HTTP ${resp.status}).`, "error");
            }
        } catch (error) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    let _deletingProductId = null; // garde anti-doublon global
    async function adminDeleteProduct(productId) {
        const pidStr = String(productId || "").trim();
        if (!pidStr || _deletingProductId === pidStr) return; // déjà en cours
        _deletingProductId = pidStr;
        try {
            const resp = await fetchWriteApi("/admin/products/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), product_id: pidStr })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success === true) {
                if (data.config) applyUpdatedConfig(data.config);
                showToast("Produit supprimé ! 🗑️");
                renderCategories();
                renderProducts();
                await loadAdminProducts();
            } else {
                showToast((data && data.error) || `Erreur suppression (HTTP ${resp.status}).`, "error");
            }
        } catch (error) {
            showToast("Connexion impossible, réessaie.", "error");
        } finally {
            _deletingProductId = null; // libérer le verrou
        }
    }

    // ===== ADMIN CATÉGORIES =====

    async function loadAdminCategories() {
        if (!els.adminCategoriesContent) return;
        els.adminCategoriesContent.innerHTML = `<div class="admin-empty">Chargement...</div>`;
        try {
            await loadConfig();
            const cfg = state.config;
            if (!cfg) throw new Error("config indisponible");
            const categories = cfg.categories || {};
            const products = cfg.products || {};
            let html = `<div class="admin-group"><button class="admin-add-btn" id="admin-add-cat-btn" type="button">Ajouter une catégorie…</button></div>`;
            const catEntries = Object.entries(categories);
            if (!catEntries.length) {
                html += `<div class="admin-empty">Aucune catégorie.</div>`;
            } else {
                html += `<h4 class="admin-section-title">Catégories · ${catEntries.length}</h4><div class="admin-group">` + catEntries.map(([key, cat]) => {
                    const count = (products[key] || []).length;
                    return `
                    <div class="admin-product-card">
                        <button class="admin-btn-edit" data-ckey="${sanitize(key)}" type="button">
                            <span class="admin-row-text"><span class="admin-product-name">${sanitize(cat.emoji || "")} ${sanitize(cat.name || key)}</span></span>
                            <span class="admin-row-value">${count} produit${count !== 1 ? "s" : ""}</span>
                            <span class="admin-chevron" aria-hidden="true"></span>
                        </button>
                    </div>`;
                }).join("") + `</div>`;
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
        } catch (_) {
            els.adminCategoriesContent.innerHTML = `<div class="admin-empty">Impossible de charger les catégories.<br>Réessaie dans quelques secondes.</div>`;
        }
    }

    function uniqueCategoryKey(name) {
        const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "categorie";
        const existing = (state.config && state.config.categories) || {};
        let candidate = base;
        let suffix = 2;
        while (existing[candidate]) candidate = `${base}_${suffix++}`;
        return candidate;
    }

    function showAdminCategoryForm(key, cat) {
        const isEdit = !!key;
        const formHtml = `
            <div class="admin-form-wrap">
                <button class="admin-form-back-btn" id="admin-cat-form-back" type="button">‹ Catégories</button>
                <h3 class="admin-form-title">${isEdit ? "Modifier la catégorie" : "Nouvelle catégorie"}</h3>
                <form id="admin-cat-form" autocomplete="off">
                    <input type="hidden" id="acf-key" value="${isEdit ? sanitize(key) : ""}">
                    <label class="admin-label">Nom *<input class="admin-input" id="acf-name" type="text" maxlength="50" value="${sanitize(cat ? cat.name : "")}" required></label>
                    <label class="admin-label">Emoji<input class="admin-input" id="acf-emoji" type="text" maxlength="8" value="${sanitize(cat ? (cat.emoji || "📦") : "📦")}"></label>
                    <label class="admin-label">Description<input class="admin-input" id="acf-desc" type="text" maxlength="200" value="${sanitize(cat ? (cat.description || "") : "")}"></label>
                    <button class="admin-form-submit" type="submit">${isEdit ? "Enregistrer" : "Ajouter la catégorie"}</button>
                </form>
                ${isEdit ? `<button class="admin-form-delete" id="acf-delete" type="button">Supprimer la catégorie</button>` : ""}
            </div>`;
        if (els.adminCategoriesContent) els.adminCategoriesContent.innerHTML = formHtml;
        document.getElementById("admin-cat-form-back").addEventListener("click", loadAdminCategories);

        const deleteBtn = document.getElementById("acf-delete");
        if (deleteBtn) {
            deleteBtn.addEventListener("click", () => {
                const count = ((state.config && state.config.products && state.config.products[key]) || []).length;
                const catName = sanitize(cat.name || key);
                showConfirmModal({
                    title: "Supprimer la catégorie ?",
                    emoji: cat.emoji || "📁",
                    message: count > 0
                        ? `Supprimer définitivement la catégorie <strong>« ${catName} »</strong> et ses <strong>${count} produit(s)</strong> associés ?`
                        : `Supprimer définitivement la catégorie <strong>« ${catName} »</strong> ?`,
                    confirmText: "Oui, supprimer",
                    cancelText: "Annuler",
                    isDanger: true,
                    onConfirm: async () => {
                        deleteBtn.disabled = true;
                        await adminDeleteCategory(key);
                    }
                });
            });
        }
        document.getElementById("admin-cat-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const catName = document.getElementById("acf-name").value.trim();
            const catKey = isEdit ? document.getElementById("acf-key").value : uniqueCategoryKey(catName);
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
                body: JSON.stringify({
                    init_data: getAdminInitData(),
                    ...catData,
                    category: { ...catData }
                })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Catégorie sauvegardée ! 📁");
                renderCategories();
                renderProducts();
                await loadAdminCategories();
            } else {
                showToast((data && data.error) || `Erreur lors de la sauvegarde (HTTP ${resp.status}).`, "error");
            }
        } catch (error) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    async function adminDeleteCategory(key) {
        try {
            const resp = await fetchWriteApi("/admin/categories/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    init_data: getAdminInitData(),
                    key: key,
                    cat_key: key
                })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Catégorie supprimée ! 🗑️");
                renderCategories();
                renderProducts();
                await loadAdminCategories();
            } else {
                showToast((data && data.error) || `Erreur lors de la suppression (HTTP ${resp.status}).`, "error");
            }
        } catch (error) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    // ===== ADMIN PARAMÈTRES (SETTINGS) =====

    async function loadAdminSettings() {
        if (!els.adminSettingsContent) return;
        els.adminSettingsContent.innerHTML = `<div class="admin-empty">Chargement des paramètres...</div>`;
        try {
            let cfg = state.config && typeof state.config === "object" ? state.config : null;
            if (!cfg) {
                await loadConfig();
                cfg = state.config;
            }
            if (!cfg) throw new Error("config indisponible");
            const verifiedAdminConfig = await fetchAdminConfig();
            if (!verifiedAdminConfig) throw new Error("accès admin refusé");
            cfg.admin = Object.assign({}, cfg.admin, { whitelist: (verifiedAdminConfig.admin && verifiedAdminConfig.admin.whitelist) || [] });

            const rest = cfg.restaurant || {};
            const adminCfg = cfg.admin || {};
            const whitelist = Array.isArray(adminCfg.whitelist) ? adminCfg.whitelist : [];
            const tgUser = adminCfg.telegram_username || cfg.telegram_username || "";
            const chLink = adminCfg.channel_link || cfg.channel_link || "";
            const tickerText = adminCfg.ticker_text || (els.tickerTexts[0] ? els.tickerTexts[0].textContent.replace(/\s+/g, " ").replace(/\s*✦\s*$/, "").trim() : "");
            const musicTracks = getMusicPlaylist();
            const musicRows = musicTracks.map((track, i) => `
                <div class="admin-list-row">
                    <span class="admin-row-text"><span class="admin-product-name">${sanitize(track.title || `Piste ${i + 1}`)}</span></span>
                    <span class="admin-reorder-btns">
                        <button class="admin-btn-reorder" data-music-move="${i}" data-dir="-1" type="button" aria-label="Monter" ${i === 0 ? "disabled" : ""}>▲</button>
                        <button class="admin-btn-reorder" data-music-move="${i}" data-dir="1" type="button" aria-label="Descendre" ${i === musicTracks.length - 1 ? "disabled" : ""}>▼</button>
                    </span>
                    <button class="admin-row-remove" data-music-remove="${i}" type="button">Retirer</button>
                </div>
            `).join("");
            const welcomePhoto = adminCfg.welcome_photo || "";
            const welcomeMessage = adminCfg.welcome_message
                || `*🕵🏻 Bienvenue chez ${String(rest.name || "").toUpperCase()} !*\n\nSi vous souhaitez faire une commande ou nous contacter, utilisez les options ci-dessous.`;

            const wlChips = whitelist.map((u) => `
                <div class="admin-list-row">
                    <span>@${sanitize(u)}</span>
                    <button class="admin-chip-remove" data-user="${sanitize(u)}" type="button">Retirer</button>
                </div>
            `).join("");

            const html = `
                <h4 class="admin-section-title">Boutique</h4>
                <div class="admin-settings-card">
                    <form id="admin-form-settings" autocomplete="off">
                        <label class="admin-label">Nom
                            <input class="admin-input" id="as-name" type="text" value="${sanitize(rest.name || '')}" required>
                        </label>
                        <label class="admin-label">Sous-titre
                            <input class="admin-input" id="as-slogan" type="text" placeholder="Menu premium 2026">
                        </label>
                        <label class="admin-label">Devise
                            <input class="admin-input" id="as-currency" type="text" value="${sanitize(rest.currency || 'EUR')}">
                        </label>
                        <label class="admin-label">Commande min. (€)
                            <input class="admin-input" id="as-minorder" type="number" step="0.01" value="${rest.minOrder || 0}">
                        </label>
                        <label class="admin-label">Livraison (€)
                            <input class="admin-input" id="as-deliveryfee" type="number" step="0.01" value="${rest.deliveryFee || 0}">
                        </label>
                        <button class="admin-form-submit" type="submit">Enregistrer</button>
                    </form>
                </div>

                <h4 class="admin-section-title">Telegram</h4>
                <div class="admin-settings-card">
                    <form id="admin-form-contact" autocomplete="off">
                        <label class="admin-label">Pseudo (sans @)
                            <input class="admin-input" id="as-tg-username" type="text" value="${sanitize(tgUser)}">
                        </label>
                        <label class="admin-label">Lien du canal
                            <input class="admin-input" id="as-channel-link" type="text" value="${sanitize(chLink)}">
                        </label>
                        <button class="admin-form-submit" type="submit">Enregistrer</button>
                    </form>
                </div>

                <h4 class="admin-section-title">Banderole défilante</h4>
                <div class="admin-settings-card">
                    <form id="admin-form-ticker" autocomplete="off">
                        <label class="admin-label">
                            <textarea class="admin-input admin-textarea" id="as-ticker-text" rows="3" maxlength="300" aria-label="Texte de la banderole"></textarea>
                        </label>
                        <button class="admin-form-submit" type="submit">Enregistrer</button>
                    </form>
                </div>
                <p class="admin-hint admin-footnote">Emojis acceptés. Sépare les infos avec ✦. Vide = texte par défaut.</p>

                <h4 class="admin-section-title">Accueil du bot (/start)</h4>
                <div class="admin-settings-card">
                    <form id="admin-form-welcome" autocomplete="off">
                        <div class="admin-field">
                            <span class="admin-field-label">Photo</span>
                            <input class="admin-input" id="as-welcome-photo" type="text" placeholder="Lien https:// (vide = photo actuelle)">
                            <div class="admin-upload-box">
                                <label class="admin-upload-btn" for="as-welcome-photo-file">Choisir une photo…</label>
                                <input type="file" id="as-welcome-photo-file" accept="image/*" style="display:none;">
                                <span class="admin-upload-status" id="as-welcome-photo-status"></span>
                            </div>
                        </div>
                        <label class="admin-label">Message
                            <textarea class="admin-input admin-textarea" id="as-welcome-message" rows="5" maxlength="500"></textarea>
                        </label>
                        <button class="admin-form-submit" type="submit">Enregistrer</button>
                    </form>
                </div>
                <p class="admin-hint admin-footnote">*texte* = gras. Vide = message par défaut.</p>

                <h4 class="admin-section-title">Musique</h4>
                <div class="admin-settings-card">
                    ${musicRows}
                    <form id="admin-form-music" autocomplete="off">
                        <div class="admin-field">
                            <input class="admin-input" id="as-music-title" type="text" maxlength="80" placeholder="Titre du son">
                            <input class="admin-input" id="as-music-url" type="text" placeholder="Lien .mp3">
                            <div class="admin-upload-box">
                                <label class="admin-upload-btn" for="as-music-file">Choisir un son…</label>
                                <input type="file" id="as-music-file" accept="audio/*" style="display:none;">
                                <span class="admin-upload-status" id="as-music-status"></span>
                            </div>
                        </div>
                        <button class="admin-form-submit" type="submit">Ajouter à la playlist</button>
                    </form>
                </div>
                <p class="admin-hint admin-footnote">Démarre après l'écran d'accueil, en boucle. Si le téléphone bloque le son automatique, la musique se lance au premier toucher.</p>

                <h4 class="admin-section-title">Accès à la gestion</h4>
                <div class="admin-settings-card">
                    ${wlChips}
                    <form id="admin-form-whitelist" class="admin-inline-form" autocomplete="off">
                        <input class="admin-input" id="as-new-admin" type="text" placeholder="@pseudo Telegram">
                        <button class="admin-inline-btn" type="submit">Ajouter</button>
                    </form>
                </div>
                <p class="admin-hint admin-footnote">Seules ces personnes peuvent ouvrir la gestion.</p>

                <h4 class="admin-section-title">Bot</h4>
                <button class="admin-form-delete" id="as-restart-bot" type="button">Redémarrer le bot</button>
                <p class="admin-hint admin-footnote">Si le bot ne répond plus. Il revient tout seul en 10 secondes environ.</p>
            `;

            els.adminSettingsContent.innerHTML = html;
            document.getElementById("as-slogan").value = rest.slogan || "";
            document.getElementById("as-ticker-text").value = tickerText;
            document.getElementById("as-welcome-photo").value = welcomePhoto;
            document.getElementById("as-welcome-message").value = welcomeMessage;

            document.getElementById("admin-form-settings").addEventListener("submit", async (e) => {
                e.preventDefault();
                const settingsData = {
                    name: document.getElementById("as-name").value.trim(),
                    slogan: document.getElementById("as-slogan").value.trim(),
                    currency: document.getElementById("as-currency").value.trim(),
                    minOrder: parseFloat(document.getElementById("as-minorder").value) || 0,
                    deliveryFee: parseFloat(document.getElementById("as-deliveryfee").value) || 0,
                };
                await adminSaveSettings(settingsData);
                applyTranslations();
            });

            document.getElementById("admin-form-ticker").addEventListener("submit", async (e) => {
                e.preventDefault();
                await adminSaveContact({ ticker_text: document.getElementById("as-ticker-text").value.trim() }, "Banderole mise à jour ! 📣");
                applyTranslations();
            });

            document.getElementById("admin-form-contact").addEventListener("submit", async (e) => {
                e.preventDefault();
                const contactData = {
                    telegram_username: document.getElementById("as-tg-username").value.trim().replace(/^@/, ""),
                    channel_link: document.getElementById("as-channel-link").value.trim(),
                };
                await adminSaveContact(contactData);
            });

            document.getElementById("as-welcome-photo-file").addEventListener("change", function () {
                handleAdminFileUpload(this, "as-welcome-photo", "as-welcome-photo-status");
            });

            document.getElementById("admin-form-welcome").addEventListener("submit", async (e) => {
                e.preventDefault();
                const photo = document.getElementById("as-welcome-photo").value.trim();
                if (photo.startsWith("data:")) {
                    showToast("Photo non envoyée au serveur, réessaie ou colle un lien https.", "error");
                    return;
                }
                await adminSaveContact({
                    welcome_photo: photo,
                    welcome_message: document.getElementById("as-welcome-message").value.trim(),
                }, "Accueil du bot mis à jour ! 👋");
            });

            const saveMusicPlaylist = async (tracks, successMsg) => {
                if (await adminSaveContact({ music_playlist: JSON.stringify(tracks) }, successMsg)) {
                    syncMusicPlaylist();
                    await loadAdminSettings();
                }
            };

            document.getElementById("as-music-file").addEventListener("change", async function () {
                const file = this.files && this.files[0];
                if (!file) return;
                const statusEl = document.getElementById("as-music-status");
                statusEl.textContent = "Envoi : 0 %";
                setUploadBusy(this, true);
                try {
                    const url = await uploadMediaFile(file, (percent) => {
                        statusEl.textContent = percent < 99 ? `Envoi : ${percent} %` : "Enregistrement…";
                    });
                    document.getElementById("as-music-url").value = url;
                    const titleEl = document.getElementById("as-music-title");
                    if (!titleEl.value.trim()) titleEl.value = file.name.replace(/\.[^.]+$/, "");
                    statusEl.textContent = "Son prêt";
                } catch (err) {
                    statusEl.textContent = err.message;
                    showToast(err.message, "error");
                } finally {
                    setUploadBusy(this, false);
                }
            });

            document.getElementById("admin-form-music").addEventListener("submit", async (e) => {
                e.preventDefault();
                const url = document.getElementById("as-music-url").value.trim();
                if (!/^(https?:\/\/|\/uploads\/)/i.test(url)) {
                    showToast("Ajoute un son (fichier ou lien https).", "error");
                    return;
                }
                const title = document.getElementById("as-music-title").value.trim() || `Piste ${musicTracks.length + 1}`;
                await saveMusicPlaylist([...musicTracks, { title, url }], "Son ajouté à la playlist 🎵");
            });

            els.adminSettingsContent.querySelectorAll("[data-music-remove]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const index = Number(btn.dataset.musicRemove);
                    saveMusicPlaylist(musicTracks.filter((_, i) => i !== index), "Son retiré");
                });
            });

            els.adminSettingsContent.querySelectorAll("[data-music-move]").forEach((btn) => {
                btn.addEventListener("click", () => {
                    const from = Number(btn.dataset.musicMove);
                    const to = from + Number(btn.dataset.dir);
                    const tracks = [...musicTracks];
                    [tracks[from], tracks[to]] = [tracks[to], tracks[from]];
                    saveMusicPlaylist(tracks, "Ordre mis à jour");
                });
            });

            document.getElementById("as-restart-bot").addEventListener("click", () => {
                showConfirmModal({
                    title: "Redémarrer le bot ?",
                    emoji: "🔄",
                    message: "Le bot sera coupé quelques secondes puis repartira tout seul.",
                    confirmText: "Oui, redémarrer",
                    cancelText: "Annuler",
                    isDanger: false,
                    onConfirm: adminRestartBot
                });
            });

            document.getElementById("admin-form-whitelist").addEventListener("submit", async (e) => {
                e.preventDefault();
                const input = document.getElementById("as-new-admin");
                const newUsername = input.value.trim().replace(/^@/, "");
                if (!newUsername) return;
                const currentWL = Array.isArray(cfg.admin && cfg.admin.whitelist) ? [...cfg.admin.whitelist] : [];
                if (!currentWL.includes(newUsername)) {
                    currentWL.push(newUsername);
                    await adminSaveWhitelist(currentWL);
                }
            });

            els.adminSettingsContent.querySelectorAll(".admin-chip-remove").forEach((btn) => {
                btn.addEventListener("click", async () => {
                    const toRemove = btn.dataset.user;
                    const currentWL = Array.isArray(cfg.admin && cfg.admin.whitelist) ? [...cfg.admin.whitelist] : [];
                    const updatedWL = currentWL.filter((u) => u !== toRemove);
                    await adminSaveWhitelist(updatedWL);
                });
            });

        } catch (_) {
            els.adminSettingsContent.innerHTML = `<div class="admin-empty">Impossible de charger les paramètres.</div>`;
        }
    }

    async function adminSaveSettings(settings) {
        try {
            const resp = await fetchWriteApi("/admin/settings/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), settings })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Paramètres sauvegardés ! ⚙️");
                renderUser();
            } else {
                showToast((data && data.error) || "Erreur lors de la sauvegarde.", "error");
            }
        } catch (_) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    async function adminRestartBot() {
        try {
            const resp = await fetchWriteApi("/admin/restart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: (tg && tg.initData) || "" })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && data && data.success) {
                showToast("Redémarrage en cours, retour dans 10 secondes environ 🔄");
            } else {
                showToast((data && data.error) || "Redémarrage impossible.", "error");
            }
        } catch (_) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    async function adminSaveContact(contact, successMsg = "Contacts mis à jour ! 📱") {
        try {
            const resp = await fetchWriteApi("/admin/contact/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), contact })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast(successMsg);
                return true;
            }
            showToast(resp.status === 403 ? SESSION_EXPIRED_MSG : (data && data.error) || "Erreur lors de la sauvegarde.", "error");
        } catch (_) {
            showToast("Connexion impossible, réessaie.", "error");
        }
        return false;
    }

    async function adminSaveWhitelist(whitelist) {
        try {
            const resp = await fetchWriteApi("/admin/whitelist/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ init_data: getAdminInitData(), whitelist })
            });
            const data = await readJsonIfAny(resp);
            if (resp.ok && (!data || data.success !== false)) {
                if (data && data.config) applyUpdatedConfig(data.config);
                showToast("Liste des admins mise à jour ! 🛡️");
                await loadAdminSettings();
            } else {
                showToast((data && data.error) || "Erreur lors de la sauvegarde.", "error");
            }
        } catch (_) {
            showToast("Connexion impossible, réessaie.", "error");
        }
    }

    // ===== FIN ADMIN PANEL =====

    const music = { audio: new Audio(), tracks: [], index: 0, errors: 0, resumeOnShow: false, autostart: null };

    function getMusicPlaylist() {
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
        if (!music.tracks.length) return Promise.resolve();
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
        if (!music.tracks.length || localStorage.getItem("gh-music-paused")) return;
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
            if (!music.audio.getAttribute("src") || ++music.errors >= music.tracks.length) return;
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
            bindMusicPlayer();
        } catch (error) {
            document.body.innerHTML = `<div style="padding:20px;color:#fff">Erreur: ${sanitize(error.message)}</div>`;
            return;
        }

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
        document.addEventListener("visibilitychange", async () => {
            if (document.visibilityState === "visible") {
                try {
                    await loadConfig();
                    renderCategories();
                    renderProducts();
                    syncMusicPlaylist();
                } catch (_) {}
            }
        });

        window.addEventListener("focus", async () => {
            try {
                await loadConfig();
                renderCategories();
                renderProducts();
            } catch (_) {}
        });

        // Synchronisation périodique automatique (toutes les 45 secondes)
        setInterval(async () => {
            if (document.visibilityState === "visible") {
                try {
                    await loadConfig();
                    renderCategories();
                    renderProducts();
                } catch (_) {}
            }
        }, 45000);
    }

    document.addEventListener("DOMContentLoaded", bootstrap);
})();
