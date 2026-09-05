const Razorpay = require('razorpay');

// This is the only Razorpay SDK instance. Credentials stay server-side.
module.exports = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});
