const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const SqliteDatabase = require("./sqlite-adapter");
const { OAuth2Client } = require("google-auth-library");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT) || 3000;

const payments = new Map();

// Behind Render's proxy: trust one hop so request.ip is the real client IP.
app.set("trust proxy", 1);

process.on("unhandledRejection", function (reason) {
    console.error("Unhandled promise rejection:", reason);
});

// Route handlers may be async. Wrap every handler registered through
// app.get/post/put/delete so a rejected promise or thrown error goes to the
// error middleware (JSON 500) instead of crashing the process.
function wrapHandler(fn) {
    if (typeof fn !== "function" || fn.length >= 4) return fn;
    return function (request, response, next) {
        let result;
        try {
            result = fn(request, response, next);
        } catch (error) {
            return next(error);
        }
        if (result && typeof result.catch === "function") result.catch(next);
    };
}

["get", "post", "put", "delete"].forEach(function (method) {
    const original = app[method].bind(app);
    app[method] = function () {
        if (method === "get" && arguments.length === 1) return original.apply(null, arguments);
        return original.apply(null, Array.prototype.slice.call(arguments).map(wrapHandler));
    };
});

// Simple per-IP fixed-window limiter for public endpoints.
const rateBuckets = new Map();
function makeLimiter(name, windowMs, max, message) {
    return function (request, response, next) {
        const key = name + ":" + String(request.ip || "unknown");
        const now = Date.now();
        let entry = rateBuckets.get(key);
        if (!entry || now - entry.windowStart > windowMs) {
            entry = { windowStart: now, windowMs: windowMs, count: 0 };
            rateBuckets.set(key, entry);
        }
        entry.count += 1;
        if (entry.count > max) {
            return response.status(429).json({ message: message || "Too many requests. Please try again later." });
        }
        next();
    };
}
const registerLimiter = makeLimiter("register", 60 * 60 * 1000, 10, "Too many sign-up attempts. Please try again later.");
const forgotPasswordLimiter = makeLimiter("forgot", 15 * 60 * 1000, 5, "Too many reset requests. Please try again later.");
const resetPasswordLimiter = makeLimiter("reset-password", 15 * 60 * 1000, 10, "Too many reset attempts. Please request a new code later.");
const activityLimiter = makeLimiter("activity", 60 * 1000, 30);
const trackLimiter = makeLimiter("track", 60 * 1000, 30, "Too many lookups. Please wait a minute and try again.");
const paymentStatusLimiter = makeLimiter("mpesa-status", 60 * 1000, 120);

app.use(express.json({ limit: "100kb" }));

// Serve public/ first, then allow only web-safe root assets; keep server.js and data private.
app.use(express.static(path.join(__dirname, "public")));
app.get("/", function (request, response) {
    response.sendFile(path.join(__dirname, "index.html"));
});
app.use(function (request, response, next) {
    if ((request.method !== "GET" && request.method !== "HEAD") ||
        !/^\/(?:[^/]+\/)*[^/]+\.(?:html|css|js|png|jpe?g|gif|webp|svg|ico)$/i.test(request.path)) {
        return next();
    }

    let decodedPath;
    try {
        decodedPath = decodeURIComponent(request.path);
    } catch (error) {
        return next();
    }

    const filePath = path.resolve(__dirname, "." + decodedPath);
    const extension = path.extname(filePath).toLowerCase();
    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname ||
        path.basename(filePath).toLowerCase() === "server.js" ||
        !fs.existsSync(filePath) || !fs.statSync(filePath).isFile() ||
        !/\.(?:html|css|js|png|jpe?g|gif|webp|svg|ico)$/.test(extension)) {
        return next();
    }

    response.sendFile(filePath);
});

/* =========================
   DATABASE
========================= */

const DATA_DIR = process.env.PHYNEX_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new SqliteDatabase(path.join(DATA_DIR, "phynex.db"));
db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS sellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        token TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        specifications TEXT,
        price INTEGER NOT NULL,
        old_price INTEGER,
        category TEXT,
        image TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        sponsored INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (seller_id) REFERENCES sellers(id)
    );

    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        token TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL UNIQUE,
        customer_id INTEGER,
        customer_name TEXT,
        customer_email TEXT,
        customer_phone TEXT,
        county TEXT,
        location TEXT,
        address TEXT,
        instructions TEXT,
        subtotal INTEGER NOT NULL DEFAULT 0,
        delivery_fee INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'mpesa',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_request_id TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        product_id INTEGER,
        seller_id INTEGER,
        name TEXT,
        image TEXT,
        price INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT,
        value TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        product_name TEXT,
        customer_name TEXT,
        rating INTEGER,
        comment TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_type TEXT NOT NULL,
        user_id INTEGER,
        name TEXT,
        email TEXT,
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'contact',
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
`);

/* =========================
   MIGRATIONS (safe to re-run)
========================= */

function ensureColumn(table, column, definition) {
    const columns = db.prepare("PRAGMA table_info(" + table + ")").all();
    const hasColumn = columns.some(function (col) { return col.name === column; });

    if (!hasColumn) {
        db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
    }
}

ensureColumn("products", "media", "TEXT");
ensureColumn("products", "ship_from", "TEXT");
ensureColumn("products", "availability", "TEXT");
ensureColumn("products", "tracking_code", "TEXT");
ensureColumn("products", "stock", "INTEGER DEFAULT 0");
ensureColumn("products", "low_stock_threshold", "INTEGER DEFAULT 5");
ensureColumn("products", "sku", "TEXT");
ensureColumn("products", "brand", "TEXT");
ensureColumn("products", "subcategory", "TEXT");
ensureColumn("products", "condition_label", "TEXT");
ensureColumn("products", "warranty", "TEXT");
ensureColumn("products", "tags", "TEXT");
ensureColumn("products", "featured", "INTEGER DEFAULT 0");

ensureColumn("sellers", "status", "TEXT DEFAULT 'approved'");
ensureColumn("sellers", "whatsapp", "TEXT");

ensureColumn("orders", "stock_deducted", "INTEGER DEFAULT 0");

ensureColumn("customers", "google_id", "TEXT");
ensureColumn("customers", "reset_token", "TEXT");
ensureColumn("customers", "reset_token_expires", "INTEGER");
ensureColumn("customers", "token_expires", "INTEGER");
ensureColumn("sellers", "token_expires", "INTEGER");
ensureColumn("sellers", "reset_token", "TEXT");
ensureColumn("sellers", "reset_token_expires", "INTEGER");
ensureColumn("products", "deleted_at", "INTEGER");
ensureColumn("activity_log", "actor_type", "TEXT DEFAULT 'system'");
ensureColumn("activity_log", "actor_id", "INTEGER");
ensureColumn("activity_log", "actor_name", "TEXT");
ensureColumn("activity_log", "actor_email", "TEXT");
ensureColumn("activity_log", "source", "TEXT DEFAULT 'server'");
ensureColumn("activity_log", "request_path", "TEXT");
ensureColumn("activity_log", "details", "TEXT");
ensureColumn("orders", "updated_at", "INTEGER");
ensureColumn("orders", "reservation_expires", "INTEGER");
ensureColumn("products", "reserved_stock", "INTEGER DEFAULT 0");
db.prepare("UPDATE products SET availability = CASE WHEN COALESCE(stock, 0) > 0 THEN 'for_sale' ELSE 'sold' END").run();

// M-PESA transaction details, captured from the Daraja callback so
// admin can trace exactly which payment (receipt number, phone,
// transaction time) paid for which order.
ensureColumn("orders", "mpesa_receipt", "TEXT");
ensureColumn("orders", "mpesa_transaction_date", "TEXT");
ensureColumn("orders", "mpesa_phone", "TEXT");

// Delivery sub-county (e.g. "Westlands" within Malindi county), captured
// alongside county/location so orders carry a precise Kenyan address.
ensureColumn("orders", "sub_county", "TEXT");

// County/sub-county for customer saved addresses and seller business
// locations, using the same 47-county Kenya dataset as checkout.
ensureColumn("customers", "county", "TEXT");
ensureColumn("customers", "sub_county", "TEXT");
ensureColumn("sellers", "county", "TEXT");
ensureColumn("sellers", "sub_county", "TEXT");

const DEFAULT_CATEGORIES = [
    ["Phones & Tablets","phones-tablets","Mobile phones, tablets and accessories"],
    ["Computers & Laptops","computers-laptops","Laptops, desktops, monitors and computer accessories"],
    ["Electronics","electronics","TVs, audio, smart devices and electronics"],
    ["Gaming","gaming","Consoles, games, controllers and gaming accessories"],
    ["Fashion","fashion","Clothing, fashion and accessories"],
    ["Shoes & Bags","shoes-bags","Shoes, handbags, backpacks and travel bags"],
    ["Beauty & Personal Care","beauty-personal-care","Beauty, cosmetics and personal-care products"],
    ["Home & Garden","home-garden","Home improvement, decor, garden and outdoor home items"],
    ["Furniture","furniture","Beds, sofas, tables, chairs and storage"],
    ["Appliances","appliances","Kitchen, laundry, cooling and household appliances"],
    ["Grocery","grocery","Food, beverages and everyday household consumables"],
    ["Health & Wellness","health-wellness","Wellness and non-prescription health products"],
    ["Baby & Kids","baby-kids","Baby products, toys, kids clothing and essentials"],
    ["Sports & Outdoors","sports-outdoors","Sports equipment, fitness and outdoor gear"],
    ["Automotive","automotive","Car, motorcycle and vehicle parts and accessories"],
    ["Books & Stationery","books-stationery","Books, school, office and stationery supplies"],
    ["Jewelry & Watches","jewelry-watches","Jewelry, watches and accessories"],
    ["Cameras & Photography","cameras-photography","Cameras, lenses and photography equipment"],
    ["Pet Supplies","pet-supplies","Pet food, accessories and supplies"],
    ["Industrial & Tools","industrial-tools","Tools, hardware, machinery and business equipment"],
    ["Services","services","Local and professional services"],
    ["Other","other","Other products that do not fit another category"]
];

const seedCategory = db.prepare(
    "INSERT OR IGNORE INTO categories (name, slug, description, created_at) VALUES (?, ?, ?, ?)"
);
for (const category of DEFAULT_CATEGORIES) {
    seedCategory.run(category[0], category[1], category[2], Date.now());
}

/* =========================
   AUTO-CATEGORISATION
   Keyword map used to place a product in the right category
   whenever a seller/admin leaves the category field blank, so
   no product is ever saved with an empty category.
========================= */

const CATEGORY_KEYWORDS = [
    ["Phones & Tablets", ["phone", "smartphone", "iphone", "samsung galaxy", "tecno", "infinix", "itel", "tablet", "ipad", "sim card", "phone case", "screen protector"]],
    ["Computers & Laptops", ["laptop", "notebook", "macbook", "dell", "hp laptop", "lenovo", "desktop", "pc", "monitor", "keyboard", "mouse", "printer", "computer", "ram", "ssd", "hard drive", "motherboard", "graphics card"]],
    ["Electronics", ["tv", "television", "speaker", "headphone", "earphone", "earbud", "bluetooth", "radio", "smartwatch", "power bank", "charger", "cable", "drone", "projector", "router", "modem"]],
    ["Gaming", ["playstation", "xbox", "nintendo", "gaming console", "game controller", "video game", "ps4", "ps5", "gamepad"]],
    ["Fashion", ["shirt", "dress", "trouser", "jeans", "jacket", "suit", "skirt", "blouse", "t-shirt", "hoodie", "clothing", "kitenge", "ankara"]],
    ["Shoes & Bags", ["shoe", "sneaker", "sandal", "heel", "boot", "handbag", "backpack", "purse", "wallet", "suitcase", "luggage"]],
    ["Beauty & Personal Care", ["makeup", "lipstick", "perfume", "cosmetic", "skincare", "lotion", "shampoo", "hair", "wig", "nail", "cream", "soap"]],
    ["Home & Garden", ["decor", "curtain", "rug", "carpet", "garden", "plant pot", "lamp", "lighting", "bedding", "duvet", "pillow"]],
    ["Furniture", ["sofa", "bed", "mattress", "chair", "table", "wardrobe", "cabinet", "shelf", "desk", "furniture"]],
    ["Appliances", ["fridge", "refrigerator", "microwave", "blender", "cooker", "oven", "washing machine", "iron box", "kettle", "fan", "air conditioner", "heater", "appliance"]],
    ["Grocery", ["rice", "flour", "sugar", "cooking oil", "beverage", "snack", "grocery", "food", "drink", "juice", "tea", "coffee"]],
    ["Health & Wellness", ["vitamin", "supplement", "first aid", "thermometer", "wellness", "fitness tracker", "mask", "sanitizer"]],
    ["Baby & Kids", ["baby", "diaper", "toy", "stroller", "kids", "infant", "toddler"]],
    ["Sports & Outdoors", ["bicycle", "bike", "gym", "dumbbell", "treadmill", "football", "basketball", "tent", "camping", "sports", "yoga mat"]],
    ["Automotive", ["car", "vehicle", "tyre", "tire", "engine oil", "motorcycle", "spare part", "car battery", "helmet", "automotive"]],
    ["Books & Stationery", ["book", "novel", "textbook", "pen", "notebook paper", "stationery", "office supplies"]],
    ["Jewelry & Watches", ["watch", "necklace", "bracelet", "ring", "earring", "jewelry", "jewellery"]],
    ["Cameras & Photography", ["camera", "lens", "tripod", "dslr", "gopro", "photography"]],
    ["Pet Supplies", ["dog food", "cat food", "pet", "leash", "aquarium", "pet supplies"]],
    ["Industrial & Tools", ["drill", "hammer", "wrench", "toolbox", "generator", "welding", "industrial", "machine", "tools"]],
    ["Services", ["service", "repair service", "installation", "consultation", "cleaning service"]]
];

function inferCategory(name, description, tags) {
    const text = [name, description, tags].filter(Boolean).join(" ").toLowerCase();
    for (const [category, keywords] of CATEGORY_KEYWORDS) {
        if (keywords.some(function (keyword) { return text.indexOf(keyword) !== -1; })) {
            return category;
        }
    }
    return "Other";
}

function resolveCategory(rawCategory, name, description, tags) {
    const trimmed = String(rawCategory || "").trim();
    if (trimmed) return trimmed;
    return inferCategory(name, description, tags);
}

// One-time startup backfill: give every already-saved product with a
// blank category a real one, so nothing already in the database is
// left uncategorised either.
(function backfillEmptyCategories() {
    const blank = db.prepare("SELECT id, name, description, tags FROM products WHERE category IS NULL OR TRIM(category) = ''").all();
    if (!blank.length) return;
    const update = db.prepare("UPDATE products SET category = ? WHERE id = ?");
    const applyBackfill = db.transaction(function () {
        for (const product of blank) {
            update.run(inferCategory(product.name, product.description, product.tags), product.id);
        }
    });
    applyBackfill();
    console.log("Backfilled category for " + blank.length + " product(s) that had none.");
})();

/* =========================
   SMALL HELPERS
========================= */

function newToken() {
    return crypto.randomBytes(24).toString("hex");
}

function generateTrackingCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
    let code;
    let attempts = 0;

    do {
        code = "";
        for (let i = 0; i < 8; i++) {
            code += alphabet[crypto.randomInt(alphabet.length)];
        }
        attempts++;
    } while (
        attempts < 20 &&
        db.prepare("SELECT id FROM products WHERE tracking_code = ?").get(code)
    );

    return code;
}

// Returns null when blank, NaN when not a number, otherwise a rounded integer.
function optionalInt(value) {
    if (Array.isArray(value)) value = value[value.length - 1];
    if (value === undefined || value === null || String(value).trim() === "") return null;
    return Math.round(Number(value));
}

function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function generateOrderNumber() {
    return "PHX-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function logActivity(action, description, request, details) {
    try {
        const actor = request && (request.customer || request.seller);
        const actorType = actor
            ? (request.customer ? "customer" : "seller")
            : (request && request.__adminActivity ? "admin" : "system");

        db.prepare(
            `INSERT INTO activity_log
                (action, description, created_at, actor_type, actor_id, actor_name, actor_email, source, request_path, details)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            String(action || "activity"),
            String(description || ""),
            Date.now(),
            actorType,
            actor ? actor.id : null,
            actor ? (actor.business_name || actor.name || "") : (actorType === "admin" ? "PHYNEX Admin" : ""),
            actor ? (actor.email || "") : "",
            request ? "server" : "system",
            request ? String(request.originalUrl || request.url || "") : "",
            details == null ? "" : JSON.stringify(details)
        );
    } catch (error) {
        console.error("Activity log failed:", error.message);
    }
}

