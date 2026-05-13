// Sécurité intégrée - IIFE pour encapsuler le code
(function() {
    'use strict';
    
    // Configuration de sécurité
    const SECURITY_CONFIG = {
        MAX_CART_ITEMS: 1000,
        MAX_ITEM_QUANTITY: 1000,
        MAX_ADDRESS_LENGTH: 200,
        MIN_ADDRESS_LENGTH: 10,
        RATE_LIMIT_MS: 1000, // 1 seconde entre les actions
        ALLOWED_DOMAINS: ['telegram.org', 't.me'],
        MAX_ACTIONS_PER_MINUTE: 30,
        MAX_TOTAL_PRICE: 10000
    };
    
    // Variables de sécurité
    let lastActionTime = 0;
    let actionCount = 0;
    let securityLogs = [];
    
    // Fonction de rate limiting
    function checkRateLimit() {
        const now = Date.now();
        if (now - lastActionTime < SECURITY_CONFIG.RATE_LIMIT_MS) {
            console.warn('Action trop rapide, ignorée');
            return false;
        }
        
        // Reset counter every minute
        if (now - lastActionTime > 60000) {
            actionCount = 0;
        }
        
        if (actionCount >= SECURITY_CONFIG.MAX_ACTIONS_PER_MINUTE) {
            console.warn('Trop d\'actions par minute');
            return false;
        }
        
        lastActionTime = now;
        actionCount++;
        return true;
    }
    
    // Validation sécurisée des entrées
    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input
            .replace(/[<>"'&]/g, '') // Supprimer caractères dangereux
            .trim()
            .substring(0, 500); // Limiter la longueur
    }
    
    // Validation des quantités
    function validateQuantity(qty) {
        const num = parseFloat(String(qty).replace(',', '.'));
        return num > 0 && num <= SECURITY_CONFIG.MAX_ITEM_QUANTITY && Number.isFinite(num) ? num : 1;
    }
    
    // Protection contre les manipulations DOM
    function protectDOM() {
        // Désactiver console en production
        if (window.location.hostname !== 'localhost') {
            console.log = console.warn = console.error = function() {};
        }
        
        // Bloquer F12, Ctrl+Shift+I, etc.
        document.addEventListener('keydown', function(e) {
            if (e.key === 'F12' || 
                (e.ctrlKey && e.shiftKey && e.key === 'I') ||
                (e.ctrlKey && e.shiftKey && e.key === 'C') ||
                (e.ctrlKey && e.key === 'u')) {
                e.preventDefault();
                return false;
            }
        });
        
        // Bloquer clic droit
        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
    }
    
    // Validation de l'origine Telegram
    function validateTelegramOrigin() {
        const referrer = document.referrer;
        const isValidOrigin = SECURITY_CONFIG.ALLOWED_DOMAINS.some(domain => 
            referrer.includes(domain)
        );
        
        if (!isValidOrigin && window.location.hostname !== 'localhost') {
            console.warn('Origine non autorisée');
        }
    }
    
    // Chiffrement simple pour les données sensibles
    function simpleEncrypt(text) {
        return btoa(encodeURIComponent(text));
    }
    
    function simpleDecrypt(encoded) {
        try {
            return decodeURIComponent(atob(encoded));
        } catch {
            return '';
        }
    }
    
    // Log de sécurité
    function securityLog(action, details) {
        const logEntry = {
            timestamp: Date.now(),
            action: action,
            details: details,
            userAgent: navigator.userAgent.substring(0, 100)
        };
        securityLogs.push(logEntry);
        
        // Garder seulement les 100 derniers logs
        if (securityLogs.length > 100) {
            securityLogs = securityLogs.slice(-100);
        }
    }
    
    // Exposer les fonctions sécurisées globalement
    window.SecurityUtils = {
        checkRateLimit,
        sanitizeInput,
        validateQuantity,
        simpleEncrypt,
        simpleDecrypt,
        securityLog
    };
    
    // Initialiser la protection
    protectDOM();
    validateTelegramOrigin();
})();

// Code principal de l'application
const tg = window.Telegram.WebApp;
let restaurantUsername = 'peakyblinders540'; // Votre username sans @ (sera mis à jour depuis adminConfig)

// Configuration initiale
tg.ready();
tg.expand();

// Variables globales pour les données du menu
let menuData = {};
let restaurantConfig = {};
let categoriesData = {}; // Variable globale pour les catégories (comme menuData pour les produits)

// Fonction pour charger la configuration depuis config.json
async function loadConfig() {
    try {
        // Charger depuis le serveur d'abord (source de vérité)
        let config = null;
        try {
            const response = await fetch('./config.json?t=' + Date.now());
            if (response.ok) {
                config = await response.json();
            }
        } catch (e) {
            // Ignorer, on tentera le fallback local
        }

        // Fallback: utiliser localStorage SEULEMENT si le serveur n'a pas répondu
        if (!config) {
            const backupConfig = localStorage.getItem('miniapp_config_backup');
            if (backupConfig) {
                try {
                    config = JSON.parse(backupConfig);
                } catch (parseError) {
                    localStorage.removeItem('miniapp_config_backup');
                    localStorage.removeItem('miniapp_config_timestamp');
                    config = null;
                }
            }
        }

        if (!config) {
            throw new Error('Impossible de charger la configuration');
        }

        // Stocker les données globalement
        restaurantConfig = config.restaurant;
        window.restaurantConfig = config; // Stocker la config complète pour l'admin
        menuData = config.products;
        categoriesData = config.categories || {}; // Charger les catégories dans la variable globale
        adminConfig = config.admin || {}; // Charger la config admin
        
        // Mettre à jour restaurantUsername depuis adminConfig
        if (adminConfig && adminConfig.telegram_username) {
            restaurantUsername = adminConfig.telegram_username;
        }
        
        Object.keys(menuData).forEach(cat => {
            menuData[cat] = menuData[cat].map(p => {
                p.image = `https://picsum.photos/seed/greenhouse-${p.id}/900/700`;
                if (p.customPrices) {
                    const normalized = {};
                    Object.entries(p.customPrices).forEach(([k, v]) => {
                        const nk = String(k).replace(',', '.');
                        normalized[nk] = v;
                    });
                    p.customPrices = normalized;
                }
                return p;
            });
        });
        
        return config;
    } catch (error) {
        return null;
    }
}

// État du panier
let cart = [];
let currentCategory = 'all';
let currentOrderType = 'delivery'; // Variable pour tracker le type de service sélectionné
let productDetailService = 'delivery'; // Variable pour tracker le service sélectionné sur la page de détail du produit
let currentDetailMedia = 'image';

// Variables pour les éléments DOM (seront initialisées après le chargement)
let userInfo, menuGrid, cartSummary, cartItems, cartTotal, checkoutBtn;
let categoryBtns = [];

// Fonction pour afficher les informations utilisateur
function displayUserInfo() {
    const user = tg.initDataUnsafe?.user;
    if (user) {
        const safeName = window.SecurityUtils.sanitizeInput(user.first_name || 'Utilisateur');
        userInfo.textContent = `Bienvenue ${safeName} ! 👋`;
    } else {
        userInfo.textContent = 'Mode développement - Bienvenue ! 👋';
    }
}

// Fonction pour ajuster l'affichage des images selon leurs proportions
function adjustImageDisplay(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
        return;
    }
    
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const container = img.closest('.product-image');
    
    if (!container) {
        return;
    }
    
    // Supprimer les classes existantes
    container.classList.remove('portrait', 'landscape', 'square');
    img.classList.remove('fit-cover', 'fit-contain', 'fit-fill', 'fit-scale-down');
    
    // Déterminer le type d'image et appliquer les styles appropriés
    if (aspectRatio < 0.8) {
        // Image portrait (hauteur > largeur)
        container.classList.add('portrait');
        img.classList.add('fit-contain');
    } else if (aspectRatio > 1.2) {
        // Image paysage (largeur > hauteur)
        container.classList.add('landscape');
        img.classList.add('fit-cover');
    } else {
        // Image carrée ou proche du carré
        container.classList.add('square');
        img.classList.add('fit-cover');
    }
    
}

// Fonction pour ajuster l'affichage des images de détail
function adjustDetailImageDisplay(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
        return;
    }
    
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    img.classList.remove('fit-cover', 'fit-contain', 'fit-fill', 'fit-scale-down');
    img.classList.add('fit-contain');
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = '65vh';
    
    const container = img.closest('.product-detail-image');
    if (container) {
        container.classList.remove('portrait', 'landscape', 'square');
        if (aspectRatio < 0.8) {
            container.classList.add('portrait');
        } else if (aspectRatio > 1.2) {
            container.classList.add('landscape');
        } else {
            container.classList.add('square');
        }
    }
}

// Fonction pour créer une carte produit avec vraie image
function createProductCard(product) {
    const safeName = window.SecurityUtils.sanitizeInput(product.name);
    const safeDescription = window.SecurityUtils.sanitizeInput(product.description);
    const safePrice = parseFloat(product.price) || 0;
    const safeEmoji = window.SecurityUtils.sanitizeInput(product.emoji);
    const customPriceValues = Object.values(product.customPrices || {})
        .map((value) => {
            if (typeof value === 'object' && value !== null) {
                const delivery = parseFloat(value.delivery);
                const pickup = parseFloat(value.pickup);
                const candidates = [delivery, pickup].filter(Number.isFinite);
                return candidates.length ? Math.min(...candidates) : NaN;
            }

            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : NaN;
        })
        .filter(Number.isFinite);
    const startPrice = customPriceValues.length ? Math.min(...customPriceValues) : safePrice;
    
    // Déterminer quel badge afficher
    let badgeHtml = '';
    if (product.isNew) {
        badgeHtml = '<div class="new-badge">Nouveau</div>';
    } else if (product.isPromo) {
        badgeHtml = '<div class="promo-badge">Promo</div>';
    }
    
    return `
        <div class="product-card" data-category="${product.category}">
            <div class="product-image" onclick="openProductDetail(${product.id})" style="cursor: pointer;">
                <img src="${product.image}" alt="${safeName}" class="product-img" 
                     onload="adjustImageDisplay(this)"
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
                <div class="product-emoji-fallback" style="display: none;">
                    ${safeEmoji}
                </div>
                ${badgeHtml}
            </div>
            <div class="product-info">
                <h3 class="product-name" onclick="openProductDetail(${product.id})" style="cursor: pointer;">${safeName}</h3>
                <p class="product-description">${safeDescription}</p>
                <div class="product-footer product-footer-modern">
                    <span class="product-starting-price">Dès ${startPrice.toFixed(2)}€</span>
                    <button class="add-to-cart-btn" onclick="openProductDetail(${product.id})">
                        Voir détails
                    </button>
                </div>
            </div>
        </div>
    `;
}

// Fonction pour afficher tous les produits
function displayProducts() {
    let html = '';
    Object.values(menuData).flat().forEach(product => {
        html += createProductCard(product);
    });
    menuGrid.innerHTML = html;
}

