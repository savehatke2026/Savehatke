// ============================================
// SaveHatke — Real-Time Marketplace Logic
// ============================================

let allCoupons = [];
let currentCategory = 'all';
let currentSource = '';
let searchQuery = '';
let currentPage = 1;
const PER_PAGE = 30;

document.addEventListener('DOMContentLoaded', () => {
  loadCoupons();
  initFilters();
  spawnParticles();

  // Check URL query parameters
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    currentCategory = cat;
    document.querySelectorAll('#categoryPills .cpill').forEach((p) => {
      p.classList.toggle('active', p.dataset.category === cat);
    });
  }
});

async function loadCoupons() {
  try {
    const data = await api('/coupons');
    allCoupons = data.coupons || [];
    renderFilteredCoupons();
  } catch (err) {
    console.warn('Load coupons notice:', err.message);
    allCoupons = [];
    renderFilteredCoupons();
  }
}

function renderFilteredCoupons() {
  let filtered = [...allCoupons];

  // Category filter
  if (currentCategory !== 'all') {
    filtered = filtered.filter((c) => (c.category || '').toLowerCase() === currentCategory.toLowerCase());
  }

  // Search filter
  const search = document.getElementById('searchInput')?.value?.toLowerCase().trim() || searchQuery;
  if (search) {
    filtered = filtered.filter(
      (c) =>
        (c.brand || '').toLowerCase().includes(search) ||
        (c.description || '').toLowerCase().includes(search) ||
        (c.title || '').toLowerCase().includes(search) ||
        (c.category || '').toLowerCase().includes(search)
    );
  }

  // Source filter
  const source = document.getElementById('sourceFilter')?.value || currentSource;
  if (source) {
    filtered = filtered.filter((c) => c.source === source);
  }

  // Separate paid and free coupons
  const paidCoupons = filtered.filter((c) => c.source !== 'auto-scraped');
  const freeCoupons = filtered.filter((c) => c.source === 'auto-scraped');

  // Pagination for paid coupons
  const totalPages = Math.ceil(paidCoupons.length / PER_PAGE);
  if (currentPage > totalPages) currentPage = 1;
  const pageSlice = paidCoupons.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);

  renderCouponGrid('couponGrid', pageSlice);
  renderPagination(totalPages);

  // Free codes section
  const freeSection = document.getElementById('freeCodesSection');
  if (freeCoupons.length > 0 && freeSection) {
    freeSection.style.display = 'block';
    renderCouponGrid('freeCodesGrid', freeCoupons);
  } else if (freeSection) {
    freeSection.style.display = 'none';
  }
}

function renderCouponGrid(gridId, coupons) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (coupons.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-ico">🏷️</div>
        <div class="empty-title">No coupons found in database</div>
        <div class="empty-sub">Add coupons in the Admin panel or sell a coupon to make it appear here live!</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = coupons
    .map((c) => {
      const isFree = c.source === 'auto-scraped';
      const priceText = isFree ? 'FREE' : `₹${c.sellingPrice || '15'}`;
      const origVal = c.discount ? (c.discount.includes('%') || c.discount.includes('₹') ? c.discount : `₹${c.discount} OFF`) : (c.originalValue ? `₹${c.originalValue} OFF` : 'SPECIAL OFFER');
      const logoUrl = getBrandLogo(c.brand);
      const initial = getBrandInitial(c.brand);

      return `
        <div class="coupon-card" style="cursor:pointer" onclick="buyCoupon('${c.id}', ${isFree})">
          ${isFree ? '<span class="cfree-badge">FREE</span>' : '<div class="cverified">✓ VERIFIED DEAL</div>'}
          <div class="ctop">
            <div class="cbrand">
              <span class="cbrand-logo-wrap">
                ${logoUrl
                  ? `<img class="cbrand-logo" src="${logoUrl}" alt="${c.brand}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="cbrand-initial" style="display:none">${initial}</span>`
                  : `<span class="cbrand-initial">${initial}</span>`
                }
              </span>
              <span class="cbrand-name">${c.brand}</span>
            </div>
            <div class="coff">${origVal}</div>
          </div>
          <div class="cdesc">${c.title || c.description || 'Verified Discount Offer'}</div>
          <div class="cmeta">
            <div>
              <span class="clbl">Selling Price</span>
              <span class="cval">${priceText}</span>
            </div>
            <span class="ccat">${c.category}</span>
          </div>
          <button class="cbuy-btn" onclick="event.stopPropagation(); buyCoupon('${c.id}', ${isFree})">
            ${isFree ? 'Get Free Code →' : 'Buy Coupon →'}
          </button>
        </div>
      `;
    })
    .join('');
}

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

function renderPagination(totalPages) {
  const bar = document.getElementById('paginationBar');
  const pagesSpan = document.getElementById('pgPages');
  const prevBtn = document.getElementById('pgPrev');
  const nextBtn = document.getElementById('pgNext');
  const infoSpan = document.getElementById('pgInfo');

  if (!bar || totalPages <= 1) {
    if (bar) bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

  // Smart page number list with ellipsis
  const pages = [];
  if (totalPages <= 7) {
    // Show all pages if 7 or fewer
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    // Always show first, last, current, and neighbors
    pages.push(1);
    if (currentPage > 3) pages.push('…');
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push('…');
    pages.push(totalPages);
  }

  let pagesHtml = '';
  for (const p of pages) {
    if (p === '…') {
      pagesHtml += `<span class="pg-ellipsis">…</span>`;
    } else {
      pagesHtml += `<button class="pg-btn ${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
    }
  }
  if (pagesSpan) pagesSpan.innerHTML = pagesHtml;
  if (infoSpan) infoSpan.textContent = `Page ${currentPage}/${totalPages}`;
}