function logMarketActivity(request, action, description, details) {
    logActivity(action, description, request, details);
}

// Records every login/logout so the admin can see who has been
// coming and going, and when. Never allowed to break the request
// that triggered it.
function logLogin(userType, user, action) {
    try {
        db.prepare(
            `INSERT INTO login_log (user_type, user_id, name, email, action, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            userType,
            user ? user.id : null,
            user ? (user.business_name || user.name || "") : "",
            user ? user.email : "",
            action,
            Date.now()
        );
    } catch (error) {
        console.error("Login log failed:", error.message);
    }
}

// Admin-added products still need a seller_id (the column is NOT NULL),
// so we lazily create one internal "PHYNEX" system seller account and
// attach every admin-created product to it.
function ensureSystemSeller() {
    const existing = db
        .prepare("SELECT * FROM sellers WHERE email = ?")
        .get("admin@phynex.internal");

    if (existing) return existing;

    const passwordHash = crypto.randomBytes(24).toString("hex"); // unusable login, admin never logs in as this account

    const result = db
        .prepare(
            `INSERT INTO sellers (business_name, email, phone, password_hash, token, status, created_at)
             VALUES (?, ?, ?, ?, NULL, 'approved', ?)`
        )
        .run("PHYNEX", "admin@phynex.internal", "", passwordHash, Date.now());

    return db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);
}

const DEFAULT_SETTINGS = {
    storeName: "PHYNEX",
    supportEmail: "phynex70@gmail.com",
    supportPhone: "0793 977 389",
    description: "",
    currency: "KES (KSh)",
    deliveryFee: 300,
    lowStockThreshold: 5,
    sellerListings: true,
    requireApproval: true,
    showGaming: true,
    showNew: true,
    showSponsored: true,
    announcement: ""
};

function getSettings() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'store'").get();

    if (!row) return Object.assign({}, DEFAULT_SETTINGS);

    try {
        const settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(row.value));
        if (!String(settings.supportEmail || "").trim()) settings.supportEmail = DEFAULT_SETTINGS.supportEmail;
        if (!String(settings.supportPhone || "").trim()) settings.supportPhone = DEFAULT_SETTINGS.supportPhone;
        return settings;
    } catch (error) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

function saveSettings(partial) {
    const merged = Object.assign({}, getSettings(), partial);

    db.prepare(
        `INSERT INTO settings (key, value) VALUES ('store', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify(merged));

    return merged;
}

function publicSeller(seller) {
    return {
        id: seller.id,
        businessName: seller.business_name,
        email: seller.email,
        phone: seller.phone,
        whatsapp: seller.whatsapp || seller.phone || "",
        status: seller.status || "approved",
        county: seller.county || "",
        subCounty: seller.sub_county || ""
    };
}

function publicCustomer(customer) {
    return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        hasGoogle: Boolean(customer.google_id),
        county: customer.county || "",
        subCounty: customer.sub_county || ""
    };
}

function googleConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID);
}

const googleClient = googleConfigured() ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

function publicProduct(product) {

    var media = [];

    if (product.media) {
        try {
            media = JSON.parse(product.media) || [];
        } catch (error) {
            media = [];
        }
    }

    // Backwards compatibility: older rows only have a single
    // "image" column and no media array yet.
    if (media.length === 0 && product.image) {
        media = [{ url: product.image, type: "image" }];
    }

    return {
        id: product.id,
        sellerId: product.seller_id,
        sellerName: product.business_name || undefined,
        sellerPhone: product.seller_phone || undefined,
        sellerWhatsapp: product.seller_whatsapp || product.seller_phone || undefined,
        name: product.name,
        description: product.description || "",
        specifications: product.specifications || "",
        shipFrom: product.ship_from || product.seller_county || (product.business_name === "PHYNEX" ? "PHYNEX Malindi" : ""),
        price: product.price,
        oldPrice: product.old_price || null,
        category: product.category || "",
        brand: product.brand || "",
        subcategory: product.subcategory || "",
        condition: product.condition_label || "",
        warranty: product.warranty || "",
        tags: product.tags || "",
        featured: Boolean(product.featured),
        sku: product.sku || "",
        stock: product.stock != null ? Math.max(0, Number(product.stock) - Number(product.reserved_stock || 0)) : 0,
        lowStockThreshold: product.low_stock_threshold != null ? product.low_stock_threshold : 5,
        image: (media[0] && media[0].url) || product.image || "",
        images: media.filter(function (m) { return m.type === "image"; }).map(function (m) { return m.url; }),
        media: media,
        status: product.status,
        availability: product.availability || (Number(product.stock || 0) > 0 ? "for_sale" : "sold"),
        sponsored: Boolean(product.sponsored),
        rejectionReason: product.rejection_reason || null,
        trackingCode: product.tracking_code || null,
        createdAt: product.created_at
    };
}

function publicOrder(order) {
    return {
        id: order.id,
        orderNumber: order.order_number,
        customerId: order.customer_id,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
        county: order.county,
        subCounty: order.sub_county,
        location: order.location,
        address: order.address,
        instructions: order.instructions,
        subtotal: order.subtotal,
        deliveryFee: order.delivery_fee,
        total: order.total,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        mpesaReceipt: order.mpesa_receipt || null,
        mpesaTransactionDate: order.mpesa_transaction_date || null,
        mpesaPhone: order.mpesa_phone || null,
        status: order.status,
        createdAt: order.created_at
    };
}

/* =========================
   SELLER AUTH MIDDLEWARE
========================= */

function requireSeller(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
        return response.status(401).json({ message: "Please log in as a seller." });
    }

    const seller = db
        .prepare("SELECT * FROM sellers WHERE token = ? AND (token_expires IS NULL OR token_expires > ?)")
        .get(token, Date.now());

    if (!seller) {
        return response.status(401).json({ message: "Your session has expired. Please log in again." });
    }

    if (seller.status === "suspended") {
        return response.status(403).json({ message: "Your seller account has been suspended. Contact PHYNEX support." });
    }

    request.seller = seller;
    next();
}

// Best-effort customer lookup — does NOT block the request if there's
// no token or an invalid one. Used by checkout/payment so guest-style
// requests still work, but a logged-in customer's order gets linked
// to their account when possible.
function optionalCustomer(request) {
    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) return null;

    return db.prepare("SELECT * FROM customers WHERE token = ? AND (token_expires IS NULL OR token_expires > ?)").get(token, Date.now()) || null;
}

/* =========================
   ADMIN AUTH (simple shared password)
========================= */

const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const adminTokens = new Map(); // token -> expiry timestamp

function requireAdmin(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expires = token ? adminTokens.get(token) : null;

    if (!expires || expires < Date.now()) {
        if (token) adminTokens.delete(token);
        return response.status(401).json({ message: "Admin login required." });
    }

    request.__adminActivity = true;
    next();
}

const authAttempts = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;

function authKey(request, identity) {
    return String(request.ip || "unknown") + ":" + String(identity || "").toLowerCase();
}

// Only FAILED attempts count. This checks the limit without counting.
function authRateLimited(request, identity) {
    const row = authAttempts.get(authKey(request, identity));
    if (!row || Date.now() - row.startedAt > AUTH_WINDOW_MS) return false;
    return row.count >= AUTH_MAX_ATTEMPTS;
}

function authRecordFailure(request, identity) {
    const key = authKey(request, identity);
    const now = Date.now();
    const row = authAttempts.get(key);
    if (!row || now - row.startedAt > AUTH_WINDOW_MS) {
        authAttempts.set(key, { startedAt: now, count: 1 });
    } else {
        row.count += 1;
    }
}

function authClear(request, identity) {
    authAttempts.delete(authKey(request, identity));
}

app.post("/api/admin/login", function (request, response) {

    const password = String((request.body || {}).password || "");

    if (authRateLimited(request, "admin")) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    if (!process.env.ADMIN_PASSWORD) {
        return response.status(503).json({
            message: "Admin login is not configured yet. Set ADMIN_PASSWORD in .env."
        });
    }

    if (!safeEqual(password, process.env.ADMIN_PASSWORD)) {
        authRecordFailure(request, "admin");
        return response.status(401).json({ message: "Incorrect admin password." });
    }

    authClear(request, "admin");

    const token = newToken();
    adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);

    response.json({ token: token });
});

