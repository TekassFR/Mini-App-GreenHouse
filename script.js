(function () {
    "use strict";

    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
        tg.ready();
        tg.expand();
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
        orders: []
    };

    const els = {
        intro: document.getElementById("intro-screen"),
        userChip: document.getElementById("user-chip"),
        categoryNav: document.getElementById("category-nav"),
        productGrid: document.getElementById("product-grid"),
        pages: document.querySelectorAll(".page"),
        tabs: document.querySelectorAll(".tab-btn"),

        cartEmptyState: document.getElementById("cart-empty-state"),
        cartContent: document.getElementById("cart-content"),
        cartItems: document.getElementById("cart-items"),
        cartTotal: document.getElementById("cart-total"),
        clearCartBtn: document.getElementById("clear-cart-btn"),
        checkoutBtn: document.getElementById("checkout-btn"),
        deliveryAddress: document.getElementById("delivery-address"),
        pickupTime: document.getElementById("pickup-time"),
        deliveryFieldGroup: document.getElementById("delivery-field-group"),
        pickupFieldGroup: document.getElementById("pickup-field-group"),
        serviceSwitch: document.getElementById("service-switch"),

        historyList: document.getElementById("history-list"),
        reviewList: document.getElementById("review-list"),
        reviewForm: document.getElementById("review-form"),
        reviewAuthor: document.getElementById("review-author"),
        reviewStars: document.getElementById("review-stars"),
        reviewMessage: document.getElementById("review-message"),
        reviewRating: document.getElementById("review-rating"),
        reviewCount: document.getElementById("review-count"),

        profileName: document.getElementById("profile-name"),
        profileUsername: document.getElementById("profile-username"),
        profileCartCount: document.getElementById("profile-cart-count"),
        profileOrderCount: document.getElementById("profile-order-count"),

        infoContactUsername: document.getElementById("info-contact-username"),
        contactBtn: document.getElementById("contact-btn"),
        channelBtn: document.getElementById("channel-btn"),

        detailOverlay: document.getElementById("detail-overlay"),
        detailCloseBtn: document.getElementById("detail-close-btn"),
        detailImage: document.getElementById("detail-image"),
        detailVideo: document.getElementById("detail-video"),
        detailName: document.getElementById("detail-name"),
        detailDescription: document.getElementById("detail-description"),
        detailCategoryChip: document.getElementById("detail-category-chip"),
        showImageBtn: document.getElementById("show-image-btn"),
        showVideoBtn: document.getElementById("show-video-btn"),
        detailQtyGrid: document.getElementById("detail-qty-grid"),
        detailSelectedPrice: document.getElementById("detail-selected-price"),
        detailAddBtn: document.getElementById("detail-add-btn")
    };

    function sanitize(input) {
        if (typeof input !== "string") return "";
        return input.replace(/[<>"'&]/g, "").trim();
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
        localStorage.setItem("gh_cart", JSON.stringify(state.cart));
        localStorage.setItem("gh_orders", JSON.stringify(state.orders));
        localStorage.setItem("gh_reviews", JSON.stringify(state.reviews));
    }

    function loadLocal() {
        try {
            const cart = JSON.parse(localStorage.getItem("gh_cart") || "[]");
            const orders = JSON.parse(localStorage.getItem("gh_orders") || "[]");
            const reviews = JSON.parse(localStorage.getItem("gh_reviews") || "[]");
            state.cart = Array.isArray(cart) ? cart : [];
            state.orders = Array.isArray(orders) ? orders : [];
            state.reviews = Array.isArray(reviews) ? reviews : [];
        } catch (_) {
            state.cart = [];
            state.orders = [];
            state.reviews = [];
        }
    }

    async function loadConfig() {
        const resp = await fetch(`./config.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("config.json introuvable");
        const cfg = await resp.json();
        state.config = cfg;
        state.products = allProductsFromConfig(cfg);
        state.categories = Object.keys((cfg && cfg.categories) || {});
    }

    function renderUser() {
        const user = tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
        const firstName = sanitize((user && user.first_name) || "Utilisateur");
        const username = user && user.username ? `@${sanitize(user.username)}` : "-";

        els.userChip.textContent = `Salut ${firstName}`;
        els.profileName.textContent = firstName;
        els.profileUsername.textContent = username;

        const adminUser = state.config && state.config.admin ? state.config.admin.telegram_username : "peakyblinders540";
        els.infoContactUsername.textContent = `Telegram: @${adminUser}`;
    }

    function renderCategories() {
        let html = `<button class="category-btn ${state.category === "all" ? "active" : ""}" data-category="all">Tout</button>`;
        state.categories.forEach((catId) => {
            const meta = getCategoryMeta(catId);
            html += `<button class="category-btn ${state.category === catId ? "active" : ""}" data-category="${catId}">${sanitize(meta.emoji || "📦")} ${sanitize(meta.name || catId)}</button>`;
        });
        els.categoryNav.innerHTML = html;

        els.categoryNav.querySelectorAll(".category-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                state.category = btn.dataset.category;
                renderCategories();
                renderProducts();
            });
        });
    }

    function productCardTemplate(product) {
        const img = sanitize(product.image || "");
        const name = sanitize(product.name || "Produit");
        const desc = sanitize(product.description || "");
        const start = getStartingPrice(product);

        let badge = "";
        if (product.isNew) badge = `<span class="badge new">Nouveau</span>`;
        else if (product.isPromo) badge = `<span class="badge promo">Promo</span>`;

        return `
            <article class="product-card" data-product-id="${product.id}">
                <div class="product-media">
                    <img src="${img}" alt="${name}" loading="lazy" referrerpolicy="no-referrer">
                    ${badge}
                </div>
                <div class="product-body">
                    <h3 class="product-title">${name}</h3>
                    <p class="product-desc">${desc}</p>
                    <div class="product-foot">
                        <span class="price-chip">Des ${formatEUR(start)}</span>
                        <button class="btn primary" type="button">Voir</button>
                    </div>
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
                        <p class="muted">${formatEUR(item.unitPrice)} / unite</p>
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
            els.historyList.innerHTML = `<div class="card panel">Aucune commande pour le moment.</div>`;
            return;
        }

        const html = state.orders
            .slice()
            .reverse()
            .map((order) => {
                const date = new Date(order.timestamp).toLocaleString("fr-FR");
                return `
                    <article class="card panel">
                        <h3>Commande #${order.id}</h3>
                        <p class="muted">${date} - ${order.type === "pickup" ? "Sur place" : "Livraison"}</p>
                        <p><strong>Total:</strong> ${formatEUR(order.total)}</p>
                        <p class="muted">${sanitize(order.summary)}</p>
                    </article>
                `;
            })
            .join("");

        els.historyList.innerHTML = html;
    }

    function renderReviews() {
        if (!state.reviews.length) {
            els.reviewList.innerHTML = `<div class="card panel">Pas encore d'avis, sois le premier.</div>`;
            els.reviewRating.textContent = "4.9 / 5";
            els.reviewCount.textContent = "Base sur 0 avis";
            return;
        }

        const avg = state.reviews.reduce((s, r) => s + r.stars, 0) / state.reviews.length;
        els.reviewRating.textContent = `${avg.toFixed(1)} / 5`;
        els.reviewCount.textContent = `Base sur ${state.reviews.length} avis`;

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

    function addReview(author, stars, message) {
        state.reviews.push({
            author,
            stars,
            message,
            timestamp: Date.now()
        });
        saveLocal();
        renderReviews();
    }

    function renderProfileStats() {
        const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
        els.profileCartCount.textContent = String(count);
        els.profileOrderCount.textContent = String(state.orders.length);
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

    function openProductDetail(product) {
        state.selectedProduct = product;
        state.selectedQty = null;
        state.selectedPrice = 0;
        state.detailMedia = "image";

        const categoryMeta = getCategoryMeta(product.category);
        els.detailName.textContent = sanitize(product.name || "Produit");
        els.detailDescription.textContent = sanitize(product.description || "");
        els.detailCategoryChip.textContent = `${sanitize(categoryMeta.emoji || "📦")} ${sanitize(categoryMeta.name || product.category)}`;

        els.detailImage.src = sanitize(product.image || "");
        els.detailImage.style.display = "block";

        const videoUrl = getPlayableVideo(product.video);
        if (videoUrl) {
            els.detailVideo.src = videoUrl;
            els.showVideoBtn.style.display = "inline-block";
        } else {
            els.detailVideo.src = "";
            els.showVideoBtn.style.display = "none";
        }

        switchDetailMedia("image");
        renderDetailQuantities(product);
        els.detailOverlay.style.display = "block";
    }

    function closeProductDetail() {
        els.detailOverlay.style.display = "none";
        els.detailVideo.pause();
        els.detailVideo.currentTime = 0;
    }

    function switchDetailMedia(mode) {
        state.detailMedia = mode;
        const videoAvailable = !!els.detailVideo.src;

        if (mode === "video" && videoAvailable) {
            els.detailImage.style.display = "none";
            els.detailVideo.style.display = "block";
            els.showImageBtn.classList.remove("active");
            els.showVideoBtn.classList.add("active");
            els.detailVideo.play().catch(() => {});
            return;
        }

        els.detailVideo.pause();
        els.detailVideo.currentTime = 0;
        els.detailVideo.style.display = "none";
        els.detailImage.style.display = "block";
        els.showVideoBtn.classList.remove("active");
        els.showImageBtn.classList.add("active");
    }

    function renderDetailQuantities(product) {
        const entries = getQtyEntries(product);
        els.detailQtyGrid.innerHTML = entries
            .map((entry, idx) => `
                <button class="qty-card ${idx === 0 ? "active" : ""}" data-qty="${entry.qty}" data-price="${entry.price}" type="button">
                    <div class="qty-label">${entry.qty}G</div>
                    <div class="qty-price">${toPrice(entry.price).toFixed(2)}EUR</div>
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
            alert("Panier vide.");
            return;
        }

        const total = state.cart.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
        if (state.orderType === "delivery") {
            const address = sanitize(els.deliveryAddress.value || "");
            if (address.length < 10) {
                alert("Adresse trop courte.");
                return;
            }
        } else {
            const time = sanitize(els.pickupTime.value || "");
            if (!time) {
                alert("Selectionne une heure d'arrivee.");
                return;
            }
        }

        const orderId = state.orders.length + 1;
        const summary = state.cart.map((i) => `${sanitize(i.name)} x${i.quantity}`).join(", ");
        state.orders.push({
            id: orderId,
            type: state.orderType,
            total,
            summary,
            items: JSON.parse(JSON.stringify(state.cart)),
            timestamp: Date.now()
        });

        const username = state.config && state.config.admin ? state.config.admin.telegram_username : "peakyblinders540";
        const text = encodeURIComponent(
            `Nouvelle commande #${orderId}\n` +
            `Type: ${state.orderType === "pickup" ? "Sur place" : "Livraison"}\n` +
            `Details: ${summary}\n` +
            `Total: ${formatEUR(total)}`
        );
        const url = `https://t.me/${username}?text=${text}`;

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
                els.serviceSwitch.querySelectorAll(".service-btn").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                state.orderType = btn.dataset.service;
                const isDelivery = state.orderType === "delivery";
                els.deliveryFieldGroup.style.display = isDelivery ? "grid" : "none";
                els.pickupFieldGroup.style.display = isDelivery ? "none" : "grid";
            });
        });

        els.contactBtn.addEventListener("click", () => {
            const username = state.config && state.config.admin ? state.config.admin.telegram_username : "peakyblinders540";
            const url = `https://t.me/${username}`;
            if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
            else window.open(url, "_blank");
        });

        els.channelBtn.addEventListener("click", () => {
            const link = state.config && state.config.admin ? state.config.admin.channel_link : "https://t.me/+1ucagzAd9_YxZDE0";
            if (tg && tg.openLink) tg.openLink(link);
            else window.open(link, "_blank");
        });

        els.reviewForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const author = sanitize(els.reviewAuthor.value || "");
            const stars = Math.max(1, Math.min(5, parseInt(els.reviewStars.value, 10) || 5));
            const message = sanitize(els.reviewMessage.value || "");
            if (!author || !message) {
                alert("Remplis le nom et le message.");
                return;
            }
            addReview(author, stars, message);
            els.reviewForm.reset();
            els.reviewStars.value = "5";
        });

        els.detailCloseBtn.addEventListener("click", closeProductDetail);
        els.showImageBtn.addEventListener("click", () => switchDetailMedia("image"));
        els.showVideoBtn.addEventListener("click", () => switchDetailMedia("video"));

        els.detailAddBtn.addEventListener("click", () => {
            if (!state.selectedProduct || !state.selectedQty || !state.selectedPrice) {
                alert("Selectionne une quantite.");
                return;
            }
            addToCart(state.selectedProduct, state.selectedQty, state.selectedPrice);
            closeProductDetail();
            switchPage("cart");
        });

        els.detailOverlay.addEventListener("click", (e) => {
            if (e.target === els.detailOverlay) closeProductDetail();
        });
    }

    async function bootstrap() {
        try {
            await loadConfig();
            loadLocal();
            renderUser();
            renderCategories();
            renderProducts();
            renderCart();
            renderHistory();
            renderReviews();
            renderProfileStats();
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
