# LoginexNew

Premium-style marketing website + lightweight rental platform for Loginex.

## Features
- Marketing home page for VPS / Minecraft / web hosting / storage business.
- Server inventory page with machine specs from admin panel.
- Blog page populated by admin-published posts.
- 30-day rental purchase flow per server.
- Hourly lifecycle job:
  - Sends email reminder 3 days before expiry.
  - Expires rentals after 30 days and returns stock to pool.

## Stack
- Express + EJS
- MongoDB + Mongoose
- Node Cron + Nodemailer

## Run locally
```bash
npm install
npm run dev
```
Then open `http://localhost:3000`.

## Admin panel
Set an admin key, then access:
`/admin?key=YOUR_ADMIN_KEY`

Environment variables:
- `ADMIN_KEY`
- `MONGODB_URI` (example: `mongodb://127.0.0.1:27017/loginex`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
