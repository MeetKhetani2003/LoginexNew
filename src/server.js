const express = require('express');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const dayjs = require('dayjs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'loginex-admin';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : undefined,
});

async function initDb() {
  db = await open({
    filename: path.join(__dirname, 'data', 'loginex.db'),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      cpu TEXT NOT NULL,
      ram TEXT NOT NULL,
      storage TEXT NOT NULL,
      price_monthly REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      purchased_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      warned INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(server_id) REFERENCES servers(id)
    );
  `);
}

function adminGuard(req, res, next) {
  const providedKey = req.query.key || req.body.key;
  if (providedKey !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Provide ?key=ADMIN_KEY');
  }
  return next();
}

app.get('/', async (req, res) => {
  const blogs = await db.all('SELECT * FROM blogs ORDER BY id DESC LIMIT 3');
  const servers = await db.all('SELECT * FROM servers ORDER BY id DESC LIMIT 6');
  res.render('home', { blogs, servers });
});

app.get('/blog', async (req, res) => {
  const blogs = await db.all('SELECT * FROM blogs ORDER BY id DESC');
  res.render('blog', { blogs });
});

app.get('/servers', async (req, res) => {
  const servers = await db.all('SELECT * FROM servers ORDER BY id DESC');
  res.render('servers', { servers });
});

app.get('/rent/:id', async (req, res) => {
  const server = await db.get('SELECT * FROM servers WHERE id = ?', req.params.id);
  if (!server) {
    return res.status(404).send('Server not found');
  }
  if (server.stock <= 0) {
    return res.status(400).send('Server currently unavailable.');
  }
  return res.render('rent', { server, baseUrl: BASE_URL });
});

app.post('/rent/:id', async (req, res) => {
  const server = await db.get('SELECT * FROM servers WHERE id = ?', req.params.id);
  if (!server || server.stock <= 0) {
    return res.status(400).send('Server unavailable');
  }

  const { customerName, customerEmail } = req.body;
  const purchasedAt = dayjs();
  const expiresAt = purchasedAt.add(30, 'day');

  await db.run(
    `INSERT INTO rentals (customer_name, customer_email, server_id, purchased_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    customerName,
    customerEmail,
    server.id,
    purchasedAt.toISOString(),
    expiresAt.toISOString()
  );

  await db.run('UPDATE servers SET stock = stock - 1 WHERE id = ?', server.id);

  res.render('success', {
    customerName,
    customerEmail,
    server,
    expiresAt: expiresAt.format('MMM D, YYYY'),
  });
});

app.get('/admin', adminGuard, async (req, res) => {
  const blogs = await db.all('SELECT * FROM blogs ORDER BY id DESC');
  const servers = await db.all('SELECT * FROM servers ORDER BY id DESC');
  const rentals = await db.all(
    `SELECT rentals.*, servers.name AS server_name
     FROM rentals JOIN servers ON rentals.server_id = servers.id
     ORDER BY rentals.id DESC`
  );

  res.render('admin', { blogs, servers, rentals, key: ADMIN_KEY });
});

app.post('/admin/blog', adminGuard, async (req, res) => {
  const { title, content, author } = req.body;
  await db.run(
    'INSERT INTO blogs (title, content, author, created_at) VALUES (?, ?, ?, ?)',
    title,
    content,
    author,
    dayjs().toISOString()
  );
  res.redirect(`/admin?key=${ADMIN_KEY}`);
});

app.post('/admin/server', adminGuard, async (req, res) => {
  const { name, region, cpu, ram, storage, priceMonthly, stock } = req.body;
  await db.run(
    `INSERT INTO servers (name, region, cpu, ram, storage, price_monthly, stock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    name,
    region,
    cpu,
    ram,
    storage,
    Number(priceMonthly),
    Number(stock),
    dayjs().toISOString()
  );
  res.redirect(`/admin?key=${ADMIN_KEY}`);
});

async function processRentalLifecycle() {
  const now = dayjs();
  const activeRentals = await db.all(`
    SELECT rentals.*, servers.name AS server_name
    FROM rentals JOIN servers ON rentals.server_id = servers.id
    WHERE rentals.status = 'active'
  `);

  for (const rental of activeRentals) {
    const expiry = dayjs(rental.expires_at);
    const daysLeft = expiry.diff(now, 'day');

    if (daysLeft <= 3 && rental.warned === 0) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || 'noreply@loginex.ca',
          to: rental.customer_email,
          subject: 'Your Loginex server rental is expiring soon',
          text: `Hi ${rental.customer_name}, your ${rental.server_name} rental expires on ${expiry.format('MMM D, YYYY')}. Renew now to avoid release.`,
        });
      } catch (error) {
        console.log('Email send skipped/failed:', error.message);
      }
      await db.run('UPDATE rentals SET warned = 1 WHERE id = ?', rental.id);
    }

    if (expiry.isBefore(now)) {
      await db.run('UPDATE rentals SET status = ? WHERE id = ?', 'expired', rental.id);
      await db.run('UPDATE servers SET stock = stock + 1 WHERE id = ?', rental.server_id);
    }
  }
}

cron.schedule('0 * * * *', async () => {
  try {
    await processRentalLifecycle();
  } catch (error) {
    console.error('Lifecycle job error:', error);
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Loginex app running at http://localhost:${PORT}`);
  });
});
