# PHYNEX marketplace fixes

## What was fixed
- Products are stored in a configurable persistent data directory. On Render, use a Persistent Disk mounted at `/data` and set `PHYNEX_DATA_DIR=/data`.
- Public product API always loads every approved product from SQLite; the homepage no longer limits seller listings to eight items.
- Checkout now uses the real database price and stock instead of trusting browser-supplied prices.
- Stock is reserved during an M-PESA checkout and released when payment fails/expires; paid orders deduct stock once.
- M-PESA callbacks can recover an order from SQLite after a server restart instead of relying only on in-memory payment data.
- Customer and seller login sessions expire after 7 days and login attempts are rate-limited.
- Password minimum is 8 characters.
- Admin-created categories are seeded with a broad marketplace category set and are available through `/api/categories`.
- The main site's category area and `categories.html` load categories from the admin-managed database.
- `category.html` now loads live approved products rather than a hard-coded product list.

## Render setup (required for products/orders to survive restarts)
1. Create/attach a Render Persistent Disk to the web service.
2. Mount it at `/data`.
3. Add environment variable `PHYNEX_DATA_DIR=/data`.
4. Deploy.
5. Keep your existing M-PESA, email, Google and admin environment variables. Do not commit `.env`.

The delivered archive intentionally excludes the existing `.env` file because it can contain secrets.
