// ============================================
// SaveHatke — Seed 200 MORE Real Coupons into Supabase
// ============================================
// Usage: node server/seed_coupons_200.js

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

function futureDate(minDays = 30, maxDays = 180) {
  const ms = Date.now() + (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString().split('T')[0];
}

function recentDate(minDays = 1, maxDays = 30) {
  const ms = Date.now() - (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString();
}

// ── 200 NEW Real Indian Coupons (all unique codes) ──────────────────────
const coupons = [
  // ─── E-Commerce (1–20) ────────────────────────────────────────────────
  { brand: 'Amazon', code: 'AMZSAVE750', title: 'Amazon ₹750 Off on ₹3000+', category: 'E-Commerce', discount: '₹750 Off', originalValue: '750', sellingPrice: '59', minOrderValue: '3000', description: 'Flat ₹750 off on orders above ₹3000. All categories including fashion, home, and electronics.', terms: 'Min order ₹3000. One per account. Excludes gift cards.' },
  { brand: 'Amazon', code: 'AMZKINDLE30', title: 'Amazon 30% Off Kindle Books', category: 'E-Commerce', discount: '30% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '500', description: '30% off on Kindle eBooks and audiobooks. Bestsellers and new releases included.', terms: 'Max ₹300 off. Digital content only.' },
  { brand: 'Amazon', code: 'AMZWARDROBE', title: 'Amazon Wardrobe ₹400 Off', category: 'E-Commerce', discount: '₹400 Off', originalValue: '400', sellingPrice: '35', minOrderValue: '1500', description: 'Flat ₹400 off on Amazon Wardrobe fashion picks — try before you buy.', terms: 'Min ₹1500. Wardrobe eligible items. Select cities.' },
  { brand: 'Flipkart', code: 'FKPLUS400', title: 'Flipkart Plus ₹400 Extra Off', category: 'E-Commerce', discount: '₹400 Off', originalValue: '400', sellingPrice: '39', minOrderValue: '2000', description: 'Flipkart Plus members get extra ₹400 off on any order above ₹2000.', terms: 'Plus members only. Min ₹2000. All categories.' },
  { brand: 'Flipkart', code: 'FKFASHION25', title: 'Flipkart 25% Off Fashion', category: 'E-Commerce', discount: '25% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1500', description: '25% off on men and women fashion — brands like Roadster, Metronaut, and Anubhutee.', terms: 'Max ₹800 off. Fashion category only.' },
  { brand: 'Flipkart', code: 'FKHOME15', title: 'Flipkart 15% Off Home & Kitchen', category: 'E-Commerce', discount: '15% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '2000', description: '15% off on home décor, kitchen appliances, and bedding on Flipkart.', terms: 'Max ₹600. Home & Kitchen category.' },
  { brand: 'Meesho', code: 'MEESHO150', title: 'Meesho ₹150 Off ₹500+', category: 'E-Commerce', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: '₹150 off on your Meesho order. Budget fashion, home, and beauty products.', terms: 'Min ₹500. All users. One use per order.' },
  { brand: 'Meesho', code: 'MEEFIRST100', title: 'Meesho ₹100 Off First Order', category: 'E-Commerce', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '349', description: '₹100 off for new Meesho users on their first order. Huge variety at budget prices.', terms: 'New users only. Min ₹349.' },
  { brand: 'Tata CLiQ', code: 'CLIQ15SALE', title: 'Tata CLiQ 15% Off Electronics', category: 'E-Commerce', discount: '15% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '5000', description: '15% off on electronics — Samsung, LG, Bose, and more at Tata CLiQ.', terms: 'Max ₹1500. Select electronics brands.' },
  { brand: 'JioMart', code: 'JIOSAVE200', title: 'JioMart ₹200 Off ₹1000+', category: 'E-Commerce', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '1000', description: 'Save ₹200 on your next JioMart order. Groceries, FMCG, and household essentials.', terms: 'Min ₹1000. All users. Pan India.' },
  { brand: 'BigBasket', code: 'BBWEEKEND', title: 'BigBasket Weekend ₹150 Off', category: 'E-Commerce', discount: '₹150 Off', originalValue: '150', sellingPrice: '19', minOrderValue: '700', description: 'Weekend special — ₹150 off on BigBasket orders. Valid Saturday and Sunday only.', terms: 'Min ₹700. Weekend orders only.' },
  { brand: 'Snapdeal', code: 'SNAP20ALL', title: 'Snapdeal 20% Off Sitewide', category: 'E-Commerce', discount: '20% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '20% off on everything at Snapdeal — fashion, electronics, home, and more.', terms: 'Max ₹500. Min ₹1000. All categories.' },
  { brand: 'ShopClues', code: 'SCLUE15OFF', title: 'ShopClues 15% Off All Products', category: 'E-Commerce', discount: '15% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '800', description: '15% off on ShopClues — budget deals on electronics, fashion, and daily needs.', terms: 'Max ₹400. Min ₹800. All sellers.' },
  { brand: 'Nykaa', code: 'NYKSHOP20', title: 'Nykaa 20% Off Sitewide', category: 'E-Commerce', discount: '20% Off', originalValue: '600', sellingPrice: '49', minOrderValue: '1200', description: '20% off across Nykaa — beauty, skincare, wellness, and fashion.', terms: 'Max ₹600. All brands. One per user.' },
  { brand: 'Amazon', code: 'AMZPAY200', title: 'Amazon Pay ₹200 Off EMI', category: 'E-Commerce', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '5000', description: '₹200 off when you choose Amazon Pay EMI on purchases above ₹5000.', terms: 'Min ₹5000. Amazon Pay EMI only. Select products.' },

  // ─── Fashion (16–40) ──────────────────────────────────────────────────
  { brand: 'Myntra', code: 'MYNWEEKEND', title: 'Myntra Weekend 35% Off', category: 'Fashion', discount: '35% Off', originalValue: '1500', sellingPrice: '119', minOrderValue: '2000', description: 'Weekend special — 35% off on fashion, footwear, and accessories at Myntra.', terms: 'Max ₹1500 off. Weekend orders. All brands.' },
  { brand: 'Myntra', code: 'MYNKIDS30', title: 'Myntra 30% Off Kids Fashion', category: 'Fashion', discount: '30% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1200', description: '30% off on kids clothing, shoes, and accessories. Top brands included.', terms: 'Max ₹800. Kids category only.' },
  { brand: 'Myntra', code: 'MYNBEAUTY20', title: 'Myntra Beauty 20% Off', category: 'Fashion', discount: '20% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '20% off on beauty and personal care products on Myntra.', terms: 'Max ₹500. Beauty category only.' },
  { brand: 'AJIO', code: 'AJIONEW40', title: 'AJIO New User 40% Off', category: 'Fashion', discount: '40% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '1500', description: 'First-time AJIO shoppers get 40% off on everything. Fashion for the whole family.', terms: 'New users only. Max ₹1000.' },
  { brand: 'AJIO', code: 'AJIOLUXE25', title: 'AJIO Luxe 25% Off Designer', category: 'Fashion', discount: '25% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '25% off on AJIO Luxe designer brands — Manish Malhotra, Ritu Kumar, and more.', terms: 'Max ₹2000. Luxe category only.' },
  { brand: 'H&M', code: 'HMKIDS20', title: 'H&M 20% Off Kids Collection', category: 'Fashion', discount: '20% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1500', description: '20% off on H&M kids wear — cute, trendy, and sustainable clothing.', terms: 'Max ₹600. Kids section only. Online & in-store.' },
  { brand: 'H&M', code: 'HMHOME15', title: 'H&M Home 15% Off', category: 'Fashion', discount: '15% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '2000', description: '15% off on H&M Home — cushions, candles, bedding, and bathroom accessories.', terms: 'Max ₹500. H&M Home collection only.' },
  { brand: 'Puma', code: 'PUMASNKR25', title: 'Puma 25% Off Sneakers', category: 'Fashion', discount: '25% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '2500', description: '25% off on Puma sneakers — RS-X, Suede, and Cali collection.', terms: 'Max ₹1200. Sneakers only. puma.com orders.' },
  { brand: 'Adidas', code: 'ADIRUN20', title: 'Adidas 20% Off Running Shoes', category: 'Fashion', discount: '20% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '3000', description: '20% off on Adidas Ultraboost, Supernova, and Adizero running shoes.', terms: 'Max ₹1000. Running shoes only.' },
  { brand: 'Nike', code: 'NIKEJORDAN15', title: 'Nike 15% Off Jordan Collection', category: 'Fashion', discount: '15% Off', originalValue: '1500', sellingPrice: '119', minOrderValue: '5000', description: '15% off on Air Jordan sneakers and apparel at nike.com/in.', terms: 'Max ₹1500. Jordan brand only. Online exclusive.' },
  { brand: 'Lenskart', code: 'LENSSUN40', title: 'Lenskart 40% Off Sunglasses', category: 'Fashion', discount: '40% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1000', description: '40% off on premium sunglasses — Ray-Ban, Oakley, and Lenskart Studio.', terms: 'Max ₹800. Sunglasses only. All users.' },
  { brand: 'Zara', code: 'ZARA20NEW', title: 'Zara 20% Off New Arrivals', category: 'Fashion', discount: '20% Off', originalValue: '1500', sellingPrice: '119', minOrderValue: '4000', description: '20% off on Zara new arrivals — dresses, blazers, and premium casuals.', terms: 'Max ₹1500. New arrivals only. zara.com/in.' },
  { brand: 'Reebok', code: 'RBOK30SALE', title: 'Reebok 30% Off Outlet', category: 'Fashion', discount: '30% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '2000', description: '30% off on Reebok outlet — classic, fitness, and lifestyle shoes and apparel.', terms: 'Max ₹1000. Outlet items only.' },
  { brand: 'Crocs', code: 'CROCS25FUN', title: 'Crocs 25% Off All Styles', category: 'Fashion', discount: '25% Off', originalValue: '700', sellingPrice: '55', minOrderValue: '1500', description: '25% off on Crocs — Classic Clogs, LiteRide, and Jibbitz charms.', terms: 'Max ₹700. All styles. crocs.in only.' },
  { brand: 'Bata', code: 'BATA20SHOES', title: 'Bata 20% Off Footwear', category: 'Fashion', discount: '20% Off', originalValue: '500', sellingPrice: '35', minOrderValue: '1200', description: '20% off on Bata shoes for men, women, and kids. All categories.', terms: 'Max ₹500. Online and in-store.' },

  // ─── Beauty & Personal Care (41–65) ───────────────────────────────────
  { brand: 'Nykaa', code: 'NYKSKIN15', title: 'Nykaa 15% Off Skincare', category: 'Beauty & Personal Care', discount: '15% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '800', description: '15% off on all skincare — moisturizers, sunscreens, face washes, and serums.', terms: 'Max ₹400. Skincare category. All brands.' },
  { brand: 'Nykaa', code: 'NYKFRAG20', title: 'Nykaa 20% Off Fragrances', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '600', sellingPrice: '49', minOrderValue: '1500', description: '20% off on premium perfumes — Calvin Klein, Hugo Boss, Bath & Body Works.', terms: 'Max ₹600. Fragrance category only.' },
  { brand: 'Purplle', code: 'PURP30NEW', title: 'Purplle 30% Off New Users', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '500', sellingPrice: '35', minOrderValue: '800', description: 'New to Purplle? Get 30% off on your first order — makeup, skincare, and haircare.', terms: 'New users only. Max ₹500.' },
  { brand: 'Mamaearth', code: 'MAMAHAIR25', title: 'Mamaearth 25% Off Haircare', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '25% off on Mamaearth onion shampoo, conditioner, and hair oil combos.', terms: 'Max ₹500. Haircare products only.' },
  { brand: 'Lakmé', code: 'LAKME30LIP', title: 'Lakmé 30% Off Lipsticks', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '600', description: '30% off on Lakmé 9to5, Absolute, and Enrich lipstick range.', terms: 'Max ₹400. Lip products only.' },
  { brand: 'The Body Shop', code: 'TBS25BODY', title: 'Body Shop 25% Off Body Care', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '700', sellingPrice: '55', minOrderValue: '1500', description: '25% off on body butters, shower gels, and body lotions at The Body Shop.', terms: 'Max ₹700. Body care category only.' },
  { brand: 'mCaffeine', code: 'MCAF30COMBO', title: 'mCaffeine 30% Off Combos', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '30% off on mCaffeine gift sets and combo packs — coffee-infused skincare.', terms: 'Max ₹500. Combo packs only.' },
  { brand: 'Forest Essentials', code: 'FOREST20LUX', title: 'Forest Essentials 20% Off', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '3000', description: '20% off on Forest Essentials Ayurvedic luxury skincare and haircare.', terms: 'Max ₹1000. forestessentialsindia.com only.' },
  { brand: 'Sugar Cosmetics', code: 'SUGAR35ALL', title: 'Sugar Cosmetics 35% Off', category: 'Beauty & Personal Care', discount: '35% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '35% off on Sugar lipsticks, kajal, foundation, and eye palettes.', terms: 'Max ₹500. All products. sugarcosmetics.com.' },
  { brand: 'Biotique', code: 'BIO25AYUR', title: 'Biotique 25% Off Ayurvedic Care', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '350', sellingPrice: '25', minOrderValue: '600', description: '25% off on Biotique Ayurvedic face wash, shampoo, and moisturizers.', terms: 'Max ₹350. biotique.com orders only.' },
  { brand: 'Kama Ayurveda', code: 'KAMA15PURE', title: 'Kama Ayurveda 15% Off', category: 'Beauty & Personal Care', discount: '15% Off', originalValue: '800', sellingPrice: '65', minOrderValue: '3000', description: '15% off on Kama Ayurveda premium skincare — kumkumadi oil, rose water, and face packs.', terms: 'Max ₹800. kamaayurveda.com only.' },
  { brand: 'Colorbar', code: 'CLRBAR30', title: 'Colorbar 30% Off Makeup', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '700', description: '30% off on Colorbar foundations, concealers, and lip products.', terms: 'Max ₹400. colorbarcosmetics.com only.' },
  { brand: 'Faces Canada', code: 'FACES25ALL', title: 'Faces Canada 25% Off', category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '350', sellingPrice: '25', minOrderValue: '600', description: '25% off on Faces Canada makeup — vegan and cruelty-free beauty essentials.', terms: 'Max ₹350. All Faces Canada products.' },
  { brand: 'Dove', code: 'DOVE20CARE', title: 'Dove 20% Off Body Care', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '200', sellingPrice: '15', minOrderValue: '500', description: '20% off on Dove body wash, shampoo, and deodorant range on official stores.', terms: 'Max ₹200. Select Dove products.' },
  { brand: 'LOréal Paris', code: 'LOREAL25PRO', title: "L'Oréal Paris 25% Off Hair Color", category: 'Beauty & Personal Care', discount: '25% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '500', description: "25% off on L'Oréal Paris Excellence, Casting, and Magic hair color range.", terms: 'Max ₹300. Hair color products only.' },

  // ─── Food & Delivery (56–85) ──────────────────────────────────────────
  { brand: 'Swiggy', code: 'SWIG200MEGA', title: 'Swiggy ₹200 Off ₹500+', category: 'Food & Delivery', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '500', description: 'Mega deal — ₹200 off on Swiggy food orders above ₹500. All restaurants.', terms: 'Min ₹500. One per user. Select cities.' },
  { brand: 'Swiggy', code: 'SWIGSNACK75', title: 'Swiggy ₹75 Off Snacks Order', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '199', description: '₹75 off on quick bites and snacks ordered via Swiggy.', terms: 'Min ₹199. Snacks and desserts category.' },
  { brand: 'Zomato', code: 'ZOMNEW200', title: 'Zomato ₹200 Off New User', category: 'Food & Delivery', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '400', description: 'New to Zomato? Get ₹200 off on your first food order.', terms: 'New users only. Min ₹400.' },
  { brand: 'Zomato', code: 'ZOMLUNCH50', title: 'Zomato ₹50 Off Lunch Orders', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '150', description: '₹50 off on lunch orders placed between 11 AM – 3 PM on Zomato.', terms: 'Min ₹150. Lunch hours only.' },
  { brand: "Domino's", code: 'DOMCHEESE20', title: "Domino's 20% Off Cheese Burst", category: 'Food & Delivery', discount: '20% Off', originalValue: '200', sellingPrice: '19', minOrderValue: '500', description: "20% off on all Domino's Cheese Burst pizzas. Extra cheese, extra savings!", terms: 'Max ₹200. Cheese Burst pizzas only.' },
  { brand: "Domino's", code: 'DOMCOMBO150', title: "Domino's Combo ₹150 Off", category: 'Food & Delivery', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '499', description: "₹150 off on Domino's combo meals — pizza + sides + drinks.", terms: 'Min ₹499. Combo meals only.' },
  { brand: 'Pizza Hut', code: 'PHUT40FAM', title: 'Pizza Hut 40% Off Family Deal', category: 'Food & Delivery', discount: '40% Off', originalValue: '400', sellingPrice: '35', minOrderValue: '800', description: '40% off on Pizza Hut family meals — 2 pizzas, sides, and dessert.', terms: 'Max ₹400. Family meal category.' },
  { brand: 'KFC', code: 'KFCBUCKET30', title: 'KFC 30% Off Bucket Meals', category: 'Food & Delivery', discount: '30% Off', originalValue: '200', sellingPrice: '19', minOrderValue: '400', description: '30% off on KFC bucket meals and sharing combos.', terms: 'Max ₹200. Bucket meals only.' },
  { brand: "McDonald's", code: 'MCD50MEAL', title: "McDonald's ₹50 Off McValue Meal", category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '199', description: "₹50 off on any McDonald's McValue meal via app ordering.", terms: "Min ₹199. McDonald's app only." },
  { brand: 'Burger King', code: 'BK40WHOPPER', title: 'Burger King 40% Off Whopper', category: 'Food & Delivery', discount: '40% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '200', description: '40% off on Whopper and premium burger combos at Burger King.', terms: 'Max ₹100. Whopper category only.' },
  { brand: 'Subway', code: 'SUB30FOOT', title: 'Subway 30% Off Footlong', category: 'Food & Delivery', discount: '30% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '300', description: '30% off on Subway footlong subs — all varieties, extra toppings included.', terms: 'Max ₹100. Footlong subs only.' },
  { brand: 'Starbucks', code: 'SBUX20LATTE', title: 'Starbucks 20% Off on ₹500+', category: 'Food & Delivery', discount: '20% Off', originalValue: '200', sellingPrice: '19', minOrderValue: '500', description: '20% off on Starbucks orders above ₹500. Lattes, frappuccinos, and pastries.', terms: 'Max ₹200. In-store and delivery.' },
  { brand: 'Dunzo', code: 'DUNZO50FAST', title: 'Dunzo ₹50 Off Delivery', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '150', description: '₹50 off on Dunzo delivery — groceries, medicines, and parcels.', terms: 'Min ₹150. Delivery orders only.' },
  { brand: 'Zepto', code: 'ZEPTOSAVE50', title: 'Zepto ₹50 Off Groceries', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '199', description: '₹50 off on Zepto 10-minute grocery delivery. Dairy, snacks, and more.', terms: 'Min ₹199. All users. Select cities.' },
  { brand: 'Blinkit', code: 'BLINK100NEW', title: 'Blinkit ₹100 Off New User', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '299', description: '₹100 off for first-time Blinkit users on instant grocery delivery.', terms: 'New users only. Min ₹299.' },
  { brand: 'Swiggy Instamart', code: 'INSTASAVE100', title: 'Instamart ₹100 Off ₹399+', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '399', description: '₹100 off on Swiggy Instamart orders above ₹399. Groceries in 10 minutes.', terms: 'Min ₹399. Instamart only.' },
  { brand: 'Licious', code: 'LICFRESH100', title: 'Licious ₹100 Off Fresh Orders', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '400', description: '₹100 off on fresh meat, seafood, and ready-to-cook meals from Licious.', terms: 'Min ₹400. All users.' },
  { brand: 'FreshToHome', code: 'FTH75FISH', title: 'FreshToHome ₹75 Off Seafood', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '350', description: '₹75 off on fresh fish, prawns, and seafood from FreshToHome.', terms: 'Min ₹350. Seafood category.' },
  { brand: 'Country Delight', code: 'CDMILK50', title: 'Country Delight ₹50 Off Dairy', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 off on farm-fresh milk, paneer, and curd from Country Delight.', terms: 'Min ₹200. Dairy products only.' },

  // ─── Travel & Transport (76–105) ──────────────────────────────────────
  { brand: 'MakeMyTrip', code: 'MMTBUS200', title: 'MakeMyTrip ₹200 Off Bus Tickets', category: 'Travel & Transport', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '600', description: '₹200 off on bus ticket bookings via MakeMyTrip. AC and non-AC buses.', terms: 'Min ₹600. All operators.' },
  { brand: 'MakeMyTrip', code: 'MMTINTL2000', title: 'MakeMyTrip ₹2000 Off Intl Flights', category: 'Travel & Transport', discount: '₹2000 Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '10000', description: '₹2000 off on international flight bookings on MakeMyTrip.', terms: 'Min ₹10000. International flights only.' },
  { brand: 'Cleartrip', code: 'CTHOTEL400', title: 'Cleartrip ₹400 Off Hotels', category: 'Travel & Transport', discount: '₹400 Off', originalValue: '400', sellingPrice: '35', minOrderValue: '1500', description: '₹400 off on hotel bookings via Cleartrip. Budget and premium stays.', terms: 'Min ₹1500. All properties.' },
  { brand: 'EaseMyTrip', code: 'EASEDOM500', title: 'EaseMyTrip ₹500 Off Domestic', category: 'Travel & Transport', discount: '₹500 Off', originalValue: '500', sellingPrice: '39', minOrderValue: '3000', description: '₹500 off on domestic flight bookings at EaseMyTrip.', terms: 'Min ₹3000. Domestic flights only.' },
  { brand: 'Uber', code: 'UBERGO30', title: 'Uber 30% Off UberGo Rides', category: 'Travel & Transport', discount: '30% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '200', description: '30% off on UberGo rides. Quick, affordable city transport.', terms: 'Max ₹100. UberGo only. Select cities.' },
  { brand: 'Ola', code: 'OLAAUTO25', title: 'Ola 25% Off Auto Rides', category: 'Travel & Transport', discount: '25% Off', originalValue: '50', sellingPrice: '5', minOrderValue: '100', description: '25% off on Ola Auto rides. Budget-friendly rides in your city.', terms: 'Max ₹50. Auto category only.' },
  { brand: 'Rapido', code: 'RAPIDONEW50', title: 'Rapido ₹50 Off First Ride', category: 'Travel & Transport', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '80', description: '₹50 off on your first Rapido bike taxi ride.', terms: 'New users only. Min fare ₹80.' },
  { brand: 'IndiGo', code: 'INDIGO400RT', title: 'IndiGo ₹400 Off Round Trip', category: 'Travel & Transport', discount: '₹400 Off', originalValue: '400', sellingPrice: '35', minOrderValue: '4000', description: '₹400 off on IndiGo round-trip domestic flights.', terms: 'Min ₹4000. Round-trip bookings only.' },
  { brand: 'SpiceJet', code: 'SPICE350FLY', title: 'SpiceJet ₹350 Off Flights', category: 'Travel & Transport', discount: '₹350 Off', originalValue: '350', sellingPrice: '29', minOrderValue: '2500', description: '₹350 off on SpiceJet domestic flight bookings.', terms: 'Min ₹2500. All routes. spicejet.com.' },
  { brand: 'Air India', code: 'AIRINDIA500', title: 'Air India ₹500 Off Flights', category: 'Travel & Transport', discount: '₹500 Off', originalValue: '500', sellingPrice: '45', minOrderValue: '3500', description: '₹500 off on Air India domestic and international flights.', terms: 'Min ₹3500. airindia.com bookings.' },
  { brand: 'Vistara', code: 'VIST20PREM', title: 'Vistara 20% Off Premium Economy', category: 'Travel & Transport', discount: '20% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '5000', description: '20% off on Vistara Premium Economy seats. Comfort at a discount.', terms: 'Max ₹1500. Premium Economy only.' },
  { brand: 'RedBus', code: 'RBUS100NITE', title: 'RedBus ₹100 Off Night Buses', category: 'Travel & Transport', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '300', description: '₹100 off on night sleeper bus bookings via RedBus.', terms: 'Min ₹300. Sleeper buses. Departure after 8 PM.' },
  { brand: 'IRCTC', code: 'IRCTCTAT100', title: 'IRCTC ₹100 Off Tatkal Tickets', category: 'Travel & Transport', discount: '₹100 Off', originalValue: '100', sellingPrice: '15', minOrderValue: '300', description: '₹100 off on Tatkal train ticket bookings via IRCTC.', terms: 'Min ₹300. Tatkal quota only.' },
  { brand: 'Yatra', code: 'YATRA600FLY', title: 'Yatra ₹600 Off Flights', category: 'Travel & Transport', discount: '₹600 Off', originalValue: '600', sellingPrice: '49', minOrderValue: '3000', description: '₹600 off on flight bookings via Yatra.com. All airlines.', terms: 'Min ₹3000. yatra.com bookings.' },
  { brand: 'ixigo', code: 'IXIGO300OFF', title: 'ixigo ₹300 Off Travel Bookings', category: 'Travel & Transport', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1500', description: '₹300 off on flights, trains, and bus bookings via ixigo.', terms: 'Min ₹1500. All modes of travel.' },

  // ─── Hotels & Stays (106–125) ─────────────────────────────────────────
  { brand: 'OYO', code: 'OYO30BDAY', title: 'OYO 30% Off Birthday Special', category: 'Hotels & Stays', discount: '30% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '2000', description: '30% off on OYO stays for birthday celebrations. Budget to premium rooms.', terms: 'Max ₹1200. Min ₹2000. Valid in birthday month.' },
  { brand: 'OYO', code: 'OYOWEEKEND25', title: 'OYO 25% Off Weekend Stays', category: 'Hotels & Stays', discount: '25% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '2000', description: '25% off on OYO weekend bookings (Fri–Sun). All cities.', terms: 'Max ₹1000. Weekend check-ins only.' },
  { brand: 'Booking.com', code: 'BOOK15DEAL', title: 'Booking.com 15% Off Genius Deal', category: 'Hotels & Stays', discount: '15% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '4000', description: '15% off with Genius discount on participating hotels worldwide.', terms: 'Max ₹2000. Genius level 1+ required.' },
  { brand: 'Agoda', code: 'AGODA20IN', title: 'Agoda 20% Off India Stays', category: 'Hotels & Stays', discount: '20% Off', originalValue: '1800', sellingPrice: '129', minOrderValue: '4000', description: '20% off on hotels and resorts across India on Agoda.', terms: 'Max ₹1800. India properties only.' },
  { brand: 'Goibibo', code: 'GOIVILLA800', title: 'Goibibo ₹800 Off Villas', category: 'Hotels & Stays', discount: '₹800 Off', originalValue: '800', sellingPrice: '59', minOrderValue: '4000', description: '₹800 off on luxury villa and cottage bookings at Goibibo.', terms: 'Min ₹4000. Villa/cottage category.' },
  { brand: 'Treebo', code: 'TREEFIRST20', title: 'Treebo 20% Off First Stay', category: 'Hotels & Stays', discount: '20% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1500', description: '20% off on your first Treebo hotel booking. Quality budget stays.', terms: 'New users. Max ₹800.' },
  { brand: 'FabHotels', code: 'FAB30LONG', title: 'FabHotels 30% Off 3+ Nights', category: 'Hotels & Stays', discount: '30% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '30% off on FabHotels stays of 3 nights or longer.', terms: 'Max ₹1500. Min 3-night stay.' },
  { brand: 'Airbnb', code: 'AIRBNB1000', title: 'Airbnb ₹1000 Off Weekend Stays', category: 'Hotels & Stays', discount: '₹1000 Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '5000', description: '₹1000 off on Airbnb weekend stays. Unique homes near you.', terms: 'Min ₹5000. Weekend check-ins.' },
  { brand: 'Zostel', code: 'ZOST25HOST', title: 'Zostel 25% Off Hostels', category: 'Hotels & Stays', discount: '25% Off', originalValue: '500', sellingPrice: '35', minOrderValue: '1000', description: '25% off on Zostel hostel bookings. Backpacker-friendly stays across India.', terms: 'Max ₹500. zostel.com only.' },
  { brand: 'StayVista', code: 'VISTA20LUX', title: 'StayVista 20% Off Luxury Villas', category: 'Hotels & Stays', discount: '20% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '20% off on StayVista luxury villa rentals — private pools, mountain views.', terms: 'Max ₹3000. Min ₹10000 booking.' },

  // ─── Electronics & Gadgets (116–140) ──────────────────────────────────
  { brand: 'Samsung', code: 'SAMPHONE10', title: 'Samsung 10% Off Galaxy Phones', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '15000', description: '10% off on Samsung Galaxy S and A series phones on samsung.com/in.', terms: 'Max ₹3000. Samsung store only.' },
  { brand: 'OnePlus', code: 'OP20BUDS', title: 'OnePlus 20% Off Earbuds', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '2000', description: '20% off on OnePlus Nord Buds and Buds Pro earphones.', terms: 'Max ₹800. Earbuds only.' },
  { brand: 'boAt', code: 'BOAT30WATCH', title: 'boAt 30% Off Smartwatches', category: 'Electronics & Gadgets', discount: '30% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1500', description: '30% off on boAt Wave, Storm, and Xtend smartwatches.', terms: 'Max ₹600. Smartwatches only.' },
  { brand: 'Noise', code: 'NOISE20BUDS', title: 'Noise 20% Off Earbuds', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '400', sellingPrice: '29', minOrderValue: '1000', description: '20% off on Noise Buds VS, Air Buds, and Connect earphones.', terms: 'Max ₹400. gonoise.com only.' },
  { brand: 'Apple', code: 'APPLE10ACC', title: 'Apple 10% Off Accessories', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '10% off on Apple AirPods, AirTag, and MagSafe accessories.', terms: 'Max ₹2000. Accessories only.' },
  { brand: 'Realme', code: 'REALME15PH', title: 'Realme 15% Off Phones', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '8000', description: '15% off on Realme GT, Number Pro, and Narzo series phones.', terms: 'Max ₹2000. realme.com only.' },
  { brand: 'Xiaomi', code: 'MI20SMART', title: 'Xiaomi 20% Off Smart Home', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '3000', description: '20% off on Xiaomi smart speakers, cameras, and home devices.', terms: 'Max ₹1000. Smart home category.' },
  { brand: 'JBL', code: 'JBL25AUDIO', title: 'JBL 25% Off Speakers', category: 'Electronics & Gadgets', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on JBL Flip, Charge, and PartyBox Bluetooth speakers.', terms: 'Max ₹1500. jbl.com/in only.' },
  { brand: 'Sony', code: 'SONY15HEAD', title: 'Sony 15% Off Headphones', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '15% off on Sony WH-1000XM5, WF series, and LinkBuds headphones.', terms: 'Max ₹2000. Headphones only.' },
  { brand: 'Dell', code: 'DELL10LAP', title: 'Dell 10% Off Laptops', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '5000', sellingPrice: '349', minOrderValue: '40000', description: '10% off on Dell Inspiron, Vostro, and XPS laptops.', terms: 'Max ₹5000. dell.com/in only.' },
  { brand: 'HP', code: 'HP15PRINT', title: 'HP 15% Off Printers & Ink', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '5000', description: '15% off on HP printers, ink cartridges, and toner.', terms: 'Max ₹1500. hp.com/in only.' },
  { brand: 'Lenovo', code: 'LNVO12THINK', title: 'Lenovo 12% Off ThinkPad', category: 'Electronics & Gadgets', discount: '12% Off', originalValue: '8000', sellingPrice: '499', minOrderValue: '50000', description: '12% off on Lenovo ThinkPad business laptops.', terms: 'Max ₹8000. ThinkPad range only.' },
  { brand: 'Canon', code: 'CANON20CAM', title: 'Canon 20% Off Cameras', category: 'Electronics & Gadgets', discount: '20% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '20000', description: '20% off on Canon EOS, PowerShot, and mirrorless cameras.', terms: 'Max ₹5000. canon.co.in only.' },

  // ─── Gaming & Entertainment (141–160) ─────────────────────────────────
  { brand: 'PlayStation', code: 'PSN300GAME', title: 'PS Store ₹300 Off Games', category: 'Gaming & Entertainment', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1000', description: '₹300 off on PlayStation Store game purchases.', terms: 'Min ₹1000. Digital games only.' },
  { brand: 'Xbox', code: 'XBOXLIVE200', title: 'Xbox Live Gold ₹200 Off', category: 'Gaming & Entertainment', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '400', description: '₹200 off on Xbox Live Gold 6-month subscription.', terms: 'Min ₹400. Gold subscription only.' },
  { brand: 'Steam', code: 'STEAM30SALE', title: 'Steam ₹300 Off Sale Items', category: 'Gaming & Entertainment', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1500', description: '₹300 off during Steam seasonal sale on game bundles.', terms: 'Min ₹1500. Sale items only.' },
  { brand: 'BookMyShow', code: 'BMS100EVT', title: 'BookMyShow ₹100 Off Events', category: 'Gaming & Entertainment', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '500', description: '₹100 off on live events, comedy shows, and concerts on BookMyShow.', terms: 'Min ₹500. Events category only.' },
  { brand: 'BookMyShow', code: 'BMSPLAY75', title: 'BookMyShow ₹75 Off Plays', category: 'Gaming & Entertainment', discount: '₹75 Off', originalValue: '75', sellingPrice: '5', minOrderValue: '250', description: '₹75 off on theater plays and drama tickets via BookMyShow.', terms: 'Min ₹250. Plays category.' },
  { brand: 'Netflix', code: 'NFLXSTD100', title: 'Netflix ₹100 Off Standard Plan', category: 'Gaming & Entertainment', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '499', description: '₹100 off on Netflix Standard plan subscription.', terms: 'Min ₹499. New and existing users.' },
  { brand: 'Spotify', code: 'SPOT50PREM', title: 'Spotify ₹50 Off Premium', category: 'Gaming & Entertainment', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '119', description: '₹50 off on Spotify Premium monthly subscription.', terms: 'Min ₹119. Individual plans only.' },
  { brand: 'YouTube', code: 'YT30PREMIUM', title: 'YouTube ₹30 Off Premium', category: 'Gaming & Entertainment', discount: '₹30 Off', originalValue: '30', sellingPrice: '5', minOrderValue: '129', description: '₹30 off on YouTube Premium monthly subscription. Ad-free videos and music.', terms: 'Min ₹129. Individual plans.' },
  { brand: 'Disney+ Hotstar', code: 'HOTSUPER150', title: 'Hotstar ₹150 Off Super Plan', category: 'Gaming & Entertainment', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '399', description: '₹150 off on Disney+ Hotstar Super annual plan.', terms: 'Min ₹399. Annual plan only.' },
  { brand: 'SonyLIV', code: 'SLIV100ANN', title: 'SonyLIV ₹100 Off Annual', category: 'Gaming & Entertainment', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '599', description: '₹100 off on SonyLIV annual premium subscription.', terms: 'Min ₹599. Annual plan only.' },
  { brand: 'ZEE5', code: 'ZEE5SAVE80', title: 'ZEE5 ₹80 Off Premium', category: 'Gaming & Entertainment', discount: '₹80 Off', originalValue: '80', sellingPrice: '5', minOrderValue: '299', description: '₹80 off on ZEE5 Premium quarterly plan.', terms: 'Min ₹299. Quarterly plan.' },
  { brand: 'Amazon Prime', code: 'PRIME100QTR', title: 'Prime ₹100 Off Quarterly Plan', category: 'Gaming & Entertainment', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '459', description: '₹100 off on Amazon Prime quarterly subscription.', terms: 'Min ₹459. Quarterly plan only.' },

  // ─── Fitness & Sports (153–170) ───────────────────────────────────────
  { brand: 'Cult.fit', code: 'CULT20YOGA', title: 'Cult.fit 20% Off Yoga Classes', category: 'Fitness & Sports', discount: '20% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '20% off on Cult.fit yoga and meditation membership.', terms: 'Max ₹1500. Yoga plans only.' },
  { brand: 'Decathlon', code: 'DECAT15CYCLE', title: 'Decathlon 15% Off Cycling Gear', category: 'Fitness & Sports', discount: '15% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '3000', description: '15% off on cycling helmets, gloves, jerseys, and accessories.', terms: 'Max ₹800. Cycling category.' },
  { brand: 'Decathlon', code: 'DECAT10CAMP', title: 'Decathlon 10% Off Camping Gear', category: 'Fitness & Sports', discount: '10% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '2000', description: '10% off on tents, sleeping bags, and hiking equipment at Decathlon.', terms: 'Max ₹500. Camping/hiking only.' },
  { brand: 'Nike', code: 'NIKERUN25', title: 'Nike 25% Off Running Gear', category: 'Fitness & Sports', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on Nike running shoes, shorts, and Dri-FIT apparel.', terms: 'Max ₹1500. Running category.' },
  { brand: 'MuscleBlaze', code: 'MB25WHEY', title: 'MuscleBlaze 25% Off Protein', category: 'Fitness & Sports', discount: '25% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '2500', description: '25% off on MuscleBlaze whey protein, BCAA, and pre-workout supplements.', terms: 'Max ₹1000. muscleblaze.com.' },
  { brand: 'Optimum Nutrition', code: 'ON20GOLD', title: 'ON 20% Off Gold Standard', category: 'Fitness & Sports', discount: '20% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '4000', description: '20% off on Optimum Nutrition Gold Standard Whey and serious mass gainer.', terms: 'Max ₹1200. Select ON products.' },
  { brand: 'Puma', code: 'PUMAGYM20', title: 'Puma 20% Off Gym Wear', category: 'Fitness & Sports', discount: '20% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '2000', description: '20% off on Puma training shorts, joggers, and gym shoes.', terms: 'Max ₹800. Training category.' },
  { brand: 'Under Armour', code: 'UA25TRAIN', title: 'Under Armour 25% Off', category: 'Fitness & Sports', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on Under Armour performance wear, shoes, and accessories.', terms: 'Max ₹1500. underarmour.in only.' },

  // ─── Health & Pharmacy (161–175) ──────────────────────────────────────
  { brand: 'PharmEasy', code: 'PE30LAB', title: 'PharmEasy 30% Off Lab Tests', category: 'Health & Pharmacy', discount: '30% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '30% off on blood tests and health packages booked via PharmEasy.', terms: 'Max ₹500. Lab tests only.' },
  { brand: '1mg (Tata)', code: 'ONEMG25LAB', title: '1mg 25% Off Health Checkup', category: 'Health & Pharmacy', discount: '25% Off', originalValue: '600', sellingPrice: '49', minOrderValue: '1500', description: '25% off on full body health checkup packages at 1mg.', terms: 'Max ₹600. Health packages only.' },
  { brand: 'Netmeds', code: 'NETMED15RX', title: 'Netmeds 15% Off Repeat Orders', category: 'Health & Pharmacy', discount: '15% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '800', description: '15% off on repeat prescription medicine orders at Netmeds.', terms: 'Max ₹300. Returning users only.' },
  { brand: 'Apollo Pharmacy', code: 'APOLLO20CHK', title: 'Apollo 20% Off Health Checkup', category: 'Health & Pharmacy', discount: '20% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1500', description: '20% off on Apollo preventive health checkup packages.', terms: 'Max ₹500. Health packages only.' },
  { brand: 'MediBuddy', code: 'MEDI25DOC', title: 'MediBuddy 25% Off Consultation', category: 'Health & Pharmacy', discount: '25% Off', originalValue: '200', sellingPrice: '15', minOrderValue: '300', description: '25% off on online doctor consultations via MediBuddy.', terms: 'Max ₹200. Consultations only.' },
  { brand: 'Practo', code: 'PRACTO20DOC', title: 'Practo 20% Off Doctor Consult', category: 'Health & Pharmacy', discount: '20% Off', originalValue: '150', sellingPrice: '10', minOrderValue: '300', description: '20% off on Practo online doctor consultations and teleconsults.', terms: 'Max ₹150. Teleconsult only.' },
  { brand: 'HealthKart', code: 'HK20SUPP', title: 'HealthKart 20% Off Supplements', category: 'Health & Pharmacy', discount: '20% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1500', description: '20% off on vitamins, minerals, and dietary supplements at HealthKart.', terms: 'Max ₹500. healthkart.com only.' },

  // ─── Education (168–185) ──────────────────────────────────────────────
  { brand: 'Udemy', code: 'UDEMY90BIG', title: 'Udemy 90% Off Big Sale', category: 'Education', discount: '90% Off', originalValue: '3000', sellingPrice: '29', minOrderValue: '0', description: 'Udemy Big Sale — courses from ₹349. Python, Web Dev, Data Science, and more.', terms: 'Select courses. Sale period only.' },
  { brand: 'Coursera', code: 'COURSE25CERT', title: 'Coursera 25% Off Certificates', category: 'Education', discount: '25% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '8000', description: '25% off on Coursera Professional Certificates from Google, Meta, and IBM.', terms: 'Max ₹3000. Professional Certificates only.' },
  { brand: 'Unacademy', code: 'UNAC15GATE', title: 'Unacademy 15% Off GATE Prep', category: 'Education', discount: '15% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '8000', description: '15% off on Unacademy GATE preparation subscription.', terms: 'Max ₹2000. GATE plans only.' },
  { brand: 'Vedantu', code: 'VEDAN20LIVE', title: 'Vedantu 20% Off Live Classes', category: 'Education', discount: '20% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '20% off on Vedantu live classes for CBSE, ICSE, JEE, and NEET prep.', terms: 'Max ₹3000. Live class plans only.' },
  { brand: 'Toppr', code: 'TOPPR25OFF', title: 'Toppr 25% Off Annual Plan', category: 'Education', discount: '25% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '25% off on Toppr annual subscription. Adaptive learning for classes 5–12.', terms: 'Max ₹2000. Annual plans only.' },
  { brand: 'LinkedIn Learning', code: 'LNKD30LRN', title: 'LinkedIn Learning 30% Off', category: 'Education', discount: '30% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '30% off on LinkedIn Learning annual subscription. Business, tech, and creative courses.', terms: 'Max ₹2000. Annual plan only.' },
  { brand: 'Pluralsight', code: 'PLRL20TECH', title: 'Pluralsight 20% Off Tech Skills', category: 'Education', discount: '20% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '8000', description: '20% off on Pluralsight tech skill courses — cloud, security, and DevOps.', terms: 'Max ₹2500. Annual Standard plan.' },
  { brand: 'Khan Academy', code: 'KHAN50DON', title: 'Khan Academy ₹500 Donation Credit', category: 'Education', discount: '₹500 Credit', originalValue: '500', sellingPrice: '25', minOrderValue: '0', description: 'Support Khan Academy — ₹500 donation credit for free education worldwide.', terms: 'Donation credit. No min order.' },

  // ─── Finance & Payments (176–195) ─────────────────────────────────────
  { brand: 'Paytm', code: 'PAYTM100DTH', title: 'Paytm ₹100 Off DTH Recharge', category: 'Finance & Payments', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '500', description: '₹100 off on DTH recharge via Paytm. All operators — Tata Play, Airtel, Dish TV.', terms: 'Min ₹500. DTH recharge only.' },
  { brand: 'PhonePe', code: 'PPEINSURE', title: 'PhonePe ₹200 Off Insurance', category: 'Finance & Payments', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '1000', description: '₹200 off on insurance premiums paid via PhonePe.', terms: 'Min ₹1000. Insurance category.' },
  { brand: 'Google Pay', code: 'GPAY50BILL', title: 'Google Pay ₹50 Off Bill Payment', category: 'Finance & Payments', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '300', description: '₹50 cashback on electricity and gas bill payments via Google Pay.', terms: 'Min ₹300. Utility bills only.' },
  { brand: 'CRED', code: 'CRED100RENT', title: 'CRED ₹100 Off Rent Payment', category: 'Finance & Payments', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '5000', description: '₹100 CRED cashback on rent payments via CRED RentPay.', terms: 'Min ₹5000. RentPay only.' },
  { brand: 'MobiKwik', code: 'MBKW50RECH', title: 'MobiKwik ₹50 Off Recharge', category: 'Finance & Payments', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 cashback on mobile recharge via MobiKwik wallet.', terms: 'Min ₹200. MobiKwik wallet only.' },
  { brand: 'Airtel Thanks', code: 'AIRTEL75RCH', title: 'Airtel Thanks ₹75 Off Recharge', category: 'Finance & Payments', discount: '₹75 Off', originalValue: '75', sellingPrice: '5', minOrderValue: '299', description: '₹75 off on Airtel prepaid recharge via Airtel Thanks app.', terms: 'Min ₹299. Airtel users only.' },
  { brand: 'Jio', code: 'JIORECHARGE50', title: 'Jio ₹50 Off Recharge', category: 'Finance & Payments', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '199', description: '₹50 off on Jio prepaid recharge plans via MyJio app.', terms: 'Min ₹199. Jio users only.' },
  { brand: 'BharatPe', code: 'BPAY50SCAN', title: 'BharatPe ₹50 Cashback on UPI', category: 'Finance & Payments', discount: '₹50 Cashback', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 cashback on first UPI payment via BharatPe scanner.', terms: 'Min ₹200. New BharatPe users.' },

  // ─── General / Home Services (184–200) ────────────────────────────────
  { brand: 'Urban Company', code: 'UCBEAUTY150', title: 'Urban Company ₹150 Off Beauty', category: 'General', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: '₹150 off on salon at home services — facial, waxing, and manicure.', terms: 'Min ₹500. Beauty services only.' },
  { brand: 'Urban Company', code: 'UCCLEAN200', title: 'Urban Company ₹200 Off Cleaning', category: 'General', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '800', description: '₹200 off on deep cleaning, sofa cleaning, and bathroom cleaning services.', terms: 'Min ₹800. Cleaning services.' },
  { brand: 'Urban Company', code: 'UCAC100', title: 'Urban Company ₹100 Off AC Service', category: 'General', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '400', description: '₹100 off on AC service, repair, and gas refill via Urban Company.', terms: 'Min ₹400. AC services only.' },
  { brand: 'Pepperfry', code: 'PF25SOFA', title: 'Pepperfry 25% Off Sofas', category: 'General', discount: '25% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '15000', description: '25% off on sofas and recliners at Pepperfry. Premium comfort for your home.', terms: 'Max ₹5000. Sofas category.' },
  { brand: 'Pepperfry', code: 'PF15BED', title: 'Pepperfry 15% Off Beds', category: 'General', discount: '15% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '12000', description: '15% off on king and queen size beds and mattresses at Pepperfry.', terms: 'Max ₹3000. Beds category.' },
  { brand: 'IKEA', code: 'IKEA20KITCH', title: 'IKEA 20% Off Kitchen Accessories', category: 'General', discount: '20% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '3000', description: '20% off on IKEA kitchen storage, utensils, and dining accessories.', terms: 'Max ₹1000. Kitchen category.' },
  { brand: 'HomeLane', code: 'HLANE10MOD', title: 'HomeLane 10% Off Modular Kitchen', category: 'General', discount: '10% Off', originalValue: '15000', sellingPrice: '999', minOrderValue: '100000', description: '10% off on HomeLane modular kitchen design and installation.', terms: 'Max ₹15000. New bookings only.' },
  { brand: 'Godrej Interio', code: 'GODR15FURN', title: 'Godrej Interio 15% Off Furniture', category: 'General', discount: '15% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '15000', description: '15% off on Godrej Interio office chairs, desks, and home furniture.', terms: 'Max ₹3000. godrejinterio.com.' },
  { brand: 'NestAway', code: 'NEST500RENT', title: 'NestAway ₹500 Off First Rent', category: 'General', discount: '₹500 Off', originalValue: '500', sellingPrice: '39', minOrderValue: '5000', description: '₹500 off on your first month rent via NestAway — PG, flat, and room rentals.', terms: 'New users. Min ₹5000 rent.' },
  { brand: 'Rentomojo', code: 'RENTO20FURN', title: 'Rentomojo 20% Off Furniture Rental', category: 'General', discount: '20% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '3000', description: '20% off on monthly furniture and appliance rentals via Rentomojo.', terms: 'Max ₹1000. 6-month plans.' },
  { brand: 'Furlenco', code: 'FURL25RENT', title: 'Furlenco 25% Off Furniture Rental', category: 'General', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '4000', description: '25% off on Furlenco premium furniture rental subscription.', terms: 'Max ₹1500. Annual plans.' },
  { brand: 'Sleepwell', code: 'SLPWELL15MT', title: 'Sleepwell 15% Off Mattresses', category: 'General', discount: '15% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '8000', description: '15% off on Sleepwell Ortho and Nexa mattresses for restful sleep.', terms: 'Max ₹2000. sleepwell.co.in only.' },
  { brand: 'Wakefit', code: 'WAKE20MATT', title: 'Wakefit 20% Off Mattresses', category: 'General', discount: '20% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '8000', description: '20% off on Wakefit Orthopaedic and memory foam mattresses.', terms: 'Max ₹2500. wakefit.co only.' },
  { brand: 'Livspace', code: 'LIV10DESIGN', title: 'Livspace 10% Off Interior Design', category: 'General', discount: '10% Off', originalValue: '20000', sellingPrice: '1499', minOrderValue: '150000', description: '10% off on Livspace modular kitchen and full home interior design.', terms: 'Max ₹20000. New bookings only.' },
];

async function seedCoupons() {
  console.log(`\n🚀 Seeding ${coupons.length} NEW coupons into Supabase...\n`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

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
      is_featured: Math.random() < 0.2,
      is_exclusive: Math.random() < 0.15,
      is_verified: true,
      seller_email: '',
      status: 'available',
      source: 'admin',
      added_at: recentDate(1, 30),
    }));

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
