const express = require('express');
const dotenv  = require('dotenv');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const admin   = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

dotenv.config();

// ============================================
// FIREBASE INITIALIZATION
// ============================================
let db;
try {
  if (!process.env.FIREBASE_CREDENTIALS_JSON) {
    throw new Error('FIREBASE_CREDENTIALS_JSON environment variable is missing.');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK initialized securely.');
} catch (error) {
  console.error('❌ CRITICAL ERROR:', error.message);
  process.exit(1);
}

// ============================================
// SERVER CONFIGURATION
// ============================================
const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MONNIFY CONFIGURATION
// ============================================
const MONNIFY_BASE_URL    = 'https://api.monnify.com';
const MONNIFY_API_KEY     = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY  = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT    = process.env.MONNIFY_CONTRACT_CODE;
const MONNIFY_WALLET_ACCT = process.env.MONNIFY_WALLET_ACCOUNT_NUMBER;

/** Basic auth header for login + low-privilege endpoints */
const monnifyBasicAuth = () =>
  'Basic ' + Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');

/**
 * Get a short-lived Monnify Bearer token.
 * Required for: disbursements, transaction verification, account resolve.
 */
async function getMonnifyToken() {
  const res = await axios.post(
    `${MONNIFY_BASE_URL}/api/v1/auth/login`,
    {},
    { headers: { Authorization: monnifyBasicAuth() } }
  );
  if (!res.data.requestSuccessful) {
    throw new Error(`Monnify auth failed: ${res.data.responseMessage}`);
  }
  return res.data.responseBody.accessToken;
}

console.log('🔧 Monnify Config:');
console.log('API Key:        ', MONNIFY_API_KEY     ? '✅ Set' : '❌ Missing');
console.log('Secret Key:     ', MONNIFY_SECRET_KEY  ? '✅ Set' : '❌ Missing');
console.log('Contract Code:  ', MONNIFY_CONTRACT    ? '✅ Set' : '❌ Missing');
console.log('Wallet Account: ', MONNIFY_WALLET_ACCT ? '✅ Set' : '❌ Missing');

// ============================================
// CLOUDINARY CONFIGURATION
// ============================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('🔧 Cloudinary Config:');
console.log('Cloud Name:', process.env.CLOUDINARY_CLOUD_NAME ? '✅ Set' : '❌ Missing');
console.log('API Key:   ', process.env.CLOUDINARY_API_KEY    ? '✅ Set' : '❌ Missing');
console.log('API Secret:', process.env.CLOUDINARY_API_SECRET ? '✅ Set' : '❌ Missing');

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());

// ============================================
// ROUTES - HEALTH & MONITORING
// ============================================
app.get('/health', (req, res) => {
  res.status(200).send('Server is alive');
});

/**
 * SERVER IP HELPER
 * Visit https://callondemand-backend.onrender.com/api/server-ip
 * Copy the "ip" value and add it to Monnify Dashboard → Settings → API Settings → Whitelist IP
 * Then DELETE or protect this route.
 */
app.get('/api/server-ip', async (req, res) => {
  try {
    const result = await axios.get('https://api.ipify.org?format=json');
    console.log('🌐 Server outbound IP:', result.data.ip);
    res.json({ ip: result.data.ip, note: 'Add this IP to Monnify Dashboard → Settings → API Settings → Whitelist IP, then remove this route.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not determine IP', message: err.message });
  }
});

