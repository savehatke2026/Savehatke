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

// Local SVGs (preferred — always loads). Add new entries as you need them.
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
  'Swiggy':           '/logos/swiggy.svg',
  'Swiggy Instamart': '/logos/swiggy.svg',
  'Meesho':           '/logos/meesho.png',
  "Domino's":         '/logos/dominos.svg',
};

function getBrandLogo(brand) {
  // 1) Local SVG first (reliable, offline-friendly)
  const local = BRAND_LOGOS[brand];
  if (local) return local;
  // 2) Fall back to clearbit's domain-based logo
  const domain = BRAND_DOMAINS[brand];
  if (domain) return `https://logo.clearbit.com/${domain}`;
  return '';
}

function getBrandInitial(brand) {
  return (brand || '?').charAt(0).toUpperCase();
}

// ── Expiry Countdown ────────────────────────────────────────────────────
// Colour bands, by whole days left until the coupon expires:
//   ≤ 1 week (7d) → red, flashing   ≤ 2 weeks (14d) → yellow   beyond → green
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a coupon expiry value into a timestamp.
 * Date-only strings ("2026-10-11") are treated as end-of-day local time so a
 * coupon stays usable for the whole of its final day; values that also carry a
 * time ("2026-10-11T18:30", written by the admin timer picker) are taken as-is.
 * @returns {number|null} epoch ms, or null when unset/unparseable
 */
function parseExpiry(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999)
    : new Date(s);
  const t = d.getTime();
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

/** Human countdown text — coarse when far out, ticks to seconds near the end. */
function expiryLabel(msLeft) {
  if (msLeft <= 0) return '⌛ Expired';
  const totalSec = Math.floor(msLeft / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d >= 1) return `⏳ ${d}d ${h}h left`;
  if (h >= 1) return `⏳ ${h}h ${m}m left`;
  return `⏳ ${m}m ${s}s left`;
}