/* =========================
   CUSTOMER AUTH MIDDLEWARE
========================= */

function requireCustomer(request, response, next) {

    const header = request.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
        return response.status(401).json({ message: "Please log in to continue." });
    }

    const customer = db
        .prepare("SELECT * FROM customers WHERE token = ? AND (token_expires IS NULL OR token_expires > ?)")
        .get(token, Date.now());

    if (!customer) {
        return response.status(401).json({ message: "Your session has expired. Please log in again." });
    }

    request.customer = customer;
    next();
}

/* =========================
   CUSTOMER REGISTER / LOGIN
========================= */

app.post("/api/customers/register", registerLimiter, async function (request, response) {

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");

    if (!name || !email || !password) {
        return response.status(400).json({ message: "Name, email and password are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (password.length < 8) {
        return response.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const existing = db.prepare("SELECT id FROM customers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO customers (name, email, phone, password_hash, token, token_expires, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(name, email, phone, passwordHash, token, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now());

    const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);

    logLogin("customer", customer, "register");

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (authRateLimited(request, email)) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    const customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    if (!customer) {
        authRecordFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, customer.password_hash);

    if (!valid) {
        authRecordFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    authClear(request, email);

    const token = newToken();

    db.prepare("UPDATE customers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, customer.id);

    logLogin("customer", customer, "login");

    response.json({ token: token, customer: publicCustomer(customer) });
});

app.post("/api/customers/google", async function (request, response) {

    if (!googleConfigured() || !googleClient) {
        return response.status(503).json({ message: "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID to .env." });
    }

    const credential = String((request.body || {}).credential || "");

    if (!credential) {
        return response.status(400).json({ message: "Missing Google credential." });
    }

    let payload;

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        payload = ticket.getPayload();
    } catch (error) {
        return response.status(401).json({ message: "Could not verify that Google account." });
    }

    if (!payload || !payload.email || !payload.email_verified) {
        return response.status(401).json({ message: "Only verified Google accounts can be used to sign in." });
    }

    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || email.split("@")[0]).trim();
    const googleId = String(payload.sub);

    let customer = db.prepare("SELECT * FROM customers WHERE email = ?").get(email);

    if (customer) {
        if (!customer.google_id) {
            db.prepare("UPDATE customers SET google_id = ? WHERE id = ?").run(googleId, customer.id);
        }
    } else {
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);

        const result = db
            .prepare(
                `INSERT INTO customers (name, email, phone, password_hash, google_id, token, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(name, email, "", placeholderHash, googleId, "", Date.now());

        customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid);
    }

    const token = newToken();

    db.prepare("UPDATE customers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, customer.id);

    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);

    logLogin("customer", customer, "google");

    response.json({ token: token, customer: publicCustomer(customer) });
});

function createPasswordResetRequestHandler(table) {
    return async function (request, response) {
        const email = String((request.body || {}).email || "").trim().toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return response.status(400).json({ message: "Enter a valid account email." });
        }

        if (!mailTransporter) {
            return response.status(503).json({ message: "Password reset email is not configured. Contact PHYNEX support." });
        }

        const account = db.prepare("SELECT * FROM " + table + " WHERE email = ?").get(email);
        const genericReply = { ok: true, message: "If that email has an account, a six-digit reset code has been sent." };
        if (!account) return response.json(genericReply);

        const code = String(crypto.randomInt(100000, 1000000));
        const codeHash = crypto.createHash("sha256").update(code).digest("hex");
        const expires = Date.now() + 15 * 60 * 1000;

        db.prepare("UPDATE " + table + " SET reset_token = ?, reset_token_expires = ? WHERE id = ?")
            .run(codeHash, expires, account.id);

        try {
            await mailTransporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
                to: account.email,
                subject: "Your PHYNEX password reset code",
                text: "Your PHYNEX password reset code is " + code + ". It expires in 15 minutes. If you did not request this, ignore this email.",
                html: "<p>Your PHYNEX password reset code is:</p><p style=\"font-size:28px;font-weight:bold;letter-spacing:4px\">" + code + "</p><p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>"
            });
        } catch (error) {
            db.prepare("UPDATE " + table + " SET reset_token = NULL, reset_token_expires = NULL WHERE id = ?")
                .run(account.id);
            console.error("Password reset email failed:", error.message);
            return response.status(503).json({ message: "Could not send the reset code right now. Please try again later." });
        }

        response.json(genericReply);
    };
}

function createPasswordResetCompletionHandler(table, accountType) {
    return async function (request, response) {
        const body = request.body || {};
        const email = String(body.email || "").trim().toLowerCase();
        const code = String(body.code || "").trim();
        const password = String(body.password || "");

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
            return response.status(400).json({ message: "Enter the account email and six-digit reset code." });
        }
        if (password.length < 8) {
            return response.status(400).json({ message: "Password must be at least 8 characters." });
        }

        const codeHash = crypto.createHash("sha256").update(code).digest("hex");
        const account = db.prepare(
            "SELECT * FROM " + table + " WHERE email = ? AND reset_token = ? AND reset_token_expires > ?"
        ).get(email, codeHash, Date.now());

        if (!account) {
            return response.status(400).json({ message: "The reset code is invalid or expired. Request a new code and try again." });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const sessionToken = newToken();
        db.prepare(
            "UPDATE " + table + " SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, token = ?, token_expires = ? WHERE id = ?"
        ).run(passwordHash, sessionToken, Date.now() + 7 * 24 * 60 * 60 * 1000, account.id);

        authClear(request, email);

        if (accountType === "customer") {
            const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(account.id);
            logLogin("customer", updated, "password_reset");
            return response.json({ token: sessionToken, customer: publicCustomer(updated) });
        }

        const updated = db.prepare("SELECT * FROM sellers WHERE id = ?").get(account.id);
        logLogin("seller", updated, "password_reset");
        response.json({ token: sessionToken, seller: publicSeller(updated) });
    };
}

app.post("/api/customers/forgot-password", forgotPasswordLimiter, createPasswordResetRequestHandler("customers"));
app.post("/api/sellers/forgot-password", forgotPasswordLimiter, createPasswordResetRequestHandler("sellers"));
app.post("/api/customers/reset-password", resetPasswordLimiter, createPasswordResetCompletionHandler("customers", "customer"));
app.post("/api/sellers/reset-password", resetPasswordLimiter, createPasswordResetCompletionHandler("sellers", "seller"));

app.get("/api/customers/me", requireCustomer, function (request, response) {
    response.json({ customer: publicCustomer(request.customer) });
});

app.put("/api/customers/me", requireCustomer, function (request, response) {

    const body = request.body || {};
    const name = String(body.name || request.customer.name || "").trim();
    const phone = String(body.phone || "").trim();
    const county = String(body.county || "").trim();
    const subCounty = String(body.subCounty || "").trim();

    if (!name) {
        return response.status(400).json({ message: "Name is required." });
    }

    if (county && !subCounty) {
        return response.status(400).json({ message: "Select your sub-county." });
    }

    db.prepare(
        "UPDATE customers SET name = ?, phone = ?, county = ?, sub_county = ? WHERE id = ?"
    ).run(name, phone, county, subCounty, request.customer.id);

    const updated = db.prepare("SELECT * FROM customers WHERE id = ?").get(request.customer.id);

    response.json({ customer: publicCustomer(updated) });
});

app.post("/api/customers/logout", requireCustomer, function (request, response) {
    db.prepare("UPDATE customers SET token = NULL WHERE id = ?").run(request.customer.id);
    logLogin("customer", request.customer, "logout");
    response.json({ ok: true });
});


/* =========================
   SELLER REGISTER / LOGIN
========================= */

app.post("/api/sellers/register", registerLimiter, async function (request, response) {

    const body = request.body || {};

    const businessName = String(body.businessName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const password = String(body.password || "");
    const county = String(body.county || "").trim();

    if (!businessName || !email || !password) {
        return response.status(400).json({ message: "Business name, email and password are required." });
    }

    if (!county) {
        return response.status(400).json({ message: "Select your business county." });
    }

    if (!phone) {
        return response.status(400).json({ message: "A phone number is required so buyers can reach you." });
    }

    if (!whatsapp) {
        return response.status(400).json({ message: "A WhatsApp number is required so buyers can reach you." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (password.length < 8) {
        return response.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const existing = db.prepare("SELECT id FROM sellers WHERE email = ?").get(email);

    if (existing) {
        return response.status(409).json({ message: "An account with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = newToken();

    const result = db
        .prepare(
            `INSERT INTO sellers (business_name, email, phone, whatsapp, county, sub_county, password_hash, token, token_expires, status, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'approved', ?)`
        )
        .run(businessName, email, phone, whatsapp, county, passwordHash, token, Date.now() + 7 * 24 * 60 * 60 * 1000, Date.now());

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(result.lastInsertRowid);

    logActivity("seller_registered", businessName + " created a seller account.");
    logLogin("seller", seller, "register");

    response.json({ token: token, seller: publicSeller(seller) });
});

app.post("/api/sellers/login", async function (request, response) {

    const body = request.body || {};

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (authRateLimited(request, email)) {
        return response.status(429).json({ message: "Too many login attempts. Please try again in 15 minutes." });
    }

    const seller = db.prepare("SELECT * FROM sellers WHERE email = ?").get(email);

    if (!seller) {
        authRecordFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    const valid = await bcrypt.compare(password, seller.password_hash);

    if (!valid) {
        authRecordFailure(request, email);
        return response.status(401).json({ message: "Incorrect email or password." });
    }

    authClear(request, email);

    if (seller.status === "suspended") {
        return response.status(403).json({ message: "Your seller account has been suspended. Contact PHYNEX support." });
    }

    const token = newToken();

    db.prepare("UPDATE sellers SET token = ?, token_expires = ? WHERE id = ?").run(token, Date.now() + 7 * 24 * 60 * 60 * 1000, seller.id);

    logLogin("seller", seller, "login");

    response.json({ token: token, seller: publicSeller(seller) });
});

app.get("/api/sellers/me", requireSeller, function (request, response) {
    response.json({ seller: publicSeller(request.seller) });
});

app.post("/api/sellers/logout", requireSeller, function (request, response) {
    db.prepare("UPDATE sellers SET token = NULL WHERE id = ?").run(request.seller.id);
    logLogin("seller", request.seller, "logout");
    response.json({ ok: true });
});

app.put("/api/sellers/me", requireSeller, function (request, response) {

    const body = request.body || {};
    const phone = body.phone != null ? String(body.phone).trim() : request.seller.phone;
    const whatsapp = body.whatsapp != null ? String(body.whatsapp).trim() : request.seller.whatsapp;

    if (!phone || !whatsapp) {
        return response.status(400).json({ message: "Phone and WhatsApp numbers cannot be empty." });
    }

    db.prepare("UPDATE sellers SET phone = ?, whatsapp = ? WHERE id = ?").run(phone, whatsapp, request.seller.id);

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(request.seller.id);

    response.json({ seller: publicSeller(seller) });
});

/* =========================
   MEDIA UPLOAD (images + short videos)
========================= */

const multer = require("multer");

// Uploads live in the persistent data dir so they survive redeploys.
const uploadsDir = path.join(DATA_DIR, "uploads");

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// One-time copy of files uploaded before this fix (old location: next to server.js).
(function migrateLegacyUploads() {
    const legacyDir = path.join(__dirname, "uploads");
    if (path.resolve(legacyDir) === path.resolve(uploadsDir) || !fs.existsSync(legacyDir)) return;
    try {
        fs.readdirSync(legacyDir).forEach(function (name) {
            const target = path.join(uploadsDir, name);
            if (!fs.existsSync(target)) fs.copyFileSync(path.join(legacyDir, name), target);
        });
    } catch (error) {
        console.error("Could not copy legacy uploads:", error.message);
    }
})();

// Only these types can be stored, and the extension always comes from this
// table, never from the client's filename.
const MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm"
};

app.use("/uploads", function (request, response, next) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!/\.(jpg|jpeg|png|webp|gif|mp4|webm)$/i.test(request.path)) {
        return response.status(404).end();
    }
    next();
}, express.static(uploadsDir, {
    index: false,
    dotfiles: "ignore",
    setHeaders: function (response) {
        response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    }
}));

function fileMatchesSignature(filePath, mimetype) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(16);
        const read = fs.readSync(fd, buf, 0, 16, 0);
        if (read < 12) return false;
        switch (mimetype) {
            case "image/jpeg": return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
            case "image/png": return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
            case "image/gif": return /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6));
            case "image/webp": return buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP";
            case "video/mp4": return buf.toString("latin1", 4, 8) === "ftyp";
            case "video/webm": return buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
            default: return false;
        }
    } catch (error) {
        return false;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (error) { /* ignore */ } }
    }
}

function uploadedFileList(request) {
    let list = [];
    if (Array.isArray(request.files)) list = request.files.slice();
    else if (request.files && typeof request.files === "object") {
        Object.keys(request.files).forEach(function (key) { list = list.concat(request.files[key]); });
    }
    if (request.file) list.push(request.file);
    return list;
}

function removeUploadedFiles(request) {
    uploadedFileList(request).forEach(function (file) {
        try { fs.unlinkSync(file.path); } catch (error) { /* already gone */ }
    });
}

// Runs after multer: checks the real file signature, deletes everything if
// any file is not what it claims to be, and cleans up if the request later fails.
function verifyUploads(request, response, next) {
    const files = uploadedFileList(request);
    const bad = files.some(function (file) { return !fileMatchesSignature(file.path, file.mimetype); });
    if (bad) {
        removeUploadedFiles(request);
        return response.status(400).json({ message: "One of the files is not a valid image or video." });
    }
    response.on("finish", function () {
        if (response.statusCode >= 400) removeUploadedFiles(request);
    });
    next();
}

const mediaStorage = multer.diskStorage({
    destination: function (request, file, callback) {
        callback(null, uploadsDir);
    },
    filename: function (request, file, callback) {
        const ext = MIME_EXT[file.mimetype] || "";
        const unique = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
        callback(null, unique + ext);
    }
});

const mediaFileFilter = function (request, file, callback) {
    if (MIME_EXT[file.mimetype]) {
        callback(null, true);
    } else {
        callback(new Error("Only image and video files are allowed."));
    }
};

const uploadMedia = multer({
    storage: mediaStorage,
    limits: { fileSize: 25 * 1024 * 1024, files: 6 },
    fileFilter: mediaFileFilter
});

// Separate upload handler for the admin's own "add/edit product" form,
// which uses distinct field names: a single "image" plus a "gallery" array.
const uploadAdminProductFiles = multer({
    storage: mediaStorage,
    limits: { fileSize: 25 * 1024 * 1024, files: 7 },
    fileFilter: function (request, file, callback) {
        // Admin product uploads are images only. This keeps the form simple
        // and gives a clear error instead of silently failing on the upload.
        if (MIME_EXT[file.mimetype] && file.mimetype.indexOf("image/") === 0) {
            return callback(null, true);
        }
        return callback(new Error("Only JPG, PNG, WEBP or GIF images can be uploaded here."));
    }
}).fields([
    { name: "image", maxCount: 1 },
    { name: "gallery", maxCount: 6 }
]);

function handleAdminUpload(request, response, next) {
    uploadAdminProductFiles(request, response, function (error) {
        if (error) {
            const message = error instanceof multer.MulterError
                ? (error.code === "LIMIT_FILE_SIZE" ? "Each file must be under 25MB." : error.message)
                : error.message;
            return response.status(400).json({ message: message || "Could not upload files." });
        }
        verifyUploads(request, response, next);
    });
}

/* =========================
   SELLER — SUBMIT / VIEW OWN PRODUCTS
========================= */

/* =========================
   LISTING QUALITY CHECK
   Sellers must describe the exact item they're selling — this
   rejects blank, too-short, or obviously placeholder specs/
   descriptions before a listing is even saved for admin review.
========================= */

const PLACEHOLDER_PATTERNS = [
    /^(n\/?a|none|null|undefined|test|testing|asdf+|xxx+|tbd|todo|-+|\.+|\?+|sample|lorem\s?ipsum)$/i
];

function isPlaceholderText(value) {
    const text = String(value || "").trim();
    if (!text) return true;
    if (PLACEHOLDER_PATTERNS.some(function (pattern) { return pattern.test(text); })) return true;
    // A string made of one character repeated (e.g. "aaaaaaaa") or with
    // no letters at all isn't a real specification.
    if (/^(.)\1{4,}$/i.test(text)) return true;
    if (!/[a-z]/i.test(text)) return true;
    return false;
}

app.post("/api/products", requireSeller, function (request, response, next) {

    uploadMedia.array("media", 6)(request, response, function (error) {

        if (error) {
            const message = error instanceof multer.MulterError
                ? (error.code === "LIMIT_FILE_SIZE" ? "Each file must be under 25MB." : error.message)
                : error.message;
            return response.status(400).json({ message: message || "Could not upload files." });
        }

        verifyUploads(request, response, next);
    });

}, function (request, response) {

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const specifications = String(body.specifications || "").trim();
    const shipFrom = String(body.shipFrom || "").trim();
    const price = Math.round(Number(body.price));
    const oldPriceInput = optionalInt(body.oldPrice);
    const oldPrice = oldPriceInput === 0 ? null : oldPriceInput;
    const category = resolveCategory(body.category, name, description, "");
    const stockInput = optionalInt(body.stock);
    const stock = stockInput;

    if (Number.isNaN(oldPrice) || (oldPrice !== null && oldPrice < 0) || stock === null || Number.isNaN(stock) || stock < 1) {
        return response.status(400).json({ message: "Enter a valid old price and at least one unit of initial stock." });
    }

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    if (shipFrom.length < 3 || shipFrom.length > 120) {
        return response.status(400).json({ message: "Enter where this product ships from (town/county, 3 to 120 characters)." });
    }

    if (description.length < 20 || isPlaceholderText(description)) {
        return response.status(400).json({
            message: "Please write a real description of this exact item (at least 20 characters) — placeholder text like \"N/A\" or \"test\" isn't allowed."
        });
    }

    if (specifications.length < 15 || isPlaceholderText(specifications)) {
        return response.status(400).json({
            message: "Please add real specifications for this exact item (at least 15 characters) — placeholder text isn't allowed. Listings with fake or copied specs get rejected during admin review."
        });
    }

    const files = request.files || [];

    const media = files.map(function (file) {
        return {
            url: "/uploads/" + file.filename,
            type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
        };
    });

    const mediaJson = JSON.stringify(media);
    const firstImage = (media.find(function (m) { return m.type === "image"; }) || media[0] || {}).url || "";
    const trackingCode = generateTrackingCode();

    const result = db
        .prepare(
            `INSERT INTO products
                     (seller_id, name, description, specifications, ship_from, price, old_price, category, image, media, status, sponsored, tracking_code, stock, availability, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 'for_sale', ?)`
        )
        .run(
            request.seller.id, name, description, specifications, shipFrom, price,
            oldPrice, category, firstImage, mediaJson, trackingCode, stock, Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_submitted", request.seller.business_name + " submitted \"" + name + "\" for review.", request, { productId: product.id });

    response.json({ product: publicProduct(product) });
});

app.get("/api/seller/products", requireSeller, function (request, response) {

    const products = db
        .prepare("SELECT * FROM products WHERE seller_id = ? ORDER BY created_at DESC")
        .all(request.seller.id);

    response.json({ products: products.map(publicProduct) });
});

app.delete("/api/seller/products/:id", requireSeller, function (request, response) {

    const product = db
        .prepare("SELECT * FROM products WHERE id = ? AND seller_id = ?")
        .get(request.params.id, request.seller.id);

    if (!product) {
        return response.status(404).json({ message: "Product not found." });
    }

    db.prepare("DELETE FROM products WHERE id = ?").run(product.id);

    logActivity("seller_product_deleted", request.seller.business_name + " deleted \"" + product.name + "\".", request, { productId: product.id });

    response.json({ ok: true });
});

/* =========================
   MARKET — ACTIVITY TRACKING
   Stores marketplace actions permanently in SQLite until an admin
   explicitly deletes them.
========================= */

const MARKET_ACTIVITY_ACTIONS = ["market_visited", "category_viewed", "cart_item_added", "buy_now_clicked", "checkout_opened", "market_search"];

app.post("/api/market/activity", activityLimiter, function (request, response) {
    const body = request.body || {};
    const action = String(body.action || "").trim().slice(0, 80);
    const description = String(body.description || "").trim().slice(0, 200);

    if (!action) {
        return response.status(400).json({ message: "Activity action is required." });
    }

    // Noisy events (product views, list loads, popups) are deliberately not stored.
    if (MARKET_ACTIVITY_ACTIONS.indexOf(action) === -1) {
        return response.json({ ok: true, ignored: true });
    }

    let details = null;
    if (body.details && typeof body.details === "object") {
        try {
            if (JSON.stringify(body.details).length <= 500) details = body.details;
        } catch (error) { details = null; }
    }

    const customer = optionalCustomer(request);
    if (customer) request.customer = customer;

    logMarketActivity(request, action, description || ("Market activity: " + action), details);

    response.json({ ok: true });
});

/* =========================
   PUBLIC — APPROVED PRODUCTS
========================= */

app.get("/api/products", function (request, response) {

    const sponsoredOnly = request.query.sponsored === "1";

    const rows = sponsoredOnly
        ? db.prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp, sellers.county AS seller_county FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved' AND products.sponsored = 1 AND COALESCE(sellers.status, 'approved') != 'suspended'
             ORDER BY products.created_at DESC`
        ).all()
        : db.prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp, sellers.county AS seller_county FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'approved' AND COALESCE(sellers.status, 'approved') != 'suspended'
             ORDER BY products.created_at DESC`
        ).all();

    response.json({ products: rows.map(publicProduct) });
});

/* =========================
   PUBLIC — SINGLE PRODUCT DETAIL
   Used when a buyer taps a product image/name to see full details.
========================= */

app.get("/api/products/:id", function (request, response) {

    const product = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp, sellers.county AS seller_county
             FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.id = ? AND products.status = 'approved' AND COALESCE(sellers.status, 'approved') != 'suspended'`
        )
        .get(request.params.id);

    if (!product) {
        return response.status(404).json({ message: "Product not found." });
    }

    response.json({ product: publicProduct(product) });
});

/* =========================
   PUBLIC — TRACK MY PRODUCT
========================= */

app.get("/api/track/:code", trackLimiter, function (request, response) {

    const code = String(request.params.code || "").trim();

    // Old codes were 4 digits; new ones are 8 letters/digits. Both work.
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
        return response.status(400).json({ message: "Enter a valid tracking number." });
    }

    // No seller phone/WhatsApp here, and only live (approved) products.
    const product = db
        .prepare(
            `SELECT products.*, sellers.business_name FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE UPPER(products.tracking_code) = UPPER(?)
               AND products.status = 'approved'
               AND COALESCE(sellers.status, 'approved') != 'suspended'`
        )
        .get(code);

    if (!product) {
        return response.status(404).json({ message: "No product found with that tracking number." });
    }

    response.json({ product: publicProduct(product) });
});

app.post("/api/orders/track", trackLimiter, function (request, response) {
    const body = request.body || {};
    const orderNumber = String(body.orderNumber || "").trim().toUpperCase();
    const email = String(body.email || "").trim().toLowerCase();

    if (!/^PHX-[A-F0-9]{8}$/.test(orderNumber) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid order number and the email used at checkout." });
    }

    const order = db.prepare(
        "SELECT id, order_number, payment_method, payment_status, status, total, created_at, updated_at FROM orders WHERE order_number = ? AND LOWER(customer_email) = ?"
    ).get(orderNumber, email);

    if (!order) {
        return response.status(404).json({ message: "We could not find an order matching those details." });
    }

    const items = db.prepare(
        "SELECT name, image, quantity FROM order_items WHERE order_id = ? ORDER BY id ASC"
    ).all(order.id);

    response.json({
        order: {
            orderNumber: order.order_number,
            paymentMethod: order.payment_method,
            paymentStatus: order.payment_status,
            status: order.status,
            total: order.total,
            createdAt: order.created_at,
            updatedAt: order.updated_at || order.created_at,
            items: items
        }
    });
});

/* =========================
   ADMIN — DASHBOARD
========================= */

app.get("/api/admin/dashboard", requireAdmin, function (request, response) {

    const totalProducts = db.prepare("SELECT COUNT(*) AS c FROM products").get().c;
    const pendingProducts = db.prepare("SELECT COUNT(*) AS c FROM products WHERE status = 'pending'").get().c;
    const totalOrders = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
    const revenue = db.prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE payment_status = 'paid'").get().s;
    const pendingPayments = db.prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE payment_status = 'pending'").get().s;
    const unreadMessages = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE is_read = 0").get().c;

    const recentOrders = db
        .prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 6")
        .all()
        .map(publicOrder);

    const pendingProductsList = db
        .prepare(
            `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = 'pending'
             ORDER BY products.created_at DESC LIMIT 6`
        )
        .all()
        .map(publicProduct);

    response.json({
        totalProducts: totalProducts,
        pendingProducts: pendingProducts,
        totalOrders: totalOrders,
        revenue: revenue,
        pendingPayments: pendingPayments,
        unreadMessages: unreadMessages,
        recentOrders: recentOrders,
        pendingProductsList: pendingProductsList
    });
});

/* =========================
   ADMIN — REVIEW / APPROVE / SPONSOR PRODUCTS
========================= */

app.get("/api/admin/products", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             WHERE products.status = ?
             ORDER BY products.created_at DESC`
        ).all(status)
        : db.prepare(
            `SELECT products.*, sellers.business_name, sellers.email, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp FROM products
             JOIN sellers ON sellers.id = products.seller_id
             ORDER BY products.created_at DESC`
        ).all();

    response.json({
        products: rows.map(function (row) {
            return Object.assign(publicProduct(row), { sellerEmail: row.email });
        })
    });
});

app.post("/api/admin/products/:id/approve", requireAdmin, function (request, response) {

    const result = db
        .prepare("UPDATE products SET status = 'approved', rejection_reason = NULL WHERE id = ?")
        .run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("product_approved", "Approved \"" + (product ? product.name : request.params.id) + "\".", request, { productId: Number(request.params.id) });

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/reject", requireAdmin, function (request, response) {

    const reason = String((request.body || {}).reason || "").trim();

    const result = db
        .prepare("UPDATE products SET status = 'rejected', rejection_reason = ? WHERE id = ?")
        .run(reason || "Not specified", request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("product_rejected", "Rejected \"" + (product ? product.name : request.params.id) + "\" (" + (reason || "no reason given") + ").", request, { productId: Number(request.params.id), reason: reason || "" });

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/sponsor", requireAdmin, function (request, response) {

    const sponsored = (request.body || {}).sponsored ? 1 : 0;

    const result = db
        .prepare("UPDATE products SET sponsored = ? WHERE id = ?")
        .run(sponsored, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity(sponsored ? "product_sponsored" : "product_unsponsored", (sponsored ? "Sponsored " : "Unsponsored ") + "\"" + (product ? product.name : request.params.id) + "\".", request, { productId: Number(request.params.id), sponsored: Boolean(sponsored) });

    response.json({ ok: true });
});

app.post("/api/admin/products/:id/stock", requireAdmin, function (request, response) {

    const stock = Math.max(0, Math.round(Number((request.body || {}).stock)));

    if (!Number.isFinite(stock)) {
        return response.status(400).json({ message: "Enter a valid stock quantity." });
    }

    const result = db.prepare(
        "UPDATE products SET stock = ?, availability = ? WHERE id = ?"
    ).run(stock, stock > 0 ? "for_sale" : "sold", request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Product not found." });
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);
    logActivity("stock_updated", "Set stock for \"" + (product ? product.name : request.params.id) + "\" to " + stock + ".", request, { productId: Number(request.params.id), stock: stock });

    response.json({ ok: true });
});

app.delete("/api/admin/products/:id", requireAdmin, function (request, response) {

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    db.prepare("DELETE FROM products WHERE id = ?").run(request.params.id);

    if (product) {
        logActivity("product_deleted", "Deleted \"" + product.name + "\".", request, { productId: product.id });
    }

    response.json({ ok: true });
});

// Admin creating a product directly (not via a seller submission).
// Goes straight to "approved" since an admin is creating it themselves.
app.post("/api/admin/products", requireAdmin, handleAdminUpload, function (request, response) {

    const body = request.body || {};
    const files = request.files || {};

    const name = String(body.name || "").trim();
    const price = Math.round(Number(body.price));

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    const newOldPrice = optionalInt(body.oldPrice);
    const newStock = optionalInt(body.stock);
    if (Number.isNaN(newOldPrice) || (newOldPrice !== null && newOldPrice < 0) || Number.isNaN(newStock) || (newStock !== null && newStock < 0)) {
        return response.status(400).json({ message: "Old price and stock must be valid numbers." });
    }

    const mainImageFile = (files.image && files.image[0]) || null;
    if (!mainImageFile) {
        return response.status(400).json({ message: "Please choose a main product image before saving the product." });
    }

    const systemSeller = ensureSystemSeller();

    const galleryFiles = files.gallery || [];

    const media = [];

    if (mainImageFile) {
        media.push({ url: "/uploads/" + mainImageFile.filename, type: "image" });
    }

    galleryFiles.forEach(function (file) {
        media.push({
            url: "/uploads/" + file.filename,
            type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
        });
    });

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || "";
    const trackingCode = generateTrackingCode();

    const result = db
        .prepare(
            `INSERT INTO products
                (seller_id, name, description, specifications, ship_from, price, old_price, category, image, media,
                 status, sponsored, tracking_code, stock, availability, low_stock_threshold, sku, brand, subcategory,
                 condition_label, warranty, tags, featured, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            systemSeller.id,
            name,
            String(body.description || "").trim(),
            String(body.specifications || "").trim(),
            String(body.shipFrom || "PHYNEX Malindi").trim(),
            price,
            newOldPrice || null,
            resolveCategory(body.category, name, body.description, body.tags),
            firstImage,
            mediaJson,
            trackingCode,
            newStock === null ? 0 : newStock,
            newStock !== null && newStock > 0 ? "for_sale" : "sold",
            5,
            String(body.sku || "").trim(),
            String(body.brand || "").trim(),
            String(body.subcategory || "").trim(),
            String(body.condition || "").trim(),
            String(body.warranty || "").trim(),
            String(body.tags || "").trim(),
            body.featured === "true" ? 1 : 0,
            Date.now()
        );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid);

    logActivity("product_created", "Admin added \"" + name + "\" directly.", request, { productId: product.id });

    response.json({ message: "Product created.", product: publicProduct(product) });
});