// Fonction pour charger les catégories depuis la source de vérité
function loadCategories() {
    // Priorité 1: window.restaurantConfig (données en mémoire, toujours à jour)
    if (window.restaurantConfig && window.restaurantConfig.categories) {
        return window.restaurantConfig.categories;
    }
    
    // Priorité 2: localStorage (comme loadConfig() pour les produits)
    const backupConfig = localStorage.getItem('miniapp_config_backup');
    if (backupConfig) {
        try {
            const parsed = JSON.parse(backupConfig);
            if (parsed.categories) {
                // Synchroniser window.restaurantConfig (comme loadConfig())
                if (!window.restaurantConfig) {
                    window.restaurantConfig = {};
                }
                window.restaurantConfig.categories = parsed.categories;
                return parsed.categories;
            }
        } catch (e) {
            // Ignorer l'erreur
        }
    }
    
    return {};
}

// Fonction pour générer dynamiquement les boutons de catégories
// SOLUTION ROBUSTE À 100% : Système de vérification et retry
function displayCategoryButtons() {
    // Retry si le DOM n'est pas prêt
    const categoryNav = document.querySelector('.category-nav');
    if (!categoryNav) {
        setTimeout(() => displayCategoryButtons(), 100);
        return;
    }
    
    // Source de vérité: configuration chargée du serveur (window.restaurantConfig)
    let categories = {};
    if (window.restaurantConfig && window.restaurantConfig.categories && typeof window.restaurantConfig.categories === 'object') {
        categories = window.restaurantConfig.categories;
        categoriesData = categories; // garder en mémoire
    } else {
        // Fallback: données en mémoire
        categories = categoriesData || {};
    }
    
    // ÉTAPE 2 : Construire le HTML
    let html = '<button class="category-btn active" data-category="all">🍽️ Tout</button>';
    
    // Trier les catégories par ID pour un affichage cohérent
    const sortedCategoryIds = Object.keys(categories).sort();
    sortedCategoryIds.forEach(categoryId => {
        const category = categories[categoryId];
        if (category && typeof category === 'object' && category.name) {
            const emoji = category.emoji || '📦';
            const name = category.name || categoryId;
            html += `<button class="category-btn" data-category="${categoryId}">${emoji} ${name}</button>`;
        }
    });
    
    // ÉTAPE 3 : FORCER le remplacement du HTML avec vérification
    const oldHTML = categoryNav.innerHTML;
    categoryNav.innerHTML = html;
    
    // Vérifier que le HTML a bien été mis à jour
    if (categoryNav.innerHTML.trim() === '' || categoryNav.innerHTML === oldHTML) {
        // Retry après un court délai
        setTimeout(() => {
            categoryNav.innerHTML = html;
            attachCategoryListeners();
        }, 50);
        return;
    }
    
    // ÉTAPE 4 : Attacher les event listeners
    attachCategoryListeners();
}

// Fonction séparée pour attacher les listeners (réutilisable)
function attachCategoryListeners() {
    const categoryNav = document.querySelector('.category-nav');
    if (!categoryNav) return;
    
    // Supprimer tous les anciens listeners en clonant les boutons
    const newNav = categoryNav.cloneNode(true);
    categoryNav.parentNode.replaceChild(newNav, categoryNav);
    
    // Réattacher les listeners sur les nouveaux boutons
    categoryBtns = newNav.querySelectorAll('.category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const category = this.dataset.category;
            filterByCategory(category);
        });
    });
}

// Fonction pour filtrer par catégorie
function filterByCategory(category) {
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    const safeCategory = window.SecurityUtils.sanitizeInput(category);
    currentCategory = safeCategory;
    const productCards = document.querySelectorAll('.product-card');
    
    productCards.forEach(card => {
        const cardCategory = card.dataset.category;
        if (safeCategory === 'all' || cardCategory === safeCategory) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });
    
    // Mettre à jour les boutons de catégorie
    categoryBtns.forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.category === safeCategory) {
            btn.classList.add('active');
        }
    });
    
    window.SecurityUtils.securityLog('category_filter', { category: safeCategory });
}

// Variable globale pour stocker l'ID du produit actuel
let currentProductId = null;

// Fonction helper pour obtenir le prix correct selon le service sélectionné
function getPriceForService(item, quantity, serviceType = 'delivery') {
    const safeQty = String(window.SecurityUtils.validateQuantity(quantity)).replace(',', '.');
    
    // Utiliser le service enregistré avec le produit si disponible, sinon le serviceType passé en paramètre
    const serviceToUse = item.selectedService || serviceType;
    
    if (item.customPrices && item.customPrices[safeQty]) {
        const priceData = item.customPrices[safeQty];
        
        // Si le prix est un objet avec delivery/pickup (seulement pour certains produits)
        if (typeof priceData === 'object' && priceData.delivery !== undefined && priceData.pickup !== undefined) {
            // C'est un prix différencié delivery/pickup
            return serviceToUse === 'pickup' ? priceData.pickup : priceData.delivery;
        }
        
        // Sinon, c'est un prix simple (ancien format)
        return priceData;
    }
    
    // Fallback: calculer avec le prix de base
    const basePrice = parseFloat(item.price) || 0;
    return basePrice * window.SecurityUtils.validateQuantity(quantity);
}

// Fonction pour changer le service (delivery/pickup) sur la page de détail du produit
function changeProductService(service) {
    if (service !== 'delivery' && service !== 'pickup') return;
    
    productDetailService = service;
    
    // Mettre à jour les boutons actifs
    const deliveryBtn = document.getElementById('service-delivery-btn');
    const pickupBtn = document.getElementById('service-pickup-btn');
    
    if (deliveryBtn && pickupBtn) {
        if (service === 'delivery') {
            deliveryBtn.classList.add('service-btn-active');
            pickupBtn.classList.remove('service-btn-active');
        } else {
            pickupBtn.classList.add('service-btn-active');
            deliveryBtn.classList.remove('service-btn-active');
        }
    }
    
    // Regenerate les bulles avec les nouveaux prix
    const product = Object.values(menuData).flat().find(p => p.id === currentProductId);
    if (product) {
        regenerateProductBubbles(product);
    }
}

// Fonction pour regenerate les bulles de quantité avec le bon service
function regenerateProductBubbles(product) {
    const quantityBubblesContainer = document.querySelector('.quantity-bubbles');
    if (!quantityBubblesContainer || !product.customPrices) return;
    
    // Vider le conteneur
    quantityBubblesContainer.innerHTML = '';
    
    // Obtenir les quantités disponibles depuis customPrices
    const entries = Object.entries(product.customPrices)
        .map(([key, val]) => {
            const qty = parseFloat(String(key).replace(',', '.'));
            
            // Gérer à la fois les prix simples et les prix différenciés
            if (typeof val === 'object' && val.delivery !== undefined && val.pickup !== undefined) {
                // Prix différencié delivery/pickup
                return { qty, priceDelivery: parseFloat(val.delivery), pricePickup: parseFloat(val.pickup), isDifferentiated: true };
            } else {
                // Prix simple
                const price = parseFloat(val);
                return { qty, price, isDifferentiated: false };
            }
        })
        .filter(e => e.qty > 0 && Number.isFinite(e.qty))
        .sort((a, b) => a.qty - b.qty);
    
    entries.forEach(({ qty, price, priceDelivery, pricePickup, isDifferentiated }) => {
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'quantity-bubble';
        bubbleDiv.setAttribute('data-qty', qty);
        bubbleDiv.onclick = () => addToCartWithQuantity(currentProductId, qty);
        
        if (isDifferentiated) {
            // Afficher le prix correspondant au service sélectionné
            const displayPrice = productDetailService === 'pickup' ? pricePickup : priceDelivery;
            const serviceEmoji = productDetailService === 'pickup' ? '🏪' : '📦';
            bubbleDiv.innerHTML = `
                <span class="bubble-qty">${qty}g</span>
                <span class="bubble-price">${serviceEmoji} ${displayPrice.toFixed(2)}€</span>
            `;
        } else {
            // Afficher un seul prix pour les autres produits
            bubbleDiv.innerHTML = `
                <span class="bubble-qty">${qty}g</span>
                <span class="bubble-price">${price.toFixed(2)}€</span>
            `;
        }
        quantityBubblesContainer.appendChild(bubbleDiv);
    });
}

// Fonction pour ouvrir la page de détail produit
function openProductDetail(productId) {
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    // Validation de l'ID du produit
    if (!productId || typeof productId !== 'number' || productId <= 0) {
        return;
    }
    
    const product = Object.values(menuData).flat().find(p => p.id === productId);
    if (!product) {
        return;
    }
    
    // Stocker l'ID du produit actuel
    currentProductId = productId;
    
    // Remplir les informations du produit
    const detailPage = document.getElementById('product-detail-page');
    const detailImg = document.getElementById('detail-product-img');
    const detailVideo = document.getElementById('detail-product-video');
    const detailVideoSource = document.getElementById('detail-video-source');
    const detailEmoji = document.getElementById('detail-product-emoji');
    const mediaThumbVideo = document.getElementById('media-thumb-video');
    const detailName = document.getElementById('detail-product-name');
    const detailDescription = document.getElementById('detail-product-description');
    
    // Sécuriser les données
    const safeName = window.SecurityUtils.sanitizeInput(product.name);
    const safeDescription = window.SecurityUtils.sanitizeInput(product.description);
    const safeEmoji = window.SecurityUtils.sanitizeInput(product.emoji);
    
    // Remplir les éléments
    detailName.textContent = safeName;
    detailDescription.textContent = safeDescription;
    
    // Générer dynamiquement les boutons de quantité basés sur customPrices
    const quantityBubblesContainer = document.querySelector('.quantity-bubbles');
    if (quantityBubblesContainer && product.customPrices) {
        // Vérifier si le produit a des prix différenciés (delivery/pickup)
        const hasDifferentiatedPrices = Object.values(product.customPrices).some(price => 
            typeof price === 'object' && price.delivery !== undefined && price.pickup !== undefined
        );
        
        // Afficher le sélecteur de service seulement si le produit a des prix différenciés
        const serviceSelector = document.getElementById('service-selector');
        if (serviceSelector) {
            if (hasDifferentiatedPrices) {
                serviceSelector.style.display = 'block';
                // Réinitialiser à delivery par défaut
                productDetailService = 'delivery';
                const deliveryBtn = document.getElementById('service-delivery-btn');
                const pickupBtn = document.getElementById('service-pickup-btn');
                if (deliveryBtn && pickupBtn) {
                    deliveryBtn.classList.add('service-btn-active');
                    pickupBtn.classList.remove('service-btn-active');
                }
            } else {
                serviceSelector.style.display = 'none';
            }
        }
        
        // Générer les bulles avec la nouvelle fonction
        regenerateProductBubbles(product);
    } else {
        // Fallback vers l'affichage simple si pas de customPrices
        const serviceSelector = document.getElementById('service-selector');
        if (serviceSelector) {
            serviceSelector.style.display = 'none';
        }
        
        if (quantityBubblesContainer) {
            quantityBubblesContainer.innerHTML = '';
        }
    }
    
    // Gérer l'image
    detailImg.setAttribute('data-error', '0');
    detailImg.style.display = 'block';
    detailImg.src = product.image;
    detailImg.alt = safeName;
    detailImg.onload = function() {
        this.setAttribute('data-error', '0');
        adjustDetailImageDisplay(this);
    };
    detailImg.onerror = function() {
        this.setAttribute('data-error', '1');
        this.style.display = 'none';
        if (currentDetailMedia === 'image') {
            detailEmoji.style.display = 'flex';
        }
        detailEmoji.textContent = safeEmoji;
    };

    const playableVideoUrl = getPlayableVideoUrl(product.video);
    if (playableVideoUrl && detailVideo && detailVideoSource && mediaThumbVideo) {
        detailVideoSource.src = playableVideoUrl;
        detailVideo.load();
        detailVideo.style.display = 'none';
        mediaThumbVideo.style.display = 'inline-flex';
    } else if (detailVideo && detailVideoSource && mediaThumbVideo) {
        detailVideo.pause();
        detailVideo.currentTime = 0;
        detailVideoSource.src = '';
        detailVideo.load();
        detailVideo.style.display = 'none';
        mediaThumbVideo.style.display = 'none';
    }

    switchDetailMedia('image');
    
    // Masquer le menu principal et afficher la page de détail
    document.querySelector('main').style.display = 'none';
    document.querySelector('.category-nav').style.display = 'none';
    detailPage.style.display = 'block';
    
    // Log de sécurité
    window.SecurityUtils.securityLog('product_detail_opened', { productId: productId });
}

