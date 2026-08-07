// ============================================
// SaveHatke — Price Tracker Routes
// ============================================

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');
const db = require('../services/googleSheets');

const router = express.Router();

// Mock price data for demo purposes
// In production, replace with real scraping or API integration
function getMockPrice(url) {
  const prices = [
    { name: 'Samsung Galaxy M34 5G', price: '14999', platform: 'Amazon' },
    { name: 'boAt Rockerz 450 Headphone', price: '1299', platform: 'Flipkart' },
    { name: 'Nike Air Max 90', price: '8995', platform: 'Amazon' },
    { name: 'Redmi Note 13 Pro', price: '22999', platform: 'Flipkart' },
    { name: 'Sony WH-1000XM5', price: '24990', platform: 'Amazon' },
  ];
  const random = prices[Math.floor(Math.random() * prices.length)];

  // Detect platform from URL
  let platform = 'Unknown';
  if (url.includes('amazon')) platform = 'Amazon';
  else if (url.includes('flipkart')) platform = 'Flipkart';
  else if (url.includes('myntra')) platform = 'Myntra';
  else if (url.includes('ajio')) platform = 'AJIO';

  return {
    productName: random.name,
    currentPrice: random.price,
    platform: platform !== 'Unknown' ? platform : random.platform,
    lowestPrice: String(Math.floor(Number(random.price) * 0.85)),
  };
}

// POST /api/tracker/add — Add a product to track
router.post('/add', authenticateToken, async (req, res) => {
  try {
    const { productUrl, targetPrice } = req.body;

    if (!productUrl) {
      return res.status(400).json({ error: 'Product URL is required.' });
    }

    // Validate URL format
    try {
      new URL(productUrl);
    } catch {
      return res.status(400).json({ error: 'Please provide a valid URL.' });
    }

    // Check duplicate tracking
    const userTracked = await db.findRows(db.SHEETS.PRICE_TRACKING, 'userEmail', req.user.email);
    const duplicate = userTracked.find((t) => t.productUrl === productUrl);
    if (duplicate) {
      return res.status(409).json({ error: 'You are already tracking this product.' });
    }

    // Fetch mock price data
    const priceData = getMockPrice(productUrl);

    const tracking = {
      id: uuidv4(),
      userEmail: req.user.email,
      productUrl,
      platform: priceData.platform,
      productName: priceData.productName,
      currentPrice: priceData.currentPrice,
      targetPrice: targetPrice || String(Math.floor(Number(priceData.currentPrice) * 0.9)),
      lowestPrice: priceData.lowestPrice,
      lastChecked: new Date().toISOString(),
      alertSent: 'false',
    };

    await db.appendRow(db.SHEETS.PRICE_TRACKING, tracking);

    res.status(201).json({
      message: 'Product added to your tracking list.',
      tracking: {
        id: tracking.id,
        productName: tracking.productName,
        platform: tracking.platform,
        currentPrice: tracking.currentPrice,
        targetPrice: tracking.targetPrice,
        lowestPrice: tracking.lowestPrice,
      },
    });
  } catch (err) {
    console.error('Add tracker error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/tracker/list — Get user's tracked products
router.get('/list', authenticateToken, async (req, res) => {
  try {
    const tracked = await db.findRows(db.SHEETS.PRICE_TRACKING, 'userEmail', req.user.email);
    res.json({
      products: tracked.map((t) => ({
        id: t.id,
        productUrl: t.productUrl,
        platform: t.platform,
        productName: t.productName,
        currentPrice: t.currentPrice,
        targetPrice: t.targetPrice,
        lowestPrice: t.lowestPrice,
        lastChecked: t.lastChecked,
        alertSent: t.alertSent === 'true',
      })),
    });
  } catch (err) {
    console.error('List tracker error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// DELETE /api/tracker/:id — Remove a tracked product
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const tracking = await db.findRow(db.SHEETS.PRICE_TRACKING, 'id', id);
    if (!tracking) {
      return res.status(404).json({ error: 'Tracked product not found.' });
    }
    if (tracking.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    await db.deleteRow(db.SHEETS.PRICE_TRACKING, 'id', id);
    res.json({ message: 'Product removed from tracking.' });
  } catch (err) {
    console.error('Delete tracker error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /api/tracker/check/:id — Manually refresh price (mock)
router.get('/check/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const tracking = await db.findRow(db.SHEETS.PRICE_TRACKING, 'id', id);
    if (!tracking) {
      return res.status(404).json({ error: 'Tracked product not found.' });
    }
    if (tracking.userEmail !== req.user.email) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Simulate a price change
    const currentNum = Number(tracking.currentPrice);
    const fluctuation = (Math.random() - 0.5) * 0.1; // ±5%
    const newPrice = String(Math.round(currentNum * (1 + fluctuation)));
    const lowestPrice = String(Math.min(Number(tracking.lowestPrice || currentNum), Number(newPrice)));

    await db.updateRow(db.SHEETS.PRICE_TRACKING, 'id', id, {
      currentPrice: newPrice,
      lowestPrice,
      lastChecked: new Date().toISOString(),
    });

    const belowTarget = Number(newPrice) <= Number(tracking.targetPrice);

    res.json({
      message: belowTarget ? '🎉 Price dropped below your target!' : 'Price updated.',
      product: {
        id: tracking.id,
        productName: tracking.productName,
        previousPrice: tracking.currentPrice,
        currentPrice: newPrice,
        targetPrice: tracking.targetPrice,
        lowestPrice,
        belowTarget,
      },
    });
  } catch (err) {
    console.error('Check price error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
