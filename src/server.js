const express = require('express');
const path = require('path');
const dayjs = require('dayjs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'loginex-admin';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/loginex';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const blogSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  author: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
});

const serverSchema = new mongoose.Schema({
  name: { type: String, required: true },
  region: { type: String, required: true },
  cpu: { type: String, required: true },
  ram: { type: String, required: true },
  storage: { type: String, required: true },
  priceMonthly: { type: Number, required: true },
  stock: { type: Number, required: true, default: 1 },
  createdAt: { type: Date, required: true, default: Date.now },
});

const rentalSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
  purchasedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, required: true, enum: ['active', 'expired'], default: 'active' },
  warned: { type: Boolean, required: true, default: false },
});

const Blog = mongoose.model('Blog', blogSchema);
const Server = mongoose.model('Server', serverSchema);
const Rental = mongoose.model('Rental', rentalSchema);

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

function adminGuard(req, res, next) {
  const providedKey = req.query.key || req.body.key;
  if (providedKey !== ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Provide ?key=ADMIN_KEY');
  }
  return next();
}

app.get('/', async (req, res) => {
  const blogs = await Blog.find().sort({ createdAt: -1 }).limit(3).lean();
  const servers = await Server.find().sort({ createdAt: -1 }).limit(6).lean();
  res.render('home', { blogs, servers });
});

app.get('/blog', async (req, res) => {
  const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
  res.render('blog', { blogs });
});

app.get('/servers', async (req, res) => {
  const servers = await Server.find().sort({ createdAt: -1 }).lean();
  res.render('servers', { servers });
});

app.get('/rent/:id', async (req, res) => {
  const server = await Server.findById(req.params.id).lean();
  if (!server) {
    return res.status(404).send('Server not found');
  }
  if (server.stock <= 0) {
    return res.status(400).send('Server currently unavailable.');
  }
  return res.render('rent', { server });
});

app.post('/rent/:id', async (req, res) => {
  const server = await Server.findById(req.params.id);
  if (!server || server.stock <= 0) {
    return res.status(400).send('Server unavailable');
  }

  const { customerName, customerEmail } = req.body;
  const purchasedAt = dayjs();
  const expiresAt = purchasedAt.add(30, 'day');

  await Rental.create({
    customerName,
    customerEmail,
    serverId: server._id,
    purchasedAt: purchasedAt.toDate(),
    expiresAt: expiresAt.toDate(),
    status: 'active',
  });

  server.stock -= 1;
  await server.save();

  res.render('success', {
    customerName,
    customerEmail,
    server: server.toObject(),
    expiresAt: expiresAt.format('MMM D, YYYY'),
  });
});

app.get('/admin', adminGuard, async (req, res) => {
  const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
  const servers = await Server.find().sort({ createdAt: -1 }).lean();
  const rentals = await Rental.find().sort({ purchasedAt: -1 }).populate('serverId').lean();

  const rentalRows = rentals.map((rental) => ({
    ...rental,
    server_name: rental.serverId?.name || 'Unknown',
    expires_at: rental.expiresAt,
    status: rental.status,
    customer_name: rental.customerName,
  }));

  res.render('admin', { blogs, servers, rentals: rentalRows, key: ADMIN_KEY });
});

app.post('/admin/blog', adminGuard, async (req, res) => {
  const { title, content, author } = req.body;
  await Blog.create({
    title,
    content,
    author,
    createdAt: new Date(),
  });
  res.redirect(`/admin?key=${ADMIN_KEY}`);
});

app.post('/admin/server', adminGuard, async (req, res) => {
  const { name, region, cpu, ram, storage, priceMonthly, stock } = req.body;
  await Server.create({
    name,
    region,
    cpu,
    ram,
    storage,
    priceMonthly: Number(priceMonthly),
    stock: Number(stock),
    createdAt: new Date(),
  });
  res.redirect(`/admin?key=${ADMIN_KEY}`);
});

async function processRentalLifecycle() {
  const now = dayjs();
  const activeRentals = await Rental.find({ status: 'active' }).populate('serverId');

  for (const rental of activeRentals) {
    const expiry = dayjs(rental.expiresAt);
    const daysLeft = expiry.diff(now, 'day');

    if (daysLeft <= 3 && !rental.warned) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || 'noreply@loginex.ca',
          to: rental.customerEmail,
          subject: 'Your Loginex server rental is expiring soon',
          text: `Hi ${rental.customerName}, your ${rental.serverId?.name || 'server'} rental expires on ${expiry.format('MMM D, YYYY')}. Renew now to avoid release.`,
        });
      } catch (error) {
        console.log('Email send skipped/failed:', error.message);
      }
      rental.warned = true;
      await rental.save();
    }

    if (expiry.isBefore(now)) {
      rental.status = 'expired';
      await rental.save();

      if (rental.serverId) {
        rental.serverId.stock += 1;
        await rental.serverId.save();
      }
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

async function start() {
  await mongoose.connect(MONGODB_URI);
  app.listen(PORT, () => {
    console.log(`Loginex app running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Startup error:', error);
  process.exit(1);
});