// Nouvelle fonction pour ajouter au panier avec quantité spécifique
function addToCartWithQuantity(productId, quantity) {
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    // Validation des paramètres
    if (!productId || typeof productId !== 'number' || productId <= 0) {
        return;
    }
    
    const validQuantity = window.SecurityUtils.validateQuantity(quantity);
    
    const product = Object.values(menuData).flat().find(p => p.id === productId);
    if (!product) {
        return;
    }
    
    // Ajouter la quantité spécifiée au panier
    const existingItem = cart.find(item => item.id === productId);
    
    if (existingItem) {
        // Ajouter la quantité
        existingItem.quantity = existingItem.quantity + validQuantity;
        // Mettre à jour le service aussi si le produit a des prix différenciés
        const hasDifferentiatedPrices = Object.values(product.customPrices || {}).some(price => 
            typeof price === 'object' && price.delivery !== undefined && price.pickup !== undefined
        );
        if (hasDifferentiatedPrices) {
            existingItem.selectedService = productDetailService;
        }
    } else {
        const newItem = { ...product, quantity: validQuantity };
        // Enregistrer le service sélectionné pour les produits avec prix différenciés
        const hasDifferentiatedPrices = Object.values(product.customPrices || {}).some(price => 
            typeof price === 'object' && price.delivery !== undefined && price.pickup !== undefined
        );
        if (hasDifferentiatedPrices) {
            newItem.selectedService = productDetailService;
        }
        cart.push(newItem);
    }
    
    // Mettre à jour l'affichage du panier
    updateCartDisplay();
    
    // Afficher un message de confirmation
    const productName = window.SecurityUtils.sanitizeInput(product.name);
    showNotification(`${validQuantity} x ${productName} ajouté(s) au panier !`);
    
    // Feedback haptique
    if (tg.HapticFeedback) {
        tg.HapticFeedback.impactOccurred('medium');
    }
    
    // Log de sécurité
    window.SecurityUtils.securityLog('add_to_cart_quantity', { 
        productId: productId, 
        quantity: validQuantity,
        productName: product.name 
    });
}

// Fonction pour fermer la page de détail produit
function closeProductDetail() {
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    const detailPage = document.getElementById('product-detail-page');
    const detailVideo = document.getElementById('detail-product-video');
    const detailVideoSource = document.getElementById('detail-video-source');

    if (detailVideo && detailVideoSource) {
        detailVideo.pause();
        detailVideo.currentTime = 0;
        detailVideoSource.src = '';
        detailVideo.load();
    }
    
    // Masquer la page de détail et afficher le menu principal
    detailPage.style.display = 'none';
    document.querySelector('main').style.display = 'block';
    document.querySelector('.category-nav').style.display = 'flex';
    
    // Réafficher le panier s'il contient des éléments
    if (cart.length > 0) {
        const cartSummary = document.getElementById('cart-summary');
        if (cartSummary) {
            cartSummary.style.display = 'block';
        }
    }
    
    // Log de sécurité
    window.SecurityUtils.securityLog('product_detail_closed', {});
}

// Fonction pour ajouter au panier (VERSION SÉCURISÉE)
function addToCart(productId) {
    // Vérification du rate limiting
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    // Validation de l'ID du produit
    if (!productId || typeof productId !== 'number' || productId <= 0) {
        return;
    }
    
    // Vérification de la limite du panier
    if (cart.length >= 50) {
        if (tg.showAlert) {
            tg.showAlert('Panier plein ! Maximum 50 articles.');
        }
        return;
    }
    
    const product = Object.values(menuData).flat().find(p => p.id === productId);
    if (!product) {
        return;
    }
    
    const existingItem = cart.find(item => item.id === productId);
    
    if (existingItem) {
        // Pas de limite de quantité
        existingItem.quantity += 1;
    } else {
        cart.push({ ...product, quantity: 1 });
    }
    
    updateCartDisplay();
    
    // Feedback haptique
    if (tg.HapticFeedback) {
        tg.HapticFeedback.impactOccurred('medium');
    }
    
    // Animation du bouton
    const btn = event.target;
    if (btn) {
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => {
            btn.style.transform = 'scale(1)';
        }, 150);
    }
    
    // Log de sécurité
    window.SecurityUtils.securityLog('add_to_cart', { productId: productId, productName: product.name });
}

// Fonction pour mettre à jour l'affichage du panier (VERSION SÉCURISÉE)
function updateCartDisplay() {
    if (cart.length === 0) {
        cartSummary.style.display = 'none';
        renderCartPage();
        renderProfilePage();
        return;
    }
    
    // Vérification de sécurité sur le panier
    if (cart.length > 50) {
        cart = cart.slice(0, 50);
    }
    
    cartSummary.style.display = 'block';
    
    let html = '';
    let total = 0;
    
    cart.forEach(item => {
        // Validation des données de l'article
        const safeName = window.SecurityUtils.sanitizeInput(item.name || '');
        const safePrice = parseFloat(item.price) || 0;
        const safeQuantity = window.SecurityUtils.validateQuantity(item.quantity);
        const safeEmoji = window.SecurityUtils.sanitizeInput(item.emoji || '🍽️');
        
        if (safePrice <= 0 || safeQuantity <= 0) {
            return;
        }
        
        // Utiliser la fonction helper pour obtenir le prix correct selon le service
        let itemTotal = getPriceForService(item, safeQuantity, currentOrderType);
        total += itemTotal;
        
        // Calculer le prix unitaire effectif
        let unitPrice = itemTotal / safeQuantity;
        
        html += `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-name">${safeEmoji} ${safeName}</div>
                    <div class="cart-item-price">Quantité: ${safeQuantity} - Prix: ${itemTotal.toFixed(2)}€</div>
                </div>
                <div class="cart-item-controls">
                    <button class="quantity-btn" onclick="updateQuantity(${item.id}, -1)">−</button>
                    <span class="quantity-display">${safeQuantity}</span>
                    <button class="quantity-btn" onclick="updateQuantity(${item.id}, 1)">+</button>
                </div>
            </div>
        `;
    });
    
    // Validation du total
    if (total > 10000) {
        if (tg.showAlert) {
            tg.showAlert('Erreur dans le calcul du total.');
        }
        return;
    }
    
    cartItems.innerHTML = html;
    cartTotal.textContent = total.toFixed(2) + '€';
    renderCartPage();
    renderProfilePage();
    
    window.SecurityUtils.securityLog('cart_update', { itemCount: cart.length, total: total });
}

function getPlayableVideoUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';

    const clean = rawUrl.trim();
    if (!clean) return '';
    if (clean.includes('youtube.com') || clean.includes('youtu.be')) return '';

    if (clean.includes('imgur.com') && !clean.includes('i.imgur.com')) {
        let id = '';
        if (clean.includes('/a/')) {
            id = clean.split('/a/')[1].split('?')[0].split('/')[0];
        } else {
            const match = clean.match(/imgur\.com\/([a-zA-Z0-9]+)/);
            if (match) id = match[1];
        }
        return id ? `https://i.imgur.com/${id}.mp4` : '';
    }

    if (clean.endsWith('.gifv')) {
        return clean.replace('.gifv', '.mp4');
    }

    return clean;
}

function switchDetailMedia(mode) {
    const detailImg = document.getElementById('detail-product-img');
    const detailEmoji = document.getElementById('detail-product-emoji');
    const detailVideo = document.getElementById('detail-product-video');
    const thumbImage = document.getElementById('media-thumb-image');
    const thumbVideo = document.getElementById('media-thumb-video');

    if (!detailImg || !detailEmoji || !detailVideo || !thumbImage || !thumbVideo) return;

    const product = Object.values(menuData).flat().find(p => p.id === currentProductId);
    const hasVideo = !!(product && getPlayableVideoUrl(product.video));

    if (mode === 'video' && hasVideo) {
        currentDetailMedia = 'video';
        detailImg.style.display = 'none';
        detailEmoji.style.display = 'none';
        detailVideo.style.display = 'block';
        thumbImage.classList.remove('media-thumb-active');
        thumbVideo.classList.add('media-thumb-active');
        detailVideo.play().catch(() => {});
        return;
    }

    currentDetailMedia = 'image';
    detailVideo.pause();
    detailVideo.currentTime = 0;
    detailVideo.style.display = 'none';
    thumbVideo.classList.remove('media-thumb-active');
    thumbImage.classList.add('media-thumb-active');

    if (detailImg.getAttribute('data-error') === '1') {
        detailImg.style.display = 'none';
        detailEmoji.style.display = 'flex';
    } else {
        detailImg.style.display = 'block';
        detailEmoji.style.display = 'none';
    }
}

// Fonction pour vider complètement le panier (VERSION SÉCURISÉE)
function clearCart() {
    // Vérification du rate limiting
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    // Demander confirmation avant de vider le panier
    if (cart.length === 0) {
        if (tg.showAlert) {
            tg.showAlert('Le panier est déjà vide.');
        }
        return;
    }
    
    // Confirmation avec l'utilisateur
    if (tg.showConfirm) {
        tg.showConfirm('Êtes-vous sûr de vouloir vider complètement votre panier ?', function(confirmed) {
            if (confirmed) {
                performClearCart();
            }
        });
    } else {
        // Fallback si showConfirm n'est pas disponible
        if (confirm('Êtes-vous sûr de vouloir vider complètement votre panier ?')) {
            performClearCart();
        }
    }
}

// Fonction interne pour effectuer le vidage du panier
function performClearCart() {
    const itemCount = cart.length;
    cart = [];
    updateCartDisplay();
    
    // Feedback haptique
    if (tg.HapticFeedback) {
        tg.HapticFeedback.notificationOccurred('success');
    }
    
    // Log de sécurité
    window.SecurityUtils.securityLog('cart_cleared', { previousItemCount: itemCount });
}