app.put("/api/admin/products/:id", requireAdmin, handleAdminUpload, function (request, response) {

    const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    if (!existing) {
        return response.status(404).json({ message: "Product not found." });
    }

    const body = request.body || {};
    const files = request.files || {};

    const name = String(body.name || existing.name || "").trim();
    const price = body.price != null && body.price !== "" ? Math.round(Number(body.price)) : existing.price;

    if (!name || !Number.isFinite(price) || price < 1) {
        return response.status(400).json({ message: "Product name and a valid price are required." });
    }

    const editOldPrice = optionalInt(body.oldPrice);
    const editStock = optionalInt(body.stock);
    if (Number.isNaN(editOldPrice) || (editOldPrice !== null && editOldPrice < 0) || Number.isNaN(editStock) || (editStock !== null && editStock < 0)) {
        return response.status(400).json({ message: "Old price and stock must be valid numbers." });
    }

    let media = [];
    try { media = JSON.parse(existing.media || "[]") || []; } catch (error) { media = []; }

    const mainImageFile = (files.image && files.image[0]) || null;
    const galleryFiles = files.gallery || [];

    if (mainImageFile) {
        const rest = media.filter(function (m, index) { return index !== 0; });
        media = [{ url: "/uploads/" + mainImageFile.filename, type: "image" }].concat(rest);
    }

    if (galleryFiles.length) {
        const mainOnly = media.length ? [media[0]] : [];
        const newGallery = galleryFiles.map(function (file) {
            return {
                url: "/uploads/" + file.filename,
                type: file.mimetype.indexOf("video/") === 0 ? "video" : "image"
            };
        });
        const replaceFlag = Array.isArray(body.replaceGallery) ? body.replaceGallery[body.replaceGallery.length - 1] : body.replaceGallery;
        // New photos are ADDED to the gallery unless the admin ticks "replace".
        media = String(replaceFlag) === "true" ? mainOnly.concat(newGallery) : media.concat(newGallery).slice(0, 12);
    }

    const mediaJson = JSON.stringify(media);
    const firstImage = (media[0] && media[0].url) || existing.image || "";

    db.prepare(
        `UPDATE products SET
            name = ?, description = ?, specifications = ?, ship_from = ?, price = ?, old_price = ?, category = ?,
            image = ?, media = ?, stock = ?, availability = ?, sku = ?, brand = ?, subcategory = ?, condition_label = ?,
            warranty = ?, tags = ?, featured = ?
         WHERE id = ?`
    ).run(
        name,
        body.description != null ? String(body.description).trim() : existing.description,
        body.specifications != null ? String(body.specifications).trim() : existing.specifications,
        body.shipFrom != null ? String(body.shipFrom).trim() : existing.ship_from,
        price,
        body.oldPrice !== undefined ? (editOldPrice || null) : existing.old_price,
        resolveCategory(
            body.category != null ? body.category : existing.category,
            name,
            body.description != null ? body.description : existing.description,
            body.tags != null ? body.tags : existing.tags
        ),
        firstImage,
        mediaJson,
        editStock !== null ? editStock : existing.stock,
        editStock !== null ? (editStock > 0 ? "for_sale" : "sold") : existing.availability,
        body.sku != null ? String(body.sku).trim() : existing.sku,
        body.brand != null ? String(body.brand).trim() : existing.brand,
        body.subcategory != null ? String(body.subcategory).trim() : existing.subcategory,
        body.condition != null ? String(body.condition).trim() : existing.condition_label,
        body.warranty != null ? String(body.warranty).trim() : existing.warranty,
        body.tags != null ? String(body.tags).trim() : existing.tags,
        body.featured != null ? (body.featured === "true" ? 1 : 0) : existing.featured,
        request.params.id
    );

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(request.params.id);

    logActivity("product_edited", "Admin edited \"" + name + "\".", request, { productId: product.id });

    response.json({ message: "Product updated.", product: publicProduct(product) });
});

