// ============================================
// SaveHatke — Shared coupon metadata helpers
// ============================================
// Brand-logo resolution and expiry maths, used by both the public marketplace
// (public/js/marketplace.js) and the admin Coupon Management table
// (public/js/admin.js). Loaded as a classic script, so everything declared here
// is available to the scripts that follow it on the page.

// ── Brand Logo Helpers ──────────────────────────────────────────────────
const BRAND_DOMAINS = {
  'Amazon': 'amazon.in',
  'Amazon Pay': 'amazon.in',
  'Amazon Prime': 'primevideo.com',
  'Flipkart': 'flipkart.com',
  'Meesho': 'meesho.com',
  'Tata CLiQ': 'tatacliq.com',
  'Croma': 'croma.com',
  'JioMart': 'jiomart.com',
  'BigBasket': 'bigbasket.com',
  'Myntra': 'myntra.com',
  'AJIO': 'ajio.com',
  'H&M': 'hm.com',
  'Puma': 'puma.com',
  'Adidas': 'adidas.co.in',
  'Nike': 'nike.com',
  'Nykaa Fashion': 'nykaafashion.com',
  'Lenskart': 'lenskart.com',
  'Nykaa': 'nykaa.com',
  'Purplle': 'purplle.com',
  'Mamaearth': 'mamaearth.in',
  'Minimalist': 'beminimalist.co',
  'Lakmé': 'lakmeindia.com',
  'The Body Shop': 'thebodyshop.in',
  'mCaffeine': 'mcaffeine.com',
  'WOW Skin Science': 'buywow.in',
  'Plum': 'plumgoodness.com',
  'Swiggy': 'swiggy.com',
  'Swiggy Instamart': 'swiggy.com',
  'Zomato': 'zomato.com',
  "Domino's": 'dominos.co.in',
  'Pizza Hut': 'pizzahut.co.in',
  'EatSure': 'eatsure.com',
  'KFC': 'kfc.co.in',
  'MakeMyTrip': 'makemytrip.com',
  'Cleartrip': 'cleartrip.com',
  'EaseMyTrip': 'easemytrip.com',
  'Uber': 'uber.com',
  'Rapido': 'rapido.bike',
  'Ola': 'olacabs.com',
  'IRCTC': 'irctc.co.in',
  'RedBus': 'redbus.in',
  'IndiGo': 'goindigo.in',
  'OYO': 'oyorooms.com',
  'Booking.com': 'booking.com',
  'Agoda': 'agoda.com',
  'Goibibo': 'goibibo.com',
  'Treebo': 'treebo.com',
  'FabHotels': 'fabhotels.com',
  'Airbnb': 'airbnb.co.in',
  'Reliance Digital': 'reliancedigital.in',
  'Samsung': 'samsung.com',
  'OnePlus': 'oneplus.in',
  'boAt': 'boat-lifestyle.com',
  'Noise': 'gonoise.com',
  'Apple': 'apple.com',
  'Vijay Sales': 'vijaysales.com',
  'PlayStation': 'playstation.com',
  'Xbox': 'xbox.com',
  'Steam': 'steampowered.com',
  'Google Play': 'play.google.com',
  'BookMyShow': 'bookmyshow.com',
  'Netflix': 'netflix.com',
  'Disney+ Hotstar': 'hotstar.com',
  'Cult.fit': 'cult.fit',
  'Decathlon': 'decathlon.in',
  'HealthifyMe': 'healthifyme.com',
  'GNC': 'gnc.com',
  'PharmEasy': 'pharmeasy.in',
  '1mg (Tata)': '1mg.com',
  'Netmeds': 'netmeds.com',
  'Apollo Pharmacy': 'apollopharmacy.in',
  'Udemy': 'udemy.com',
  'Coursera': 'coursera.org',
  'Unacademy': 'unacademy.com',
  "BYJU'S": 'byjus.com',
  'Skillshare': 'skillshare.com',
  'Simplilearn': 'simplilearn.com',
  'Paytm': 'paytm.com',
  'PhonePe': 'phonepe.com',
  'Google Pay': 'pay.google.com',
  'CRED': 'cred.club',
  'FreeCharge': 'freecharge.in',
  'Zepto': 'zeptonow.com',
  'Blinkit': 'blinkit.com',
  'Urban Company': 'urbancompany.com',
  'Pepperfry': 'pepperfry.com',
  'IKEA': 'ikea.in',
  'Licious': 'licious.in',
  'BBQ Nation': 'bbqnation.com',
  'Barbeque Nation': 'bbqnation.com',
  'SonyLIV': 'sonyliv.com',
  'ZEE5': 'zee5.com',
  // ── New brands from 200-coupon batch ──
  'Snapdeal': 'snapdeal.com',
  'ShopClues': 'shopclues.com',
  'Zara': 'zara.com',
  'Reebok': 'reebok.co.in',
  'Crocs': 'crocs.in',
  'Bata': 'bata.in',
  'Forest Essentials': 'forestessentialsindia.com',
  'Sugar Cosmetics': 'sugarcosmetics.com',
  'Biotique': 'biotique.com',
  'Kama Ayurveda': 'kamaayurveda.com',
  'Colorbar': 'colorbarcosmetics.com',
  'Faces Canada': 'facescanada.com',
  'Dove': 'dove.com',
  "L'Oréal Paris": 'lorealparis.co.in',
  "McDonald's": 'mcdonaldsindia.com',
  'Burger King': 'burgerking.in',
  'Subway': 'subway.com',
  'Starbucks': 'starbucks.in',
  'Dunzo': 'dunzo.com',
  'FreshToHome': 'freshtohome.com',
  'Country Delight': 'countrydelight.in',
  'SpiceJet': 'spicejet.com',
  'Air India': 'airindia.com',
  'Vistara': 'airvistara.com',
  'Yatra': 'yatra.com',
  'ixigo': 'ixigo.com',
  'Zostel': 'zostel.com',
  'StayVista': 'stayvista.com',
  'Realme': 'realme.com',
  'Xiaomi': 'mi.com',
  'Mi': 'mi.com',
  'JBL': 'jbl.com',
  'Sony': 'sony.co.in',
  'Dell': 'dell.com',
  'HP': 'hp.com',
  'Lenovo': 'lenovo.com',
  'Canon': 'canon.co.in',
  'Bose': 'bose.in',
  'Marshall': 'marshallheadphones.com',
  'Spotify': 'spotify.com',
  'YouTube': 'youtube.com',
  'MuscleBlaze': 'muscleblaze.com',
  'Optimum Nutrition': 'optimumnutrition.com',
  'Under Armour': 'underarmour.com',
  'ASICS': 'asics.com',
  'New Balance': 'newbalance.com',
  'Fitbit': 'fitbit.com',
  'MediBuddy': 'medibuddy.in',
  'Practo': 'practo.com',
  'HealthKart': 'healthkart.com',
  'Lybrate': 'lybrate.com',
  'Tata 1mg': '1mg.com',
  'Vedantu': 'vedantu.com',
  'Toppr': 'toppr.com',
  'LinkedIn Learning': 'linkedin.com',
  'Pluralsight': 'pluralsight.com',
  'Khan Academy': 'khanacademy.org',
  'Great Learning': 'greatlearning.in',
  'upGrad': 'upgrad.com',
  'Edureka': 'edureka.co',
  'MobiKwik': 'mobikwik.com',
  'Airtel Thanks': 'airtel.in',
  'Jio': 'jio.com',
  'BharatPe': 'bharatpe.com',
  'Vi': 'myvi.in',
  'Bewakoof': 'bewakoof.com',
  'Souled Store': 'thesouledstore.com',
  'Snitch': 'snitch.co.in',
  'Urbanic': 'urbanic.com',
  'Clovia': 'clovia.com',
  'Renee Cosmetics': 'reneecosmetics.in',
  'Swiss Beauty': 'swissbeauty.in',
  'Beardo': 'beardo.in',
  'Chaayos': 'chaayos.com',
  "Haldiram's": 'haldirams.com',
  'Baskin Robbins': 'baskinrobbins.in',
  'Wow! Momo': 'wowmomos.com',
  'Lemon Tree': 'lemontreehotels.com',
  'ITC Hotels': 'itchotels.com',
  'Taj Hotels': 'tajhotels.com',
  'Curefit': 'cult.fit',
  'FirstCry': 'firstcry.com',
  'Hopscotch': 'hopscotch.in',
  'Prestige': 'ttkhealthcare.com',
  'Crompton': 'crompton.co.in',
  'Havells': 'havells.com',
  'Asian Paints': 'asianpaints.com',
  'Nippon Paint': 'nipponpaint.co.in',
  'NestAway': 'nestaway.com',
  'Rentomojo': 'rentomojo.com',
  'Furlenco': 'furlenco.com',
  'Sleepwell': 'sleepwell.co.in',
  'Wakefit': 'wakefit.co',
  'Livspace': 'livspace.com',
  'HomeLane': 'homelane.com',
  'Godrej Interio': 'godrejinterio.com',
};

