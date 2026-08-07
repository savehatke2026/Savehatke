# 💰 SaveHatke — Smart Price Tracker & Coupon Marketplace

India's smartest e-commerce utility — track prices across Amazon & Flipkart, and trade unused reward coupons on a peer-to-peer marketplace.

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ installed ([download](https://nodejs.org))
- A modern web browser

### 1. Install Dependencies
```bash
cd server
npm install
```

### 2. Configure Environment
```bash
# Copy the example env file
cp .env.example .env
# Edit .env with your settings (or use defaults for development)
```

### 3. Start the Server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Open in Browser
- 🏠 Landing Page: http://localhost:3000
- 📊 Dashboard: http://localhost:3000/dashboard.html
- 🏷️ Marketplace: http://localhost:3000/marketplace.html
- 💰 Sell Coupons: http://localhost:3000/sell.html
- 🔐 Admin Panel: http://localhost:3000/admin.html
- 📞 Support: http://localhost:3000/support.html

### Default Admin Credentials
- **Username:** `admin`
- **Password:** `SaveHatke@Admin2024`

---

## 🗄️ Google Sheets Database Setup

The platform uses Google Sheets as its primary database. For development, it automatically falls back to an in-memory store with demo data.

### To Connect Google Sheets (Production):

1. **Create a Google Cloud Project** at [console.cloud.google.com](https://console.cloud.google.com)
2. **Enable the Google Sheets API** (APIs & Services → Library → search "Google Sheets API" → Enable)
3. **Create a Service Account:**
   - Go to IAM & Admin → Service Accounts
   - Create a new service account
   - Under Keys tab, click "Add Key" → "Create new key" → JSON
   - Download the JSON key file
4. **Create a Google Spreadsheet** and note the Spreadsheet ID (from the URL)
5. **Share the spreadsheet** with the service account's `client_email` (give Editor access)
6. **Update your `.env` file:**
   ```env
   GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id
   GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@project.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

The server will automatically create the required sheet tabs (Users, Coupons, PriceTracking, SupportTickets) with headers on first connection.

---

## 📂 Project Structure

```
SaveHatke/
├── server/                    # Node.js/Express backend
│   ├── server.js              # App entry point
│   ├── package.json           # Dependencies
│   ├── .env                   # Environment variables
│   ├── middleware/
│   │   └── auth.js            # JWT authentication
│   ├── routes/
│   │   ├── auth.js            # User registration/login
│   │   ├── coupons.js         # Coupon marketplace CRUD
│   │   ├── priceTracker.js    # Price tracking
│   │   ├── admin.js           # Admin panel
│   │   └── support.js         # Support tickets
│   └── services/
│       └── googleSheets.js    # Google Sheets database layer
├── public/                    # Frontend (vanilla HTML/CSS/JS)
│   ├── index.html             # Landing page
│   ├── dashboard.html         # User dashboard
│   ├── marketplace.html       # Buy coupons
│   ├── sell.html              # Sell coupons
│   ├── admin.html             # Admin panel
│   ├── support.html           # Customer support
│   ├── terms.html             # Terms & Conditions
│   ├── privacy.html           # Privacy Policy
│   ├── css/styles.css         # Design system
│   └── js/                    # Page-specific logic
└── README.md
```

---

## 🔑 Features

| Feature | Description |
|---------|-------------|
| 📊 Price Tracker | Paste Amazon/Flipkart links to track prices & get alerts |
| 🏷️ Coupon Marketplace | Browse & buy verified discount codes at low prices |
| 💰 Sell Coupons | Submit unused reward codes and earn ₹10 per coupon |
| 🔐 Admin Panel | Manage inventory, add offline codes, review submissions |
| 🌐 Browser Extension | Coming soon — real-time price comparison while you shop |
| 📞 Customer Support | FAQ + ticket system for user assistance |
| 📜 Legal Pages | Full Terms & Privacy Policy for compliance |

---

## 🛡️ Security

- JWT-based authentication with configurable expiry
- Passwords hashed with bcrypt (10 salt rounds)
- Helmet.js security headers
- Rate limiting on all API endpoints (100 req/15min, 20 for auth)
- Separate admin authentication
- CORS protection

---

## 📄 License

ISC © SaveHatke
