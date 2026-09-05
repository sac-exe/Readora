const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const razorpay = require('../config/razorpay');
const products = require('../config/products');

const router = express.Router();
const ID_PATTERN = /^[A-Za-z0-9_]+$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

function accountFromSession(req) {
  if (req.session?.userId && req.session?.staffId) return null;
  if (req.session?.userId && ObjectId.isValid(req.session.userId)) {
    return { accountType: 'user', accountId: new ObjectId(req.session.userId), collection: 'user' };
  }
  if (req.session?.staffId && ObjectId.isValid(req.session.staffId)) {
    return { accountType: 'staff', accountId: new ObjectId(req.session.staffId), collection: 'staff' };
  }
  return null;
}

function credentialsAvailable() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

router.post('/payment/create-order', async (req, res) => {
  const account = accountFromSession(req);
  if (!account) return res.status(401).json({ error: 'Authentication required.' });
  if (!credentialsAvailable()) return res.status(503).json({ error: 'Payments are not configured.' });
  if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'productId')) {
    return res.status(400).json({ error: 'Invalid payment request.' });
  }
  const { productId } = req.body;
  if (typeof productId !== 'string' || !ID_PATTERN.test(productId) || !products[productId]) {
    return res.status(400).json({ error: 'Invalid product.' });
  }
  const product = products[productId];
  if (!Number.isSafeInteger(product.amount) || product.amount < 1) {
    return res.status(503).json({ error: 'This product is not configured for INR payments.' });
  }

  try {
    const receipt = `rd_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const order = await razorpay.orders.create({ amount: product.amount, currency: product.currency, receipt });
    await db.get().collection('payments').insertOne({
      razorpayOrderId: order.id,
      accountType: account.accountType,
      accountId: account.accountId,
      productId,
      expectedAmount: product.amount,
      currency: product.currency,
      status: 'created',
      createdAt: new Date()
    });
    return res.status(201).json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amount: product.amount,
      currency: product.currency,
      product: { id: productId, type: product.type, name: product.membership || `${product.coins} Coins` }
    });
  } catch (error) {
    console.error('Razorpay order creation failed:', error.message);
    return res.status(502).json({ error: 'Unable to create a payment order.' });
  }
});

router.post('/payment/verify', async (req, res) => {
  const account = accountFromSession(req);
  if (!account) return res.status(401).json({ error: 'Authentication required.' });
  if (!credentialsAvailable()) return res.status(503).json({ error: 'Payments are not configured.' });
  const allowedFields = new Set(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']);
  if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(field => !allowedFields.has(field))) {
    return res.status(400).json({ error: 'Invalid payment confirmation.' });
  }
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
  if (![orderId, paymentId].every(value => typeof value === 'string' && ID_PATTERN.test(value))
      || typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
    return res.status(400).json({ error: 'Malformed payment confirmation.' });
  }
  try {
    const payments = db.get().collection('payments');
    const paymentRecord = await payments.findOne({ razorpayOrderId: orderId });
    if (!paymentRecord) return res.status(404).json({ error: 'Payment order not found.' });
    if (paymentRecord.accountType !== account.accountType || !paymentRecord.accountId.equals(account.accountId)) {
      return res.status(403).json({ error: 'This payment order does not belong to this account.' });
    }
    // Razorpay requires the order ID used for this HMAC to come from our server
    // record, never from the Checkout response.
    if (orderId !== paymentRecord.razorpayOrderId) return res.status(400).json({ error: 'Payment order validation failed.' });
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${paymentRecord.razorpayOrderId}|${paymentId}`).digest('hex');
    const signatureMatches = crypto.timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(signature, 'utf8'));
    if (!signatureMatches) return res.status(400).json({ error: 'Payment signature is invalid.' });
    if (paymentRecord.status === 'fulfilled') {
      return paymentRecord.razorpayPaymentId === paymentId
        ? res.json({ success: true, alreadyProcessed: true })
        : res.status(409).json({ error: 'This order has already been fulfilled.' });
    }
    if (paymentRecord.razorpayPaymentId && paymentRecord.razorpayPaymentId !== paymentId) {
      return res.status(409).json({ error: 'This order has already been used with another payment.' });
    }
    const product = products[paymentRecord.productId];
    if (!product || product.amount !== paymentRecord.expectedAmount || product.currency !== paymentRecord.currency) {
      return res.status(409).json({ error: 'Payment product validation failed.' });
    }
    const gatewayPayment = await razorpay.payments.fetch(paymentId);
    if (gatewayPayment.order_id !== paymentRecord.razorpayOrderId || gatewayPayment.amount !== paymentRecord.expectedAmount
        || gatewayPayment.currency !== paymentRecord.currency || gatewayPayment.status !== 'captured') {
      return res.status(409).json({ error: 'Payment has not been captured for this order.' });
    }

    // Atomically bind this Razorpay payment ID to this order before entitlement.
    // A retry with the same ID may resume; another payment ID cannot take over.
    // This uses single-document atomicity, which works even when MongoDB
    // transactions are unavailable on a standalone deployment.
    let claim = await payments.findOneAndUpdate(
      {
        razorpayOrderId: paymentRecord.razorpayOrderId,
        accountType: account.accountType,
        accountId: account.accountId,
        $or: [
          { status: 'created', razorpayPaymentId: { $exists: false } },
          { status: 'processing', razorpayPaymentId: paymentId }
        ]
      },
      { $set: { status: 'processing', razorpayPaymentId: paymentId, processingAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!claim) {
      const current = await payments.findOne({ razorpayOrderId: paymentRecord.razorpayOrderId });
      if (current?.status === 'fulfilled' && current.razorpayPaymentId === paymentId) {
        return res.json({ success: true, alreadyProcessed: true });
      }
      return res.status(409).json({ error: 'This payment order is already being processed.' });
    }

    // A conditional single-document update adds the entitlement and records the
    // payment ID together. Concurrent requests therefore allow exactly one $inc.
    const marker = { fulfilledRazorpayPaymentIds: { $ne: paymentId } };
    const update = product.type === 'coins'
      ? { $inc: { coins: product.coins }, $addToSet: { fulfilledRazorpayPaymentIds: paymentId } }
      : {
        $set: { 'plan.name': product.membership, 'plan.expires': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), profileFrame: product.frame },
        $inc: { coins: product.bonusCoins },
        $addToSet: { fulfilledRazorpayPaymentIds: paymentId }
    };
    const accounts = db.get().collection(account.collection);
    const applied = await accounts.updateOne({ _id: account.accountId, ...marker }, update);
    let alreadyApplied = false;
    if (!applied.matchedCount) {
      const existingAccount = await accounts.findOne(
        { _id: account.accountId },
        { projection: { fulfilledRazorpayPaymentIds: 1 } }
      );
      if (!existingAccount || !existingAccount.fulfilledRazorpayPaymentIds?.includes(paymentId)) {
        // Leave the payment in processing so a later retry can safely recover.
        throw new Error('Payment entitlement could not be applied.');
      }
      alreadyApplied = true;
    }
    try {
      await db.get().collection('coin_transactions').insertOne({
        userType: account.accountType,
        ...(account.accountType === 'user' ? { userId: account.accountId } : { staffId: account.accountId }),
        type: product.type === 'coins' ? 'coin_purchase' : `membership_${paymentRecord.productId.replace('membership_', '')}_bonus`,
        amount: product.type === 'coins' ? product.coins : product.bonusCoins,
        productId: paymentRecord.productId, paymentMethod: 'razorpay', razorpayOrderId: paymentRecord.razorpayOrderId,
        razorpayPaymentId: paymentId, status: 'success', createdAt: new Date()
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existingTransaction = await db.get().collection('coin_transactions').findOne(
        { razorpayPaymentId: paymentId },
        { projection: { razorpayOrderId: 1 } }
      );
      if (!existingTransaction || existingTransaction.razorpayOrderId !== paymentRecord.razorpayOrderId) throw error;
    }
    await payments.updateOne(
      { razorpayOrderId: paymentRecord.razorpayOrderId, razorpayPaymentId: paymentId },
      { $set: { status: 'fulfilled', fulfilledAt: new Date() }, $unset: { processingAt: '' } }
    );
    return res.json({ success: true, alreadyProcessed: alreadyApplied });
  } catch (error) {
    console.error('Razorpay verification failed:', error.message);
    return res.status(500).json({ error: 'Unable to verify payment.' });
  }
});

module.exports = router;