// Local logo files (preferred — always loads, no third-party dependency).
// Add new entries as you need them; the file must exist under public/logos/.
const BRAND_LOGOS = {
  'Amazon':           '/logos/amazon.svg',
  'Amazon Pay':       '/logos/amazon.svg',
  'Amazon Prime':     '/logos/amazon.svg',
  'Amazon Fresh':     '/logos/amazon.svg',
  'Nykaa':            '/logos/nykaa.svg',
  'Nykaa Fashion':    '/logos/nykaa.svg',
  'Adidas':           '/logos/adidas.svg',
  'Puma':             '/logos/puma.svg',
  'Zomato':           '/logos/zomato.svg',
  'Google':           '/logos/google.svg',
  'Google Pay':       '/logos/google.svg',
  'Myntra':           '/logos/myntra.svg',
  'Flipkart':         '/logos/flipkart.png',
  'Flipkart Plus':    '/logos/flipkart.png',
  'Swiggy':           '/logos/swiggy.svg',
  'Swiggy Instamart': '/logos/swiggy.svg',
  'Meesho':           '/logos/meesho.png',
  "Domino's":         '/logos/dominos.svg',
  'Blinkit':            '/logos/blinkit.svg',
  'Zepto':              '/logos/zepto.svg',
  'Pizza Hut':          '/logos/pizzahut.svg',
  'Croma':              '/logos/croma.svg',
  'AJIO':               '/logos/ajio.svg',
  'Mamaearth':          '/logos/mamaearth.png',
  'Lakmé':              '/logos/lakme.svg',
  'Uber':               '/logos/uber.svg',
  'Booking.com':        '/logos/booking.svg',
  'Reliance Digital':   '/logos/reliance-digital.svg',
  'ixigo':              '/logos/ixigo.svg',
  'Shopsy':             '/logos/shopsy.jpg',
  'Snapdeal':           '/logos/snapdeal.png',
  'Tata CLiQ':          '/logos/tata-cliq.jpg',
  'Netflix':            '/logos/netflix.svg',
  'KFC':                '/logos/kfc.png',
  'CRED':               '/logos/cred.png',
  'Subway':             '/logos/subway.png',
  'Coursera':           '/logos/coursera.svg',
  "McDonald's":         '/logos/mcdonalds.svg',
};