/* =========================
   ADMIN — INVENTORY
========================= */

app.get("/api/admin/inventory", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM products ORDER BY stock ASC, name ASC").all();

    response.json({
        products: rows.map(function (row) {
            return {
                id: row.id,
                name: row.name,
                sku: row.sku || "",
                stock: row.stock != null ? row.stock : 0,
                availability: row.availability || (Number(row.stock || 0) > 0 ? "for_sale" : "sold"),
                lowStockThreshold: row.low_stock_threshold != null ? row.low_stock_threshold : 5
            };
        })
    });
});

/* =========================
   ADMIN — ORDERS
========================= */

app.get("/api/admin/orders", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();

    response.json({ orders: rows.map(publicOrder) });
});

app.get("/api/admin/orders/:id", requireAdmin, function (request, response) {

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(request.params.id);

    if (!order) {
        return response.status(404).json({ message: "Order not found." });
    }

    const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);

    response.json({
        order: Object.assign(publicOrder(order), {
            items: items.map(function (item) {
                return {
                    id: item.id,
                    productId: item.product_id,
                    sellerId: item.seller_id,
                    name: item.name,
                    image: item.image,
                    price: item.price,
                    quantity: item.quantity
                };
            })
        })
    });
});

// Allowed manual order status changes. "delivered" is final; a cancelled
// order can only come back via "paid" (admin confirmed a late payment).
const ORDER_TRANSITIONS = {
    pending: ["paid", "cancelled"],
    paid: ["processing", "shipped", "delivered", "cancelled"],
    processing: ["shipped", "delivered", "cancelled"],
    shipped: ["delivered", "cancelled"],
    delivered: [],
    cancelled: ["paid"]
};

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    error.publicMessage = message;
    return error;
}