// Fonction pour mettre à jour la quantité (VERSION SÉCURISÉE)
function updateQuantity(productId, change) {
    // Vérification du rate limiting
    if (!window.SecurityUtils.checkRateLimit()) {
        return;
    }
    
    // Validation des paramètres
    const safeProductId = parseInt(productId);
    const safeChange = parseInt(change);
    
    if (!safeProductId || safeProductId !== productId || safeProductId <= 0) {
        return;
    }
    
    if (isNaN(safeChange) || Math.abs(safeChange) > 5) {
        return;
    }
    
    const item = cart.find(item => item.id === productId);
    if (!item) {
        return;
    }
    
    const newQuantity = item.quantity + safeChange;
    
    // Vérifications de sécurité sur la nouvelle quantité
    if (newQuantity < 0) {
        return;
    }
    
    // Pas de limite de quantité maximale
    
    item.quantity = newQuantity;
    
    if (item.quantity <= 0) {
        cart = cart.filter(cartItem => cartItem.id !== productId);
        window.SecurityUtils.securityLog('item_removed', { productId: productId });
    } else {
        window.SecurityUtils.securityLog('quantity_updated', { productId: productId, newQuantity: newQuantity });
    }
    
    updateCartDisplay();
    
    if (tg.HapticFeedback) {
        tg.HapticFeedback.impactOccurred('light');
    }
}

// Fonction pour formater le message de commande (SÉCURISÉE)
function formatOrderMessage(orderData, orderType = 'delivery') {
    const safeAddress = window.SecurityUtils.sanitizeInput(orderData.deliveryAddress);
    const safeTotal = parseFloat(orderData.total) || 0;
    
    if (safeTotal <= 0 || safeTotal > 10000) {
        return null;
    }
    
    let orderText = '';
    
    if (orderType === 'pickup') {
        // Message pour "Sur place"
        const arrivalTime = orderData.arrivalTime || 'Non spécifiée';
        orderText = `🛒 NOUVELLE COMMANDE - SUR PLACE\n\n` +
            `🕐 Heure d'arrivée: ${arrivalTime}\n\n` +
            `📋 Détails de la commande:\n` +
            orderData.items.map(item => {
                const safeName = window.SecurityUtils.sanitizeInput(item.name);
                const safeQty = window.SecurityUtils.validateQuantity(item.quantity);
                const safeItemTotal = parseFloat(item.total) || 0;
                return `• ${safeName} x${safeQty} = ${safeItemTotal.toFixed(2)}€`;
            }).join('\n') +
            `\n\n💰 TOTAL: ${safeTotal.toFixed(2)}€\n` +
            `🕐 Commandé le: ${new Date(orderData.timestamp).toLocaleString('fr-FR')}`;
    } else {
        // Message pour "Livraison"
        orderText = `🛒 NOUVELLE COMMANDE\n\n` +
            `📍 Adresse de livraison: ${safeAddress}\n\n` +
            `📋 Détails de la commande:\n` +
            orderData.items.map(item => {
                const safeName = window.SecurityUtils.sanitizeInput(item.name);
                const safeQty = window.SecurityUtils.validateQuantity(item.quantity);
                const safeItemTotal = parseFloat(item.total) || 0;
                return `• ${safeName} x${safeQty} = ${safeItemTotal.toFixed(2)}€`;
            }).join('\n') +
            `\n\n💰 TOTAL: ${safeTotal.toFixed(2)}€\n` +
            `🕐 Commandé le: ${new Date(orderData.timestamp).toLocaleString('fr-FR')}`;
    }
    
    return encodeURIComponent(orderText);
}

// Fonction pour afficher les notifications (SÉCURISÉE)
function showNotification(message) {
    const safeMessage = window.SecurityUtils.sanitizeInput(message);
    
    if (safeMessage.length > 200) {
        return;
    }
    
    // Utiliser l'API Telegram si disponible
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.showAlert) {
        window.Telegram.WebApp.showAlert(safeMessage);
    } else {
        // Fallback pour les tests en dehors de Telegram
        alert(safeMessage);
    }
    
    // Ajouter un effet de vibration si disponible
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
    }
}

// Fonction pour préparer les données de commande (SÉCURISÉE)
function prepareOrderData(deliveryAddress, orderType = 'delivery', arrivalTime = '') {
    const safeAddress = window.SecurityUtils.sanitizeInput(deliveryAddress);
    
    // Pour le type "Sur place", l'adresse n'est pas obligatoire
    if (orderType === 'delivery') {
        if (safeAddress.length < 10 || safeAddress.length > 200) {
            return null;
        }
    }
    
    const total = cart.reduce((sum, item) => {
        // Utiliser la fonction helper pour obtenir le prix correct selon le service
        let itemTotal = getPriceForService(item, item.quantity, orderType);
        return sum + itemTotal;
    }, 0);
    
    if (total <= 0 || total > 10000) {
        return null;
    }
    
    const orderData = {
        items: cart.map(item => {
            const safePrice = parseFloat(item.price) || 0;
            const safeQty = window.SecurityUtils.validateQuantity(item.quantity);
            
            // Utiliser la fonction helper pour obtenir le prix correct selon le service
            let itemTotal = getPriceForService(item, safeQty, orderType);
            
            return {
                name: window.SecurityUtils.sanitizeInput(item.name),
                quantity: safeQty,
                price: safePrice,
                total: itemTotal
            };
        }),
        total: total,
        deliveryAddress: orderType === 'pickup' ? 'Sur place' : safeAddress,
        orderType: orderType,
        timestamp: Date.now()
    };
    
    // Ajouter l'heure d'arrivée si c'est une commande "Sur place"
    if (orderType === 'pickup' && arrivalTime) {
        orderData.arrivalTime = arrivalTime;
    }
    
    return orderData;
}

// Fonction pour envoyer la commande au restaurant (SÉCURISÉE)
function sendOrderToRestaurant(orderData, orderType = 'delivery') {
    if (!orderData) {
        return;
    }
    
    const message = formatOrderMessage(orderData, orderType);
    if (!message) {
        return;
    }
    
    // Utiliser adminConfig.telegram_username si disponible, sinon restaurantUsername
    const username = (adminConfig && adminConfig.telegram_username) ? adminConfig.telegram_username : restaurantUsername;
    const telegramUrl = `https://t.me/${username}?text=${message}`;
    
    // Validation de l'URL
    try {
        new URL(telegramUrl);
    } catch (e) {
        return;
    }
    
    window.SecurityUtils.securityLog('order_sent', { 
        total: orderData.total, 
        itemCount: orderData.items.length,
        orderType: orderType
    });
    
    window.open(telegramUrl, '_blank');
}

// Fonction pour afficher le modal d'adresse moderne (SÉCURISÉE)
function showAddressModal() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('address-modal');
        const input = document.getElementById('address-input');
        const confirmBtn = document.getElementById('confirm-address');
        const cancelBtn = document.getElementById('cancel-address');
        
        if (!modal || !input || !confirmBtn || !cancelBtn) {
            reject(new Error('Éléments du modal non trouvés'));
            return;
        }
        
        // Réinitialiser le modal
        input.value = '';
        confirmBtn.disabled = true;
        modal.style.display = 'flex';
        
        // Focus sur l'input
        setTimeout(() => input.focus(), 100);
        
        // Validation en temps réel
        function validateInput() {
            const address = window.SecurityUtils.sanitizeInput(input.value.trim());
            confirmBtn.disabled = address.length < 15;
        }
        
        input.addEventListener('input', validateInput);
        
        // Gestion de la confirmation
        function handleConfirm() {
            const address = window.SecurityUtils.sanitizeInput(input.value.trim());
            
            if (address.length < 15) {
                if (tg.showAlert) {
                    tg.showAlert('L\'adresse doit contenir au moins 15 caractères.');
                }
                return;
            }
            
            if (address.length > 200) {
                if (tg.showAlert) {
                    tg.showAlert('L\'adresse est trop longue (max 200 caractères).');
                }
                return;
            }
            
            cleanup();
            modal.style.display = 'none';
            window.SecurityUtils.securityLog('address_confirmed', { addressLength: address.length });
            resolve(address);
        }
        
        // Gestion de l'annulation
        function handleCancel() {
            cleanup();
            modal.style.display = 'none';
            window.SecurityUtils.securityLog('address_cancelled', {});
            reject(new Error('Adresse annulée par l\'utilisateur'));
        }
        
        // Nettoyage des event listeners
        function cleanup() {
            input.removeEventListener('input', validateInput);
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            input.removeEventListener('keypress', handleKeyPress);
            modal.removeEventListener('click', handleModalClick);
        }
        
        // Gestion des touches
        function handleKeyPress(e) {
            if (e.key === 'Enter' && !confirmBtn.disabled) {
                handleConfirm();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        }
        
        // Fermeture en cliquant à l'extérieur
        function handleModalClick(e) {
            if (e.target === modal) {
                handleCancel();
            }
        }
        
        // Ajouter les event listeners
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        input.addEventListener('keypress', handleKeyPress);
        modal.addEventListener('click', handleModalClick);
    });
}

// Fonction pour afficher le modal de type de commande (SÉCURISÉE)
function showOrderTypeModal() {
    console.log('showOrderTypeModal appelé');
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('order-type-modal');
        const pickupBtn = document.getElementById('pickup-btn');
        const deliveryBtn = document.getElementById('delivery-btn');
        
        console.log('Modal:', modal, 'Pickup:', pickupBtn, 'Delivery:', deliveryBtn);
        
        if (!modal || !pickupBtn || !deliveryBtn) {
            console.error('Éléments du modal non trouvés');
            reject(new Error('Éléments du modal non trouvés'));
            return;
        }
        
        // Afficher le modal
        modal.style.display = 'flex';
        
        // Gestion du bouton "Sur place"
        function handlePickup() {
            cleanup();
            modal.style.display = 'none';
            currentOrderType = 'pickup'; // Mettre à jour le type de service sélectionné
            // Synchroniser le service pour tous les items du panier avec prix différenciés
            cart.forEach(item => {
                const hasDifferentiatedPrices = Object.values(item.customPrices || {}).some(price => 
                    typeof price === 'object' && price.delivery !== undefined && price.pickup !== undefined
                );
                if (hasDifferentiatedPrices) {
                    item.selectedService = 'pickup';
                }
            });
            updateCartDisplay(); // Rafraîchir l'affichage du panier avec les nouveaux prix
            window.SecurityUtils.securityLog('order_type_selected', { type: 'pickup' });
            resolve('pickup');
        }
        
        // Gestion du bouton "Livraison"
        function handleDelivery() {
            cleanup();
            modal.style.display = 'none';
            currentOrderType = 'delivery'; // Mettre à jour le type de service sélectionné
            // Synchroniser le service pour tous les items du panier avec prix différenciés
            cart.forEach(item => {
                const hasDifferentiatedPrices = Object.values(item.customPrices || {}).some(price => 
                    typeof price === 'object' && price.delivery !== undefined && price.pickup !== undefined
                );
                if (hasDifferentiatedPrices) {
                    item.selectedService = 'delivery';
                }
            });
            updateCartDisplay(); // Rafraîchir l'affichage du panier avec les nouveaux prix
            window.SecurityUtils.securityLog('order_type_selected', { type: 'delivery' });
            resolve('delivery');
        }
        
        // Nettoyage des event listeners
        function cleanup() {
            pickupBtn.removeEventListener('click', handlePickup);
            deliveryBtn.removeEventListener('click', handleDelivery);
            modal.removeEventListener('click', handleModalClick);
        }
        
        // Fermeture en cliquant à l'extérieur
        function handleModalClick(e) {
            if (e.target === modal) {
                cleanup();
                modal.style.display = 'none';
                window.SecurityUtils.securityLog('order_type_cancelled', {});
                reject(new Error('Choix de commande annulé'));
            }
        }
        
        // Ajouter les event listeners
        pickupBtn.addEventListener('click', handlePickup);
        deliveryBtn.addEventListener('click', handleDelivery);
        modal.addEventListener('click', handleModalClick);
    });
}