/**
 * Brand names reach us three ways — an admin picking from a list, a seller
 * free-typing into the sell form, and whatever is already sitting in the
 * sheet — so "AJIO", "Ajio" and "ajio" all turn up for the same brand. Look
 * the logo up on a squashed key (lowercased, accents dropped, punctuation and
 * spaces removed) so one map entry covers every spelling: 'Lakmé' also
 * answers for "Lakme", 'Booking.com' for "booking com", 'Pizza Hut' for
 * "pizzahut".
 */
function normBrandKey(brand) {
  return String(brand || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics: Lakmé -> Lakme
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');        // drop spaces, dots, apostrophes, &
}

const BRAND_LOGOS_NORM = Object.create(null);
for (const [name, url] of Object.entries(BRAND_LOGOS)) {
  const key = normBrandKey(name);
  if (key && !(key in BRAND_LOGOS_NORM)) BRAND_LOGOS_NORM[key] = url;
}
// Spellings that do not squash down to a listed brand name on their own.
Object.assign(BRAND_LOGOS_NORM, {
  booking:          '/logos/booking.svg',   // "Booking" without the .com
  reliancedigi:     '/logos/reliance-digital.svg',
  instamart:        '/logos/swiggy.svg',
  dominos:          '/logos/dominos.svg',   // typed without the apostrophe
});

const BRAND_DOMAINS_NORM = Object.create(null);
for (const [name, domain] of Object.entries(BRAND_DOMAINS)) {
  const key = normBrandKey(name);
  if (key && !(key in BRAND_DOMAINS_NORM)) BRAND_DOMAINS_NORM[key] = domain;
}

// ── Brand hero backgrounds ─────────────────────────────────────────────
// Per-brand card backgrounds for the marketplace coupon cards, living in
// public/images/coupons/brands/. Keyed on the same squashed-brand rules as
// the logos above, so every spelling of a brand ("AJIO", "Ajio", "ajio")
// finds its background. The filename is what matters — add a new
// <name>-bg.png to the folder and an entry here, and every card for that
// brand picks it up.
const BRAND_BGS = {
  'Adidas':           'adidas-bg.png',
  'Airtel Thanks':    'airtel-thanks-bg.png',
  'AJIO':             'ajio-bg.png',
  'Amazon':           'amazon-bg.png',
  'Amazon Pay':       'amazon-bg.png',
  'Amazon Prime':     'amazon-bg.png',
  'Apollo 24/7':      'apollo-247-bg.png',
  'BigBasket':        'bigbasket-bg.png',
  'Blinkit':          'blinkit-bg.png',
  'boAt':             'boat-bg.png',
  'BookMyShow':       'bookmyshow-bg.png',
  'Burger King':      'burger-king-bg.png',
  'Cleartrip':        'cleartrip-bg.png',
  'Croma':            'croma-bg.png',
  'Country Delight':  'country-delight-bg.png',
  'CRED':             'cred-bg.png',
  'Decathlon':        'decathlon-bg.png',
  "Domino's":         'dominos-bg.png',
  'FirstCry':         'firstcry-bg.png',
  'Flipkart':         'flipkart-bg.png',
  'Flipkart Plus':    'flipkart-bg.png',
  'FreshToHome':      'freshtohome-bg.png',
  'IKEA':             'ikea-bg.png',
  'JBL':              'jbl-bg.png',
  'KFC':              'kfc-bg.png',
  'Lenskart':         'lenskart-bg.png',
  'Livspace':         'livspace-bg.png',
  'MakeMyTrip':       'makemytrip-bg.png',
  'Mamaearth':        'mamaearth-bg.png',
  "McDonald's":       'mcdonalds-bg.png',
  'Meesho':           'meesho-bg.png',
  'MobiKwik':         'mobikwik-bg.png',
  'Myntra':           'myntra-bg.png',
  'Netflix':          'netflix-bg.png',
  'Nike':             'nike-bg.png',
  'Nykaa':            'nykaa-bg.png',
  'Nykaa Fashion':    'nykaa-bg.png',
  'OYO':              'oyo-bg.png',
  'Paytm':            'paytm-bg.png',
  'PharmEasy':        'pharmeasy-bg.png',
  'PhonePe':          'phonepe-bg.png',
  'Pizza Hut':        'pizza-hut-bg.png',
  'Puma':             'puma-bg.png',
  'Rapido':           'rapido-bg.png',
  'Realme':           'realme-bg.png',
  'Samsung':          'samsung-bg.png',
  'The Souled Store': 'souled-store-bg.png',
  'Spotify':          'spotify-bg.png',
  'Starbucks':        'starbucks-bg.png',
  'Subway':           'subway-bg.png',
  'Swiggy':           'swiggy-bg.png',
  'Swiggy Instamart': 'swiggy-bg.png',
  'Treebo':           'treebo-bg.png',
  'Uber':             'uber-bg.png',
  'Urban Company':    'urban-company-bg.png',
  'Wakefit':          'wakefit-bg.png',
  'Zepto':            'zepto-bg.png',
  'Zomato':           'zomato-bg.png',
};

const BRAND_BGS_NORM = Object.create(null);
for (const [name, file] of Object.entries(BRAND_BGS)) {
  const key = normBrandKey(name);
  if (key && !(key in BRAND_BGS_NORM)) BRAND_BGS_NORM[key] = file;
}
// Spellings that do not squash down to a listed name on their own.
Object.assign(BRAND_BGS_NORM, {
  dominos:     'dominos-bg.png',   // typed without the apostrophe
  instamart:   'swiggy-bg.png',    // "Instamart" alone means Swiggy Instamart
  souledstore: 'souled-store-bg.png',
  urbancompany:'urban-company-bg.png',
});

/**
 * The marketplace card's hero background for a brand, or '' when the brand
 * has no background on file. Callers layer this under any coupon-specific
 * admin image: coupon.backgroundImage (set per coupon) always wins.
 */
function getBrandBackground(brand) {
  const file = BRAND_BGS[brand] || BRAND_BGS_NORM[normBrandKey(brand)];
  return file ? `/images/coupons/brands/${file}` : '';
}

function getBrandLogo(brand) {
  // 1) Local file first (reliable, offline-friendly), exact key then squashed
  const local = BRAND_LOGOS[brand] || BRAND_LOGOS_NORM[normBrandKey(brand)];
  if (local) return local;
  // 2) Fall back to clearbit's domain-based logo
  const domain = BRAND_DOMAINS[brand] || BRAND_DOMAINS_NORM[normBrandKey(brand)];
  if (domain) return `https://logo.clearbit.com/${domain}`;
  return '';
}

// ── Dark-surface legibility ─────────────────────────────────────────────
// Every surface that shows these logos is dark (#060d1f cards, the admin table,
// the sell form), and brands publish their logos for white backgrounds. Measured
// against the card background, three of them are literally invisible — 100% of
// their pixels land under a 2:1 contrast ratio — and two more lose most of their
// artwork. Rather than putting the old plate back behind every logo, each of
// those files gets the narrowest treatment that fixes it.

// Single-colour dark artwork: repainting it white keeps the mark's shape exactly
// and costs nothing, because there is only one colour to lose. Never add a
// multi-colour logo here — inverting one rewrites its brand colours.
const BRAND_LOGO_MONO_DARK = new Set([
  '/logos/croma.svg',   // one fill, #191c1f
  '/logos/uber.svg',    // one fill, #010202
  '/logos/lakme.svg',   // no fill attributes at all, so it paints black
  '/logos/cred.png',    // black wordmark on now-transparent background
]);

// Brand colours worth keeping, but with dark artwork mixed in (Booking.com's
// navy wordmark, Pizza Hut's black lettering, Snapdeal's black "snapdeal" beside
// its red mark). These keep the chip's *sizing* treatment (height:auto so a
// short wordmark doesn't stretch to fill the slot) but no longer draw the
// white background or padding — the logo sits straight on the card like every
// other brand, with the card's own dark surface behind it.
//
// The JPGs cannot carry transparency, so the white background behind their
// artwork is baked into the file itself; nothing CSS draws adds to it.
const BRAND_LOGO_LIGHT_CHIP = new Set([
  '/logos/booking.svg',
  '/logos/pizzahut.svg',
  '/logos/snapdeal.png',
  '/logos/shopsy.jpg',
  '/logos/tata-cliq.jpg',
]);

/**
 * Extra class for a brand logo <img>, given whatever getBrandLogo returned.
 * Returns '' for logos that already read fine on a dark background.
 */
function getBrandLogoClass(logoUrl) {
  if (BRAND_LOGO_MONO_DARK.has(logoUrl)) return 'blogo-lift';
  if (BRAND_LOGO_LIGHT_CHIP.has(logoUrl)) return 'blogo-chip';
  return '';
}

// The rules ship with the list they belong to, so a new entry above needs no
// matching edit in marketplace.html / index.html / vault.html / sell.html. The
// selectors are element+class so they outrank each page's own `.cbrand-logo` /
// `.inv-brand-logo` background and padding without needing !important.
(function injectBrandLogoCss() {
  if (typeof document === 'undefined' || document.getElementById('sh-brand-logo-css')) return;
  const el = document.createElement('style');
  el.id = 'sh-brand-logo-css';
  el.textContent =
    'img.blogo-lift{filter:brightness(0) invert(1)}' +
    // height:auto keeps the logo at its natural shape instead of stretching
    // to fill the slot's full height (a short wordmark like Booking.com must
    // not be pulled tall). No background, no padding, no border — the logo
    // sits straight on the surface like every other brand's.
    'img.blogo-chip{width:auto;height:auto;max-width:100%;max-height:100%}';
  (document.head || document.documentElement).appendChild(el);
})();

function getBrandInitial(brand) {
  return (brand || '?').charAt(0).toUpperCase();
}

// ── Expiry Countdown ────────────────────────────────────────────────────
// Timer defaults to 2 weeks from addedAt when no explicit expiry is set.
// Colour bands, by whole days left until the coupon expires:
//   ≤ 1 week (7d) → red   ≤ 2 weeks (14d) → yellow   beyond → green
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a coupon's actual stored expiry value into a timestamp. This is the
 * single source of the countdown — the remaining time is always computed as
 * (this timestamp − now); no default, fixed or generated timer is ever
 * substituted for it. When a coupon genuinely has no expiry, this returns
 * null so callers can say so ("No timer set") instead of inventing one.
 *
 * expiry is stored as TEXT (Supabase `expiry_date` / the Sheets `expiryDate`
 * column), and the Coupons sheet mirrors whatever a cell renders in the
 * sheet's locale — so the accepted shapes, all deterministic (no reliance on
 * the engine's loose string parsing):
 *   "2026-10-11"              → end of that LOCAL day, so the coupon stays
 *                                usable for the whole of its final day
 *   "2026-10-11T18:30"        → LOCAL time (what the admin timer picker and
 *   "2026-10-11 18:30"          the sell form's datetime-local inputs write;
 *                                a space separator is swapped for the "T"
 *                                the engine is only required to understand)
 *   "2026-10-11T18:30:00.000Z" → absolute — an explicit offset is honoured
 *   "30/09/2026", "30/09/2026 23:59", "09/30/2026 11:30 PM"
 *                            → a locale-rendered date parsed by hand, since
 *                                new Date() rejects day-first dates outright
 * @returns {number|null} epoch ms, or null when unset/unparseable
 */
function parseExpiry(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  // Bare "YYYY-MM-DD" → end of that local day (23:59:59.999).
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3], 23, 59, 59, 999).getTime();
  }

  // Day/month/year with separators — "30/09/2026", "30-09-2026", optionally
  // with a clock ("30/09/2026 23:59", "… 11:30:15 PM"). Disambiguate on which
  // component can only be a day (first > 12) or only be a month (second > 12);
  // when both fit, read it day-first — the sheets behind this project render
  // en-IN. Without a time, the whole final day counts (same rule as above).
  const locale = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (locale) {
    const first = +locale[1];
    const second = +locale[2];
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) { day = second; month = first; } // month-first sheet
    if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) return null;
    const hasTime = locale[4] !== undefined;
    let hour = hasTime ? +locale[4] : 23;
    const minute = hasTime ? +locale[5] : 59;
    const sec = hasTime ? (locale[6] !== undefined ? +locale[6] : 0) : 59;
    const ampm = (locale[7] || '').toLowerCase();
    if (hour > 23 || minute > 59 || sec > 59) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const at = new Date(+locale[3], month - 1, day, hour, minute, sec, 0);
    // Date auto-rolls overflow (Feb 31 → Mar 3) — a rolled date would count
    // down to the wrong moment, so only accept it when it round-trips.
    if (!Number.isFinite(at.getTime()) || at.getDate() !== day || at.getMonth() !== month - 1) return null;
    return at.getTime();
  }

  // Everything ISO-shaped — "…T18:30" is LOCAL time (no offset given),
  // "…T18:30:00Z"/"…T18:30+05:30" is absolute — plus the space-separated
  // "YYYY-MM-DD HH:mm" rendering, normalised to the "T" form first because
  // engines are only required to accept "T".
  const t = new Date(s.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pick the colour band for the time remaining: 'expired' | 'red' | 'yellow' | 'green'.
 * Counts whole days so a coupon dated exactly one week out reads as "1 week"
 * (red) rather than tipping into the next band on the end-of-day padding.
 * Callers prefix it with their own class namespace (cexpiry-… / inv-exp-…).
 */
function expiryBand(msLeft) {
  if (msLeft <= 0) return 'expired';
  const daysLeft = Math.floor(msLeft / DAY_MS);
  if (daysLeft <= 7) return 'red';
  if (daysLeft <= 14) return 'yellow';
  return 'green';
}

/**
 * Split the time remaining into clock segments. This is the primitive the
 * marketplace ticker writes straight into per-digit spans, which is why the
 * hours/minutes/seconds come back as already-padded two-character strings.
 *
 * Format rules (2-week countdown):
 *   ≥ 7 days  →  DDd HH:MM:SS  (days shown, hours are 0-23 within the day)
 *   < 7 days  →  HH:MM:SS      (no days, hours = total remaining hours)
 *
 * @returns {{expired:boolean, days:number, dd:string, hh:string, mm:string, ss:string}}
 */
function expiryParts(msLeft) {
  if (msLeft <= 0) return { expired: true, days: 0, dd: '', hh: '00', mm: '00', ss: '00' };
  const totalSec = Math.floor(msLeft / 1000);
  const days = Math.floor(totalSec / 86400);
  const pad = (n) => String(n).padStart(2, '0');

  if (days >= 7) {
    // ≥ 7 days: show day count + hours within the day
    return {
      expired: false,
      days,
      dd: `${days}d`,
      hh: pad(Math.floor((totalSec % 86400) / 3600)),
      mm: pad(Math.floor((totalSec % 3600) / 60)),
      ss: pad(totalSec % 60),
    };
  }

  // < 7 days: collapse days into total hours for urgency
  const totalHours = Math.floor(totalSec / 3600);
  return {
    expired: false,
    days,
    dd: '',
    hh: pad(totalHours),
    mm: pad(Math.floor((totalSec % 3600) / 60)),
    ss: pad(totalSec % 60),
  };
}

/** Bare clock text: '14d 06:23:15' when ≥7 days, '142:23:15' under 7 days. */
function expiryClockText(msLeft) {
  const p = expiryParts(msLeft);
  if (p.expired) return 'Ended';
  const clock = `${p.hh}:${p.mm}:${p.ss}`;
  return p.dd ? `${p.dd} ${clock}` : clock;
}

/**
 * Single-string countdown for the admin inventory chip, whose ticker replaces
 * `textContent` wholesale and so cannot carry the marketplace's blinking colons.
 * The marketplace renders from `expiryParts` instead.
 */
function expiryLabel(msLeft) {
  return msLeft <= 0 ? '⌛ Ended' : `⏳ ${expiryClockText(msLeft)}`;
}