const changeOrderStatus = db.transaction(function (orderId, status) {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw httpError(404, "Order not found.");
    if (order.status === status) return order;

    if ((ORDER_TRANSITIONS[order.status] || []).indexOf(status) === -1) {
        throw httpError(409, "An order cannot be changed from " + order.status + " to " + status + ".");
    }

    const now = Date.now();
    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(order.id);

    if (status === "cancelled") {
        if (order.stock_deducted) {
            const restore = db.prepare("UPDATE products SET stock = stock + ?, availability = 'for_sale' WHERE id = ?");
            items.forEach(function (item) { if (item.product_id) restore.run(item.quantity, item.product_id); });
            db.prepare("UPDATE orders SET stock_deducted = 0 WHERE id = ?").run(order.id);
        } else if (order.payment_status === "pending") {
            releaseReservedStock(order.id);
        }
        db.prepare("UPDATE orders SET status = 'cancelled', payment_status = ?, reservation_expires = NULL, updated_at = ? WHERE id = ?")
            .run(order.payment_status === "pending" ? "cancelled" : order.payment_status, now, order.id);
    } else if (status === "paid") {
        if (!order.stock_deducted) {
            if (order.payment_status !== "pending") {
                // The reservation was already released, so check stock and hold it again first.
                const reserve = db.prepare(
                    "UPDATE products SET reserved_stock = COALESCE(reserved_stock, 0) + ? WHERE id = ? AND (stock - COALESCE(reserved_stock, 0)) >= ?"
                );
                items.forEach(function (item) {
                    if (item.product_id && reserve.run(item.quantity, item.product_id, item.quantity).changes !== 1) {
                        throw httpError(409, "Not enough stock to reinstate this order.");
                    }
                });
            }
            db.prepare("UPDATE orders SET payment_status = 'paid', status = 'paid', reservation_expires = NULL, updated_at = ? WHERE id = ?").run(now, order.id);
            deductStockForOrder(order.id);
        } else {
            db.prepare("UPDATE orders SET payment_status = 'paid', status = 'paid', updated_at = ? WHERE id = ?").run(now, order.id);
        }
    } else {
        db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(status, now, order.id);
    }

    return db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
});

app.post("/api/admin/orders/:id/status", requireAdmin, function (request, response) {

    const status = String((request.body || {}).status || "").trim();

    if (Object.keys(ORDER_TRANSITIONS).indexOf(status) === -1) {
        return response.status(400).json({ message: "Invalid order status." });
    }

    const order = changeOrderStatus(Number(request.params.id), status);

    logActivity("order_status_updated", "Order " + order.order_number + " marked as " + status + ".", request, { orderId: order.id, status: status });

    response.json({ ok: true });
});

/* =========================
   ADMIN — SELLERS
========================= */

app.get("/api/admin/sellers", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM sellers WHERE status = ? AND email != 'admin@phynex.internal' ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM sellers WHERE email != 'admin@phynex.internal' ORDER BY created_at DESC").all();

    const orderCountStmt = db.prepare(
        `SELECT COUNT(DISTINCT order_items.order_id) AS c
         FROM order_items JOIN products ON products.id = order_items.product_id
         WHERE products.seller_id = ?`
    );

    response.json({
        sellers: rows.map(function (seller) {
            return {
                id: seller.id,
                name: seller.business_name,
                email: seller.email,
                phone: seller.phone,
                whatsapp: seller.whatsapp || seller.phone || "",
                loggedIn: Boolean(seller.token && seller.token_expires && seller.token_expires > Date.now()),
                status: seller.status || "approved",
                orderCount: orderCountStmt.get(seller.id).c
            };
        })
    });
});

app.post("/api/admin/sellers/:id/status", requireAdmin, function (request, response) {

    const status = String((request.body || {}).status || "").trim();
    const allowed = ["pending", "approved", "suspended"];

    if (!allowed.includes(status)) {
        return response.status(400).json({ message: "Invalid seller status." });
    }

    const result = db.prepare("UPDATE sellers SET status = ? WHERE id = ?").run(status, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Seller not found." });
    }

    const seller = db.prepare("SELECT * FROM sellers WHERE id = ?").get(request.params.id);
    logActivity("seller_status_updated", seller.business_name + " marked as " + status + ".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — CUSTOMERS
========================= */

app.get("/api/admin/customers", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();

    const orderCountStmt = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_id = ?");

    response.json({
        customers: rows.map(function (customer) {
            return {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                phone: customer.phone,
                loggedIn: Boolean(customer.token && customer.token_expires && customer.token_expires > Date.now()),
                status: "approved",
                orderCount: orderCountStmt.get(customer.id).c
            };
        })
    });
});

/* =========================
   ADMIN — CATEGORIES
========================= */

app.get("/api/categories", function (request, response) {
    const rows = db.prepare("SELECT id, name, slug, description FROM categories ORDER BY name ASC").all();
    const countStmt = db.prepare("SELECT COUNT(*) AS c FROM products WHERE category = ? AND status = 'approved'");
    response.json({
        categories: rows.map(function (category) {
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description || "",
                productCount: countStmt.get(category.name).c
            };
        })
    });
});

app.get("/api/admin/categories", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM categories ORDER BY name ASC").all();

    const countStmt = db.prepare("SELECT COUNT(*) AS c FROM products WHERE category = ?");

    response.json({
        categories: rows.map(function (category) {
            return {
                id: category.id,
                name: category.name,
                slug: category.slug,
                description: category.description,
                productCount: countStmt.get(category.name).c
            };
        })
    });
});