// Fonction pour afficher le modal d'heure d'arrivée (SÉCURISÉE)
function showArrivalTimeModal() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('arrival-time-modal');
        const timeInput = document.getElementById('arrival-time-input');
        const confirmBtn = document.getElementById('confirm-time');
        const cancelBtn = document.getElementById('cancel-time');
        
        if (!modal || !timeInput || !confirmBtn || !cancelBtn) {
            reject(new Error('Éléments du modal non trouvés'));
            return;
        }
        
        // Afficher le modal
        modal.style.display = 'flex';
        
        // Focus sur l'input
        setTimeout(() => timeInput.focus(), 100);
        
        // Gestion de la confirmation
        function handleConfirm() {
            const arrivalTime = timeInput.value.trim();
            
            if (!arrivalTime) {
                if (tg.showAlert) {
                    tg.showAlert('Veuillez sélectionner une heure d\'arrivée.');
                }
                return;
            }
            
            cleanup();
            modal.style.display = 'none';
            window.SecurityUtils.securityLog('arrival_time_confirmed', { time: arrivalTime });
            resolve(arrivalTime);
        }
        
        // Gestion de l'annulation
        function handleCancel() {
            cleanup();
            modal.style.display = 'none';
            window.SecurityUtils.securityLog('arrival_time_cancelled', {});
            reject(new Error('Heure d\'arrivée annulée par l\'utilisateur'));
        }
        
        // Nettoyage des event listeners
        function cleanup() {
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            timeInput.removeEventListener('keypress', handleKeyPress);
            modal.removeEventListener('click', handleModalClick);
        }
        
        // Gestion des touches
        function handleKeyPress(e) {
            if (e.key === 'Enter') {
                handleConfirm();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        }
        
        // Fermeture en cliquant à l'extérieur
        function handleModalClick(e) {
            if (e.target === modal) {
                handleCancel();
            }
        }
        
        // Ajouter les event listeners
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        timeInput.addEventListener('keypress', handleKeyPress);
        modal.addEventListener('click', handleModalClick);
    });
}

// Fonction de checkout (VERSION SÉCURISÉE)
async function checkout() {
    console.log('Checkout appelé', cart);
    
    // Vérification du rate limiting
    if (!window.SecurityUtils.checkRateLimit()) {
        console.log('Rate limit atteint');
        return;
    }
    
    // Validation du panier
    if (!cart || cart.length === 0) {
        console.log('Panier vide');
        if (tg.showAlert) {
            tg.showAlert('Votre panier est vide.');
        } else {
            alert('Votre panier est vide.');
        }
        return;
    }
    
    if (cart.length > 50) {
        if (tg.showAlert) {
            tg.showAlert('Panier trop volumineux. Veuillez réduire le nombre d\'articles.');
        }
        return;
    }
    
    // Validation des articles du panier
    const validCart = cart.filter(item => {
        const validPrice = parseFloat(item.price) > 0;
        const validQuantity = parseFloat(item.quantity) > 0;
        const validName = item.name && item.name.trim().length > 0;
        
        return validPrice && validQuantity && validName;
    });
    
    if (validCart.length !== cart.length) {
        cart = validCart;
        updateCartDisplay();
    }
    
    if (cart.length === 0) {
        if (tg.showAlert) {
            tg.showAlert('Aucun article valide dans le panier.');
        }
        return;
    }
    
    try {
        // Afficher la modal de choix du type de commande
        const orderType = await showOrderTypeModal();
        
        // Feedback haptique
        if (tg.HapticFeedback) {
            tg.HapticFeedback.impactOccurred('heavy');
        }
        
        let deliveryAddress = '';
        let arrivalTime = '';
        
        // Si Sur place, demander l'heure d'arrivée
        if (orderType === 'pickup') {
            arrivalTime = await showArrivalTimeModal();
        }
        // Si livraison, demander l'adresse
        else if (orderType === 'delivery') {
            deliveryAddress = await showAddressModal();
        }
        
        // Préparer les données de commande
        const orderData = prepareOrderData(deliveryAddress, orderType, arrivalTime);
        if (!orderData) {
            if (tg.showAlert) {
                tg.showAlert('Erreur lors de la préparation de la commande.');
            }
            return;
        }
        
        // Envoyer la commande
        sendOrderToRestaurant(orderData, orderType);
        
        // Vider le panier après envoi
        cart = [];
        updateCartDisplay();
        
        window.SecurityUtils.securityLog('checkout_completed', { 
            total: orderData.total,
            itemCount: orderData.items.length,
            orderType: orderType
        });
        
    } catch (error) {
        if (error.message !== 'Adresse annulée par l\'utilisateur' && error.message !== 'Choix de commande annulé') {
            if (tg.showAlert) {
                tg.showAlert('Une erreur s\'est produite. Veuillez réessayer.');
            }
        }
        window.SecurityUtils.securityLog('checkout_error', { error: error.message });
    }
}

// Initialisation sécurisée de l'application
document.addEventListener('DOMContentLoaded', async function() {
    try {
        const intro = document.getElementById('intro-screen');
        if (intro) {
            window.setTimeout(() => {
                document.body.classList.add('app-ready');
            }, 1150);
        }

        // Charger la configuration en premier
        await loadConfig();
        
        // Initialiser les variables DOM
        userInfo = document.getElementById('user-info');
        menuGrid = document.getElementById('menu-grid');
        cartSummary = document.getElementById('cart-summary');
        cartItems = document.getElementById('cart-items');
        cartTotal = document.getElementById('cart-total');
        checkoutBtn = document.getElementById('checkout-btn');
        
        // Vérifier que tous les éléments sont présents
        const requiredElements = [menuGrid, cartSummary, cartItems, cartTotal, checkoutBtn];
        const missingElements = requiredElements.filter(el => !el);
        
        if (missingElements.length > 0) {
            return;
        }
        
        // Afficher les informations utilisateur
        if (userInfo) {
            displayUserInfo();
        }
        
        // Afficher les produits (après chargement de la config)
        displayProducts();
        
        // Générer les boutons de catégories dynamiquement
        displayCategoryButtons();
        
        // Ajouter les event listeners pour les catégories (après génération)
        categoryBtns = document.querySelectorAll('.category-btn');
        categoryBtns.forEach(btn => {
            btn.addEventListener('click', function() {
                const category = this.dataset.category;
                filterByCategory(category);
            });
        });
        
        // Event listener pour le checkout
        if (checkoutBtn) {
            checkoutBtn.addEventListener('click', checkout);
        }
        
        // Event listener pour vider le panier
        const clearCartBtn = document.getElementById('clear-cart-btn');
        if (clearCartBtn) {
            clearCartBtn.addEventListener('click', clearCart);
        }
        
        // Initialiser l'affichage du panier
        updateCartDisplay();
        
        // Initialiser les pages secondaires
        refreshContactPage();
        renderProfilePage();
        renderCartPage();

        // Initialiser la navigation en bas
        initBottomNavigation();
        
        // Ne PAS nettoyer le localStorage - il doit persister
        // Les données restent sauvegardées jusqu'à ce qu'elles soient modifiées à nouveau
        
        // Initialiser l'admin
        setTimeout(() => {
            initAdmin();
        }, 500);
        
        window.SecurityUtils.securityLog('app_initialized', { timestamp: Date.now() });
        
    } catch (error) {
        window.SecurityUtils.securityLog('init_error', { error: error.message });
    }
});

// Fonction pour initialiser la navigation en bas
function initBottomNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const container = document.querySelector('.container');
    const infoPage = document.getElementById('info-page');
    const cartPage = document.getElementById('cart-page');
    const reviewsPage = document.getElementById('reviews-page');
    const contactPage = document.getElementById('contact-page');
    const profilePage = document.getElementById('profile-page');
    const adminPage = document.getElementById('admin-page');
    const mainContent = document.querySelector('main');
    const cartSummary = document.querySelector('.cart-summary');
    const categoryNav = document.querySelector('.category-nav');

    function hideAllSubPages() {
        if (infoPage) infoPage.style.display = 'none';
        if (cartPage) cartPage.style.display = 'none';
        if (reviewsPage) reviewsPage.style.display = 'none';
        if (contactPage) contactPage.style.display = 'none';
        if (profilePage) profilePage.style.display = 'none';
        if (adminPage) adminPage.style.display = 'none';
    }

    function showAccueil() {
        container.classList.remove('info-page-active');
        container.classList.remove('admin-page-active');
        hideAllSubPages();
        if (mainContent) mainContent.style.display = 'block';
        if (categoryNav) categoryNav.style.display = 'flex';
        displayCategoryButtons();
        setTimeout(() => displayCategoryButtons(), 60);
        if (cart.length > 0 && cartSummary) {
            cartSummary.style.display = 'block';
        }
    }

    navItems.forEach(item => {
        item.addEventListener('click', function() {
            const page = this.dataset.page;
            
            // Retirer la classe active de tous les éléments
            navItems.forEach(nav => nav.classList.remove('active'));
            
            // Ajouter la classe active à l'élément cliqué
            this.classList.add('active');
            
            // Gérer l'affichage des pages
            switch(page) {
                case 'accueil':
                    showAccueil();
                    break;
                    
                case 'info':
                    hideAllSubPages();
                    container.classList.add('info-page-active');
                    container.classList.remove('admin-page-active');
                    if (infoPage) infoPage.style.display = 'block';
                    if (mainContent) mainContent.style.display = 'none';
                    if (categoryNav) categoryNav.style.display = 'none';
                    if (cartSummary) cartSummary.style.display = 'none';
                    break;

                case 'panier':
                    hideAllSubPages();
                    container.classList.remove('info-page-active');
                    container.classList.remove('admin-page-active');
                    renderCartPage();
                    if (cartPage) cartPage.style.display = 'block';
                    if (mainContent) mainContent.style.display = 'none';
                    if (categoryNav) categoryNav.style.display = 'none';
                    if (cartSummary) cartSummary.style.display = 'none';
                    break;

                case 'avis':
                    hideAllSubPages();
                    container.classList.remove('info-page-active');
                    container.classList.remove('admin-page-active');
                    if (reviewsPage) reviewsPage.style.display = 'block';
                    if (mainContent) mainContent.style.display = 'none';
                    if (categoryNav) categoryNav.style.display = 'none';
                    if (cartSummary) cartSummary.style.display = 'none';
                    break;
                    
                case 'contact':
                    hideAllSubPages();
                    container.classList.remove('info-page-active');
                    container.classList.remove('admin-page-active');
                    refreshContactPage();
                    if (contactPage) contactPage.style.display = 'block';
                    if (mainContent) mainContent.style.display = 'none';
                    if (categoryNav) categoryNav.style.display = 'none';
                    if (cartSummary) cartSummary.style.display = 'none';
                    break;

                case 'profil':
                    hideAllSubPages();
                    container.classList.remove('info-page-active');
                    container.classList.remove('admin-page-active');
                    renderProfilePage();
                    if (profilePage) profilePage.style.display = 'block';
                    if (mainContent) mainContent.style.display = 'none';
                    if (categoryNav) categoryNav.style.display = 'none';
                    if (cartSummary) cartSummary.style.display = 'none';
                    break;

                default:
                    showAccueil();
                    break;
            }
            
            // Ajouter un effet de vibration si disponible
            if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback) {
                window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
            }
        });
    });
}

