// ============================================
// SaveHatke — Seed Brand-Focused Coupons into Supabase
// ============================================
// Usage: node server/seed_coupons_brands.js
// Requires .env at the project root with SUPABASE_URL and SUPABASE_SERVICE_KEY
//
// Adds ~120 NEW coupons across all requested brands:
// Amazon, Flipkart, Zepto, Pizza Hut, BBQ Nation, MakeMyTrip,
// Puma, Adidas, Nike, Meesho, Myntra, AJIO, Swiggy, Zomato,
// Nykaa, Blinkit, and more.
//
// All codes are unique and do not duplicate seed_coupons.js,
// seed_coupons_200.js, or seed_extra.js.

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

// Helper: random future date between minDays–maxDays from now
function futureDate(minDays = 30, maxDays = 180) {
  const ms = Date.now() + (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString().split('T')[0];
}

// Helper: recent past date 1–30 days ago
function recentDate(minDays = 1, maxDays = 30) {
  const ms = Date.now() - (minDays + Math.random() * (maxDays - minDays)) * 86400000;
  return new Date(ms).toISOString();
}

// ── 120 Brand-Focused Coupons (all unique codes) ────────────────────────
const coupons = [

  // ═══════════════════════════════════════════════════════════════════════
  // AMAZON (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Amazon', code: 'AMZMONSOON25', title: 'Amazon Monsoon Sale 25% Off', category: 'E-Commerce', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on fashion, home essentials, and rainy-day gear during Amazon Monsoon Sale.', terms: 'Max ₹1500 off. Min order ₹3000. All categories. One per account.' },
  { brand: 'Amazon', code: 'AMZECHO350', title: 'Amazon ₹350 Off Echo Devices', category: 'E-Commerce', discount: '₹350 Off', originalValue: '350', sellingPrice: '29', minOrderValue: '2000', description: 'Flat ₹350 off on Echo Dot, Echo Show, and Fire TV Stick.', terms: 'Min ₹2000. Amazon devices only. While stocks last.' },
  { brand: 'Amazon', code: 'AMZBEAUTY20', title: 'Amazon Beauty 20% Off', category: 'E-Commerce', discount: '20% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1500', description: '20% off on luxury beauty, skincare, and grooming products on Amazon.', terms: 'Max ₹600. Premium beauty category. Select brands.' },
  { brand: 'Amazon', code: 'AMZSPORTFIT', title: 'Amazon Sports ₹800 Off', category: 'E-Commerce', discount: '₹800 Off', originalValue: '800', sellingPrice: '59', minOrderValue: '3000', description: 'Flat ₹800 off on sports equipment, gym gear, and fitness trackers on Amazon.', terms: 'Min ₹3000. Sports & Fitness category only.' },
  { brand: 'Amazon', code: 'AMZBABY300', title: 'Amazon Baby Products ₹300 Off', category: 'E-Commerce', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1200', description: '₹300 off on diapers, baby food, toys, and nursery essentials on Amazon.', terms: 'Min ₹1200. Baby category only. All brands.' },

  // ═══════════════════════════════════════════════════════════════════════
  // FLIPKART (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Flipkart', code: 'FKMOBILE500', title: 'Flipkart ₹500 Off Mobiles', category: 'E-Commerce', discount: '₹500 Off', originalValue: '500', sellingPrice: '45', minOrderValue: '8000', description: 'Flat ₹500 off on Samsung, Realme, Xiaomi, and Nothing phones on Flipkart.', terms: 'Min ₹8000. Select smartphones. Flipkart Assured.' },
  { brand: 'Flipkart', code: 'FKLAPDEALS', title: 'Flipkart 12% Off Laptops', category: 'E-Commerce', discount: '12% Off', originalValue: '4000', sellingPrice: '249', minOrderValue: '25000', description: '12% off on laptops — HP, Lenovo, ASUS, and Acer during Flipkart Laptop Days.', terms: 'Max ₹4000. Min ₹25000. Excludes Apple MacBooks.' },
  { brand: 'Flipkart', code: 'FKFURNI20', title: 'Flipkart 20% Off Furniture', category: 'E-Commerce', discount: '20% Off', originalValue: '2500', sellingPrice: '149', minOrderValue: '8000', description: '20% off on beds, sofas, wardrobes, and dining sets on Flipkart Furniture.', terms: 'Max ₹2500. Furniture category. Assembly included on select.' },
  { brand: 'Flipkart', code: 'FKKIDSALE', title: 'Flipkart Kids Fashion 40% Off', category: 'E-Commerce', discount: '40% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1200', description: '40% off on kids clothing, shoes, and accessories during Flipkart Kids Sale.', terms: 'Max ₹800. Kids fashion only. Ages 2-14.' },
  { brand: 'Flipkart', code: 'FKTVDEAL15', title: 'Flipkart 15% Off Smart TVs', category: 'E-Commerce', discount: '15% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '20000', description: '15% off on 43" and above Smart TVs — Samsung, LG, Sony, OnePlus, and Mi.', terms: 'Max ₹5000. Min ₹20000. Smart TVs only.' },

  // ═══════════════════════════════════════════════════════════════════════
  // MEESHO (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Meesho', code: 'MEEKURTI30', title: 'Meesho 30% Off Kurtis & Sarees', category: 'E-Commerce', discount: '30% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '500', description: '30% off on ethnic wear — kurtis, sarees, and salwar suits at unbeatable Meesho prices.', terms: 'Max ₹300. Ethnic wear category. All sellers.' },
  { brand: 'Meesho', code: 'MEEHOME200', title: 'Meesho ₹200 Off Home Décor', category: 'E-Commerce', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '600', description: 'Flat ₹200 off on bedsheets, curtains, cushion covers, and home décor items.', terms: 'Min ₹600. Home & Kitchen category.' },
  { brand: 'Meesho', code: 'MEEFASH50', title: 'Meesho ₹50 Off Fashion', category: 'E-Commerce', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '249', description: '₹50 off on all fashion orders on Meesho. Trendy styles at budget-friendly prices.', terms: 'Min ₹249. All fashion categories.' },
  { brand: 'Meesho', code: 'MEESUPER15', title: 'Meesho Super Sale 15% Off', category: 'E-Commerce', discount: '15% Off', originalValue: '200', sellingPrice: '15', minOrderValue: '499', description: 'Mega sale — 15% off on everything during Meesho Super Sale week.', terms: 'Max ₹200. All categories. Limited period.' },

  // ═══════════════════════════════════════════════════════════════════════
  // ZEPTO (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Zepto', code: 'ZEPTO75ALL', title: 'Zepto ₹75 Off Groceries', category: 'Food & Delivery', discount: '₹75 Off', originalValue: '75', sellingPrice: '10', minOrderValue: '249', description: '₹75 off on your Zepto grocery order. Fruits, veggies, snacks, and dairy in 10 minutes.', terms: 'Min ₹249. All users. Select cities.' },
  { brand: 'Zepto', code: 'ZEPTOCAFE50', title: 'Zepto Café ₹50 Off', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '149', description: '₹50 off on Zepto Café — coffee, chai, smoothies, and fresh juices delivered in minutes.', terms: 'Min ₹149. Zepto Café items only.' },
  { brand: 'Zepto', code: 'ZEPTOPASS30', title: 'Zepto Pass ₹30 Off Per Order', category: 'Food & Delivery', discount: '₹30 Off', originalValue: '30', sellingPrice: '5', minOrderValue: '99', description: '₹30 off every order with Zepto Pass. Unlimited free deliveries and exclusive deals.', terms: 'Pass subscribers only. Min ₹99 per order.' },
  { brand: 'Zepto', code: 'ZEPTOSNACK', title: 'Zepto 20% Off Snacks & Beverages', category: 'Food & Delivery', discount: '20% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '199', description: '20% off on packaged snacks, chips, cold drinks, and energy drinks on Zepto.', terms: 'Max ₹100. Snacks & beverages category.' },
  { brand: 'Zepto', code: 'ZEPTOFRESH', title: 'Zepto ₹100 Off Fresh Produce', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '399', description: '₹100 off on fresh fruits, vegetables, and organic produce. Farm-to-door in 10 min.', terms: 'Min ₹399. Fresh produce only. Select cities.' },

  // ═══════════════════════════════════════════════════════════════════════
  // MYNTRA (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Myntra', code: 'MYNINSIDER', title: 'Myntra Insider 35% Off', category: 'Fashion', discount: '35% Off', originalValue: '1800', sellingPrice: '129', minOrderValue: '2500', description: 'Myntra Insider members get 35% off on premium brands — Tommy Hilfiger, Levis, U.S. Polo.', terms: 'Max ₹1800. Insider members only. Select brands.' },
  { brand: 'Myntra', code: 'MYNSHOE500', title: 'Myntra ₹500 Off Footwear', category: 'Fashion', discount: '₹500 Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1500', description: 'Flat ₹500 off on shoes — Nike, Puma, Adidas, Crocs, and Bata on Myntra.', terms: 'Min ₹1500. Footwear category only.' },
  { brand: 'Myntra', code: 'MYNKIDS30', title: 'Myntra 30% Off Kids Clothing', category: 'Fashion', discount: '30% Off', originalValue: '700', sellingPrice: '49', minOrderValue: '1200', description: '30% off on kids fashion — t-shirts, dresses, and party wear from top brands.', terms: 'Max ₹700. Kids fashion 2-16 yrs.' },
  { brand: 'Myntra', code: 'MYNWINTER40', title: 'Myntra Winter Wear 40% Off', category: 'Fashion', discount: '40% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '3000', description: '40% off on jackets, sweaters, hoodies, and thermals — get winter-ready with Myntra.', terms: 'Max ₹2000. Winterwear category. Min ₹3000.' },
  { brand: 'Myntra', code: 'MYNBEAUTY25', title: 'Myntra Beauty 25% Off', category: 'Fashion', discount: '25% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1000', description: '25% off on beauty and grooming — perfumes, skincare, and hair care on Myntra.', terms: 'Max ₹600. Beauty & Personal Care category.' },

  // ═══════════════════════════════════════════════════════════════════════
  // AJIO (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'AJIO', code: 'AJIOMAX60', title: 'AJIO 60% Off Fashion Frenzy', category: 'Fashion', discount: '60% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '2000', description: 'AJIO Fashion Frenzy — 60% off on men and women trending fashion, shoes, and bags.', terms: 'Max ₹2000. Min ₹2000. Select styles.' },
  { brand: 'AJIO', code: 'AJIOSPORT35', title: 'AJIO 35% Off Sportswear', category: 'Fashion', discount: '35% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '1500', description: '35% off on sportswear — Nike, Adidas, Puma, and Reebok on AJIO.', terms: 'Max ₹1000. Sports & activewear only.' },
  { brand: 'AJIO', code: 'AJIOETHNIC', title: 'AJIO 40% Off Ethnic Fusion', category: 'Fashion', discount: '40% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '1500', description: '40% off on Indo-Western, kurtas, and ethnic wear for men and women on AJIO.', terms: 'Max ₹1200. Ethnic & fusion category.' },
  { brand: 'AJIO', code: 'AJIOACCESS', title: 'AJIO 25% Off Accessories', category: 'Fashion', discount: '25% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '1000', description: '25% off on watches, sunglasses, wallets, and belts from premium brands on AJIO.', terms: 'Max ₹500. Accessories category.' },

  // ═══════════════════════════════════════════════════════════════════════
  // PUMA (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Puma', code: 'PUMASNEAKER', title: 'Puma 30% Off Sneakers', category: 'Fashion', discount: '30% Off', originalValue: '1200', sellingPrice: '89', minOrderValue: '2500', description: '30% off on Puma sneakers — RS-X, Suede, Cali, and Future Rider collections.', terms: 'Max ₹1200. Sneakers category. puma.com/in.' },
  { brand: 'Puma', code: 'PUMAGYM25', title: 'Puma 25% Off Gym & Training', category: 'Fashion', discount: '25% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '2000', description: '25% off on Puma gym wear — training tees, shorts, track pants, and sports bras.', terms: 'Max ₹800. Training collection only.' },
  { brand: 'Puma', code: 'PUMAKID20', title: 'Puma 20% Off Kids Collection', category: 'Fashion', discount: '20% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '1500', description: '20% off on Puma kids shoes, backpacks, and sportswear.', terms: 'Max ₹600. Kids category only. puma.com/in.' },
  { brand: 'Puma', code: 'PUMAMOTORSP', title: 'Puma Motorsport 40% Off', category: 'Fashion', discount: '40% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '2000', description: '40% off on Puma x BMW, Ferrari, and Mercedes motorsport collection.', terms: 'Max ₹1500. Motorsport line only.' },

  // ═══════════════════════════════════════════════════════════════════════
  // ADIDAS (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Adidas', code: 'ADIBOOST25', title: 'Adidas 25% Off Ultraboost', category: 'Fashion', discount: '25% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '8000', description: '25% off on Adidas Ultraboost — the ultimate running shoe for everyday performance.', terms: 'Max ₹2500. Ultraboost range only. adidas.co.in.' },
  { brand: 'Adidas', code: 'ADIPERFORM', title: 'Adidas 35% Off Performance Wear', category: 'Fashion', discount: '35% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '35% off on Adidas performance jerseys, track suits, and Aeroready gear.', terms: 'Max ₹1500. Performance category.' },
  { brand: 'Adidas', code: 'ADIORIGINAL', title: 'Adidas Originals 20% Off', category: 'Fashion', discount: '20% Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '5000', description: '20% off on Adidas Originals — Superstar, Stan Smith, Gazelle, and Forum shoes.', terms: 'Max ₹2000. Originals line only.' },
  { brand: 'Adidas', code: 'ADIKIDS30', title: 'Adidas 30% Off Kids Range', category: 'Fashion', discount: '30% Off', originalValue: '900', sellingPrice: '69', minOrderValue: '2000', description: '30% off on Adidas kids shoes, clothing, and school bags.', terms: 'Max ₹900. Kids category. adidas.co.in.' },

  // ═══════════════════════════════════════════════════════════════════════
  // NIKE (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Nike', code: 'NIKERUN30', title: 'Nike 30% Off Running Collection', category: 'Fashion', discount: '30% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '5000', description: '30% off on Nike Pegasus, Vomero, and InfinityRun shoes plus running apparel.', terms: 'Max ₹2500. Running category. nike.com/in.' },
  { brand: 'Nike', code: 'NIKEJORDAN', title: 'Nike Jordan 15% Off', category: 'Fashion', discount: '15% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '15% off on Air Jordan sneakers, hoodies, and basketball gear.', terms: 'Max ₹3000. Jordan brand only. Online exclusive.' },
  { brand: 'Nike', code: 'NIKEWMNS25', title: 'Nike Women 25% Off', category: 'Fashion', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on Nike women\'s training, yoga, and athleisure — leggings, bras, and shoes.', terms: 'Max ₹1500. Women\'s category only.' },
  { brand: 'Nike', code: 'NIKESB20', title: 'Nike SB 20% Off Skate Shoes', category: 'Fashion', discount: '20% Off', originalValue: '1800', sellingPrice: '129', minOrderValue: '5000', description: '20% off on Nike SB Dunk, Blazer, and skate apparel collection.', terms: 'Max ₹1800. Nike SB line only. nike.com/in.' },

  // ═══════════════════════════════════════════════════════════════════════
  // PIZZA HUT (4 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Pizza Hut', code: 'PHUTWEEKEND', title: 'Pizza Hut Weekend Feast 25% Off', category: 'Food & Delivery', discount: '25% Off', originalValue: '250', sellingPrice: '25', minOrderValue: '500', description: '25% off on weekend orders — pan pizzas, stuffed crust, and pasta combos.', terms: 'Max ₹250. Weekend orders only. Delivery + dine-in.' },
  { brand: 'Pizza Hut', code: 'PHUT2FOR1', title: 'Pizza Hut 2-for-1 Wednesdays', category: 'Food & Delivery', discount: 'Buy 1 Get 1', originalValue: '500', sellingPrice: '39', minOrderValue: '400', description: 'Buy 1 large pizza and get 1 absolutely free every Wednesday at Pizza Hut.', terms: 'Wednesdays only. Large pizzas. Dine-in and delivery.' },
  { brand: 'Pizza Hut', code: 'PHUTCOMBO', title: 'Pizza Hut Combo Meal ₹100 Off', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '399', description: '₹100 off on Pizza Hut combo meals — pizza + garlic bread + drink.', terms: 'Min ₹399. Combo meals only. All outlets.' },
  { brand: 'Pizza Hut', code: 'PHUTCHEESE', title: 'Pizza Hut Free Cheese Burst Upgrade', category: 'Food & Delivery', discount: 'Free Upgrade', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: 'Free cheese burst crust upgrade on any medium or large pizza at Pizza Hut.', terms: 'Min ₹500. Medium/Large pizzas. While supplies last.' },

  // ═══════════════════════════════════════════════════════════════════════
  // BBQ NATION (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'BBQ Nation', code: 'BBQ500BUFF', title: 'Barbeque Nation ₹500 Off Buffet', category: 'Food & Delivery', discount: '₹500 Off', originalValue: '500', sellingPrice: '39', minOrderValue: '2000', description: 'Flat ₹500 off on BBQ Nation unlimited buffet lunch or dinner. Live grills, unlimited starters, and desserts.', terms: 'Min bill ₹2000. Dine-in only. Valid at all outlets.' },
  { brand: 'BBQ Nation', code: 'BBQWEEKDAY', title: 'BBQ Nation 30% Off Weekday Lunch', category: 'Food & Delivery', discount: '30% Off', originalValue: '600', sellingPrice: '49', minOrderValue: '1500', description: '30% off on weekday lunch buffet at BBQ Nation. Perfect for office outings and team treats.', terms: 'Max ₹600. Mon-Thu lunch only. Min 2 guests.' },
  { brand: 'BBQ Nation', code: 'BBQBDAY', title: 'BBQ Nation Birthday Special ₹300 Off', category: 'Food & Delivery', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1000', description: '₹300 off on your birthday celebration at BBQ Nation. Includes birthday cake and celebrations.', terms: 'Min bill ₹1000. Valid on birthday week. Proof required.' },
  { brand: 'BBQ Nation', code: 'BBQFAMILY20', title: 'BBQ Nation Family Pack 20% Off', category: 'Food & Delivery', discount: '20% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '3000', description: '20% off on family buffet (4+ guests) at Barbeque Nation. Live grills and unlimited food.', terms: 'Max ₹800. Min 4 guests. All outlets.' },
  { brand: 'BBQ Nation', code: 'BBQONLINE15', title: 'BBQ Nation Online Booking ₹200 Off', category: 'Food & Delivery', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '1500', description: '₹200 off when you book your BBQ Nation table online via app or website.', terms: 'Min bill ₹1500. Online booking only. All outlets.' },

  // ═══════════════════════════════════════════════════════════════════════
  // MAKEMYTRIP (5 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'MakeMyTrip', code: 'MMTINTL2000', title: 'MakeMyTrip ₹2000 Off International', category: 'Travel & Transport', discount: '₹2000 Off', originalValue: '2000', sellingPrice: '149', minOrderValue: '15000', description: '₹2000 off on international flight bookings — Dubai, Singapore, Bangkok, and Europe.', terms: 'Min ₹15000. International flights. All airlines.' },
  { brand: 'MakeMyTrip', code: 'MMTBUS100', title: 'MakeMyTrip ₹100 Off Bus Tickets', category: 'Travel & Transport', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '400', description: '₹100 off on bus bookings via MakeMyTrip. AC Sleeper, Volvo, and luxury buses included.', terms: 'Min ₹400. All routes. One per user.' },
  { brand: 'MakeMyTrip', code: 'MMTCAB300', title: 'MakeMyTrip ₹300 Off Cab Booking', category: 'Travel & Transport', discount: '₹300 Off', originalValue: '300', sellingPrice: '29', minOrderValue: '1000', description: '₹300 off on outstation and airport cab bookings on MakeMyTrip.', terms: 'Min ₹1000. Cabs category. Select cities.' },
  { brand: 'MakeMyTrip', code: 'MMTHOLIDAY', title: 'MakeMyTrip ₹3000 Off Holiday Packages', category: 'Travel & Transport', discount: '₹3000 Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '20000', description: '₹3000 off on domestic holiday packages — Goa, Kerala, Manali, and Rajasthan.', terms: 'Min ₹20000. Holiday packages only. Min 3 nights.' },
  { brand: 'MakeMyTrip', code: 'MMTWEEKEND', title: 'MakeMyTrip Weekend Getaway 20% Off', category: 'Travel & Transport', discount: '20% Off', originalValue: '2500', sellingPrice: '169', minOrderValue: '8000', description: '20% off on weekend stay bookings — resorts, villas, and boutique hotels near your city.', terms: 'Max ₹2500. Fri-Sun stays. Min ₹8000 booking.' },

  // ═══════════════════════════════════════════════════════════════════════
  // SWIGGY (3 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Swiggy', code: 'SWIGGY200BIG', title: 'Swiggy ₹200 Off ₹500+ Orders', category: 'Food & Delivery', discount: '₹200 Off', originalValue: '200', sellingPrice: '19', minOrderValue: '500', description: 'Flat ₹200 off on Swiggy food orders above ₹500. All restaurants and cuisines.', terms: 'Min ₹500. One use per account. Select restaurants.' },
  { brand: 'Swiggy', code: 'SWIGGYPARTY', title: 'Swiggy 30% Off Party Orders', category: 'Food & Delivery', discount: '30% Off', originalValue: '400', sellingPrice: '35', minOrderValue: '1000', description: '30% off on large group orders — perfect for office parties, birthdays, and gatherings.', terms: 'Max ₹400. Min ₹1000. Party orders. Select restaurants.' },
  { brand: 'Swiggy', code: 'SWIGGYFREE', title: 'Swiggy Free Delivery + ₹50 Off', category: 'Food & Delivery', discount: '₹50 Off + Free Delivery', originalValue: '100', sellingPrice: '10', minOrderValue: '199', description: 'Free delivery plus ₹50 off on your next Swiggy order. Save on food and delivery.', terms: 'Min ₹199. Free delivery on qualifying restaurants.' },

  // ═══════════════════════════════════════════════════════════════════════
  // ZOMATO (3 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Zomato', code: 'ZOMATO50ALL', title: 'Zomato 50% Off Up to ₹100', category: 'Food & Delivery', discount: '50% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '149', description: '50% off up to ₹100 on food delivery. Quick meals from your favourite restaurants.', terms: 'Max ₹100. Min ₹149. All users. One use.' },
  { brand: 'Zomato', code: 'ZOMPREMIER', title: 'Zomato ₹150 Off Premier Restaurants', category: 'Food & Delivery', discount: '₹150 Off', originalValue: '150', sellingPrice: '15', minOrderValue: '500', description: '₹150 off on Zomato premier restaurant orders — fine dining delivered to your door.', terms: 'Min ₹500. Premier tagged restaurants only.' },
  { brand: 'Zomato', code: 'ZOMSNACK40', title: 'Zomato 40% Off Snack Time', category: 'Food & Delivery', discount: '40% Off', originalValue: '80', sellingPrice: '10', minOrderValue: '149', description: '40% off on quick snacks, street food, and light bites ordered on Zomato.', terms: 'Max ₹80. Snacks & small bites. 2 PM–6 PM only.' },

  // ═══════════════════════════════════════════════════════════════════════
  // NYKAA (3 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Nykaa', code: 'NYKAAHOT40', title: 'Nykaa Hot Pink Sale 40% Off', category: 'Beauty & Personal Care', discount: '40% Off', originalValue: '1000', sellingPrice: '79', minOrderValue: '1500', description: '40% off on bestselling makeup, skincare, and haircare during Nykaa\'s Hot Pink Sale.', terms: 'Max ₹1000. Select products. Limited period.' },
  { brand: 'Nykaa', code: 'NYKAALUXE', title: 'Nykaa Luxe 20% Off Premium Beauty', category: 'Beauty & Personal Care', discount: '20% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '20% off on luxury beauty brands — Charlotte Tilbury, Huda Beauty, and Estée Lauder.', terms: 'Max ₹1500. Luxe category only. One per user.' },
  { brand: 'Nykaa', code: 'NYKAASELF', title: 'Nykaa Self-Care ₹250 Off', category: 'Beauty & Personal Care', discount: '₹250 Off', originalValue: '250', sellingPrice: '25', minOrderValue: '800', description: '₹250 off on bath, body, aromatherapy, and wellness products at Nykaa.', terms: 'Min ₹800. Wellness & self-care category.' },

  // ═══════════════════════════════════════════════════════════════════════
  // BLINKIT (3 new)
  // ═══════════════════════════════════════════════════════════════════════
  { brand: 'Blinkit', code: 'BLINK100OFF', title: 'Blinkit ₹100 Off ₹399+', category: 'Food & Delivery', discount: '₹100 Off', originalValue: '100', sellingPrice: '10', minOrderValue: '399', description: '₹100 off on Blinkit grocery orders above ₹399. Essentials delivered in 10 minutes.', terms: 'Min ₹399. All categories. One per user.' },
  { brand: 'Blinkit', code: 'BLINKSNACK', title: 'Blinkit 25% Off Munchies', category: 'Food & Delivery', discount: '25% Off', originalValue: '75', sellingPrice: '10', minOrderValue: '199', description: '25% off on chips, biscuits, chocolates, and instant noodles on Blinkit.', terms: 'Max ₹75. Snacks & munchies category.' },
  { brand: 'Blinkit', code: 'BLINKDAIRY', title: 'Blinkit ₹50 Off Dairy & Breakfast', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '149', description: '₹50 off on milk, bread, eggs, butter, and breakfast essentials on Blinkit.', terms: 'Min ₹149. Dairy & breakfast items only.' },

  // ═══════════════════════════════════════════════════════════════════════
  // ADDITIONAL POPULAR BRANDS (~50 more)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Domino's ──────────────────────────────────────────────────────────
  { brand: "Domino's", code: 'DOM40PARTY', title: "Domino's 40% Off Party Orders", category: 'Food & Delivery', discount: '40% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: "40% off on Domino's party orders — pizzas, sides, and drinks for 6+ people.", terms: 'Max ₹500. Min ₹800. Party size orders.' },
  { brand: "Domino's", code: 'DOMBUY2', title: "Domino's Buy 2 at ₹399", category: 'Food & Delivery', discount: '2 Pizzas ₹399', originalValue: '400', sellingPrice: '29', minOrderValue: '399', description: "Get 2 medium hand-tossed pizzas for just ₹399 at Domino's. Choose from 20+ toppings.", terms: 'Medium hand-tossed only. Delivery + carryout.' },

  // ─── KFC ───────────────────────────────────────────────────────────────
  { brand: 'KFC', code: 'KFCFAMILY30', title: 'KFC Family Bucket 30% Off', category: 'Food & Delivery', discount: '30% Off', originalValue: '300', sellingPrice: '25', minOrderValue: '600', description: '30% off on KFC family buckets — 12pc chicken, fries, coleslaw, and drinks.', terms: 'Max ₹300. Min ₹600. Online and dine-in.' },
  { brand: 'KFC', code: 'KFCZINGER', title: 'KFC ₹50 Off Zinger Meal', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '249', description: '₹50 off on KFC Zinger burger meal with fries and a cold drink.', terms: 'Min ₹249. Zinger meals only. All outlets.' },

  // ─── Starbucks ─────────────────────────────────────────────────────────
  { brand: 'Starbucks', code: 'SBUX20DRINK', title: 'Starbucks 20% Off Any Drink', category: 'Food & Delivery', discount: '20% Off', originalValue: '150', sellingPrice: '15', minOrderValue: '300', description: '20% off on any grande or venti handcrafted beverage at Starbucks India.', terms: 'Max ₹150. Grande/Venti size. All outlets.' },
  { brand: 'Starbucks', code: 'SBUXBOGO', title: 'Starbucks Buy 1 Get 1 Free', category: 'Food & Delivery', discount: 'BOGO', originalValue: '350', sellingPrice: '29', minOrderValue: '350', description: 'Buy 1 handcrafted drink and get 1 of equal or lesser value free at Starbucks.', terms: 'Handcrafted drinks only. 2 PM–5 PM. Select stores.' },

  // ─── McDonald's ────────────────────────────────────────────────────────
  { brand: "McDonald's", code: 'MCDFRIES', title: "McDonald's Free Large Fries", category: 'Food & Delivery', discount: 'Free Fries', originalValue: '150', sellingPrice: '10', minOrderValue: '300', description: "Get a free large fries with any burger combo at McDonald's. McDelivery and dine-in.", terms: 'Min ₹300. Combo meal purchase required.' },
  { brand: "McDonald's", code: 'MCDVALUE25', title: "McDonald's 25% Off McValue Meals", category: 'Food & Delivery', discount: '25% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '250', description: "25% off on McDonald's McValue meals — burgers, wraps, and rice bowls.", terms: 'Max ₹100. Min ₹250. McDelivery app orders.' },

  // ─── Ola & Uber ────────────────────────────────────────────────────────
  { brand: 'Ola', code: 'OLA30AUTO', title: 'Ola 30% Off Auto Rides', category: 'Travel & Transport', discount: '30% Off', originalValue: '50', sellingPrice: '5', minOrderValue: '100', description: '30% off on Ola Auto rides. Quick, affordable three-wheeler transport.', terms: 'Max ₹50. Auto category only. 3 uses per user.' },
  { brand: 'Uber', code: 'UBERGO40', title: 'Uber 40% Off UberGo Rides', category: 'Travel & Transport', discount: '40% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '150', description: '40% off on your next 2 UberGo rides. Affordable car rides across the city.', terms: 'Max ₹100 per ride. 2 rides. UberGo only.' },

  // ─── Cleartrip ─────────────────────────────────────────────────────────
  { brand: 'Cleartrip', code: 'CTHOTEL30', title: 'Cleartrip 30% Off Hotels', category: 'Travel & Transport', discount: '30% Off', originalValue: '2000', sellingPrice: '139', minOrderValue: '5000', description: '30% off on domestic hotel bookings via Cleartrip. Verified reviews, best prices.', terms: 'Max ₹2000. Min ₹5000. All hotels.' },

  // ─── OYO ───────────────────────────────────────────────────────────────
  { brand: 'OYO', code: 'OYOWEEKEND', title: 'OYO Weekend 50% Off', category: 'Hotels & Stays', discount: '50% Off', originalValue: '2000', sellingPrice: '129', minOrderValue: '2500', description: '50% off on OYO hotel stays over the weekend. Budget to premium rooms available.', terms: 'Max ₹2000. Fri–Sun stays. App booking only.' },

  // ─── Lenskart ──────────────────────────────────────────────────────────
  { brand: 'Lenskart', code: 'LENS30SUN', title: 'Lenskart 30% Off Sunglasses', category: 'Fashion', discount: '30% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '1500', description: '30% off on branded sunglasses — Ray-Ban, Oakley, and Lenskart Studio.', terms: 'Max ₹800. Sunglasses only. All brands.' },

  // ─── H&M ───────────────────────────────────────────────────────────────
  { brand: 'H&M', code: 'HMNEWCOLL', title: 'H&M 20% Off New Collection', category: 'Fashion', discount: '20% Off', originalValue: '800', sellingPrice: '59', minOrderValue: '2000', description: '20% off on H&M new arrivals — dresses, basics, and seasonal fashion.', terms: 'Max ₹800. New collection only. Online + in-store.' },

  // ─── Decathlon ─────────────────────────────────────────────────────────
  { brand: 'Decathlon', code: 'DECAT30CAMP', title: 'Decathlon 30% Off Camping Gear', category: 'Fitness & Sports', discount: '30% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '30% off on tents, sleeping bags, trekking poles, and camping essentials at Decathlon.', terms: 'Max ₹1500. Camping & hiking category.' },

  // ─── BookMyShow ────────────────────────────────────────────────────────
  { brand: 'BookMyShow', code: 'BMS200SHOW', title: 'BookMyShow ₹200 Off Live Shows', category: 'Gaming & Entertainment', discount: '₹200 Off', originalValue: '200', sellingPrice: '25', minOrderValue: '500', description: '₹200 off on live concerts, comedy shows, and events booked on BookMyShow.', terms: 'Min 2 tickets. Events category. Select cities.' },

  // ─── Netflix ───────────────────────────────────────────────────────────
  { brand: 'Netflix', code: 'NFLXMOBILE', title: 'Netflix Mobile Plan ₹50 Off', category: 'Gaming & Entertainment', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '149', description: '₹50 off on Netflix Mobile plan subscription. Watch on your phone anywhere.', terms: 'Mobile plan only. New and renewing subscribers.' },

  // ─── Spotify ───────────────────────────────────────────────────────────
  { brand: 'Spotify', code: 'SPOTIFY50PR', title: 'Spotify Premium ₹50 Off', category: 'Gaming & Entertainment', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '119', description: '₹50 off on Spotify Premium monthly plan. Ad-free music and offline downloads.', terms: 'Min ₹119. Individual plan. New subscribers.' },

  // ─── PharmEasy ─────────────────────────────────────────────────────────
  { brand: 'PharmEasy', code: 'PE30LABTEST', title: 'PharmEasy 30% Off Lab Tests', category: 'Health & Pharmacy', discount: '30% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '30% off on health checkups and lab tests booked via PharmEasy.', terms: 'Max ₹500. Lab tests only. Home sample collection.' },

  // ─── Urban Company ─────────────────────────────────────────────────────
  { brand: 'Urban Company', code: 'UC300SALON', title: 'Urban Company ₹300 Off Salon', category: 'General', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '800', description: '₹300 off on salon-at-home services — haircut, facial, waxing, and manicure.', terms: 'Min ₹800. Salon services only. Select cities.' },

  // ─── Paytm ─────────────────────────────────────────────────────────────
  { brand: 'Paytm', code: 'PAYTM100BILL', title: 'Paytm ₹100 Cashback on Bill Pay', category: 'Finance & Payments', discount: '₹100 Cashback', originalValue: '100', sellingPrice: '10', minOrderValue: '500', description: '₹100 cashback on electricity, gas, or water bill payments via Paytm.', terms: 'Min ₹500 bill. One per user per month.' },

  // ─── PhonePe ───────────────────────────────────────────────────────────
  { brand: 'PhonePe', code: 'PPESWITCH75', title: 'PhonePe Switch ₹75 Cashback', category: 'Finance & Payments', discount: '₹75 Cashback', originalValue: '75', sellingPrice: '10', minOrderValue: '300', description: '₹75 cashback when you shop on PhonePe Switch apps — Myntra, Flipkart, and more.', terms: 'Min ₹300. PhonePe Switch orders. First transaction.' },

  // ─── CRED ──────────────────────────────────────────────────────────────
  { brand: 'CRED', code: 'CRED300SHOP', title: 'CRED Store ₹300 Off', category: 'Finance & Payments', discount: '₹300 Off', originalValue: '300', sellingPrice: '25', minOrderValue: '1000', description: '₹300 off on CRED Store exclusive products — gadgets, lifestyle, and fashion.', terms: 'Min ₹1000. CRED Store purchases. Members only.' },

  // ─── Samsung ───────────────────────────────────────────────────────────
  { brand: 'Samsung', code: 'SAM15PHONE', title: 'Samsung 15% Off Galaxy Phones', category: 'Electronics & Gadgets', discount: '15% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '20000', description: '15% off on Samsung Galaxy S and A series phones on samsung.com/in.', terms: 'Max ₹5000. Galaxy phones only. samsung.com.' },

  // ─── boAt ──────────────────────────────────────────────────────────────
  { brand: 'boAt', code: 'BOAT50WATCH', title: 'boAt 50% Off Smartwatches', category: 'Electronics & Gadgets', discount: '50% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '1500', description: '50% off on boAt Wave, Storm, and Xtend smartwatches with AMOLED display.', terms: 'Max ₹1000. Smartwatches only. boat-lifestyle.com.' },

  // ─── Cult.fit ──────────────────────────────────────────────────────────
  { brand: 'Cult.fit', code: 'CULT40GYM', title: 'Cult.fit 40% Off Gym Membership', category: 'Fitness & Sports', discount: '40% Off', originalValue: '4000', sellingPrice: '249', minOrderValue: '6000', description: '40% off on Cult.fit gym membership — unlimited group classes and gym access.', terms: 'Max ₹4000. 6-month plans. Select cities.' },

  // ─── Pepperfry ─────────────────────────────────────────────────────────
  { brand: 'Pepperfry', code: 'PF25SOFA', title: 'Pepperfry 25% Off Sofas', category: 'General', discount: '25% Off', originalValue: '5000', sellingPrice: '299', minOrderValue: '15000', description: '25% off on sofas — fabric, leather, L-shape, and recliner sofas at Pepperfry.', terms: 'Max ₹5000. Min ₹15000. Sofas category.' },

  // ─── IKEA ──────────────────────────────────────────────────────────────
  { brand: 'IKEA', code: 'IKEA20BED', title: 'IKEA 20% Off Bedroom Furniture', category: 'General', discount: '20% Off', originalValue: '3000', sellingPrice: '199', minOrderValue: '10000', description: '20% off on IKEA beds, mattresses, wardrobes, and bedroom accessories.', terms: 'Max ₹3000. Bedroom category. ikea.in only.' },

  // ─── Udemy ─────────────────────────────────────────────────────────────
  { brand: 'Udemy', code: 'UDEMY90OFF', title: 'Udemy Courses from ₹379', category: 'Education', discount: '90% Off', originalValue: '3000', sellingPrice: '25', minOrderValue: '0', description: 'Premium Udemy courses at just ₹379. Python, web dev, design, and marketing.', terms: 'Select courses. Valid during flash sale.' },

  // ─── Coursera ──────────────────────────────────────────────────────────
  { brand: 'Coursera', code: 'COURSERA50', title: 'Coursera 50% Off First Month', category: 'Education', discount: '50% Off', originalValue: '2000', sellingPrice: '99', minOrderValue: '0', description: '50% off on your first month of Coursera Plus. Access 7000+ courses from Google, IBM, Meta.', terms: 'First month. Coursera Plus monthly plan. New subscribers.' },

  // ─── FreshToHome ───────────────────────────────────────────────────────
  { brand: 'FreshToHome', code: 'FTH20FISH', title: 'FreshToHome 20% Off Seafood', category: 'Food & Delivery', discount: '20% Off', originalValue: '200', sellingPrice: '19', minOrderValue: '500', description: '20% off on fresh fish, prawns, and seafood. Chemical-free and antibiotic-free.', terms: 'Max ₹200. Seafood category. Select cities.' },

  // ─── Country Delight ───────────────────────────────────────────────────
  { brand: 'Country Delight', code: 'CD25DAIRY', title: 'Country Delight 25% Off Dairy', category: 'Food & Delivery', discount: '25% Off', originalValue: '150', sellingPrice: '15', minOrderValue: '300', description: '25% off on Country Delight milk, paneer, curd, and ghee subscription.', terms: 'Max ₹150. First subscription month. Select cities.' },

  // ─── FirstCry ──────────────────────────────────────────────────────────
  { brand: 'FirstCry', code: 'FCRY30BABY', title: 'FirstCry 30% Off Baby Essentials', category: 'E-Commerce', discount: '30% Off', originalValue: '1000', sellingPrice: '69', minOrderValue: '2000', description: '30% off on baby care, diapers, feeding bottles, and toys at FirstCry.', terms: 'Max ₹1000. Min ₹2000. All brands.' },

  // ─── Bewakoof ──────────────────────────────────────────────────────────
  { brand: 'Bewakoof', code: 'BWKF40ALL', title: 'Bewakoof 40% Off Everything', category: 'Fashion', discount: '40% Off', originalValue: '600', sellingPrice: '45', minOrderValue: '799', description: '40% off on Bewakoof — graphic tees, joggers, dresses, and oversized fits.', terms: 'Max ₹600. All categories. bewakoof.com.' },

  // ─── Souled Store ──────────────────────────────────────────────────────
  { brand: 'Souled Store', code: 'SOULED35', title: 'The Souled Store 35% Off', category: 'Fashion', discount: '35% Off', originalValue: '700', sellingPrice: '49', minOrderValue: '1299', description: '35% off on Marvel, DC, anime merch, sneakers, and backpacks.', terms: 'Max ₹700. Min ₹1299. thesouledstore.com.' },

  // ─── Wakefit ───────────────────────────────────────────────────────────
  { brand: 'Wakefit', code: 'WAKE25MATT', title: 'Wakefit 25% Off Mattresses', category: 'General', discount: '25% Off', originalValue: '4000', sellingPrice: '249', minOrderValue: '10000', description: '25% off on Wakefit orthopaedic, latex, and memory foam mattresses.', terms: 'Max ₹4000. Mattresses only. wakefit.co.' },

  // ─── Mamaearth ─────────────────────────────────────────────────────────
  { brand: 'Mamaearth', code: 'MAMA30HAIR', title: 'Mamaearth 30% Off Haircare', category: 'Beauty & Personal Care', discount: '30% Off', originalValue: '500', sellingPrice: '39', minOrderValue: '800', description: '30% off on Mamaearth onion shampoo, hair oil, and anti-hair fall range.', terms: 'Max ₹500. Haircare products. mamaearth.in.' },

  // ─── Burger King ───────────────────────────────────────────────────────
  { brand: 'Burger King', code: 'BKWHOPPER', title: 'Burger King ₹50 Off Whopper', category: 'Food & Delivery', discount: '₹50 Off', originalValue: '50', sellingPrice: '5', minOrderValue: '199', description: '₹50 off on any Whopper meal at Burger King. Double Whopper included.', terms: 'Min ₹199. Whopper meals. Delivery + dine-in.' },

  // ─── Subway ────────────────────────────────────────────────────────────
  { brand: 'Subway', code: 'SUBFOOT30', title: 'Subway 30% Off Footlong', category: 'Food & Delivery', discount: '30% Off', originalValue: '100', sellingPrice: '10', minOrderValue: '250', description: '30% off on any footlong sub at Subway. Customize with your favourite toppings.', terms: 'Max ₹100. Footlong subs only. All outlets.' },

  // ─── Realme ────────────────────────────────────────────────────────────
  { brand: 'Realme', code: 'REALME10OFF', title: 'Realme 10% Off Smartphones', category: 'Electronics & Gadgets', discount: '10% Off', originalValue: '2000', sellingPrice: '129', minOrderValue: '10000', description: '10% off on Realme GT, Narzo, and Number series smartphones on realme.com.', terms: 'Max ₹2000. realme.com orders. Select models.' },

  // ─── JBL ───────────────────────────────────────────────────────────────
  { brand: 'JBL', code: 'JBL25AUDIO', title: 'JBL 25% Off Speakers & Earbuds', category: 'Electronics & Gadgets', discount: '25% Off', originalValue: '1500', sellingPrice: '99', minOrderValue: '3000', description: '25% off on JBL Flip, Charge, Tune, and Live earbuds and Bluetooth speakers.', terms: 'Max ₹1500. jbl.com/in and Amazon.' },

  // ─── MobiKwik ──────────────────────────────────────────────────────────
  { brand: 'MobiKwik', code: 'MBKWIK50CB', title: 'MobiKwik ₹50 Cashback', category: 'Finance & Payments', discount: '₹50 Cashback', originalValue: '50', sellingPrice: '5', minOrderValue: '200', description: '₹50 SuperCash on mobile recharge, DTH, or electricity bill via MobiKwik.', terms: 'Min ₹200. SuperCash credit. One per user.' },

  // ─── Airtel Thanks ─────────────────────────────────────────────────────
  { brand: 'Airtel Thanks', code: 'AIRTELFREE', title: 'Airtel Thanks Free Data 2GB', category: 'Finance & Payments', discount: 'Free 2GB Data', originalValue: '50', sellingPrice: '5', minOrderValue: '0', description: 'Get 2GB free data on your Airtel prepaid number via Airtel Thanks app.', terms: 'Airtel prepaid only. One time. Airtel Thanks app.' },

  // ─── Livspace ──────────────────────────────────────────────────────────
  { brand: 'Livspace', code: 'LIV15DESIGN', title: 'Livspace 15% Off Interior Design', category: 'General', discount: '15% Off', originalValue: '15000', sellingPrice: '699', minOrderValue: '100000', description: '15% off on Livspace full-home interior design packages — modular kitchens, wardrobes, and living rooms.', terms: 'Max ₹15000. Full-home packages. Select cities.' },
];

async function seedCoupons() {
  console.log(`\n🚀 Seeding ${coupons.length} brand-focused coupons into Supabase...\n`);

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

  // Print brand summary
  const brandCounts = {};
  coupons.forEach((c) => {
    brandCounts[c.brand] = (brandCounts[c.brand] || 0) + 1;
  });
  console.log('📊 Brand Summary:');
  Object.entries(brandCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([brand, count]) => {
      console.log(`   ${brand}: ${count} coupon${count > 1 ? 's' : ''}`);
    });
  console.log('');
}

seedCoupons()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
