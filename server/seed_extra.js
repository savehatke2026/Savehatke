// Seed 41 more coupons to complete 200 total new coupons
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function futureDate(min = 30, max = 180) {
  return new Date(Date.now() + (min + Math.random() * (max - min)) * 86400000).toISOString().split('T')[0];
}
function recentDate(min = 1, max = 30) {
  return new Date(Date.now() - (min + Math.random() * (max - min)) * 86400000).toISOString();
}

const coupons = [
  // Additional E-Commerce
  { brand: 'Amazon', code: 'AMZGIFT100', title: 'Amazon ₹100 Off Gift Cards', category: 'E-Commerce', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '1000', description: '₹100 off when you buy Amazon gift cards worth ₹1000+.', terms: 'Min ₹1000. Gift cards only.' },
  { brand: 'Flipkart', code: 'FKGROCERY100', title: 'Flipkart Grocery ₹100 Off', category: 'E-Commerce', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '500', description: '₹100 off on grocery orders via Flipkart Minutes and grocery.', terms: 'Min ₹500. Grocery only.' },

  // Additional Fashion
  { brand: 'Bewakoof', code: 'BEWAK30OFF', title: 'Bewakoof 30% Off T-Shirts', category: 'Fashion', discount: '30% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '599', description: '30% off on Bewakoof graphic tees, hoodies, and joggers.', terms: 'Max ₹400. bewakoof.com only.' },
  { brand: 'Souled Store', code: 'SOULED25', title: 'The Souled Store 25% Off', category: 'Fashion', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '999', description: '25% off on licensed merch — Marvel, Disney, anime tees, and sneakers.', terms: 'Max ₹500. thesouledstore.com.' },
  { brand: 'Snitch', code: 'SNITCH20OFF', title: 'Snitch 20% Off Menswear', category: 'Fashion', discount: '20% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '999', description: '20% off on Snitch premium menswear — shirts, trousers, and co-ords.', terms: 'Max ₹400. snitch.co.in only.' },
  { brand: 'Urbanic', code: 'URB25DRESS', title: 'Urbanic 25% Off Dresses', category: 'Fashion', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '999', description: '25% off on Urbanic dresses, tops, and western wear.', terms: 'Max ₹500. urbanic.com only.' },
  { brand: 'Clovia', code: 'CLOV30LNGR', title: 'Clovia 30% Off Lingerie', category: 'Fashion', discount: '30% Off', originalValue: '500', sellingPrice: '35', minOrderValue: '799', description: '30% off on Clovia bras, nightwear, and activewear.', terms: 'Max ₹500. clovia.com only.' },

  // Additional Beauty
  { brand: 'Renee Cosmetics', code: 'RENEE25ALL', title: 'Renee 25% Off All Products', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '500', description: '25% off on Renee lipsticks, eyeliners, and nail paints.', terms: 'Max ₹300. reneecosmetics.in.' },
  { brand: 'Swiss Beauty', code: 'SWISS20MKP', title: 'Swiss Beauty 20% Off Makeup', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '200', sellingPrice: '15', minOrderValue: '400', description: '20% off on Swiss Beauty foundations, palettes, and lip products.', terms: 'Max ₹200. All channels.' },
  { brand: 'Beardo', code: 'BEARD30MEN', title: 'Beardo 30% Off Men Grooming', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '600', description: '30% off on Beardo beard oil, hair wax, and grooming kits.', terms: 'Max ₹400. beardo.in only.' },

  // Additional Food
  { brand: 'Chaayos', code: 'CHAI50OFF', title: 'Chaayos ₹50 Off Chai Order', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '150', description: '₹50 off on Chaayos chai and snacks ordered via app.', terms: 'Min ₹150. Chaayos app only.' },
  { brand: 'Haldirams', code: 'HALD20SNACK', title: "Haldiram's 20% Off Snacks", category: 'Food & Delivery', discount: '20% Off', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: "20% off on Haldiram's namkeen, sweets, and ready meals online.", terms: 'Max ₹150. haldirams.com.' },
  { brand: 'Baskin Robbins', code: 'BR40ICECR', title: 'Baskin Robbins 40% Off Ice Cream', category: 'Food & Delivery', discount: '40% Off', originalValue: '200', sellingPrice: '19', minOrderValue: '400', description: '40% off on Baskin Robbins ice cream orders via delivery apps.', terms: 'Max ₹200. Delivery orders.' },
  { brand: 'Wow Momos', code: 'WOWM30OFF', title: 'Wow! Momo 30% Off', category: 'Food & Delivery', discount: '30% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '250', description: '30% off on Wow! Momo momos and meal combos via app ordering.', terms: 'Max ₹100. App orders only.' },

  // Additional Hotels
  { brand: 'Lemon Tree', code: 'LEMON20HTL', title: 'Lemon Tree 20% Off Stays', category: 'Hotels & Stays', discount: '20% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '4000', description: '20% off on Lemon Tree hotel bookings across India. Business and leisure.', terms: 'Max ₹1500. lemontreehotels.com.' },
  { brand: 'ITC Hotels', code: 'ITC15ROYAL', title: 'ITC Hotels 15% Off', category: 'Hotels & Stays', discount: '15% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '15% off on ITC Hotels luxury stays — Maurya, Grand Chola, and Maratha.', terms: 'Max ₹3000. itchotels.com only.' },
  { brand: 'Taj Hotels', code: 'TAJ10PREM', title: 'Taj Hotels 10% Off Premium Rooms', category: 'Hotels & Stays', discount: '10% Off', originalValue: '5000', sellingPrice: '349', minOrderValue: '20000', description: '10% off on Taj premium room bookings. Iconic hospitality and luxury.', terms: 'Max ₹5000. tajhotels.com only.' },

  // Additional Electronics
  { brand: 'Mi', code: 'MI15PHONE', title: 'Xiaomi 15% Off Redmi Phones', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '8000', description: '15% off on Redmi Note and Redmi series smartphones.', terms: 'Max ₹1500. mi.com/in only.' },
  { brand: 'Bose', code: 'BOSE20AUD', title: 'Bose 20% Off Audio', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '4000', sellingPrice: '249', minOrderValue: '10000', description: '20% off on Bose QuietComfort, SoundLink, and Sport earbuds.', terms: 'Max ₹4000. bose.in only.' },
  { brand: 'Marshall', code: 'MRSH15SPK', title: 'Marshall 15% Off Speakers', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '15% off on Marshall Stanmore, Acton, and Emberton speakers.', terms: 'Max ₹3000. Authorized dealers.' },

  // Additional Fitness
  { brand: 'ASICS', code: 'ASICS20RUN', title: 'ASICS 20% Off Running Shoes', category: 'Fitness & Sports', discount: '20% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '4000', description: '20% off on ASICS Gel-Kayano, Nimbus, and GT running shoes.', terms: 'Max ₹1200. asics.com/in.' },
  { brand: 'New Balance', code: 'NB25FRESH', title: 'New Balance 25% Off Fresh Foam', category: 'Fitness & Sports', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '4000', description: '25% off on New Balance Fresh Foam and FuelCell running shoes.', terms: 'Max ₹1500. newbalance.in.' },
  { brand: 'Fitbit', code: 'FITB20BAND', title: 'Fitbit 20% Off Fitness Bands', category: 'Fitness & Sports', discount: '20% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '3000', description: '20% off on Fitbit Charge, Inspire, and Versa fitness trackers.', terms: 'Max ₹1000. fitbit.com only.' },

  // Additional Health
  { brand: 'Lybrate', code: 'LYB25CONSULT', title: 'Lybrate 25% Off Consultation', category: 'Health & Pharmacy', discount: '25% Off', originalValue: '150', sellingPrice: '10', minOrderValue: '250', description: '25% off on online doctor consultations via Lybrate.', terms: 'Max ₹150. Teleconsult only.' },
  { brand: 'Tata 1mg', code: 'TATA15WELL', title: '1mg 15% Off Wellness Products', category: 'Health & Pharmacy', discount: '15% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '800', description: '15% off on vitamins, supplements, and wellness products on 1mg.', terms: 'Max ₹300. Wellness category.' },

  // Additional Education
  { brand: 'Great Learning', code: 'GRTL20PGP', title: 'Great Learning 20% Off PG', category: 'Education', discount: '20% Off', originalValue: '10000', sellingPrice: '699', minOrderValue: '40000', description: '20% off on Great Learning PG programs in Data Science and AI.', terms: 'Max ₹10000. PG programs only.' },
  { brand: 'upGrad', code: 'UPGRD15MBA', title: 'upGrad 15% Off MBA Programs', category: 'Education', discount: '15% Off', originalValue: '15000', sellingPrice: '999', minOrderValue: '80000', description: '15% off on upGrad online MBA and Master degree programs.', terms: 'Max ₹15000. Degree programs only.' },
  { brand: 'Edureka', code: 'EDUR25CERT', title: 'Edureka 25% Off Certifications', category: 'Education', discount: '25% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '8000', description: '25% off on Edureka PG certifications in Cloud, DevOps, and AI.', terms: 'Max ₹3000. Certification courses.' },

  // Additional Finance
  { brand: 'Vi', code: 'VIDATA50', title: 'Vi ₹50 Off Data Recharge', category: 'Finance & Payments', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '199', description: '₹50 off on Vi prepaid data recharge plans.', terms: 'Min ₹199. Vi users only.' },
  { brand: 'FreeCharge', code: 'FC75ELEC', title: 'FreeCharge ₹75 Off Electricity Bill', category: 'Finance & Payments', discount: '₹75 Off', originalValue: '75', sellingPrice: '5', minOrderValue: '500', description: '₹75 cashback on electricity bill payment via FreeCharge.', terms: 'Min ₹500. Electricity bills only.' },
  { brand: 'Amazon Pay', code: 'APAY50SCAN', title: 'Amazon Pay ₹50 Scan & Pay', category: 'Finance & Payments', discount: '₹50 Cashback', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 cashback on Amazon Pay scan & pay at local stores.', terms: 'Min ₹200. First scan payment.' },

  // Additional General/Home
  { brand: 'Curefit', code: 'CURE20EAT', title: 'EatFit 20% Off Healthy Meals', category: 'General', discount: '20% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '300', description: '20% off on EatFit healthy meal deliveries — salads, bowls, and wraps.', terms: 'Max ₹100. EatFit orders.' },
  { brand: 'FirstCry', code: 'FCRY25BABY', title: 'FirstCry 25% Off Baby Products', category: 'General', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '25% off on baby clothing, diapers, toys, and feeding essentials at FirstCry.', terms: 'Max ₹500. firstcry.com only.' },
  { brand: 'Hopscotch', code: 'HOPS20KIDS', title: 'Hopscotch 20% Off Kids Wear', category: 'General', discount: '20% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '800', description: '20% off on Hopscotch kids clothing, dresses, and accessories.', terms: 'Max ₹400. hopscotch.in only.' },
  { brand: 'Prestige', code: 'PRSTG15APP', title: 'Prestige 15% Off Kitchen Appliances', category: 'General', discount: '15% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '3000', description: '15% off on Prestige pressure cookers, mixers, and induction cooktops.', terms: 'Max ₹800. ttkhealthcare.com only.' },
  { brand: 'Crompton', code: 'CROMP20FAN', title: 'Crompton 20% Off Fans', category: 'General', discount: '20% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '2000', description: '20% off on Crompton ceiling fans, table fans, and air coolers.', terms: 'Max ₹600. crompton.co.in.' },
  { brand: 'Havells', code: 'HAVL15ELECT', title: 'Havells 15% Off Electricals', category: 'General', discount: '15% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '2000', description: '15% off on Havells switches, wires, and home electrical products.', terms: 'Max ₹500. havells.com only.' },
  { brand: 'Asian Paints', code: 'APAINT10CLR', title: 'Asian Paints 10% Off Paints', category: 'General', discount: '10% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '5000', description: '10% off on Asian Paints Royale, Apcolite, and Tractor range.', terms: 'Max ₹1000. asianpaints.com.' },
  { brand: 'Nippon Paint', code: 'NIPP15WALL', title: 'Nippon Paint 15% Off Wall Paints', category: 'General', discount: '15% Off', originalValue: '800', sellingPrice: '55', minOrderValue: '3000', description: '15% off on Nippon Paint interior and exterior wall paints.', terms: 'Max ₹800. nipponpaint.co.in.' },
];

async function seed() {
  console.log(`\n🚀 Seeding ${coupons.length} additional coupons...\n`);
  let inserted = 0, skipped = 0;
  const BATCH = 10;

  for (let i = 0; i < coupons.length; i += BATCH) {
    const batch = coupons.slice(i, i + BATCH).map(c => ({
      id: uuidv4(), code: c.code.toUpperCase().trim(), title: c.title, type: 'Public',
      category: c.category, brand: c.brand, description: c.description, discount: c.discount,
      original_value: String(c.originalValue || '0'), selling_price: String(c.sellingPrice || '15'),
      min_order_value: String(c.minOrderValue || ''), valid_from: new Date().toISOString().split('T')[0],
      expiry_date: futureDate(), affiliate_link: '', terms: c.terms || '',
      is_featured: Math.random() < 0.2, is_exclusive: Math.random() < 0.15,
      is_verified: true, seller_email: '', status: 'available', source: 'admin',
      added_at: recentDate(),
    }));

    const codes = batch.map(b => b.code);
    const { data: existing } = await supabase.from('coupons').select('code').in('code', codes);
    const existingCodes = new Set((existing || []).map(e => e.code));
    const toInsert = batch.filter(b => !existingCodes.has(b.code));

    if (toInsert.length > 0) {
      const { data, error } = await supabase.from('coupons').insert(toInsert).select('id, code');
      if (error) { console.error(`  ❌ Batch error:`, error.message); }
      else { inserted += (data || []).length; console.log(`  ✅ Batch ${Math.floor(i/BATCH)+1}: inserted ${(data||[]).length}`); }
    }
    skipped += batch.length - toInsert.length;
  }

  console.log(`\n✅ Inserted: ${inserted} | ⏭️ Skipped: ${skipped} | 📦 Total: ${coupons.length}\n`);
}

seed().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