app.post("/api/admin/categories", requireAdmin, function (request, response) {

    const body = request.body || {};
    const name = String(body.name || "").trim();

    if (!name) {
        return response.status(400).json({ message: "Category name is required." });
    }

    const slug = String(body.slug || name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    try {
        db.prepare(
            "INSERT INTO categories (name, slug, description, created_at) VALUES (?, ?, ?, ?)"
        ).run(name, slug, String(body.description || "").trim(), Date.now());
    } catch (error) {
        return response.status(409).json({ message: "A category with that name already exists." });
    }

    logActivity("category_added", "Added category \"" + name + "\".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — PROMOTIONS
========================= */

app.get("/api/admin/promotions", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM promotions ORDER BY created_at DESC").all();

    response.json({
        promotions: rows.map(function (promo) {
            return {
                id: promo.id,
                name: promo.name,
                type: promo.type,
                value: promo.value,
                active: Boolean(promo.active)
            };
        })
    });
});

app.post("/api/admin/promotions", requireAdmin, function (request, response) {

    const body = request.body || {};
    const name = String(body.name || "").trim();

    if (!name) {
        return response.status(400).json({ message: "Promotion name is required." });
    }

    db.prepare(
        "INSERT INTO promotions (name, type, value, active, created_at) VALUES (?, ?, ?, 1, ?)"
    ).run(name, String(body.type || "").trim(), String(body.value || "").trim(), Date.now());

    logActivity("promotion_added", "Added promotion \"" + name + "\".");

    response.json({ ok: true });
});

app.post("/api/admin/promotions/:id/toggle", requireAdmin, function (request, response) {

    const promo = db.prepare("SELECT * FROM promotions WHERE id = ?").get(request.params.id);

    if (!promo) {
        return response.status(404).json({ message: "Promotion not found." });
    }

    const active = promo.active ? 0 : 1;
    db.prepare("UPDATE promotions SET active = ? WHERE id = ?").run(active, promo.id);

    logActivity("promotion_toggled", (active ? "Activated " : "Deactivated ") + "\"" + promo.name + "\".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — REVIEWS
========================= */

app.get("/api/admin/reviews", requireAdmin, function (request, response) {

    const status = String(request.query.status || "").trim();

    const rows = status
        ? db.prepare("SELECT * FROM reviews WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT * FROM reviews ORDER BY created_at DESC").all();

    response.json({
        reviews: rows.map(function (review) {
            return {
                id: review.id,
                productId: review.product_id,
                productName: review.product_name,
                customerName: review.customer_name,
                rating: review.rating,
                comment: review.comment,
                status: review.status
            };
        })
    });
});

app.post("/api/admin/reviews/:id/approve", requireAdmin, function (request, response) {

    const result = db.prepare("UPDATE reviews SET status = 'approved' WHERE id = ?").run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Review not found." });
    }

    logActivity("review_approved", "Approved review #" + request.params.id + ".");

    response.json({ ok: true });
});

app.delete("/api/admin/reviews/:id", requireAdmin, function (request, response) {

    db.prepare("DELETE FROM reviews WHERE id = ?").run(request.params.id);

    logActivity("review_deleted", "Deleted review #" + request.params.id + ".");

    response.json({ ok: true });
});

/* =========================
   ADMIN — SETTINGS
========================= */

app.get("/api/admin/settings", requireAdmin, function (request, response) {
    response.json({ settings: getSettings() });
});

app.put("/api/admin/settings", requireAdmin, function (request, response) {

    const saved = saveSettings(request.body || {});

    logActivity("settings_saved", "Store settings updated.");

    response.json({ ok: true, settings: saved });
});

/* =========================
   ADMIN — ACTIVITY LOG
========================= */

app.get("/api/admin/activity", requireAdmin, function (request, response) {

    const limit = Math.min(1000, Math.max(1, Number(request.query.limit) || 500));
    const rows = db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?").all(limit);

    response.json({
        activity: rows.map(function (row) {
            return {
                id: row.id,
                action: row.action,
                description: row.description,
                actorType: row.actor_type || "system",
                actorId: row.actor_id || null,
                actorName: row.actor_name || "",
                actorEmail: row.actor_email || "",
                source: row.source || "server",
                requestPath: row.request_path || "",
                details: row.details || "",
                createdAt: new Date(row.created_at).toLocaleString("en-KE")
            };
        })
    });
});

app.delete("/api/admin/activity/:id", requireAdmin, function (request, response) {
    const result = db.prepare("DELETE FROM activity_log WHERE id = ?").run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Activity record not found." });
    }

    response.json({ ok: true });
});

app.delete("/api/admin/activity", requireAdmin, function (request, response) {
    db.prepare("DELETE FROM activity_log").run();
    response.json({ ok: true });
});

/* =========================
   ADMIN — USER LOGIN / LOGOUT ACTIVITY
========================= */

app.get("/api/admin/login-log", requireAdmin, function (request, response) {

    const userType = String(request.query.userType || "").trim();

    const rows = userType
        ? db.prepare("SELECT * FROM login_log WHERE user_type = ? ORDER BY created_at DESC LIMIT 200").all(userType)
        : db.prepare("SELECT * FROM login_log ORDER BY created_at DESC LIMIT 200").all();

    response.json({
        entries: rows.map(function (row) {
            return {
                userType: row.user_type,
                userId: row.user_id,
                name: row.name,
                email: row.email,
                action: row.action,
                createdAt: new Date(row.created_at).toLocaleString("en-KE")
            };
        })
    });
});

// Who is currently logged in right now (has an active token), for both
// customers and sellers, so the admin can see who's online at a glance.
app.get("/api/admin/online-users", requireAdmin, function (request, response) {

    const sellers = db
        .prepare("SELECT id, business_name AS name, email, phone, whatsapp FROM sellers WHERE token IS NOT NULL AND token != '' AND token_expires > ? AND email != 'admin@phynex.internal'")
        .all(Date.now())
        .map(function (row) { return Object.assign({ userType: "seller" }, row); });

    const customers = db
        .prepare("SELECT id, name, email, phone FROM customers WHERE token IS NOT NULL AND token != '' AND token_expires > ?")
        .all(Date.now())
        .map(function (row) { return Object.assign({ userType: "customer" }, row); });

    response.json({ online: sellers.concat(customers) });
});

/* =========================
   M-PESA CONFIGURATION
========================= */

// Delivery fee comes from admin settings (also served to the browser via /api/config).
function getDeliveryFee() {
    const fee = Number(getSettings().deliveryFee);
    return Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : 300;
}

const MAX_QTY_PER_LINE = 20;

function mpesaConfigured() {
    return Boolean(
        process.env.MPESA_CONSUMER_KEY &&
        process.env.MPESA_CONSUMER_SECRET &&
        process.env.MPESA_PASSKEY &&
        process.env.MPESA_SHORTCODE &&
        process.env.MPESA_CALLBACK_URL
    );
}

function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");

    if (/^07\d{8}$/.test(digits)) return "254" + digits.slice(1);
    if (/^01\d{8}$/.test(digits)) return "254" + digits.slice(1);
    if (/^2547\d{8}$/.test(digits)) return digits;
    if (/^2541\d{8}$/.test(digits)) return digits;

    return null;
}

function darajaBaseUrl() {
    return process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";
}

function timestamp() {
    const date = new Date();

    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
        String(date.getHours()).padStart(2, "0"),
        String(date.getMinutes()).padStart(2, "0"),
        String(date.getSeconds()).padStart(2, "0")
    ].join("");
}

async function getAccessToken() {
    const credentials = Buffer.from(
        process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET
    ).toString("base64");

    const response = await fetch(
        darajaBaseUrl() + "/oauth/v1/generate?grant_type=client_credentials",
        { headers: { Authorization: "Basic " + credentials } }
    );

    const body = await response.json();

    if (!response.ok || !body.access_token) {
        throw new Error(body.errorMessage || "Unable to authenticate with M-PESA.");
    }

    return body.access_token;
}

/* =========================
   M-PESA STK PUSH
   Creates a real "orders" row (status pending) plus one
   "order_items" row per cart line, then attempts payment.
========================= */

function releaseReservedStock(orderId) {
    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
    const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, COALESCE(reserved_stock, 0) - ?) WHERE id = ?");
    items.forEach(function (item) {
        if (item.product_id) release.run(item.quantity, item.product_id);
    });
}

function releaseExpiredReservations() {
    const now = Date.now();
    const expired = db.prepare(
        "SELECT id FROM orders WHERE payment_status = 'pending' AND status = 'pending' AND reservation_expires IS NOT NULL AND reservation_expires < ?"
    ).all(now);
    if (!expired.length) return;

    const markExpired = db.prepare(
        "UPDATE orders SET payment_status = 'expired', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ? AND payment_status = 'pending'"
    );
    const tx = db.transaction(function () {
        for (const order of expired) {
            if (markExpired.run(now, order.id).changes === 1) {
                releaseReservedStock(order.id);
            }
        }
    });
    tx();
}

app.post("/api/mpesa/stkpush", async function (request, response) {

    if (!mpesaConfigured()) {
        return response.status(503).json({ message: "M-PESA is not configured yet. Add your Daraja credentials to .env." });
    }

    releaseExpiredReservations();

    const payload = request.body || {};
    const customer = optionalCustomer(request);
    const customerInfo = payload.customer || {};
    const delivery = payload.delivery || {};
    const requestedItems = Array.isArray(payload.items) ? payload.items : [];

    const deliveryCounty = String(delivery.county || "").trim();
    if (!deliveryCounty) {
        return response.status(400).json({ message: "Select your county." });
    }

    if (!requestedItems.length) {
        return response.status(400).json({ message: "Your cart is empty." });
    }

    const phone = normalizePhone(payload.mpesaPhone);
    if (!phone) return response.status(400).json({ message: "Enter a valid Kenyan M-PESA number." });

    if (requestedItems.length > 50) {
        return response.status(400).json({ message: "Your cart has too many items." });
    }

    // Merge duplicate lines by product id so the stock check sees the true total.
    const mergedQuantities = new Map();
    for (const item of requestedItems) {
        const id = Number(item && item.id);
        const hasQty = item && item.quantity !== undefined && item.quantity !== null && item.quantity !== "";
        const rawQuantity = hasQty ? Number(item.quantity) : 1;
        if (!Number.isInteger(id) || !Number.isFinite(rawQuantity) || rawQuantity < 1) {
            return response.status(400).json({ message: "Your cart contains an invalid product or quantity." });
        }
        mergedQuantities.set(id, (mergedQuantities.get(id) || 0) + Math.round(rawQuantity));
    }
    for (const quantity of mergedQuantities.values()) {
        if (quantity > MAX_QTY_PER_LINE) {
            return response.status(400).json({ message: "You can order at most " + MAX_QTY_PER_LINE + " of the same product." });
        }
    }

    const productIds = Array.from(mergedQuantities.keys());
    const placeholders = productIds.map(() => "?").join(",");
    const rows = db.prepare(
        `SELECT products.*, sellers.business_name, sellers.phone AS seller_phone, sellers.whatsapp AS seller_whatsapp
         FROM products JOIN sellers ON sellers.id = products.seller_id
         WHERE products.id IN (${placeholders}) AND products.status = 'approved'
           AND COALESCE(sellers.status, 'approved') != 'suspended'`
    ).all(...productIds);

    const byId = new Map(rows.map(row => [row.id, row]));
    const authoritativeItems = [];
    let subtotal = 0;

    for (const [id, quantity] of mergedQuantities) {
        const product = byId.get(id);

        if (!product) {
            return response.status(400).json({ message: "One of the products is no longer available." });
        }

        const available = Math.max(0, Number(product.stock || 0) - Number(product.reserved_stock || 0));
        if (available < quantity) {
            return response.status(409).json({ message: product.name + " has only " + available + " available." });
        }

        subtotal += Number(product.price) * quantity;
        authoritativeItems.push({
            product,
            quantity
        });
    }

    const deliveryFee = getDeliveryFee();
    const total = Math.round(subtotal + deliveryFee);
    const orderNumber = generateOrderNumber();
    const reservationExpires = Date.now() + 30 * 60 * 1000;

    let orderId;

    try {
        const createOrder = db.transaction(function () {
            const result = db.prepare(
                `INSERT INTO orders
                    (order_number, customer_id, customer_name, customer_email, customer_phone,
                     county, sub_county, location, address, instructions, subtotal, delivery_fee, total,
                     payment_method, payment_status, status, reservation_expires, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mpesa', 'pending', 'pending', ?, ?, ?)`
            ).run(
                orderNumber,
                customer ? customer.id : null,
                String(customerInfo.name || (customer && customer.name) || "").trim(),
                String(customerInfo.email || (customer && customer.email) || "").trim(),
                String(customerInfo.phone || payload.mpesaPhone || "").trim(),
                deliveryCounty,
                String(delivery.subCounty || "").trim() || null,
                String(delivery.location || "").trim(),
                String(delivery.address || "").trim(),
                String(delivery.instructions || "").trim(),
                subtotal,
                deliveryFee,
                total,
                reservationExpires,
                Date.now(),
                Date.now()
            );

            const id = result.lastInsertRowid;
            const insertItem = db.prepare(
                "INSERT INTO order_items (order_id, product_id, seller_id, name, image, price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)"
            );
            const reserve = db.prepare(
                "UPDATE products SET reserved_stock = COALESCE(reserved_stock, 0) + ? WHERE id = ? AND (stock - COALESCE(reserved_stock, 0)) >= ?"
            );

            for (const item of authoritativeItems) {
                const changed = reserve.run(item.quantity, item.product.id, item.quantity);
                if (changed.changes !== 1) throw new Error("Stock changed while your order was being prepared. Please try again.");
                insertItem.run(id, item.product.id, item.product.seller_id, item.product.name, item.product.image || "", item.product.price, item.quantity);
            }
            return id;
        });

        orderId = createOrder();

        const accessToken = await getAccessToken();
        const requestTimestamp = timestamp();
        const password = Buffer.from(
            process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + requestTimestamp
        ).toString("base64");

        const darajaResponse = await fetch(
            darajaBaseUrl() + "/mpesa/stkpush/v1/processrequest",
            {
                method: "POST",
                headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
                body: JSON.stringify({
                    BusinessShortCode: process.env.MPESA_SHORTCODE,
                    Password: password,
                    Timestamp: requestTimestamp,
                    TransactionType: "CustomerPayBillOnline",
                    Amount: total,
                    PartyA: phone,
                    PartyB: process.env.MPESA_SHORTCODE,
                    PhoneNumber: phone,
                    CallBackURL: mpesaCallbackUrl(),
                    AccountReference: "PHYNEX",
                    TransactionDesc: "PHYNEX order payment"
                })
            }
        );

        const result = await darajaResponse.json();

        if (!darajaResponse.ok || !result.CheckoutRequestID) {
            db.prepare("UPDATE orders SET payment_status = 'failed', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?")
                .run(Date.now(), orderId);
            const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
            const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, reserved_stock - ?) WHERE id = ?");
            items.forEach(item => { if (item.product_id) release.run(item.quantity, item.product_id); });
            return response.status(502).json({ message: result.errorMessage || result.ResponseDescription || "M-PESA rejected the STK Push request." });
        }

        db.prepare("UPDATE orders SET checkout_request_id = ?, updated_at = ? WHERE id = ?")
            .run(result.CheckoutRequestID, Date.now(), orderId);

        payments.set(result.CheckoutRequestID, {
            status: "pending",
            orderNumber,
            orderId,
            amount: total,
            phone,
            createdAt: Date.now()
        });

        logActivity("order_created", "Order " + orderNumber + " created (awaiting payment).", request, { orderNumber: orderNumber, itemCount: requestedItems.length });

        return response.json({
            checkoutRequestId: result.CheckoutRequestID,
            orderNumber,
            customerMessage: result.CustomerMessage || "M-PESA payment request sent."
        });

    } catch (error) {
        if (orderId) {
            const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);
            const release = db.prepare("UPDATE products SET reserved_stock = MAX(0, reserved_stock - ?) WHERE id = ?");
            items.forEach(item => { if (item.product_id) release.run(item.quantity, item.product_id); });
            db.prepare("UPDATE orders SET payment_status = 'failed', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?")
                .run(Date.now(), orderId);
        }
        return response.status(502).json({ message: error.message || "Unable to process your order." });
    }
});

/* =========================
   M-PESA CALLBACK
========================= */

/* =========================
   STOCK — deduct once an order is actually paid
========================= */

function deductStockForOrder(orderId) {

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);

    if (!order || order.stock_deducted) {
        return; // already paid+deducted before, or order missing — never deduct twice
    }

    const items = db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ?").all(orderId);

    const updateStock = db.prepare(
        "UPDATE products SET stock = MAX(0, stock - ?), reserved_stock = MAX(0, COALESCE(reserved_stock, 0) - ?), availability = CASE WHEN stock - ? <= 0 THEN 'sold' ELSE 'for_sale' END WHERE id = ?"
    );

    items.forEach(function (item) {
        if (item.product_id) {
            updateStock.run(item.quantity, item.quantity, item.quantity, item.product_id);
        }
    });

    db.prepare("UPDATE orders SET stock_deducted = 1 WHERE id = ?").run(orderId);
}

function mpesaCallbackUrl() {
    const base = String(process.env.MPESA_CALLBACK_URL || "").replace(/\/+$/, "");
    const secret = process.env.MPESA_CALLBACK_SECRET;
    if (!secret) return base;
    return base.endsWith("/" + secret) ? base : base + "/" + secret;
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Ask Safaricom directly whether this STK request was paid.
async function stkQuery(checkoutRequestId) {
    const accessToken = await getAccessToken();
    const requestTimestamp = timestamp();
    const password = Buffer.from(
        process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + requestTimestamp
    ).toString("base64");

    const darajaResponse = await fetch(darajaBaseUrl() + "/mpesa/stkpushquery/v1/query", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
            BusinessShortCode: process.env.MPESA_SHORTCODE,
            Password: password,
            Timestamp: requestTimestamp,
            CheckoutRequestID: checkoutRequestId
        })
    });

    return darajaResponse.json();
}

// Moves an order out of 'pending' exactly once. Anything not pending is left alone,
// so duplicate/late callbacks can't double-deduct, double-release or overwrite a paid order.
const finalizeOrderPayment = db.transaction(function (orderId, paid, meta) {
    const current = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!current || current.payment_status !== "pending") return false;

    const now = Date.now();
    meta = meta || {};

    if (paid) {
        db.prepare(
            "UPDATE orders SET payment_status = 'paid', status = 'paid', reservation_expires = NULL, updated_at = ?, mpesa_receipt = COALESCE(?, mpesa_receipt), mpesa_transaction_date = COALESCE(?, mpesa_transaction_date), mpesa_phone = COALESCE(?, mpesa_phone) WHERE id = ?"
        ).run(now, meta.receipt || null, meta.date || null, meta.phone || null, orderId);
        deductStockForOrder(orderId);
    } else {
        db.prepare(
            "UPDATE orders SET payment_status = 'failed', status = 'cancelled', reservation_expires = NULL, updated_at = ? WHERE id = ?"
        ).run(now, orderId);
        releaseReservedStock(orderId);
    }
    return true;
});