function getCartTotalValue() {
    return cart.reduce((sum, item) => sum + getPriceForService(item, item.quantity, currentOrderType), 0);
}

function renderCartPage() {
    const cartPageItems = document.getElementById('cart-page-items');
    const cartPageTotal = document.getElementById('cart-page-total');
    if (!cartPageItems || !cartPageTotal) return;

    if (!cart.length) {
        cartPageItems.innerHTML = '<p class="empty-state">Votre panier est vide.</p>';
        cartPageTotal.textContent = 'Total: 0.00€';
        return;
    }

    let html = '';
    cart.forEach(item => {
        const itemTotal = getPriceForService(item, item.quantity, currentOrderType);
        const safeName = window.SecurityUtils.sanitizeInput(item.name);
        const safeQty = window.SecurityUtils.validateQuantity(item.quantity);
        html += `
            <div class="subpage-list-item">
                <div class="subpage-list-title"><strong>${safeName}</strong></div>
                <div class="subpage-list-meta">Quantite: ${safeQty}</div>
                <div class="subpage-list-price">${itemTotal.toFixed(2)}€</div>
            </div>
        `;
    });

    cartPageItems.innerHTML = html;
    cartPageTotal.textContent = `Total: ${getCartTotalValue().toFixed(2)}€`;
}

function renderProfilePage() {
    const user = tg.initDataUnsafe?.user;
    const profileName = document.getElementById('profile-name');
    const profileUsername = document.getElementById('profile-username');
    const profileCartCount = document.getElementById('profile-cart-count');

    if (profileName) {
        profileName.textContent = window.SecurityUtils.sanitizeInput(user?.first_name || 'Utilisateur');
    }

    if (profileUsername) {
        profileUsername.textContent = user?.username ? `@${window.SecurityUtils.sanitizeInput(user.username)}` : '-';
    }

    if (profileCartCount) {
        const count = cart.reduce((sum, item) => sum + window.SecurityUtils.validateQuantity(item.quantity), 0);
        profileCartCount.textContent = String(count);
    }
}

function refreshContactPage() {
    const contactUsername = document.getElementById('contact-username');
    const contactChannel = document.getElementById('contact-channel');
    const username = (adminConfig && adminConfig.telegram_username) ? adminConfig.telegram_username : restaurantUsername;
    const channelUrl = (adminConfig && adminConfig.channel_link) ? adminConfig.channel_link : 'https://t.me/+Z6TsKIv3nvc0Yjhk';

    if (contactUsername) {
        contactUsername.textContent = `@${username}`;
    }

    if (contactChannel) {
        contactChannel.textContent = channelUrl;
    }
}

function openChannelLink() {
    const channelUrl = (adminConfig && adminConfig.channel_link) ? adminConfig.channel_link : 'https://t.me/+Z6TsKIv3nvc0Yjhk';
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) {
        window.Telegram.WebApp.openLink(channelUrl);
    } else {
        window.open(channelUrl, '_blank');
    }
}

function openTelegramContact() {
    const contactMessage = encodeURIComponent('Bonjour, j\'ai une question concernant votre menu.');
    const contactUsername = (adminConfig && adminConfig.telegram_username) ? adminConfig.telegram_username : restaurantUsername;
    const contactUrl = `https://t.me/${contactUsername}?text=${contactMessage}`;

    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.openTelegramLink(contactUrl);
    } else {
        window.open(contactUrl, '_blank');
    }
}

// ==================== PANEL ADMIN ====================

// Variables globales pour l'admin
let adminConfig = {};
let currentEditingProductId = null;
let currentEditingCategoryId = null;
let currentEditingAdminIndex = null;

// Fonction pour vérifier si l'utilisateur est admin
function isAdmin() {
    try {
        const user = tg?.initDataUnsafe?.user;
        if (!user) return false;
        
        const username = user.username?.toLowerCase();
        if (!username) return false;
        
        // Toujours utiliser la source la plus à jour (window.restaurantConfig d'abord)
        const whitelist = (window.restaurantConfig?.admin?.whitelist) || (adminConfig?.whitelist) || [];
        return whitelist.some(admin => admin.toLowerCase() === username);
    } catch (error) {
        return false;
    }
}

// Fonction pour initialiser l'admin
function initAdmin() {
    try {
        // Vérifier si l'utilisateur est admin
        if (isAdmin()) {
            const adminNavItem = document.querySelector('.admin-nav-item');
            if (adminNavItem) {
                adminNavItem.style.display = 'flex';
            }
        }
        
        // Initialiser les onglets admin (seulement si la page admin existe)
        const adminTabs = document.querySelectorAll('.admin-tab');
        if (adminTabs.length > 0) {
            adminTabs.forEach(tab => {
                tab.addEventListener('click', function() {
                    const tabName = this.dataset.tab;
                    switchAdminTab(tabName);
                });
            });
        }
        
        // Charger les données admin (seulement si les champs existent)
        const adminPage = document.getElementById('admin-page');
        if (adminPage) {
            loadAdminData();
        }
    } catch (error) {
        // Ne pas bloquer le reste de l'application
    }
}

// Fonction pour changer d'onglet admin
function switchAdminTab(tabName) {
    // Masquer toutes les sections
    document.querySelectorAll('.admin-section').forEach(section => {
        section.style.display = 'none';
    });
    
    // Retirer active de tous les onglets
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Afficher la section correspondante
    const section = document.getElementById(`admin-${tabName}`);
    if (section) {
        section.style.display = 'block';
    }
    
    // Activer l'onglet
    const tab = document.querySelector(`[data-tab="${tabName}"]`);
    if (tab) {
        tab.classList.add('active');
    }
    
    // Charger les données de la section
    if (tabName === 'products') {
        displayProductsList();
    } else if (tabName === 'categories') {
        displayCategoriesList();
    } else if (tabName === 'settings') {
        // Charger les paramètres admin dans les champs
        loadAdminSettings();
        
            // S'assurer que le bouton Sauvegarder est activé
            const saveBtn = document.getElementById('admin-save-settings-btn');
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.style.opacity = '1';
                saveBtn.style.cursor = 'pointer';
                
                // Ajouter un gestionnaire d'événement pour s'assurer que ça fonctionne
                saveBtn.onclick = function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    saveAdminSettings();
                    return false;
                };
            }
    }
}

// Fonction pour charger les données admin depuis config.json
async function loadAdminData() {
    try {
        // Utiliser la config déjà chargée ou recharger
        if (!adminConfig || Object.keys(adminConfig).length === 0) {
            const response = await fetch('./config.json?t=' + Date.now());
            const config = await response.json();
            adminConfig = config.admin || {};
        }
        
        // Charger les paramètres admin dans les champs
        const usernameField = document.getElementById('admin-telegram-username');
        const channelField = document.getElementById('admin-channel-link');
        const whitelistField = document.getElementById('admin-whitelist');
        
        if (usernameField && adminConfig.telegram_username) {
            usernameField.value = adminConfig.telegram_username;
        }
        if (channelField && adminConfig.channel_link) {
            channelField.value = adminConfig.channel_link;
        }
        if (whitelistField && adminConfig.whitelist && Array.isArray(adminConfig.whitelist)) {
            whitelistField.value = adminConfig.whitelist.join(', ');
        }
    } catch (error) {
        // Ignorer l'erreur
    }
}

// Fonction pour afficher la liste des produits
function displayProductsList() {
    const productsList = document.getElementById('products-list');
    if (!productsList) return;
    
    let html = '';
    Object.keys(menuData).forEach(categoryId => {
        menuData[categoryId].forEach(product => {
            html += `
                <div class="admin-item">
                    <div class="admin-item-info">
                        <div class="admin-item-name">${product.emoji || '📦'} ${product.name}</div>
                        <div class="admin-item-details">${product.category} - ${product.price}€</div>
                    </div>
                    <div class="admin-item-actions">
                        <button class="admin-btn admin-btn-edit" onclick="editProduct(${product.id})">✏️ Modifier</button>
                        <button class="admin-btn admin-btn-delete" onclick="deleteProduct(${product.id})">🗑️ Supprimer</button>
                    </div>
                </div>
            `;
        });
    });
    
    productsList.innerHTML = html || '<p style="color: #ccc; text-align: center;">Aucun produit</p>';
}

// Fonction pour afficher la liste des catégories
async function displayCategoriesList() {
    const categoriesList = document.getElementById('categories-list');
    if (!categoriesList) return;
    
    // Utiliser directement categoriesData (variable globale, comme menuData pour les produits)
    const categories = categoriesData || {};
    
    let html = '';
    Object.keys(categories).forEach(categoryId => {
        const category = categories[categoryId];
        html += `
            <div class="admin-item">
                <div class="admin-item-info">
                    <div class="admin-item-name">${category.emoji || '📁'} ${category.name}</div>
                    <div class="admin-item-details">ID: ${categoryId}</div>
                </div>
                <div class="admin-item-actions">
                    <button class="admin-btn admin-btn-edit" onclick="editCategory('${categoryId}')">✏️ Modifier</button>
                    <button class="admin-btn admin-btn-delete" onclick="deleteCategory('${categoryId}')">🗑️ Supprimer</button>
                </div>
            </div>
        `;
    });
    
    categoriesList.innerHTML = html || '<p style="color: #ccc; text-align: center;">Aucune catégorie</p>';
}

// Fonction pour ouvrir le modal d'ajout de produit
function openAddProductModal() {
    currentEditingProductId = null;
    document.getElementById('product-modal-title').textContent = 'Ajouter un Produit';
    
    // Réinitialiser le formulaire
    document.getElementById('product-name').value = '';
    document.getElementById('product-description').value = '';
    document.getElementById('product-price').value = '';
    document.getElementById('product-emoji').value = '';
    document.getElementById('product-image').value = '';
    document.getElementById('product-video-url').value = '';
    document.getElementById('product-isNew').checked = false;
    document.getElementById('product-isPromo').checked = false;
    document.getElementById('product-custom-prices').value = '';
    
    // Charger les catégories
    loadCategoriesForSelect();
    
    document.getElementById('product-modal').style.display = 'flex';
}

// Fonction pour éditer un produit
function editProduct(productId) {
    const product = Object.values(menuData).flat().find(p => p.id === productId);
    if (!product) return;
    
    currentEditingProductId = productId;
    document.getElementById('product-modal-title').textContent = 'Modifier le Produit';
    
    // Remplir le formulaire
    document.getElementById('product-name').value = product.name || '';
    document.getElementById('product-description').value = product.description || '';
    document.getElementById('product-price').value = product.price || '';
    document.getElementById('product-emoji').value = product.emoji || '';
    document.getElementById('product-image').value = product.image || '';
    document.getElementById('product-video-url').value = product.video || '';
    document.getElementById('product-isNew').checked = product.isNew || false;
    document.getElementById('product-isPromo').checked = product.isPromo || false;
    
    // Formater les prix personnalisés
    if (product.customPrices) {
        const customPricesStr = Object.entries(product.customPrices)
            .map(([qty, price]) => `${qty}=${price}`)
            .join(', ');
        document.getElementById('product-custom-prices').value = customPricesStr;
    }
    
    // Charger les catégories
    loadCategoriesForSelect();
    
    // Mettre à jour l'affichage du select personnalisé après chargement
    setTimeout(() => {
        const select = document.getElementById('product-category');
        const displayElement = document.getElementById('product-category-display');
        if (select && displayElement && product.category) {
            select.value = product.category;
            const selectedOption = select.options[select.selectedIndex];
            if (selectedOption) {
                displayElement.textContent = selectedOption.textContent;
            }
        }
    }, 100);
    
    document.getElementById('product-modal').style.display = 'flex';
}

