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

const { ObjectId, GridFSBucket } = require('mongodb');

const { PROFILE_IMAGES_BUCKET } = require('./helpers/profile-image-storage');

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

// Existing profile files are served by express.static above. New uploads are
// stored in GridFS so they survive server restarts and deployments.

app.get('/images/profile-images/:imageId', async (req, res, next) => {

  if (!ObjectId.isValid(req.params.imageId)) return next();

  try {

    const bucket = new GridFSBucket(get(), { bucketName: PROFILE_IMAGES_BUCKET });

    const file = await get().collection(`${PROFILE_IMAGES_BUCKET}.files`).findOne({

      _id: new ObjectId(req.params.imageId)

    });

    if (!file) return next();

    res.set({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(file.length)
    });

    res.type(file.contentType || 'application/octet-stream');

    bucket.openDownloadStream(file._id).on('error', next).pipe(res);

  } catch (error) {

    next(error);

  }

});

// Compatibility for image URLs that were historically stored as
// "../public/images/...". `public` is a server folder, not part of a browser
// URL, so redirect those requests to the static /images location.

app.get(/^\/(?:[^/]+\/)*public\/images\/(.+)$/, (req, res, next) => {

  const imagePath = req.params[0];

  if (!imagePath || imagePath.split('/').includes('..')) return next();

  return res.redirect(302, `/images/${imagePath}`);

});

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

// Keep fallback images consistent in every Handlebars view. This only changes
// render data; it never writes to an account or novel record.

app.use((req, res, next) => {

  const render = res.render.bind(res);

  const applyImageDefaults = (value, visited = new WeakSet()) => {

    if (!value || typeof value !== 'object' || visited.has(value)) return;

    visited.add(value);

    // A number of older novel documents do not have an imageUrl key at all.
    // Novel-shaped view models always have a title or novelId, so supply the
    // shared cover even when the key is missing.

    if (
      (Object.prototype.hasOwnProperty.call(value, 'imageUrl') ||
        'title' in value ||
        'novelId' in value) &&
      !value.imageUrl
    ) {

      value.imageUrl = '/images/novel-images/novel_dummy.png';

    }

    for (const child of Object.values(value)) applyImageDefaults(child, visited);

  };

  res.render = (view, locals, callback) => {

    if (locals && typeof locals === 'object') applyImageDefaults(locals);

    return render(view, locals, callback);

  };

  next();

});

// Simple session trace

app.use((req, res, next) => {

  try {

    console.log(
      `[SESSION] SID=${req.sessionID} userId=${req.session?.userId || 'none'} path=${req.path}`
    );

  } catch (e) {

    console.error('Session log error', e);

  }

  next();

});

// ============================================================
// VERCEL DATABASE CONNECTION
// ============================================================

// Connect to MongoDB once and reuse the connection for subsequent requests.

let dbInitializing = null;

async function ensureDatabaseConnection() {

  if (getDatabaseReady()) return;

  if (!dbInitializing) {

    dbInitializing = connect()
      .then(() => {

        console.log('✅ Database connected successfully');

      })
      .catch((err) => {

        dbInitializing = null;

        console.error('❌ Database connection failed:', err);

        throw err;

      });

  }

  await dbInitializing;

}

function getDatabaseReady() {

  try {

    get();

    return true;

  } catch (err) {

    return false;

  }

}

// Make sure MongoDB is connected before any route tries to use db.get().

app.use(async (req, res, next) => {

  try {

    await ensureDatabaseConnection();

    next();

  } catch (err) {

    next(err);

  }

});

// ============================================================
// ROUTES
// ============================================================

// Routes are registered immediately so Vercel knows about them
// before handling the incoming request.

app.use('/', require('./routes/user'));

app.use('/', require('./routes/admin'));

app.use('/', require('./routes/staff'));

app.use('/', require('./routes/payment'));

// ============================================================
// 404
// ============================================================

app.use((req, res) => res.status(404).render('404'));

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {

  res.locals.message = err.message;

  res.locals.error = req.app.get('env') === 'development' ? err : {};

  res.status(err.status || 500).render('error');

});

// ============================================================
// DATABASE INITIALIZATION / LOCAL SERVER
// ============================================================

async function startServer() {

  try {

    // The connection is already handled by ensureDatabaseConnection()
    // for Vercel requests. Calling it here also prepares the database
    // when running the application locally.

    await ensureDatabaseConnection();

    const db = get();

    await db.listCollections({ name: 'sessions' }).next();

    console.log('✅ Sessions collection verified');

    // Payment records are audit data, and these constraints prevent a Razorpay
    // order/payment from being attached to more than one fulfillment.

    await db.collection('payments').createIndex(
      { razorpayOrderId: 1 },
      { unique: true }
    );

    await db.collection('payments').createIndex(
      { razorpayPaymentId: 1 },
      { unique: true, sparse: true }
    );

    await db.collection('coin_transactions').createIndex(
      { razorpayPaymentId: 1 },
      { unique: true, sparse: true }
    );

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

    // ========================================================
    // LOCAL DEVELOPMENT ONLY
    // ========================================================

    if (require.main === module) {

      const PORT = process.env.PORT || 4000;

      app.listen(PORT, () => {

        console.log(`🚀 Server running at http://localhost:${PORT}`);

      });

    }

  } catch (err) {

    console.error('❌ Failed to start server:', err);

    // Only exit when running locally.
    // Vercel should receive the error through the request handler.

    if (require.main === module) {

      process.exit(1);

    }

  }

}

// Start initialization when running locally.
// Vercel uses the exported Express app below.

if (require.main === module) {

  startServer();

}

// Export Express application for Vercel

module.exports = app;