async function processMpesaCallback(callback) {

    const checkoutId = String(callback.CheckoutRequestID || "");
    const order = db.prepare("SELECT * FROM orders WHERE checkout_request_id = ?").get(checkoutId);

    if (!order) {
        logActivity("mpesa_callback_unknown", "M-PESA callback received for an unknown checkout request.", null, { checkoutRequestId: checkoutId, flagged: true });
        return;
    }

    const paid = Number(callback.ResultCode) === 0;
    payments.set(checkoutId, { message: callback.ResultDesc || "", updatedAt: Date.now() });

    if (!paid) {
        if (finalizeOrderPayment(order.id, false, {})) {
            logActivity("order_payment_failed", "Order " + order.order_number + " payment failed.");
        }
        return;
    }

    const meta = { receipt: null, date: null, phone: null, amount: NaN };
    const metadataItems = callback.CallbackMetadata && Array.isArray(callback.CallbackMetadata.Item)
        ? callback.CallbackMetadata.Item
        : [];
    metadataItems.forEach(function (item) {
        if (!item || !item.Name) return;
        if (item.Name === "MpesaReceiptNumber") meta.receipt = String(item.Value);
        if (item.Name === "TransactionDate") meta.date = String(item.Value);
        if (item.Name === "PhoneNumber") meta.phone = String(item.Value);
        if (item.Name === "Amount") meta.amount = Number(item.Value);
    });

    if (order.payment_status === "paid") return; // duplicate callback

    if (order.payment_status !== "pending") {
        // Money arrived for an order we already expired/cancelled. Keep the receipt and flag for admin.
        db.prepare(
            "UPDATE orders SET mpesa_receipt = COALESCE(?, mpesa_receipt), mpesa_transaction_date = COALESCE(?, mpesa_transaction_date), mpesa_phone = COALESCE(?, mpesa_phone), updated_at = ? WHERE id = ?"
        ).run(meta.receipt, meta.date, meta.phone, Date.now(), order.id);
        logActivity(
            "late_payment_needs_review",
            "REVIEW NEEDED: order " + order.order_number + " was already " + order.payment_status + " when M-PESA reported a successful payment" + (meta.receipt ? " (receipt " + meta.receipt + ")" : "") + ". Refund the customer or reinstate the order.",
            null,
            { orderId: order.id, receipt: meta.receipt, amount: meta.amount, flagged: true }
        );
        return;
    }

    if (!Number.isFinite(meta.amount) || Math.round(meta.amount) !== Number(order.total)) {
        logActivity(
            "mpesa_amount_mismatch",
            "REVIEW NEEDED: order " + order.order_number + " expects KSh " + order.total + " but the callback reported " + meta.amount + ". Order NOT marked paid.",
            null,
            { orderId: order.id, receipt: meta.receipt, paidAmount: meta.amount, expected: order.total, flagged: true }
        );
        return;
    }

    // Do not trust the callback alone: confirm with Safaricom.
    let confirmed = null;
    for (let attempt = 0; attempt < 3 && confirmed === null; attempt++) {
        try {
            const result = await stkQuery(checkoutId);
            if (result && result.ResultCode !== undefined && result.ResultCode !== null) {
                confirmed = String(result.ResultCode) === "0";
            }
        } catch (error) {
            console.error("STK query failed:", error.message);
        }
        if (confirmed === null && attempt < 2) await sleep(2000);
    }

    if (confirmed !== true) {
        logActivity(
            confirmed === false ? "mpesa_callback_rejected" : "mpesa_verification_unavailable",
            confirmed === false
                ? "REVIEW NEEDED: callback claimed order " + order.order_number + " was paid but Safaricom's STK query says it was not. Order NOT marked paid."
                : "Could not confirm order " + order.order_number + " with Safaricom's STK query; it stays pending and will be re-checked when the buyer's browser polls.",
            null,
            { orderId: order.id, receipt: meta.receipt, flagged: confirmed === false }
        );
        return;
    }

    if (finalizeOrderPayment(order.id, true, meta)) {
        logActivity("order_paid", "Order " + order.order_number + " was paid" + (meta.receipt ? " (receipt " + meta.receipt + ")" : "") + ".");
    }
}

app.post(["/api/mpesa/callback", "/api/mpesa/callback/:secret"], function (request, response) {

    const expected = process.env.MPESA_CALLBACK_SECRET;
    if (expected && !safeEqual(request.params.secret || "", expected)) {
        console.warn("Rejected M-PESA callback with a missing or wrong secret from " + request.ip);
        return response.status(403).json({ ResultCode: 1, ResultDesc: "Forbidden" });
    }

    const callback = request.body && request.body.Body && request.body.Body.stkCallback;

    response.json({ ResultCode: 0, ResultDesc: "Callback received" });

    if (!callback || !callback.CheckoutRequestID) return;

    processMpesaCallback(callback).catch(function (error) {
        console.error("M-PESA callback processing failed:", error);
    });
});

/* =========================
   CHECK PAYMENT STATUS
   Reads the order from the database. If the callback never arrived (or
   could not be verified) a still-pending order is re-checked with Safaricom.
========================= */

const lastReconcile = new Map();

async function reconcilePendingOrder(order) {
    if (!order || order.payment_status !== "pending" || !order.checkout_request_id) return;
    if (Date.now() - Number(order.created_at) < 20 * 1000) return;
    if (Date.now() - (lastReconcile.get(order.checkout_request_id) || 0) < 10 * 1000) return;
    lastReconcile.set(order.checkout_request_id, Date.now());

    try {
        const result = await stkQuery(order.checkout_request_id);
        if (!result || result.ResultCode === undefined || result.ResultCode === null) return; // still processing
        const success = String(result.ResultCode) === "0";
        payments.set(order.checkout_request_id, { message: result.ResultDesc || "", updatedAt: Date.now() });
        if (finalizeOrderPayment(order.id, success, {})) {
            logActivity(success ? "order_paid" : "order_payment_failed", "Order " + order.order_number + (success ? " was confirmed paid by M-PESA status query (no receipt captured; check the M-PESA statement)." : " payment failed."));
        }
    } catch (error) {
        console.error("Payment reconcile failed:", error.message);
    }
}

app.get("/api/mpesa/status/:checkoutRequestId", paymentStatusLimiter, async function (request, response) {

    const checkoutId = String(request.params.checkoutRequestId || "");
    let order = db.prepare("SELECT * FROM orders WHERE checkout_request_id = ?").get(checkoutId);

    if (!order) {
        return response.status(404).json({ status: "unknown", message: "Payment request not found." });
    }

    if (order.payment_status === "pending" && mpesaConfigured()) {
        await reconcilePendingOrder(order);
        order = db.prepare("SELECT * FROM orders WHERE checkout_request_id = ?").get(checkoutId);
    }

    const cached = payments.get(checkoutId) || {};
    let status = "pending";
    if (order.payment_status === "paid") status = "paid";
    else if (["failed", "expired", "cancelled"].indexOf(order.payment_status) !== -1) status = "failed";

    response.json({
        status: status,
        orderNumber: order.order_number,
        message: cached.message || (order.payment_status === "expired" ? "The payment request expired. Please try again." : (status === "failed" ? "The M-PESA payment could not be completed." : ""))
    });
});

/* =========================
   CONTACT FORM
========================= */

function contactMailConfigured() {
    return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);
}

const mailTransporter = contactMailConfigured()
    ? nodemailer.createTransport({
        host: process.env.EMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: Number(process.env.EMAIL_PORT) === 465,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
    })
    : null;

const contactRateLimit = new Map();
const CONTACT_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_MAX_PER_WINDOW = 5;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = contactRateLimit.get(ip);

    if (!entry || now - entry.windowStart > CONTACT_WINDOW_MS) {
        contactRateLimit.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    entry.count += 1;

    return entry.count > CONTACT_MAX_PER_WINDOW;
}

app.post("/api/contact", async function (request, response) {

    if (isRateLimited(request.ip)) {
        return response.status(429).json({ message: "Too many messages sent. Please try again later." });
    }

    const body = request.body || {};

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();

    if (!name || !email || !message) {
        return response.status(400).json({ message: "Please fill in all fields." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response.status(400).json({ message: "Enter a valid email address." });
    }

    if (name.length > 200) {
        return response.status(400).json({ message: "Name is too long." });
    }

    if (message.length > 5000) {
        return response.status(400).json({ message: "Message is too long." });
    }

    // Always keep a copy in the database first — this is what lets admin
    // see every message that comes in, whether or not outgoing email is
    // configured on this deployment.
    db.prepare(
        "INSERT INTO messages (name, email, message, source, is_read, created_at) VALUES (?, ?, ?, 'contact', 0, ?)"
    ).run(name, email, message, Date.now());

    logActivity("message_received", "New contact message from " + name + " <" + email + ">.", request, { email: email });

    if (contactMailConfigured()) {
        try {
            await mailTransporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
                to: process.env.CONTACT_TO || process.env.EMAIL_USER,
                replyTo: email,
                subject: "New PHYNEX contact form message from " + name,
                text: "From: " + name + " <" + email + ">\n\n" + message
            });
        } catch (error) {
            // Email is best-effort — the message is already saved and
            // visible to admin, so a mail-relay hiccup shouldn't fail
            // the whole request.
            console.error("Contact form email failed:", error.message);
        }
    }

    return response.json({ ok: true });
});

/* =========================
   ADMIN — MESSAGES
   Every contact-form submission, stored so admin can see them all
   even when outgoing email isn't configured.
========================= */

app.get("/api/admin/messages", requireAdmin, function (request, response) {

    const rows = db.prepare("SELECT * FROM messages ORDER BY created_at DESC").all();

    response.json({
        messages: rows.map(function (row) {
            return {
                id: row.id,
                name: row.name,
                email: row.email,
                message: row.message,
                source: row.source,
                isRead: Boolean(row.is_read),
                createdAt: row.created_at
            };
        })
    });
});

app.post("/api/admin/messages/:id/read", requireAdmin, function (request, response) {

    const read = (request.body || {}).read === false ? 0 : 1;

    const result = db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").run(read, request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Message not found." });
    }

    response.json({ ok: true });
});

app.delete("/api/admin/messages/:id", requireAdmin, function (request, response) {

    const result = db.prepare("DELETE FROM messages WHERE id = ?").run(request.params.id);

    if (result.changes === 0) {
        return response.status(404).json({ message: "Message not found." });
    }

    response.json({ ok: true });
});

/* =========================
   SERVER HEALTH
========================= */

app.get("/api/health", function (_request, response) {
    response.json({
        ok: true,
        mpesaConfigured: mpesaConfigured(),
        contactMailConfigured: contactMailConfigured(),
        googleConfigured: googleConfigured(),
        adminConfigured: Boolean(process.env.ADMIN_PASSWORD)
    });
});

/* =========================
   PUBLIC CONFIG
   Non-secret values the front-end needs (e.g. the Google Sign-In
   client ID, which is public by design — never the client secret).
========================= */

app.get("/api/config", function (_request, response) {
    response.json({
        googleClientId: googleConfigured() ? process.env.GOOGLE_CLIENT_ID : null,
        deliveryFee: getDeliveryFee()
    });
});

/* =========================
   START SERVER
========================= */

function housekeeping() {
    const now = Date.now();
    authAttempts.forEach(function (row, key) { if (now - row.startedAt > AUTH_WINDOW_MS) authAttempts.delete(key); });
    contactRateLimit.forEach(function (row, key) { if (now - row.windowStart > CONTACT_WINDOW_MS) contactRateLimit.delete(key); });
    rateBuckets.forEach(function (row, key) { if (now - row.windowStart > row.windowMs) rateBuckets.delete(key); });
    adminTokens.forEach(function (expires, token) { if (expires < now) adminTokens.delete(token); });
    payments.forEach(function (row, key) { if (now - (row.updatedAt || 0) > 24 * 60 * 60 * 1000) payments.delete(key); });
    if (lastReconcile.size > 1000) lastReconcile.clear();
    try {
        // Clear expired sessions so "online" is accurate.
        db.prepare("UPDATE customers SET token = NULL WHERE token IS NOT NULL AND token_expires IS NOT NULL AND token_expires < ?").run(now);
        db.prepare("UPDATE sellers SET token = NULL WHERE token IS NOT NULL AND token_expires IS NOT NULL AND token_expires < ?").run(now);
        releaseExpiredReservations();
    } catch (error) {
        console.error("Housekeeping failed:", error.message);
    }
}
setInterval(housekeeping, 5 * 60 * 1000);
housekeeping();

// Unknown API routes -> JSON 404; everything else falls back to a plain 404.
app.use(function (request, response) {
    if (request.path.indexOf("/api/") === 0) {
        return response.status(404).json({ message: "Not found." });
    }
    response.status(404).type("text/plain").send("Not found");
});

// Central error handler: always JSON, never a stack trace.
app.use(function (error, request, response, next) {
    if (response.headersSent) return next(error);

    let status = Number(error && (error.status || error.statusCode)) || 500;
    let message = "Something went wrong. Please try again.";

    if (error && error.type === "entity.parse.failed") {
        status = 400;
        message = "Invalid JSON in request body.";
    } else if (error && error.type === "entity.too.large") {
        status = 413;
        message = "Request body is too large.";
    } else if (error && error.publicMessage) {
        message = error.publicMessage;
    } else if (status < 500) {
        message = "Bad request.";
    }

    if (status >= 500) {
        status = 500;
        console.error("Request failed:", request.method, request.originalUrl, error);
    }

    response.status(status).json({ message: message });
});

app.listen(port, function () {
    console.log("PHYNEX server running at http://localhost:" + port);
});