// Fonction pour charger les catégories dans le select
async function loadCategoriesForSelect() {
    const select = document.getElementById('product-category');
    const customSelect = document.getElementById('product-category-select');
    const optionsContainer = document.getElementById('product-category-options');
    const displayElement = document.getElementById('product-category-display');
    
    if (!select || !customSelect || !optionsContainer || !displayElement) return;
    
    // Utiliser directement categoriesData (variable globale, comme menuData pour les produits)
    const categories = categoriesData || {};
    
    // Vider les options
    optionsContainer.innerHTML = '';
    select.innerHTML = '<option value="">-- Sélectionner une catégorie --</option>';
    
    // Créer les options personnalisées
    Object.keys(categories).forEach(categoryId => {
        const category = categories[categoryId];
        const optionText = `${category.emoji || ''} ${category.name}`;
        
        // Option pour le select caché
        const option = document.createElement('option');
        option.value = categoryId;
        option.textContent = optionText;
        select.appendChild(option);
        
        // Option pour le select personnalisé
        const customOption = document.createElement('div');
        customOption.className = 'custom-select-option';
        customOption.dataset.value = categoryId;
        customOption.textContent = optionText;
        customOption.addEventListener('click', function() {
            select.value = categoryId;
            displayElement.textContent = optionText;
            customSelect.classList.remove('active');
            optionsContainer.style.display = 'none';
        });
        optionsContainer.appendChild(customOption);
    });
    
    // Gérer le clic sur le trigger
    const trigger = customSelect.querySelector('.custom-select-trigger');
    if (trigger) {
        trigger.onclick = function(e) {
            e.stopPropagation();
            const isActive = customSelect.classList.contains('active');
            if (isActive) {
                customSelect.classList.remove('active');
                optionsContainer.style.display = 'none';
            } else {
                customSelect.classList.add('active');
                optionsContainer.style.display = 'block';
            }
        };
    }
    
    // Fermer quand on clique ailleurs
    document.addEventListener('click', function(e) {
        if (!customSelect.contains(e.target)) {
            customSelect.classList.remove('active');
            optionsContainer.style.display = 'none';
        }
    });
    
    // Mettre à jour l'affichage si une valeur est déjà sélectionnée
    if (select.value) {
        const selectedOption = select.options[select.selectedIndex];
        if (selectedOption) {
            displayElement.textContent = selectedOption.textContent;
        }
    } else {
        displayElement.textContent = '-- Sélectionner une catégorie --';
    }
}

// Fonction pour sauvegarder un produit
async function saveProduct() {
    const name = document.getElementById('product-name').value.trim();
    const description = document.getElementById('product-description').value.trim();
    const price = parseFloat(document.getElementById('product-price').value);
    const emoji = document.getElementById('product-emoji').value.trim();
    const image = document.getElementById('product-image').value.trim();
    const video = document.getElementById('product-video-url').value.trim();
    const category = document.getElementById('product-category').value;
    const isNew = document.getElementById('product-isNew').checked;
    const isPromo = document.getElementById('product-isPromo').checked;
    const customPricesStr = document.getElementById('product-custom-prices').value.trim();
    
    // Validation
    if (!name || !price || !category) {
        showNotification('Veuillez remplir tous les champs obligatoires');
        return;
    }
    
    // Parser les prix personnalisés
    const customPrices = {};
    if (customPricesStr) {
        customPricesStr.split(',').forEach(item => {
            const [qty, price] = item.trim().split('=');
            if (qty && price) {
                customPrices[qty.trim()] = parseFloat(price.trim());
            }
        });
    }
    
    // Créer l'objet produit
    const product = {
        name,
        description,
        price,
        emoji,
        image,
        video,
        category,
        isNew,
        isPromo: isPromo && !isNew, // Si nouveau, pas promo
        customPrices: Object.keys(customPrices).length > 0 ? customPrices : undefined
    };
    
    if (currentEditingProductId) {
        // Modifier un produit existant
        product.id = currentEditingProductId;
        updateProductInData(product);
    } else {
        // Ajouter un nouveau produit
        const maxId = Math.max(...Object.values(menuData).flat().map(p => p.id || 0), 0);
        product.id = maxId + 1;
        addProductToData(product);
    }
    
    // Sauvegarder
    await saveConfig();
    
    // Fermer le modal et rafraîchir
    closeProductModal();
    displayProductsList();
    displayProducts(); // Rafraîchir l'affichage principal
    showNotification('Produit sauvegardé avec succès !');
}

// Fonction pour ajouter un produit aux données
function addProductToData(product) {
    if (!menuData[product.category]) {
        menuData[product.category] = [];
    }
    menuData[product.category].push(product);
}

// Fonction pour mettre à jour un produit dans les données
function updateProductInData(product) {
    Object.keys(menuData).forEach(categoryId => {
        const index = menuData[categoryId].findIndex(p => p.id === product.id);
        if (index !== -1) {
            // Retirer de l'ancienne catégorie si nécessaire
            if (categoryId !== product.category) {
                menuData[categoryId].splice(index, 1);
                addProductToData(product);
            } else {
                menuData[categoryId][index] = product;
            }
        }
    });
}

// Fonction pour supprimer un produit
async function deleteProduct(productId) {
    if (!confirm('Êtes-vous sûr de vouloir supprimer ce produit ?')) {
        return;
    }
    
    // Trouver et supprimer le produit dans toutes les catégories
    let found = false;
    Object.keys(menuData).forEach(categoryId => {
        const beforeLength = menuData[categoryId].length;
        menuData[categoryId] = menuData[categoryId].filter(p => p.id !== productId);
        if (menuData[categoryId].length < beforeLength) {
            found = true;
        }
    });
    
    if (!found) {
        showNotification('⚠️ Produit non trouvé');
        return;
    }
    
    // Sauvegarder
    await saveConfig();
    
    // Rafraîchir les listes
    displayProductsList();
    displayProducts();
    showNotification('✅ Produit supprimé avec succès !');
}

// Fonction pour fermer le modal produit
function closeProductModal() {
    document.getElementById('product-modal').style.display = 'none';
    currentEditingProductId = null;
}

// Fonction pour ouvrir le modal d'ajout de catégorie
function openAddCategoryModal() {
    currentEditingCategoryId = null;
    document.getElementById('category-modal-title').textContent = 'Ajouter une Catégorie';
    
    // Réinitialiser le formulaire
    document.getElementById('category-id').value = '';
    document.getElementById('category-name').value = '';
    document.getElementById('category-emoji').value = '';
    document.getElementById('category-description').value = '';
    
    document.getElementById('category-modal').style.display = 'flex';
}

// Fonction pour éditer une catégorie
function editCategory(categoryId) {
    // Utiliser directement categoriesData (variable globale, comme menuData pour les produits)
    const category = categoriesData?.[categoryId];
    if (!category) return;
    
    currentEditingCategoryId = categoryId;
    document.getElementById('category-modal-title').textContent = 'Modifier la Catégorie';
    
    // Remplir le formulaire
    document.getElementById('category-id').value = categoryId;
    document.getElementById('category-id').disabled = true; // Ne pas permettre de modifier l'ID
    document.getElementById('category-name').value = category.name || '';
    document.getElementById('category-emoji').value = category.emoji || '';
    document.getElementById('category-description').value = category.description || '';
    
    document.getElementById('category-modal').style.display = 'flex';
}

// Fonction pour sauvegarder une catégorie (SYSTÈME SIMPLIFIÉ - comme saveProduct)
async function saveCategory() {
    const categoryId = document.getElementById('category-id').value.trim();
    const name = document.getElementById('category-name').value.trim();
    const emoji = document.getElementById('category-emoji').value.trim();
    const description = document.getElementById('category-description').value.trim();
    
    // Validation
    if (!categoryId || !name) {
        showNotification('Veuillez remplir tous les champs obligatoires');
        return;
    }
    
    // S'assurer que categoriesData existe (comme menuData pour les produits)
    if (!categoriesData) {
        categoriesData = {};
    }
    
    // Gérer le renommage si nécessaire
    if (currentEditingCategoryId && currentEditingCategoryId !== categoryId) {
        delete categoriesData[currentEditingCategoryId];
        if (menuData[currentEditingCategoryId]) {
            menuData[categoryId] = menuData[currentEditingCategoryId];
            menuData[categoryId].forEach(p => p.category = categoryId);
            delete menuData[currentEditingCategoryId];
        }
    }
    
    // Ajouter/mettre à jour la catégorie dans categoriesData (comme menuData pour les produits)
    categoriesData[categoryId] = {
        name,
        emoji,
        description
    };
    
    // Synchroniser avec window.restaurantConfig pour l'admin
    if (!window.restaurantConfig) {
        window.restaurantConfig = {};
    }
    window.restaurantConfig.categories = categoriesData;
    
    // Sauvegarder via saveConfig() (comme pour les produits)
    await saveConfig();
    
    // VÉRIFICATION ROBUSTE : S'assurer que la catégorie est bien dans localStorage
    const verifyConfig = localStorage.getItem('miniapp_config_backup');
    if (verifyConfig) {
        try {
            const parsed = JSON.parse(verifyConfig);
            if (!parsed.categories || !parsed.categories[categoryId]) {
                // Si la catégorie n'est pas dans localStorage, re-sauvegarder
                parsed.categories = categoriesData;
                localStorage.setItem('miniapp_config_backup', JSON.stringify(parsed));
                localStorage.setItem('miniapp_config_timestamp', Date.now().toString());
            }
        } catch (e) {
            // Erreur, re-sauvegarder
            await saveConfig();
        }
    }
    
    // Fermer le modal
    closeCategoryModal();
    
    // Rafraîchir l'affichage admin
    displayCategoriesList();
    
    // SOLUTION ROBUSTE : Forcer l'affichage avec plusieurs tentatives espacées
    // pour garantir que localStorage est bien sauvegardé et que le DOM est prêt
    displayCategoryButtons();
    setTimeout(() => displayCategoryButtons(), 100);
    setTimeout(() => displayCategoryButtons(), 300);
    setTimeout(() => displayCategoryButtons(), 500);
    
    showNotification('✅ Catégorie sauvegardée avec succès !');
}