// ============================================
// ROUTES - MONNIFY WEBHOOK  (Raw body — BEFORE express.json())
// ============================================
app.post(
  '/api/monnify/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.headers['monnify-signature'];
      const hash = crypto
        .createHmac('sha512', MONNIFY_SECRET_KEY)
        .update(req.body)
        .digest('hex');

      if (hash !== signature) {
        console.warn('⚠️  Monnify webhook: invalid signature');
        return res.status(200).send('Invalid Signature');
      }

      const event = JSON.parse(req.body.toString());
      console.log('📩 Monnify Webhook event:', event.eventType);

      // ── Wallet funding ──────────────────────────────────────────────────
      if (event.eventType === 'SUCCESSFUL_TRANSACTION') {
        const body         = event.eventData;
        const payReference = body.paymentReference;
        const txnReference = body.transactionReference;
        const amountPaid   = body.amountPaid;

        const txnRef  = db.collection('transactions').doc(payReference);
        const txnSnap = await txnRef.get();

        if (!txnSnap.exists || txnSnap.data().status === 'success') {
          return res.status(200).send('Already processed or unknown');
        }

        const userId  = txnSnap.data().userId;
        const userRef = db.collection('users').doc(userId);

        await db.runTransaction(async (t) => {
          t.update(userRef, { balance: admin.firestore.FieldValue.increment(amountPaid) });
          t.update(txnRef, {
            status:           'success',
            monnifyReference: txnReference,
            amountPaid,
            verifiedAt:       admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        // Also update the user's transactions subcollection
        await db.collection('users').doc(userId).collection('transactions').doc(payReference).set({
          reference:   payReference,
          description: 'Wallet Funding via Monnify',
          amount:      amountPaid,
          type:        'credit',
          category:    'wallet_fund',
          status:      'success',
          createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`✅ Webhook credited ₦${amountPaid} for user ${userId}`);
      }

      // ── Disbursement completion ─────────────────────────────────────────
      if (event.eventType === 'SUCCESSFUL_DISBURSEMENT' || event.eventType === 'FAILED_DISBURSEMENT') {
        const body      = event.eventData;
        const reference = body.reference;
        const status    = event.eventType === 'SUCCESSFUL_DISBURSEMENT' ? 'success' : 'failed';

        const txnRef = db.collection('transactions').doc(reference);
        const snap   = await txnRef.get();

        if (snap.exists) {
          await txnRef.update({ status, settledAt: admin.firestore.FieldValue.serverTimestamp() });

          // If disbursement failed, reverse the balance
          if (status === 'failed') {
            const userId  = snap.data().userId;
            const amount  = snap.data().amount;
            await db.collection('users').doc(userId).update({
              balance: admin.firestore.FieldValue.increment(amount),
            });
            console.warn(`↩️  Disbursement failed — reversed ₦${amount} for user ${userId}`);
          }
        }

        console.log(`📩 Disbursement webhook: ${reference} → ${status}`);
      }

      res.status(200).send('Webhook Received');
    } catch (err) {
      console.error('❌ Webhook Error:', err.message);
      res.status(200).send('Webhook Error');
    }
  }
);

// ============================================
// JSON BODY PARSER (10 MB for Base64 images)
// ============================================
app.use(express.json({ limit: '10mb' }));

// ============================================
// ROUTES - CLOUDINARY
// ============================================
app.post('/api/upload/image', async (req, res) => {
  try {
    const { fileUri, oldImagePublicId } = req.body;

    if (!fileUri) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    console.log('📊 Upload payload:', Math.round(fileUri.length / 1024), 'KB');

    if (oldImagePublicId) {
      try {
        await cloudinary.uploader.destroy(oldImagePublicId);
      } catch (err) {
        console.warn('⚠️ Cleanup failed:', err.message);
      }
    }

    const result = await cloudinary.uploader.upload(fileUri, {
      folder:         'profile_pictures',
      resource_type:  'image',
      transformation: [
        { width: 500, height: 500, crop: 'fill', gravity: 'face' },
        { quality: 'auto' },
      ],
    });

    console.log('✅ Cloudinary upload successful:', result.secure_url);
    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error('❌ Cloudinary Route Error:', error.message);
    res.status(500).json({ error: 'Failed to upload to Cloudinary', message: error.message });
  }
});

// ============================================
// ROUTES - MONNIFY TRANSACTIONS
// ============================================

/**
 * INITIALIZE PAYMENT — uses Basic auth (no token needed for init)
 */
app.post('/api/monnify/initialize', async (req, res) => {
  try {
    const { amount, email, customerName, reference } = req.body;

    if (!amount || !email || !reference) {
      return res.status(400).json({ error: 'Missing required fields: amount, email, reference' });
    }
    if (!MONNIFY_CONTRACT) {
      return res.status(500).json({ error: 'MONNIFY_CONTRACT_CODE not configured on server' });
    }

    const response = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`,
      {
        amount,
        customerName:       customerName || 'Customer',
        customerEmail:      email,
        paymentReference:   reference,
        paymentDescription: 'Wallet Funding',
        currencyCode:       'NGN',
        contractCode:       MONNIFY_CONTRACT,
        redirectUrl:        'https://callondemand-backend.onrender.com/payment/done',
        paymentMethods:     ['CARD', 'ACCOUNT_TRANSFER'],
      },
      { headers: { Authorization: monnifyBasicAuth() } }
    );

    if (!response.data.requestSuccessful) {
      throw new Error(response.data.responseMessage || 'Monnify init failed');
    }

    const body = response.data.responseBody;
    res.json({
      success:          true,
      checkoutUrl:      body.checkoutUrl,
      transactionRef:   body.transactionReference,
      paymentReference: reference,
    });
  } catch (error) {
    console.error('❌ Monnify Init Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initialization failed', message: error.message });
  }
});

/**
 * VERIFY PAYMENT — FIX: now uses Bearer token (Basic auth not accepted here)
 */
app.post('/api/monnify/verify', async (req, res) => {
  try {
    const { transactionReference } = req.body;

    if (!transactionReference) {
      return res.status(400).json({ error: 'transactionReference is required' });
    }

    // ✅ Must use Bearer token — Basic auth returns 401 on this endpoint
    const token   = await getMonnifyToken();
    const encoded = encodeURIComponent(transactionReference);

    const response = await axios.get(
      `${MONNIFY_BASE_URL}/api/v2/transactions/${encoded}`,
      { headers: { Authorization: `Bearer ${token}` } }  // ← fixed
    );

    if (!response.data.requestSuccessful) {
      return res.json({ success: false, message: 'Verification failed' });
    }

    const txn = response.data.responseBody;
    res.json({
      success:              txn.paymentStatus === 'PAID',
      paymentStatus:        txn.paymentStatus,
      amountPaid:           txn.amountPaid,
      paymentReference:     txn.paymentReference,
      transactionReference: txn.transactionReference,
      data:                 txn,
    });
  } catch (error) {
    console.error('❌ Monnify Verify Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'Verification failed', message: error.message });
  }
});

/**
 * WITHDRAWAL via Monnify Disbursements
 * ⚠️  Requires your server IP to be whitelisted in Monnify Dashboard first.
 * Visit /api/server-ip to get the IP, then add it in Monnify → Settings → API Settings → Whitelist IP
 */
app.post('/api/monnify/transfer', async (req, res) => {
  const { userId, amount, destinationBankCode, destinationAccountNumber, narration } = req.body;

  if (!userId || !amount || !destinationBankCode || !destinationAccountNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const userRef    = db.collection('users').doc(userId);
  const transferId = `WITHDRAW-${Date.now()}`;

  try {
    // 1. Deduct balance atomically in Firestore
    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const balance = userSnap.data().balance || 0;
      if (balance < amount) throw new Error('Insufficient balance');

      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });

      const txnRef = db.collection('transactions').doc(transferId);
      t.set(txnRef, {
        userId,
        amount,
        type:      'debit',
        status:    'processing',
        category:  'Withdrawal',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 2. Initiate Monnify disbursement (Bearer token required)
    const token = await getMonnifyToken();

    const disbursement = await axios.post(
      `${MONNIFY_BASE_URL}/api/v2/disbursements/single`,
      {
        amount,
        reference:               transferId,
        narration:               narration || 'Wallet Withdrawal',
        destinationBankCode,
        destinationAccountNumber,
        currency:                'NGN',
        sourceAccountNumber:     MONNIFY_WALLET_ACCT,
        destinationAccountName:  '',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!disbursement.data.requestSuccessful) {
      throw new Error(disbursement.data.responseMessage || 'Disbursement failed');
    }

    // 3. Mark as success (webhook will also fire — merge: true avoids duplication)
    await db.collection('transactions').doc(transferId).update({
      status:           'success',
      monnifyReference: disbursement.data.responseBody?.reference || transferId,
      disbursedAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Withdrawal initiated: ₦${amount} for user ${userId}`);
    res.json({ status: true, data: disbursement.data.responseBody });
  } catch (error) {
    console.error('❌ Withdrawal Error:', error.response?.data || error.message);

    // Reverse balance if Firestore was already debited
    try {
      await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
      await db.collection('transactions').doc(transferId).update({ status: 'failed' });
      console.log('↩️  Balance reversed after failed disbursement');
    } catch (reverseErr) {
      console.error('❌ CRITICAL: Reversal failed:', reverseErr.message);
    }

    res.status(400).json({ error: error.response?.data?.responseMessage || error.message });
  }
});

/**
 * RESOLVE BANK ACCOUNT — Bearer token required
 */
app.get('/api/monnify/resolve', async (req, res) => {
  const { account_number, bank_code } = req.query;

  if (!account_number || !bank_code) {
    return res.status(400).json({ error: 'Missing account_number or bank_code' });
  }

  try {
    const token    = await getMonnifyToken();
    const response = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/disbursements/account/validate?accountNumber=${account_number}&bankCode=${bank_code}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (response.data.requestSuccessful) {
      res.json({
        status: true,
        data: {
          account_name:   response.data.responseBody.accountName,
          account_number: response.data.responseBody.accountNumber,
          bank_code,
        },
      });
    } else {
      res.json({ status: false, message: response.data.responseMessage });
    }
  } catch (error) {
    console.error('❌ Account resolution error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Account resolution failed' });
  }
});

/**
 * GET SUPPORTED BANKS — Basic auth is fine here
 */
app.get('/api/monnify/banks', async (req, res) => {
  try {
    const response = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/sdk/transactions/banks`,
      { headers: { Authorization: monnifyBasicAuth() } }
    );
    res.json({ status: true, data: response.data.responseBody });
  } catch (error) {
    console.error('❌ Banks fetch error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch banks' });
  }
});

// ============================================
// ROUTES - PUSH NOTIFICATIONS
// ============================================
app.post('/api/notifications/broadcast', async (req, res) => {
  try {
    const { title, body, type, data } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and Body are required' });

    const usersSnap = await db.collection('users').where('expoPushToken', '!=', null).get();
    if (usersSnap.empty) return res.json({ success: true, sentCount: 0 });

    const messages = usersSnap.docs.map(doc => ({
      to: doc.data().expoPushToken, sound: 'default', title, body,
      data: { ...data, type: type || 'admin_notification', sentAt: new Date().toISOString() },
    }));

    const chunks = [];
    const copy = [...messages];
    while (copy.length > 0) chunks.push(copy.splice(0, 100));

    await Promise.all(chunks.map(chunk =>
      axios.post('https://exp.host/--/api/v2/push/send', chunk, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-encoding': 'gzip, deflate' },
      })
    ));

    console.log(`✅ Broadcast complete: ${usersSnap.size} notifications pushed.`);
    res.json({ success: true, sentCount: usersSnap.size });
  } catch (error) {
    console.error('❌ Broadcast Error:', error.message);
    res.status(500).json({ error: 'Failed to process broadcast' });
  }
});

app.post('/api/notifications/send-to-user', async (req, res) => {
  try {
    const { userId, notification } = req.body;
    if (!userId || !notification) return res.status(400).json({ error: 'Missing userId or notification' });

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const expoPushToken = userDoc.data().expoPushToken;
    if (!expoPushToken) return res.json({ success: true, sentCount: 0 });

    await axios.post('https://exp.host/--/api/v2/push/send',
      { to: expoPushToken, sound: 'default', title: notification.title, body: notification.body, data: notification.data ?? {} },
      { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );

    res.json({ success: true, sentCount: 1 });
  } catch (error) {
    console.error('❌ User Notification Error:', error.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  try {
    const { filters, notification } = req.body;
    if (!notification) return res.status(400).json({ error: 'Missing notification' });

    let query = db.collection('users');
    if (filters?.state) query = query.where('state', '==', filters.state);
    if (filters?.city)  query = query.where('city',  '==', filters.city);
    if (filters?.role)  query = query.where('role',  '==', filters.role);

    const snap     = await query.get();
    const messages = snap.docs.map(d => d.data()).filter(u => u.expoPushToken).map(user => ({
      to: user.expoPushToken, sound: 'default', title: notification.title,
      body: notification.body, data: notification.data ?? {},
    }));

    if (messages.length === 0) return res.json({ success: true, sentCount: 0 });

    await axios.post('https://exp.host/--/api/v2/push/send', messages, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-encoding': 'gzip, deflate' },
    });

    res.json({ success: true, sentCount: messages.length });
  } catch (error) {
    console.error('❌ Bulk Notification Error:', error.message);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// ============================================
// ROUTES - VTPASS PROXY
// ============================================
const VTPASS_BASE_URL = 'https://vtpass.com/api';

app.get('/api/vtpass/get-plans', async (req, res) => {
  const { serviceID } = req.query;
  if (!serviceID) return res.status(400).json({ status: false, error: 'serviceID is required' });
  try {
    const response = await axios.get(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'public-key': process.env.VTPASS_PUBLIC_KEY },
    });
    res.json({ status: true, data: response.data });
  } catch (error) {
    console.error('❌ Get Plans Error:', error.response?.data || error.message);
    res.status(500).json({ status: false, error: 'Failed to fetch plans' });
  }
});

app.post('/api/vtpass/pay', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/pay`, req.body, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY, 'Content-Type': 'application/json' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('❌ VTpass Pay Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.response_description || 'VTpass service error' });
  }
});

app.post('/api/vtpass/verify', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/merchant-verify`, req.body, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY, 'Content-Type': 'application/json' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('❌ VTpass Verify Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/vtpass/requery', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/requery`, req.body, {
      headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Requery failed' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err);
  res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Render Server active on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
});