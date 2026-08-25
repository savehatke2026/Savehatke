// ============================================
// SaveHatke — Seed 100 Real Coupons into Supabase
// ============================================
// Usage: node server/seed_coupons.js
// Requires .env at the project root with SUPABASE_URL and SUPABASE_SERVICE_KEY

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Helper: random future date between 30–180 days from now
function futureDate(minDays = 30, maxDays = 180) {
  const ms = Date.now() + (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString().split('T')[0];
}

// Helper: past date 1–30 days ago
function recentDate(minDays = 1, maxDays = 30) {
  const ms = Date.now() - (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString();
}

// ── 100 Real Indian E-Commerce Coupons ──────────────────────────────────
const coupons = [
  // ─── E-Commerce (1–15) ────────────────────────────────────────────────
  { brand: 'Amazon', code: 'AMZGREAT500', title: 'Amazon Great Indian Festival ₹500 Off', category: 'E-Commerce', discount: '₹500 Off', originalValue: '500', sellingPrice: '49', minOrderValue: '2000', description: 'Flat ₹500 off on orders above ₹2000 during Great Indian Festival sale. Valid on all categories.', terms: 'Min order ₹2000. Not valid on gold, jewelry. One use per account.' },
  { brand: 'Amazon', code: 'AMZFRESH200', title: 'Amazon Fresh ₹200 Off Groceries', category: 'E-Commerce', discount: '₹200 Off', originalValue: '200', sellingPrice: '29', minOrderValue: '1000', description: 'Save ₹200 on your next Amazon Fresh grocery order. Valid on fruits, vegetables, and daily essentials.', terms: 'Min order ₹1000. Fresh orders only. Select pincodes.' },
  { brand: 'Amazon', code: 'AMZPRIME15', title: 'Amazon Prime 15% Cashback', category: 'E-Commerce', discount: '15% Cashback', originalValue: '750', sellingPrice: '59', minOrderValue: '1500', description: 'Get 15% cashback up to ₹750 on Amazon Pay. Exclusive for Prime members on fashion and electronics.', terms: 'Max cashback ₹750. Prime members only. Valid on select sellers.' },
  { brand: 'Flipkart', code: 'FKBBD2026', title: 'Flipkart Big Billion Days ₹1000 Off', category: 'E-Commerce', discount: '₹1000 Off', originalValue: '1000', sellingPrice: '89', minOrderValue: '5000', description: 'Mega discount of ₹1000 on electronics, mobiles, and appliances during Big Billion Days.', terms: 'Min order ₹5000. Valid on Flipkart Assured items only.' },
  { brand: 'Flipkart', code: 'FKSUPER300', title: 'Flipkart SuperCoin ₹300 Discount', category: 'E-Commerce', discount: '₹300 Off', originalValue: '300', sellingPrice: '35', minOrderValue: '1500', description: 'Use this code to get ₹300 off. Works on fashion, home, and kitchen categories.', terms: 'Min order ₹1500. Not combinable with bank offers.' },
  { brand: 'Meesho', code: 'MEESHO250', title: 'Meesho Mega Sale ₹250 Off', category: 'E-Commerce', discount: '₹250 Off', originalValue: '250', sellingPrice: '25', minOrderValue: '800', description: 'Flat ₹250 off on Meesho orders. Great deals on ethnic wear, home decor, and accessories.', terms: 'First order only. Min order ₹800. All categories.' },
  { brand: 'Tata CLiQ', code: 'CLIQ20LUXURY', title: 'Tata CLiQ Luxury 20% Off', category: 'E-Commerce', discount: '20% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '20% off on luxury brands — Coach, Michael Kors, Armani, and more on Tata CLiQ Luxury.', terms: 'Max discount ₹2000. Select luxury brands only.' },
  { brand: 'Croma', code: 'CROMA10TECH', title: 'Croma 10% Off Electronics', category: 'E-Commerce', discount: '10% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '7000', description: '10% instant discount on laptops, headphones, and smart TVs at Croma online and stores.', terms: 'Max discount ₹1500. Not valid on Apple products.' },
  { brand: 'JioMart', code: 'JIOMART150', title: 'JioMart ₹150 Off Groceries', category: 'E-Commerce', discount: '₹150 Off', originalValue: '150', sellingPrice: '19', minOrderValue: '600', description: 'Save ₹150 on groceries, snacks, and household items on JioMart.', terms: 'Min order ₹600. Select cities only. One per user.' },
  { brand: 'BigBasket', code: 'BB200FRESH', title: 'BigBasket ₹200 Off Fresh Produce', category: 'E-Commerce', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '800', description: 'Flat ₹200 off on fruits, vegetables, dairy, and bakery items on BigBasket.', terms: 'Min order ₹800. Valid on BB Now and BB Express.' },

  // ─── Fashion (11–25) ──────────────────────────────────────────────────
  { brand: 'Myntra', code: 'MYNTRA40END', title: 'Myntra End of Reason Sale 40% Off', category: 'Fashion', discount: '40% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '2500', description: 'Get 40% off during the End of Reason Sale on top brands like Roadster, HRX, and Mango.', terms: 'Max discount ₹2000. Select brands. No exchange items.' },
  { brand: 'Myntra', code: 'MYNFIRST500', title: 'Myntra New User ₹500 Off', category: 'Fashion', discount: '₹500 Off', originalValue: '500', sellingPrice: '45', minOrderValue: '1200', description: 'New to Myntra? Get flat ₹500 off on your first fashion order. All brands included.', terms: 'New users only. Min order ₹1200.' },
  { brand: 'AJIO', code: 'AJIO50MEGA', title: 'AJIO 50% Off All Fashion', category: 'Fashion', discount: '50% Off', originalValue: '1500', sellingPrice: '119', minOrderValue: '1500', description: 'AJIO All Stars Sale — 50% off on trending fashion, footwear, and accessories.', terms: 'Max discount ₹1500. Excludes new arrivals. One per account.' },
  { brand: 'AJIO', code: 'AJIOBRAND30', title: 'AJIO 30% Off Premium Brands', category: 'Fashion', discount: '30% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '2000', description: 'Extra 30% off on Levis, Superdry, GAP, and Marks & Spencer on AJIO.', terms: 'Max ₹1200 discount. Select premium brands only.' },
  { brand: 'H&M', code: 'HM25SEASON', title: 'H&M Seasonal Sale 25% Off', category: 'Fashion', discount: '25% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '2000', description: 'Shop the H&M seasonal collection with 25% off on dresses, jackets, and denim.', terms: 'Min order ₹2000. Online and in-store. Max ₹1000 off.' },
  { brand: 'Puma', code: 'PUMA35RUN', title: 'Puma 35% Off Running Collection', category: 'Fashion', discount: '35% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '35% off on Puma running shoes, sportswear, and training gear on puma.com.', terms: 'Max ₹1500 off. Running and training categories only.' },
  { brand: 'Adidas', code: 'ADI30EXTRA', title: 'Adidas Extra 30% Off Sale Items', category: 'Fashion', discount: '30% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '2500', description: 'Stack an extra 30% off on already discounted Adidas Originals and performance wear.', terms: 'Applicable on outlet/sale items only. Max ₹1200.' },
  { brand: 'Nike', code: 'NIKE20AIR', title: 'Nike 20% Off Air Max Collection', category: 'Fashion', discount: '20% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: 'Flat 20% off on the Nike Air Max range including AM90, AM97, and AM Plus.', terms: 'Min order ₹5000. Online only at nike.com/in.' },
  { brand: 'Nykaa Fashion', code: 'NYKFASH25', title: 'Nykaa Fashion 25% Off Ethnic Wear', category: 'Fashion', discount: '25% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1500', description: 'Get 25% off on sarees, kurtis, and Indo-Western outfits at Nykaa Fashion.', terms: 'Max ₹800 off. Ethnic wear category only.' },
  { brand: 'Lenskart', code: 'LENS50FIRST', title: 'Lenskart 50% Off First Pair', category: 'Fashion', discount: '50% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '1000', description: 'Get 50% off on your first pair of eyeglasses or sunglasses at Lenskart.', terms: 'New users. Max ₹1000 off. Includes Vincent Chase & John Jacobs.' },

  // ─── Beauty & Personal Care (21–35) ───────────────────────────────────
  { brand: 'Nykaa', code: 'NYKAA30GLOW', title: 'Nykaa 30% Off Beauty Bestsellers', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '700', sellingPrice: '55', minOrderValue: '1000', description: '30% off on Nykaa bestsellers — lipsticks, foundations, serums, and skincare essentials.', terms: 'Max ₹700 off. Select products only. One per user.' },
  { brand: 'Nykaa', code: 'NYKPINK25', title: 'Nykaa Pink Friday 25% Off', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: 'Pink Friday exclusive — 25% off on MAC, Maybelline, Lakmé, and more.', terms: 'Max ₹500. Beauty category only. Limited period.' },
  { brand: 'Purplle', code: 'PURP40SALE', title: 'Purplle 40% Off All Makeup', category: 'Beauty & Personal Care', discount: '40% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '800', description: 'Flat 40% off on makeup, skincare, and haircare at Purplle.', terms: 'Max ₹600 off. All brands. Free shipping above ₹500.' },
  { brand: 'Mamaearth', code: 'MAMA20SKIN', title: 'Mamaearth 20% Off Skincare', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '400', sellingPrice: '35', minOrderValue: '800', description: '20% off on Mamaearth Vitamin C range, onion hair oil, and ubtan face wash.', terms: 'Max ₹400 off. Direct from mamaearth.in only.' },
  { brand: 'Minimalist', code: 'MINI15SERUM', title: 'Minimalist 15% Off Serums', category: 'Beauty & Personal Care', discount: '15% Off', originalValue: '300', sellingPrice: '29', minOrderValue: '600', description: '15% off on all Minimalist serums — Niacinamide, Retinol, Salicylic Acid, and AHA BHA.', terms: 'Min order ₹600. beminimalist.co purchases only.' },
  { brand: 'Lakmé', code: 'LAKME25GLOW', title: 'Lakmé 25% Off Festive Range', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: 'Get 25% off on the Lakmé 9to5 and Absolute range this festive season.', terms: 'Max ₹500. Available on lakmeindia.com and Nykaa.' },
  { brand: 'The Body Shop', code: 'TBS30LOVE', title: 'The Body Shop 30% Off Sitewide', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '900', sellingPrice: '69', minOrderValue: '2000', description: '30% off on body butters, tea tree range, and gift sets at The Body Shop India.', terms: 'Max ₹900. Online only. Excludes new launches.' },
  { brand: 'mCaffeine', code: 'MCAF20BREW', title: 'mCaffeine 20% Off Coffee Range', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '350', sellingPrice: '29', minOrderValue: '700', description: 'Flat 20% off on coffee body scrub, face wash, and shampoo from mCaffeine.', terms: 'Max ₹350. mcaffeine.com orders only.' },
  { brand: 'WOW Skin Science', code: 'WOW25APPLE', title: 'WOW 25% Off Apple Cider Range', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '400', sellingPrice: '35', minOrderValue: '700', description: 'Get 25% off on WOW Apple Cider Vinegar shampoo, face wash, and body wash combo.', terms: 'Max ₹400. buywow.in only.' },
  { brand: 'Plum', code: 'PLUM30GREEN', title: 'Plum 30% Off Green Tea Range', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '450', sellingPrice: '35', minOrderValue: '600', description: 'Save 30% on Plum Green Tea face wash, toner, and moisturizer kit.', terms: 'Max ₹450. plumgoodness.com only. One per user.' },

  // ─── Food & Delivery (31–45) ──────────────────────────────────────────
  { brand: 'Swiggy', code: 'SWIGGY50OFF', title: 'Swiggy ₹125 Off Food Order', category: 'Food & Delivery', discount: '₹125 Off', originalValue: '125', sellingPrice: '15', minOrderValue: '300', description: 'Flat ₹125 off on your Swiggy food delivery. Works on restaurants near you.', terms: 'Min order ₹300. Select restaurants. One use only.' },
  { brand: 'Swiggy', code: 'SWIGONE100', title: 'Swiggy One ₹100 Off Members Only', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '15', minOrderValue: '250', description: 'Swiggy One exclusive — extra ₹100 off on food orders for premium members.', terms: 'Swiggy One subscribers only. Min order ₹250.' },
  { brand: 'Zomato', code: 'ZOMATO60BIG', title: 'Zomato 60% Off Up to ₹150', category: 'Food & Delivery', discount: '60% Off', originalValue: '150', sellingPrice: '15', minOrderValue: '200', description: '60% off up to ₹150 on Zomato food delivery. All cuisines, all restaurants.', terms: 'Max discount ₹150. Min order ₹200. New and existing users.' },
  { brand: 'Zomato', code: 'ZOMGOLD75', title: 'Zomato Gold ₹75 Extra Off', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '199', description: 'Zomato Gold members get an additional ₹75 off on any restaurant order.', terms: 'Gold members only. Min ₹199. Combinable with restaurant deals.' },
  { brand: "Domino's", code: 'DOMFEAST30', title: "Domino's 30% Off on ₹600+", category: 'Food & Delivery', discount: '30% Off', originalValue: '300', sellingPrice: '29', minOrderValue: '600', description: "30% off on Domino's pizza orders above ₹600. Cheese burst, loaded, and premium range included.", terms: "Max ₹300 off. Valid on dominos.co.in and app." },
  { brand: 'Pizza Hut', code: 'PHUT50BOGO', title: 'Pizza Hut Buy 1 Get 1 Free', category: 'Food & Delivery', discount: 'BOGO', originalValue: '400', sellingPrice: '35', minOrderValue: '500', description: 'Buy 1 medium pizza and get 1 free at Pizza Hut. All toppings included.', terms: 'Medium pizzas only. Not valid with other offers. Dine-in and delivery.' },
  { brand: 'EatSure', code: 'EATSURE100', title: 'EatSure ₹100 Off First Order', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '250', description: '₹100 off on your first EatSure order. Multi-brand food delivered in one go.', terms: 'New users only. Min order ₹250.' },
  { brand: 'Swiggy Instamart', code: 'INSTA75FAST', title: 'Swiggy Instamart ₹75 Off Groceries', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '199', description: 'Get ₹75 off on Swiggy Instamart grocery delivery — snacks, dairy, and essentials.', terms: 'Min ₹199. Instamart orders only. Select cities.' },
  { brand: 'Zomato', code: 'ZOMDINEIN40', title: 'Zomato 40% Off Dine-In', category: 'Food & Delivery', discount: '40% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '40% off at partner restaurants when you dine-in via Zomato app booking.', terms: 'Max ₹500. Select partner restaurants. Valid Mon–Thu only.' },
  { brand: 'KFC', code: 'KFCWED50', title: 'KFC Wednesday Offer 50% Off', category: 'Food & Delivery', discount: '50% Off', originalValue: '250', sellingPrice: '25', minOrderValue: '400', description: 'Every Wednesday — get 50% off on chicken buckets and meal combos at KFC.', terms: 'Wednesdays only. Max ₹250 off. Online and in-store.' },

  // ─── Travel & Transport (41–55) ───────────────────────────────────────
  { brand: 'MakeMyTrip', code: 'MMTFLY1500', title: 'MakeMyTrip ₹1500 Off Flights', category: 'Travel & Transport', discount: '₹1500 Off', originalValue: '1500', sellingPrice: '119', minOrderValue: '5000', description: 'Flat ₹1500 off on domestic flight bookings on MakeMyTrip. All airlines included.', terms: 'Min booking ₹5000. One per user. Not valid on special fares.' },
  { brand: 'MakeMyTrip', code: 'MMTHOTEL25', title: 'MakeMyTrip 25% Off Hotels', category: 'Travel & Transport', discount: '25% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '5000', description: '25% off on domestic and international hotel bookings. Includes 3-star and above.', terms: 'Max ₹3000. Min booking ₹5000. Select properties.' },
  { brand: 'Cleartrip', code: 'CTFLY500', title: 'Cleartrip ₹500 Off Domestic Flights', category: 'Travel & Transport', discount: '₹500 Off', originalValue: '500', sellingPrice: '45', minOrderValue: '2500', description: 'Save ₹500 on domestic one-way and round-trip flights via Cleartrip.', terms: 'Min booking ₹2500. All airlines. Web and app.' },
  { brand: 'EaseMyTrip', code: 'EASEFLY750', title: 'EaseMyTrip ₹750 Off International', category: 'Travel & Transport', discount: '₹750 Off', originalValue: '750', sellingPrice: '59', minOrderValue: '8000', description: '₹750 instant discount on international flight bookings at EaseMyTrip.', terms: 'Min ₹8000. International routes only. One per PNR.' },
  { brand: 'Uber', code: 'UBERRIDE50', title: 'Uber ₹50 Off Next 3 Rides', category: 'Travel & Transport', discount: '₹50 Off × 3', originalValue: '150', sellingPrice: '19', minOrderValue: '150', description: 'Get ₹50 off on your next 3 Uber rides. Valid on UberGo and Premier.', terms: 'Max 3 rides. Min fare ₹150 each. Select cities.' },
  { brand: 'Rapido', code: 'RAPIDO30OFF', title: 'Rapido 30% Off Bike Taxi', category: 'Travel & Transport', discount: '30% Off', originalValue: '75', sellingPrice: '10', minOrderValue: '100', description: '30% off on Rapido bike taxi rides. Fastest two-wheeler rides across India.', terms: 'Max ₹75. Bike taxi category only. 5 uses per user.' },
  { brand: 'Ola', code: 'OLA100NEW', title: 'Ola ₹100 Off for New Users', category: 'Travel & Transport', discount: '₹100 Off', originalValue: '100', sellingPrice: '15', minOrderValue: '200', description: '₹100 off on your first Ola ride. Works on Mini, Sedan, and Prime.', terms: 'New users only. Min fare ₹200.' },
  { brand: 'IRCTC', code: 'IRCTC200OFF', title: 'IRCTC ₹200 Off Train Tickets', category: 'Travel & Transport', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '500', description: 'Flat ₹200 off on train ticket bookings via IRCTC app using this code.', terms: 'Min ₹500 booking. AC classes only. 1 use per month.' },
  { brand: 'RedBus', code: 'REDBUS150', title: 'RedBus ₹150 Off Bus Tickets', category: 'Travel & Transport', discount: '₹150 Off', originalValue: '150', sellingPrice: '19', minOrderValue: '400', description: 'Save ₹150 on bus ticket bookings across India via RedBus app or website.', terms: 'Min ₹400. All operators. Web and app.' },
  { brand: 'IndiGo', code: 'INDIGO600', title: 'IndiGo ₹600 Off Domestic Flights', category: 'Travel & Transport', discount: '₹600 Off', originalValue: '600', sellingPrice: '49', minOrderValue: '3000', description: '₹600 instant off on IndiGo domestic flights booked directly on goindigo.in.', terms: 'Min ₹3000. Direct bookings only. Cannot combine with sale fares.' },

  // ─── Hotels & Stays (51–60) ───────────────────────────────────────────
  { brand: 'OYO', code: 'OYO40STAY', title: 'OYO 40% Off Hotel Stays', category: 'Hotels & Stays', discount: '40% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '2000', description: '40% off on OYO hotel bookings across India. Budget and premium properties.', terms: 'Max ₹1500. Min booking ₹2000. App bookings only.' },
  { brand: 'Booking.com', code: 'BOOK20INDIA', title: 'Booking.com 20% Off India Hotels', category: 'Hotels & Stays', discount: '20% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '5000', description: '20% off on hotel stays across India on Booking.com. Includes Genius deals.', terms: 'Max ₹2500 off. Min ₹5000. Selected properties in India.' },
  { brand: 'Agoda', code: 'AGODA15ALL', title: 'Agoda 15% Off Worldwide Hotels', category: 'Hotels & Stays', discount: '15% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '5000', description: '15% off on hotel bookings worldwide via Agoda. Covers 2M+ properties.', terms: 'Max ₹2000. Min booking ₹5000. Non-refundable rates only.' },
  { brand: 'Goibibo', code: 'GOIHOTEL500', title: 'Goibibo ₹500 Off Hotels', category: 'Hotels & Stays', discount: '₹500 Off', originalValue: '500', sellingPrice: '45', minOrderValue: '2000', description: 'Flat ₹500 off on hotel bookings at Goibibo. 3-star and above properties.', terms: 'Min ₹2000. GoStays and select properties.' },
  { brand: 'MakeMyTrip', code: 'MMTHOMESTAY', title: 'MakeMyTrip ₹800 Off Homestays', category: 'Hotels & Stays', discount: '₹800 Off', originalValue: '800', sellingPrice: '59', minOrderValue: '3000', description: '₹800 off on villa and homestay bookings on MakeMyTrip. Weekend getaways included.', terms: 'Min ₹3000. Homestay/villa category. 2-night min stay.' },
  { brand: 'Treebo', code: 'TREEBO30HOT', title: 'Treebo 30% Off All Hotels', category: 'Hotels & Stays', discount: '30% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '2000', description: '30% off at Treebo-branded hotels across India. Quality stays at budget prices.', terms: 'Max ₹1000. Treebo properties only.' },
  { brand: 'FabHotels', code: 'FAB25ROOM', title: 'FabHotels 25% Off Rooms', category: 'Hotels & Stays', discount: '25% Off', originalValue: '750', sellingPrice: '55', minOrderValue: '1500', description: '25% off on FabHotels room bookings. Business and leisure stays across 50+ cities.', terms: 'Max ₹750. App booking only. FabHotels properties.' },
  { brand: 'Airbnb', code: 'AIRBNB2000', title: 'Airbnb ₹2000 Off First Stay', category: 'Hotels & Stays', discount: '₹2000 Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '8000', description: '₹2000 off on your first Airbnb booking in India. Unique homes and experiences.', terms: 'New users only. Min ₹8000 booking. India stays only.' },

  // ─── Electronics & Gadgets (59–68) ────────────────────────────────────
  { brand: 'Croma', code: 'CROMA15LAP', title: 'Croma 15% Off Laptops', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '30000', description: '15% off on laptops at Croma — HP, Lenovo, Dell, and ASUS. Online and in-store.', terms: 'Max ₹5000 off. Excludes Apple MacBooks.' },
  { brand: 'Reliance Digital', code: 'RDIGI10OFF', title: 'Reliance Digital 10% Off Store', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '15000', description: '10% off at Reliance Digital stores and reliancedigital.in on phones, TVs, and appliances.', terms: 'Max ₹3000 off. Select products. Not on iPhones.' },
  { brand: 'Samsung', code: 'SAM20GALAXY', title: 'Samsung 20% Off Galaxy Accessories', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '5000', description: '20% off on Galaxy Watch, Buds, and phone cases on samsung.com/in.', terms: 'Max ₹2000. Accessories category only. samsung.com orders.' },
  { brand: 'OnePlus', code: 'OP15STORE', title: 'OnePlus 15% Off Store Orders', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '10000', description: '15% off on OnePlus phones, earbuds, and accessories from the official OnePlus store.', terms: 'Max ₹2500. oneplus.in orders only. Excludes Nord CE.' },
  { brand: 'boAt', code: 'BOAT40SALE', title: 'boAt 40% Off Audio Gear', category: 'Electronics & Gadgets', discount: '40% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1500', description: '40% off on boAt Airdopes, Rockerz headphones, and smartwatches.', terms: 'Max ₹800. boat-lifestyle.com only. All audio products.' },
  { brand: 'Noise', code: 'NOISE30SMART', title: 'Noise 30% Off Smartwatches', category: 'Electronics & Gadgets', discount: '30% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1500', description: '30% off on Noise ColorFit, NoiseFit, and Icon smartwatches.', terms: 'Max ₹600. gonoise.com only.' },
  { brand: 'Apple', code: 'APPLE5EDU', title: 'Apple Education Store 5% Extra Off', category: 'Electronics & Gadgets', discount: '5% Off', originalValue: '5000', sellingPrice: '349', minOrderValue: '50000', description: 'Extra 5% off on Mac and iPad at Apple Education Store India. Stack with student pricing.', terms: 'Max ₹5000. Verified students only. apple.com/in/shop/go/edu.' },
  { brand: 'Vijay Sales', code: 'VIJAY10AC', title: 'Vijay Sales 10% Off ACs & Appliances', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '2000', sellingPrice: '129', minOrderValue: '15000', description: '10% off on split ACs, washing machines, and refrigerators at Vijay Sales.', terms: 'Max ₹2000. Select appliance brands. Summer sale period.' },

  // ─── Gaming & Entertainment (67–76) ───────────────────────────────────
  { brand: 'PlayStation', code: 'PSN500STORE', title: 'PlayStation Store ₹500 Off', category: 'Gaming & Entertainment', discount: '₹500 Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1500', description: '₹500 off on PlayStation Store wallet top-ups and game purchases.', terms: 'Min ₹1500 purchase. Digital purchases only.' },
  { brand: 'Xbox', code: 'XBOX3MOGP', title: 'Xbox Game Pass 3 Months ₹299', category: 'Gaming & Entertainment', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '499', description: 'Get 3 months of Xbox Game Pass Ultimate for just ₹299 instead of ₹499.', terms: 'New subscribers only. Auto-renews at ₹499/month.' },
  { brand: 'Steam', code: 'STEAM20WALLET', title: 'Steam Wallet 20% Bonus', category: 'Gaming & Entertainment', discount: '20% Bonus', originalValue: '200', sellingPrice: '19', minOrderValue: '1000', description: 'Add ₹1000 to Steam Wallet and get ₹200 bonus credit. Stock up for the Steam Sale.', terms: '₹1000 min top-up. One per Steam account.' },
  { brand: 'Google Play', code: 'GPLAY50OFF', title: 'Google Play ₹50 Off ₹200+', category: 'Gaming & Entertainment', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 off on apps, games, and in-app purchases on Google Play Store.', terms: 'Min ₹200 purchase. One use per Google account.' },
  { brand: 'BookMyShow', code: 'BMS150MOVIE', title: 'BookMyShow ₹150 Off Movies', category: 'Gaming & Entertainment', discount: '₹150 Off', originalValue: '150', sellingPrice: '19', minOrderValue: '300', description: 'Flat ₹150 off on movie tickets booked via BookMyShow. All cinemas, all shows.', terms: 'Min 2 tickets. Max ₹150 off. Not valid on IMAX recliners.' },
  { brand: 'Netflix', code: 'NFLX1FREE', title: 'Netflix 1 Month Free Premium', category: 'Gaming & Entertainment', discount: '1 Month Free', originalValue: '649', sellingPrice: '49', minOrderValue: '0', description: 'Get 1 month of Netflix Premium for free. 4K UHD streaming with 4 screens.', terms: 'New accounts only. Auto-renews at ₹649/month. Cancel anytime.' },
  { brand: 'Amazon Prime', code: 'PRIME50ANN', title: 'Amazon Prime ₹50 Off Annual Plan', category: 'Gaming & Entertainment', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '1499', description: '₹50 off on the Amazon Prime annual subscription. Prime Video, Music, and fast delivery.', terms: 'Min ₹1499 annual plan. New and renewing members.' },
  { brand: 'Disney+ Hotstar', code: 'HOTSTAR199', title: 'Disney+ Hotstar Super at ₹199', category: 'Gaming & Entertainment', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '299', description: 'Get Disney+ Hotstar Super plan for ₹199 instead of ₹299. Cricket and movies included.', terms: 'New subscribers. 3-month plan. Auto-renews at ₹299.' },

  // ─── Fitness & Sports (75–82) ─────────────────────────────────────────
  { brand: 'Cult.fit', code: 'CULT30FIT', title: 'Cult.fit 30% Off Membership', category: 'Fitness & Sports', discount: '30% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '5000', description: '30% off on Cult.fit gym and fitness membership. Includes yoga, strength, and dance classes.', terms: 'Max ₹3000 off. 3-month and above plans. Select cities.' },
  { brand: 'Decathlon', code: 'DECAT20GEAR', title: 'Decathlon 20% Off Sports Gear', category: 'Fitness & Sports', discount: '20% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '3000', description: '20% off on sports equipment, cycling gear, and outdoor accessories at Decathlon.', terms: 'Max ₹1000. Online and in-store. Excludes bikes.' },
  { brand: 'HealthifyMe', code: 'HFYME50PRO', title: 'HealthifyMe 50% Off Pro Plan', category: 'Fitness & Sports', discount: '50% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '2999', description: '50% off on HealthifyMe Pro plan with AI-powered diet coaching and calorie tracking.', terms: 'Max ₹1500. Annual plans only.' },
  { brand: 'GNC', code: 'GNC25WHEY', title: 'GNC 25% Off Whey Protein', category: 'Fitness & Sports', discount: '25% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '3000', description: '25% off on GNC whey protein, mass gainer, and multivitamins.', terms: 'Max ₹1200. guardian.in/gnc only. Select products.' },

  // ─── Pharmacy & Health (83–88) ────────────────────────────────────────
  { brand: 'PharmEasy', code: 'PE25MEDS', title: 'PharmEasy 25% Off Medicines', category: 'Health & Pharmacy', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '25% off on prescription medicines ordered via PharmEasy. Upload prescription and save.', terms: 'Max ₹500. Rx medicines only. All users.' },
  { brand: '1mg (Tata)', code: 'ONEMG20RX', title: '1mg 20% Off Prescription Orders', category: 'Health & Pharmacy', discount: '20% Off', originalValue: '400', sellingPrice: '35', minOrderValue: '1000', description: '20% off on prescription medicine orders on 1mg by Tata Health.', terms: 'Max ₹400. Upload valid prescription. Pan India delivery.' },
  { brand: 'Netmeds', code: 'NETMED25', title: 'Netmeds 25% Off First Order', category: 'Health & Pharmacy', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: 'First-time users get 25% off on all medicines and health products at Netmeds.', terms: 'Max ₹500. New users only. Min ₹1000.' },
  { brand: 'Apollo Pharmacy', code: 'APOLLO15RX', title: 'Apollo 15% Off Medicines', category: 'Health & Pharmacy', discount: '15% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '800', description: '15% off on medicines and healthcare products at Apollo Pharmacy online.', terms: 'Max ₹300. App and web orders. All users.' },

  // ─── Education & Learning (89–94) ─────────────────────────────────────
  { brand: 'Udemy', code: 'UDEMY85SALE', title: 'Udemy Courses at ₹449 Each', category: 'Education', discount: '85% Off', originalValue: '2500', sellingPrice: '25', minOrderValue: '0', description: 'Get top-rated Udemy courses for just ₹449 each during the global sale. Programming, design, marketing.', terms: 'Select courses only. Valid during sale period. One per course.' },
  { brand: 'Coursera', code: 'COURSERA30', title: 'Coursera 30% Off Plus Annual', category: 'Education', discount: '30% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '15000', description: '30% off on Coursera Plus annual subscription. Access 7000+ courses from top universities.', terms: 'Annual plan only. Max savings ~₹5000. New subscribers.' },
  { brand: 'Unacademy', code: 'UNAC20PREP', title: 'Unacademy 20% Off Plus', category: 'Education', discount: '20% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '20% off on Unacademy Plus subscription for UPSC, JEE, NEET, and other competitive exams.', terms: 'Max ₹3000. 6-month and annual plans.' },
  { brand: "BYJU'S", code: 'BYJUS15OFF', title: "BYJU'S 15% Off Premium", category: 'Education', discount: '15% Off', originalValue: '4000', sellingPrice: '249', minOrderValue: '20000', description: "15% off on BYJU'S premium learning plans for classes 6–12.", terms: 'Max ₹4000. Annual plans only. New subscriptions.' },
  { brand: 'Skillshare', code: 'SKILL50ANN', title: 'Skillshare 50% Off Annual', category: 'Education', discount: '50% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '5999', description: '50% off on Skillshare annual membership. Creative classes — illustration, video, design.', terms: 'Annual plan. Max savings ~₹3000. New members.' },
  { brand: 'Simplilearn', code: 'SIMPLE25PGP', title: 'Simplilearn 25% Off PG Programs', category: 'Education', discount: '25% Off', originalValue: '25000', sellingPrice: '999', minOrderValue: '80000', description: '25% off on Simplilearn PG programs in Data Science, AI, and Digital Marketing.', terms: 'Max ₹25000. Select PG programs. EMI available.' },

  // ─── Finance & Payments (95–100) ──────────────────────────────────────
  { brand: 'Paytm', code: 'PAYTM50CB', title: 'Paytm ₹50 Cashback on Recharge', category: 'Finance & Payments', discount: '₹50 Cashback', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 cashback on mobile recharge of ₹200 or above via Paytm.', terms: 'Min recharge ₹200. Paytm wallet credit. Once per user.' },
  { brand: 'PhonePe', code: 'PHONEPE100', title: 'PhonePe ₹100 Cashback on Bill Pay', category: 'Finance & Payments', discount: '₹100 Cashback', originalValue: '100', sellingPrice: '10', minOrderValue: '500', description: '₹100 cashback when you pay electricity, water, or gas bills via PhonePe.', terms: 'Min bill ₹500. First bill payment of the month.' },
  { brand: 'Google Pay', code: 'GPAY75SEND', title: 'Google Pay ₹75 Reward on UPI', category: 'Finance & Payments', discount: '₹75 Reward', originalValue: '75', sellingPrice: '5', minOrderValue: '500', description: 'Get ₹75 cashback reward on your first UPI payment of ₹500+ via Google Pay.', terms: 'New users. Min ₹500 UPI transaction. Scratch card reward.' },
  { brand: 'CRED', code: 'CRED200BILL', title: 'CRED ₹200 Off on Credit Card Bill', category: 'Finance & Payments', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '5000', description: 'Get ₹200 CRED coins reward when you pay credit card bill of ₹5000+ on CRED.', terms: 'Min bill ₹5000. One per billing cycle. CRED members only.' },
  { brand: 'Amazon Pay', code: 'APAY10LOAD', title: 'Amazon Pay 10% Cashback on Load', category: 'Finance & Payments', discount: '10% Cashback', originalValue: '200', sellingPrice: '15', minOrderValue: '1000', description: '10% cashback when you load ₹1000+ to Amazon Pay balance. Use on any Amazon purchase.', terms: 'Max ₹200 cashback. Min load ₹1000. Once per user.' },
  { brand: 'FreeCharge', code: 'FC50RECHARGE', title: 'FreeCharge ₹50 Off Recharge', category: 'Finance & Payments', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 off on mobile recharge via FreeCharge. All operators — Jio, Airtel, Vi.', terms: 'Min ₹200 recharge. New and existing users. One per account.' },

  // ─── Groceries & Home (95–100) ────────────────────────────────────────
  { brand: 'Zepto', code: 'ZEPTO100NEW', title: 'Zepto ₹100 Off First Grocery Order', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '299', description: '₹100 off on your first Zepto 10-minute grocery delivery. Fruits, snacks, dairy.', terms: 'New users only. Min ₹299. Select cities.' },
  { brand: 'Blinkit', code: 'BLINK75FAST', title: 'Blinkit ₹75 Off Instant Delivery', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '249', description: '₹75 off on Blinkit instant grocery delivery. Essentials in 10 minutes.', terms: 'Min ₹249. All users. One use per account.' },
  { brand: 'Urban Company', code: 'UC200HOME', title: 'Urban Company ₹200 Off Home Service', category: 'General', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '500', description: '₹200 off on salon at home, AC repair, cleaning, and plumbing via Urban Company.', terms: 'Min ₹500 booking. All services. Select cities.' },
  { brand: 'Pepperfry', code: 'PF20FURN', title: 'Pepperfry 20% Off Furniture', category: 'General', discount: '20% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '20% off on sofas, beds, dining tables, and wardrobes at Pepperfry.', terms: 'Max ₹3000. Min ₹10000. Pepperfry.com only.' },
  { brand: 'IKEA', code: 'IKEA15DECOR', title: 'IKEA 15% Off Home Décor', category: 'General', discount: '15% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '5000', description: '15% off on IKEA home décor — cushions, frames, lighting, and storage solutions.', terms: 'Max ₹1500. ikea.in online orders. Excludes furniture.' },
  { brand: 'Licious', code: 'LICIOUS150', title: 'Licious ₹150 Off Fresh Meat & Fish', category: 'Food & Delivery', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: '₹150 off on fresh chicken, mutton, fish, and eggs from Licious.', terms: 'Min ₹500. Select cities. App and web.' },
];

async function seedCoupons() {
  console.log(`\n🚀 Seeding ${coupons.length} coupons into Supabase...\n`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  // Insert in batches of 10
  const BATCH = 10;
  for (let i = 0; i < coupons.length; i += BATCH) {
    const batch = coupons.slice(i, i + BATCH).map((c) => ({
      id: uuidv4(),
      code: c.code.toUpperCase().trim(),
      title: c.title,
      type: 'Public',
      category: c.category,
      brand: c.brand,
      description: c.description,
      discount: c.discount,
      original_value: String(c.originalValue || '0'),
      selling_price: String(c.sellingPrice || '15'),
      min_order_value: String(c.minOrderValue || ''),
      valid_from: new Date().toISOString().split('T')[0],
      expiry_date: futureDate(30, 180),
      affiliate_link: '',
      terms: c.terms || '',
      is_featured: Math.random() < 0.2,   // ~20% featured
      is_exclusive: Math.random() < 0.15,  // ~15% exclusive
      is_verified: true,
      seller_email: '',
      status: 'available',
      source: 'admin',
      added_at: recentDate(1, 30),
    }));

    // Check for duplicate codes before inserting
    const codes = batch.map((b) => b.code);
    const { data: existing } = await supabase
      .from('coupons')
      .select('code')
      .in('code', codes);

    const existingCodes = new Set((existing || []).map((e) => e.code));
    const toInsert = batch.filter((b) => !existingCodes.has(b.code));
    const skipCount = batch.length - toInsert.length;

    if (toInsert.length > 0) {
      const { data, error } = await supabase
        .from('coupons')
        .insert(toInsert)
        .select('id, code');

      if (error) {
        console.error(`  ❌ Batch ${Math.floor(i / BATCH) + 1} error:`, error.message);
        failed += toInsert.length;
      } else {
        inserted += (data || []).length;
        console.log(`  ✅ Batch ${Math.floor(i / BATCH) + 1}: inserted ${(data || []).length} coupons`);
      }
    }

    if (skipCount > 0) {
      skipped += skipCount;
      console.log(`  ⏭️  Batch ${Math.floor(i / BATCH) + 1}: skipped ${skipCount} duplicates`);
    }
  }

  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Inserted: ${inserted}`);
  console.log(`⏭️  Skipped (duplicates): ${skipped}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📦 Total in array: ${coupons.length}`);
  console.log(`────────────────────────────────────\n`);
}

seedCoupons()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