function changePage(delta) {
  currentPage += delta;
  renderFilteredCoupons();
  document.getElementById('couponGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function goToPage(page) {
  currentPage = page;
  renderFilteredCoupons();
  document.getElementById('couponGrid')?.scrollIntoView({ behavior: 'smooth' });
}

function buyCoupon(id, isFree) {
  const coupon = allCoupons.find(c => String(c.id) === String(id));
  if (coupon) {
    const params = new URLSearchParams({
      id: coupon.id,
      brand: coupon.brand || '',
      category: coupon.category || '',
      title: coupon.title || coupon.description || 'Verified Discount Offer',
      price: coupon.sellingPrice || 15,
      value: coupon.originalValue || coupon.discount || 200,
      code: coupon.code || '',
      minOrder: coupon.minOrderValue || '999'
    });
    window.location.href = `checkout?${params.toString()}`;
  } else {
    window.location.href = `checkout?id=${encodeURIComponent(id)}`;
  }
}

function showCouponModal(coupon) {
  document.querySelector('.modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" style="text-align: center;">
      <div class="mhdr">
        <div class="mtitle">🎉 Coupon Purchased!</div>
        <button class="mclose" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      <div style="margin-bottom: 20px;">
        <p style="color: #a8c0dc; margin-bottom: 14px;">Here's your coupon code for <strong style="color: #e2ecff;">${coupon.brand}</strong>:</p>
        <div style="background: rgba(0, 230, 118, 0.1); border: 2px dashed #00e676; border-radius: 12px; padding: 18px; margin-bottom: 16px;">
          <code style="font-size: 1.6rem; font-weight: 800; color: #00e676; letter-spacing: 2px;">${coupon.code}</code>
        </div>
        <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${coupon.code}'); if(typeof showToast==='function') showToast('Code copied to clipboard! 📋', 'success')">
          📋 Copy Code
        </button>
      </div>
      <p style="font-size: 0.8rem; color: #6b88aa;">
        ${coupon.description || ''}<br>
        Worth ₹${coupon.originalValue || coupon.discount || ''} · Paid ₹${coupon.pricePaid || coupon.sellingPrice || ''}
      </p>
      <a href="dashboard" class="btn btn-ghost btn-sm" style="margin-top: 16px;">View in Dashboard</a>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function initFilters() {
  // Category pills
  document.querySelectorAll('#categoryPills .cpill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#categoryPills .cpill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.dataset.category || 'all';
      currentPage = 1;
      renderFilteredCoupons();
    });
  });

  // Search
  document.getElementById('searchInput')?.addEventListener('input', debounce((e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    currentPage = 1;
    renderFilteredCoupons();
  }, 250));

  // Source filter
  document.getElementById('sourceFilter')?.addEventListener('change', (e) => {
    currentSource = e.target.value;
    currentPage = 1;
    renderFilteredCoupons();
  });
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function spawnParticles() {
  const container = document.getElementById('pageParticles');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 8) + 's';
    p.style.width = p.style.height = (2 + Math.random() * 3) + 'px';
    container.appendChild(p);
  }
}
