require('dotenv').config();
const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const hbs = require('hbs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { connect, get } = require("./config/connection");
const fileUpload = require('express-fileupload');
const flash = require('connect-flash');

// 🔒 Security & Performance Packages
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

const app = express();

// 🔒 Apply security middlewares
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(helmet.frameguard({ action: 'sameorigin' }));
app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));         // adds security headers
app.use(compression());     // compress responses (faster)
app.use(mongoSanitize());   // prevents MongoDB injection
app.use(xss());             // prevents XSS attacks

// Views
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// Only trust proxy when actually deployed behind one (e.g., Nginx/Load Balancer)
if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Handlebars helpers
hbs.registerHelper('lt', (a, b) => a < b);
hbs.registerHelper('gt', (a, b) => a > b);
hbs.registerHelper('eq', (a, b) => a === b);
hbs.registerHelper('add', (a, b) => a + b);
hbs.registerHelper('subtract', (a, b) => a - b);
hbs.registerHelper('range', function (start, end) {
  const arr = [];
  for (let i = start; i <= end; ++i) arr.push(i);
  return arr;
});
hbs.registerHelper('toString', function (objectId) {
  if (objectId && typeof objectId.toString === 'function') return objectId.toString();
  return objectId;
});

// Middleware
app.use(logger('dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload());

// Session configuration
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || 'fallback-secret-32-chars-long-and-stable';

app.use(session({
  name: 'readora.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 7 days
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // secure must be false on localhost (no HTTPS), true in production with HTTPS or trusted proxy
    secure: isProd,
    // 'lax' is safest for typical app behavior across environments
    sameSite: isProd ? 'lax' : 'lax',
    // do not explicitly set domain; let browser scope it to current host to avoid collisions
    path: '/'
  },
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI, // use same env var as connection.js
    ttl: 14 * 24 * 60 * 60, // 14 days
    collectionName: 'sessions',
    autoRemove: 'interval',
    autoRemoveInterval: 60 // minutes
})
}));

// ADD FLASH MIDDLEWARE - MUST COME AFTER SESSION
app.use(flash());

// ADD FLASH MESSAGES TO RESPONSE LOCALS - ADD THIS MIDDLEWARE
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  next();
});

// Simple session trace
app.use((req, res, next) => {
  try {
    console.log(`[SESSION] SID=${req.sessionID} userId=${req.session?.userId || 'none'} path=${req.path}`);
  } catch (e) {
    console.error('Session log error', e);
  }
  next();
});

// Database connection and server start
async function startServer() {
  try {
    await connect();
    console.log('✅ Database connected successfully');

    const db = get();
    await db.listCollections({ name: 'sessions' }).next();
    console.log('✅ Sessions collection verified');

    // Daily cleanup: unset expired memberships (if any schema uses membership.expiresAt)
    setInterval(async () => {
      try {
        const now = new Date();
        await db.collection('user').updateMany(
          { 'membership.expiresAt': { $lte: now } },
          { $unset: { membership: "" } }
        );
      } catch (e) {
        console.error('membership cleanup failed', e);
      }
    }, 24 * 60 * 60 * 1000);

    // Routes
    app.use('/', require('./routes/user'));
    app.use('/', require('./routes/admin'));
    app.use('/', require('./routes/staff'));

    // 404
    app.use((req, res) => res.status(404).render('404'));

    // Error handler
    app.use((err, req, res, next) => {
      res.locals.message = err.message;
      res.locals.error = req.app.get('env') === 'development' ? err : {};
      res.status(err.status || 500).render('error');
    });

    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;