// Fonction pour supprimer une catégorie
async function deleteCategory(categoryId) {
    if (!confirm('Êtes-vous sûr de vouloir supprimer cette catégorie ? Les produits associés seront également supprimés.')) {
        return;
    }
    
    // S'assurer que categoriesData existe
    if (!categoriesData) {
        categoriesData = {};
    }
    
    // Supprimer la catégorie depuis categoriesData (comme menuData pour les produits)
    delete categoriesData[categoryId];
    
    // Supprimer les produits de cette catégorie
    if (menuData[categoryId]) {
        delete menuData[categoryId];
    }
    
    // Synchroniser avec window.restaurantConfig
    if (!window.restaurantConfig) {
        window.restaurantConfig = {};
    }
    window.restaurantConfig.categories = categoriesData;
    
    // Sauvegarder via saveConfig() (comme pour les produits)
    await saveConfig();
    
    // VÉRIFICATION ROBUSTE : S'assurer que la catégorie est bien supprimée de localStorage
    const verifyConfig = localStorage.getItem('miniapp_config_backup');
    if (verifyConfig) {
        try {
            const parsed = JSON.parse(verifyConfig);
            if (parsed.categories && parsed.categories[categoryId]) {
                // Si la catégorie est encore dans localStorage, re-sauvegarder
                parsed.categories = categoriesData;
                localStorage.setItem('miniapp_config_backup', JSON.stringify(parsed));
                localStorage.setItem('miniapp_config_timestamp', Date.now().toString());
            }
        } catch (e) {
            // Erreur, re-sauvegarder
            await saveConfig();
        }
    }
    
    // Rafraîchir les listes
    displayCategoriesList();
    displayProducts();
    
    // SOLUTION ROBUSTE : Forcer l'affichage avec plusieurs tentatives espacées
    displayCategoryButtons();
    setTimeout(() => displayCategoryButtons(), 100);
    setTimeout(() => displayCategoryButtons(), 300);
    setTimeout(() => displayCategoryButtons(), 500);
    
    showNotification('✅ Catégorie supprimée avec succès !');
}

// Fonction pour fermer le modal catégorie
function closeCategoryModal() {
    document.getElementById('category-modal').style.display = 'none';
    document.getElementById('category-id').disabled = false;
    currentEditingCategoryId = null;
}

// Fonction pour charger les paramètres admin
async function loadAdminSettings() {
    // S'assurer que adminConfig est chargé depuis window.restaurantConfig ou config.json
    if (!adminConfig || Object.keys(adminConfig).length === 0) {
        if (window.restaurantConfig && window.restaurantConfig.admin) {
            adminConfig = window.restaurantConfig.admin;
        } else {
            // Charger depuis localStorage
            const backupConfig = localStorage.getItem('miniapp_config_backup');
            if (backupConfig) {
                try {
                    const parsed = JSON.parse(backupConfig);
                    if (parsed.admin) {
                        adminConfig = parsed.admin;
                    }
                } catch (e) {
                    // Ignorer l'erreur
                }
            }
            
            // Si toujours pas, charger depuis config.json
            if (!adminConfig || Object.keys(adminConfig).length === 0) {
                try {
                    const response = await fetch('./config.json?t=' + Date.now());
                    const config = await response.json();
                    adminConfig = config.admin || {};
                } catch (e) {
                    adminConfig = {};
                }
            }
        }
    }
    
    // Charger les données admin dans les champs du formulaire
    const usernameField = document.getElementById('admin-telegram-username');
    const channelField = document.getElementById('admin-channel-link');
    
    if (usernameField && adminConfig.telegram_username) {
        usernameField.value = adminConfig.telegram_username;
    }
    if (channelField && adminConfig.channel_link) {
        channelField.value = adminConfig.channel_link;
    }
    
    // Afficher la liste des administrateurs
    displayAdminsList();
    
    // S'assurer que le bouton Sauvegarder est activé
    const saveBtn = document.getElementById('admin-save-settings-btn');
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.style.opacity = '1';
        saveBtn.style.cursor = 'pointer';
        
        // Ajouter un gestionnaire d'événement
        saveBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            saveAdminSettings();
            return false;
        };
    }
}

// Fonction pour afficher la liste des administrateurs
function displayAdminsList() {
    const adminsList = document.getElementById('admins-list');
    if (!adminsList) return;
    
    const whitelist = adminConfig.whitelist || [];
    
    if (whitelist.length === 0) {
        adminsList.innerHTML = '<p style="color: #ccc; text-align: center;">Aucun administrateur</p>';
        return;
    }
    
    let html = '';
    whitelist.forEach((username, index) => {
        html += `
            <div class="admin-item">
                <div class="admin-item-info">
                    <div class="admin-item-name">@${username}</div>
                </div>
                <div class="admin-item-actions">
                    <button class="admin-btn admin-btn-delete" onclick="deleteAdmin(${index})">🗑️ Supprimer</button>
                </div>
            </div>
        `;
    });
    
    adminsList.innerHTML = html;
}

// Fonction pour ouvrir le modal d'ajout d'admin
function openAddAdminModal() {
    document.getElementById('admin-modal-title').textContent = 'Ajouter un Administrateur';
    document.getElementById('admin-username-input').value = '';
    document.getElementById('admin-username-input').disabled = false;
    currentEditingAdminIndex = null;
    document.getElementById('admin-modal').style.display = 'flex';
}

// Fonction pour fermer le modal admin
function closeAdminModal() {
    document.getElementById('admin-modal').style.display = 'none';
    currentEditingAdminIndex = null;
}

// Fonction pour sauvegarder un admin
function saveAdmin() {
    const usernameInput = document.getElementById('admin-username-input');
    const username = usernameInput.value.trim();
    
    if (!username) {
        showNotification('Veuillez entrer un username');
        return;
    }
    
    // Retirer le @ si présent
    const cleanUsername = username.replace('@', '');
    
    if (!adminConfig.whitelist) {
        adminConfig.whitelist = [];
    }
    
    // Vérifier si l'admin existe déjà
    if (adminConfig.whitelist.includes(cleanUsername)) {
        showNotification('Cet administrateur existe déjà');
        return;
    }
    
    // Ajouter l'admin
    adminConfig.whitelist.push(cleanUsername);
    
    // Mettre à jour window.restaurantConfig
    if (!window.restaurantConfig) {
        window.restaurantConfig = {};
    }
    window.restaurantConfig.admin = adminConfig;
    
    // Sauvegarder
    saveConfig().then(() => {
        displayAdminsList();
        closeAdminModal();
        showNotification('Administrateur ajouté avec succès !');
    });
}

// Fonction pour supprimer un admin
function deleteAdmin(index) {
    if (!adminConfig.whitelist || !adminConfig.whitelist[index]) {
        return;
    }
    
    adminConfig.whitelist.splice(index, 1);
    
    // Mettre à jour window.restaurantConfig
    if (!window.restaurantConfig) {
        window.restaurantConfig = {};
    }
    window.restaurantConfig.admin = adminConfig;
    
    // Sauvegarder
    saveConfig().then(() => {
        displayAdminsList();
        showNotification('Administrateur supprimé avec succès !');
    });
}

// Fonction pour sauvegarder les paramètres admin (système direct et fiable)
function saveAdminSettings() {
    const telegramUsernameField = document.getElementById('admin-telegram-username');
    const channelLinkField = document.getElementById('admin-channel-link');
    
    if (!telegramUsernameField || !channelLinkField) {
        showNotification('❌ Erreur: Les champs de paramètres ne sont pas trouvés');
        return;
    }
    
    const telegramUsername = telegramUsernameField.value.trim();
    const channelLink = channelLinkField.value.trim();
    
    // Validation
    if (!telegramUsername) {
        showNotification('❌ Le username Telegram est obligatoire');
        return;
    }
    
    // Retirer le @ si présent
    const cleanUsername = telegramUsername.replace('@', '');
    
    try {
        // Charger la config complète depuis localStorage ou window.restaurantConfig
        let fullConfig = {};
        
        // Essayer de charger depuis localStorage d'abord
        const backupConfig = localStorage.getItem('miniapp_config_backup');
        if (backupConfig) {
            try {
                fullConfig = JSON.parse(backupConfig);
            } catch (e) {
                // Si erreur, utiliser window.restaurantConfig
                fullConfig = window.restaurantConfig || {};
            }
        } else {
            // Sinon utiliser window.restaurantConfig
            fullConfig = window.restaurantConfig || {};
        }
        
        // S'assurer que toutes les sections existent
        if (!fullConfig.restaurant) {
            fullConfig.restaurant = restaurantConfig || {};
        }
        if (!fullConfig.categories) {
            fullConfig.categories = window.restaurantConfig?.categories || {};
        }
        if (!fullConfig.products) {
            fullConfig.products = menuData || {};
        }
        if (!fullConfig.admin) {
            fullConfig.admin = {};
        }
        
        // Préserver la whitelist existante
        if (!fullConfig.admin.whitelist) {
            fullConfig.admin.whitelist = [];
        }
        
        // Mettre à jour les valeurs admin
        fullConfig.admin.telegram_username = cleanUsername;
        fullConfig.admin.channel_link = channelLink;
        // Ne pas forcer l'ajout automatique du username principal dans la whitelist
        // L'administrateur gère explicitement la whitelist via le panneau
        
        // Mettre à jour les variables globales
        adminConfig = fullConfig.admin;
        window.restaurantConfig = fullConfig;
        
        // Sauvegarder directement dans localStorage
        localStorage.setItem('miniapp_config_backup', JSON.stringify(fullConfig));
        localStorage.setItem('miniapp_config_timestamp', Date.now().toString());
        
        showNotification('✅ Paramètres sauvegardés avec succès !');
        
    } catch (error) {
        showNotification('❌ Erreur lors de la sauvegarde: ' + error.message);
    }
}

// Fonction pour sauvegarder la configuration dans config.json
async function saveConfig() {
    try {
        // Construire la config complète à partir des données en mémoire
        // Ne PAS recharger depuis le serveur pour éviter d'écraser les modifications
        // S'assurer que window.restaurantConfig existe
        if (!window.restaurantConfig) {
            window.restaurantConfig = {};
        }
        
        // Utiliser directement categoriesData (variable globale, comme menuData pour les produits)
        const config = {
            restaurant: restaurantConfig || {},
            admin: window.restaurantConfig?.admin || adminConfig || {},
            categories: categoriesData || {}, // Utiliser directement categoriesData (comme menuData)
            products: menuData || {}
        };
        
        // S'assurer que adminConfig est synchronisé avec window.restaurantConfig.admin
        if (window.restaurantConfig?.admin) {
            adminConfig = window.restaurantConfig.admin;
        }
        
        // Sauvegarder dans localStorage (cache/fallback)
        try {
            localStorage.setItem('miniapp_config_backup', JSON.stringify(config));
            localStorage.setItem('miniapp_config_timestamp', Date.now().toString());
        } catch (storageError) {
            showNotification('❌ Erreur: Impossible d\'écrire dans le cache local');
        }
        
        // Mettre à jour window.restaurantConfig avec la config complète
        window.restaurantConfig = config;
        
        // Synchroniser categoriesData avec window.restaurantConfig.categories
        categoriesData = config.categories;
        
        // Sauvegarder dans localStorage (source de vérité)
        localStorage.setItem('miniapp_config_backup', JSON.stringify(config));
        localStorage.setItem('miniapp_config_timestamp', Date.now().toString());
        
        showNotification('✅ Configuration sauvegardée avec succès !');
        
    } catch (error) {
        showNotification('Erreur lors de la sauvegarde: ' + error.message);
    }
}

