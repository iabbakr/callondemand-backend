const express    = require('express');
const dotenv     = require('dotenv');
const cors       = require('cors');
const axios      = require('axios');
const crypto     = require('crypto');
const admin      = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

dotenv.config();

// ============================================
// FIREBASE INITIALIZATION
// ============================================
let db;
try {
  if (!process.env.FIREBASE_CREDENTIALS_JSON) throw new Error('FIREBASE_CREDENTIALS_JSON missing.');
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK initialized.');
} catch (error) {
  console.error('❌ CRITICAL ERROR:', error.message);
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MONNIFY CONFIG
// ============================================
const MONNIFY_BASE_URL    = 'https://api.monnify.com';
const MONNIFY_API_KEY     = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY  = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT    = process.env.MONNIFY_CONTRACT_CODE;
const MONNIFY_WALLET_ACCT = process.env.MONNIFY_WALLET_ACCOUNT_NUMBER;

const monnifyBasicAuth = () =>
  'Basic ' + Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');

async function getMonnifyToken() {
  const res = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
    headers: { Authorization: monnifyBasicAuth() },
  });
  if (!res.data.requestSuccessful)
    throw new Error(`Monnify auth failed: ${res.data.responseMessage}`);
  return res.data.responseBody.accessToken;
}

console.log('🔧 Monnify Config:');
console.log('API Key:        ', MONNIFY_API_KEY     ? '✅ Set' : '❌ Missing');
console.log('Secret Key:     ', MONNIFY_SECRET_KEY  ? '✅ Set' : '❌ Missing');
console.log('Contract Code:  ', MONNIFY_CONTRACT    ? '✅ Set' : '❌ Missing');
console.log('Wallet Account: ', MONNIFY_WALLET_ACCT ? '✅ Set' : '❌ Missing');

// ============================================
// CLOUDINARY CONFIG
// ============================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());

// ============================================
// HEALTH
// ============================================
app.get('/health', (req, res) => res.status(200).send('Server is alive'));

app.get('/api/server-ip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json');
    res.json({ ip: r.data.ip, note: 'Whitelist this in Monnify Dashboard → Settings → API Settings' });
  } catch (e) {
    res.status(500).json({ error: 'Could not determine IP' });
  }
});

// ============================================
// PAYMENT DONE REDIRECT PAGE
// ✅ FIX: Monnify redirects here after payment.  The WebView detects the URL
//         and triggers verification.  Without this route the backend returns
//         a 404 which some WebView implementations handle differently across
//         Android/iOS, occasionally preventing the navigation-state-change
//         callback from firing.  A proper 200 response removes that ambiguity.
// ============================================
app.get('/payment/done', (req, res) => {
  const { paymentStatus = 'UNKNOWN', transactionReference = '' } = req.query;
  res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Payment ${paymentStatus}</title>
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
                 justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb; }
          .card { background: #fff; border-radius: 16px; padding: 40px 32px;
                  text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,.08); max-width: 340px; }
          .icon { font-size: 52px; margin-bottom: 12px; }
          h2 { margin: 0 0 8px; font-size: 20px; color: #111; }
          p  { margin: 0; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${paymentStatus === 'PAID' ? '✅' : paymentStatus === 'FAILED' ? '❌' : '⏳'}</div>
          <h2>${paymentStatus === 'PAID' ? 'Payment Successful' : paymentStatus === 'FAILED' ? 'Payment Failed' : 'Processing…'}</h2>
          <p>Please return to the app — your wallet is being updated.</p>
        </div>
      </body>
    </html>
  `);
});

// ============================================
// MONNIFY WEBHOOK  (raw body BEFORE express.json)
// ============================================
app.post('/api/monnify/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['monnify-signature'];
    const hash      = crypto
      .createHmac('sha512', MONNIFY_SECRET_KEY)
      .update(req.body)
      .digest('hex');

    if (hash !== signature) {
      console.warn('⚠️ Invalid webhook signature');
      return res.status(200).send('Invalid Signature');
    }

    const event = JSON.parse(req.body.toString());
    console.log('📩 Webhook:', event.eventType);

    // ── Successful payment ────────────────────────────────────────────────
    if (event.eventType === 'SUCCESSFUL_TRANSACTION') {
      const { paymentReference, transactionReference, amountPaid } = event.eventData;

      const txnRef  = db.collection('transactions').doc(paymentReference);
      const txnSnap = await txnRef.get();

      // ✅ Idempotency: skip if already processed (client-side verify may have
      //    run first and already credited the wallet).
      if (!txnSnap.exists || txnSnap.data().status === 'success') {
        console.log(`⏭️  Webhook: ${paymentReference} already processed — skipping.`);
        return res.status(200).send('Already processed');
      }

      const { userId } = txnSnap.data();

      await db.runTransaction(async (t) => {
        // Re-read inside the transaction to catch races with client-side verify
        const freshSnap = await t.get(txnRef);
        if (freshSnap.data()?.status === 'success') {
          throw new Error('ALREADY_CREDITED');
        }

        t.update(db.collection('users').doc(userId), {
          balance:   admin.firestore.FieldValue.increment(amountPaid),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        t.update(txnRef, {
          status:              'success',
          monnifyReference:    transactionReference,
          amountPaid,
          verifiedAt:          admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Write user-level transaction log
      await db
        .collection('users').doc(userId)
        .collection('transactions').doc(paymentReference)
        .set({
          reference:   paymentReference,
          description: 'Wallet Funding via Monnify',
          amount:      amountPaid,
          type:        'credit',
          category:    'wallet_fund',
          status:      'success',
          createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

      console.log(`✅ Webhook credited ₦${amountPaid} → ${userId}`);
    }

    // ── Disbursement result ───────────────────────────────────────────────
    if (
      event.eventType === 'SUCCESSFUL_DISBURSEMENT' ||
      event.eventType === 'FAILED_DISBURSEMENT'
    ) {
      const status = event.eventType === 'SUCCESSFUL_DISBURSEMENT' ? 'success' : 'failed';
      const txnRef = db.collection('transactions').doc(event.eventData.reference);
      const snap   = await txnRef.get();

      if (snap.exists) {
        await txnRef.update({
          status,
          settledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (status === 'failed') {
          const { userId, amount } = snap.data();
          await db.collection('users').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(amount),
          });
          console.warn(`↩️ Disbursement failed — reversed ₦${amount} for ${userId}`);
        }
      }
    }

    res.status(200).send('Webhook Received');
  } catch (err) {
    if (err.message === 'ALREADY_CREDITED') {
      return res.status(200).send('Already credited');
    }
    console.error('❌ Webhook Error:', err.message);
    res.status(200).send('Webhook Error');
  }
});

// ============================================
// JSON BODY PARSER
// ============================================
app.use(express.json({ limit: '10mb' }));

// ============================================
// CLOUDINARY UPLOAD
// ============================================
app.post('/api/upload/image', async (req, res) => {
  try {
    const { fileUri, oldImagePublicId } = req.body;
    if (!fileUri) return res.status(400).json({ error: 'No image data provided' });
    if (oldImagePublicId) {
      try { await cloudinary.uploader.destroy(oldImagePublicId); } catch (_) {}
    }
    const result = await cloudinary.uploader.upload(fileUri, {
      folder:        'profile_pictures',
      resource_type: 'image',
      transformation: [
        { width: 500, height: 500, crop: 'fill', gravity: 'face' },
        { quality: 'auto' },
      ],
    });
    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error('❌ Cloudinary Error:', error.message);
    res.status(500).json({ error: 'Upload failed', message: error.message });
  }
});

// ============================================
// MONNIFY — WALLET FUNDING
// ============================================
app.post('/api/monnify/initialize', async (req, res) => {
  try {
    const { amount, email, customerName, reference } = req.body;
    if (!amount || !email || !reference)
      return res.status(400).json({ error: 'Missing fields' });
    if (!MONNIFY_CONTRACT)
      return res.status(500).json({ error: 'MONNIFY_CONTRACT_CODE not set' });

    const response = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`,
      {
        amount,
        customerName:        customerName || 'Customer',
        customerEmail:       email,
        paymentReference:    reference,
        paymentDescription:  'Wallet Funding',
        currencyCode:        'NGN',
        contractCode:        MONNIFY_CONTRACT,
        redirectUrl:         `${process.env.BACKEND_URL || 'https://callondemand-backend.onrender.com'}/payment/done`,
        paymentMethods:      ['CARD', 'ACCOUNT_TRANSFER'],
      },
      { headers: { Authorization: monnifyBasicAuth() } }
    );

    if (!response.data.requestSuccessful)
      throw new Error(response.data.responseMessage);

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

app.post('/api/monnify/verify', async (req, res) => {
  try {
    const { transactionReference } = req.body;
    if (!transactionReference)
      return res.status(400).json({ error: 'transactionReference required' });

    const token    = await getMonnifyToken();
    const encoded  = encodeURIComponent(transactionReference);
    const response = await axios.get(
      `${MONNIFY_BASE_URL}/api/v2/transactions/${encoded}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.data.requestSuccessful)
      return res.json({ success: false, message: 'Verification failed' });

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

app.post('/api/monnify/transfer', async (req, res) => {
  const { userId, amount, destinationBankCode, destinationAccountNumber, narration } = req.body;
  if (!userId || !amount || !destinationBankCode || !destinationAccountNumber)
    return res.status(400).json({ error: 'Missing required fields' });

  const userRef    = db.collection('users').doc(userId);
  const transferId = `WITHDRAW-${Date.now()}`;

  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      if ((snap.data().balance || 0) < amount) throw new Error('Insufficient balance');
      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });
      t.set(db.collection('transactions').doc(transferId), {
        userId, amount, type: 'debit', status: 'processing', category: 'Withdrawal',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const token = await getMonnifyToken();
    const disbursement = await axios.post(
      `${MONNIFY_BASE_URL}/api/v2/disbursements/single`,
      {
        amount,
        reference:                 transferId,
        narration:                 narration || 'Wallet Withdrawal',
        destinationBankCode,
        destinationAccountNumber,
        currency:                  'NGN',
        sourceAccountNumber:       MONNIFY_WALLET_ACCT,
        destinationAccountName:    '',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!disbursement.data.requestSuccessful)
      throw new Error(disbursement.data.responseMessage);

    await db.collection('transactions').doc(transferId).update({
      status:            'success',
      monnifyReference:  disbursement.data.responseBody?.reference || transferId,
      disbursedAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Withdrawal: ₦${amount} for ${userId}`);
    res.json({ status: true, data: disbursement.data.responseBody });
  } catch (error) {
    console.error('❌ Withdrawal Error:', error.response?.data || error.message);
    try {
      await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
      await db.collection('transactions').doc(transferId).update({ status: 'failed' });
    } catch (e) {
      console.error('❌ CRITICAL: Reversal failed:', e.message);
    }
    res.status(400).json({ error: error.response?.data?.responseMessage || error.message });
  }
});

app.get('/api/monnify/resolve', async (req, res) => {
  const { account_number, bank_code } = req.query;
  if (!account_number || !bank_code)
    return res.status(400).json({ error: 'Missing params' });
  try {
    const token = await getMonnifyToken();
    const r = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/disbursements/account/validate?accountNumber=${account_number}&bankCode=${bank_code}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.data.requestSuccessful) {
      res.json({
        status: true,
        data: {
          account_name:   r.data.responseBody.accountName,
          account_number: r.data.responseBody.accountNumber,
          bank_code,
        },
      });
    } else {
      res.json({ status: false, message: r.data.responseMessage });
    }
  } catch (error) {
    res.status(500).json({ error: 'Account resolution failed' });
  }
});

app.get('/api/monnify/banks', async (req, res) => {
  try {
    const r = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/sdk/transactions/banks`,
      { headers: { Authorization: monnifyBasicAuth() } }
    );
    res.json({ status: true, data: r.data.responseBody });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch banks' });
  }
});

// ============================================
// MONNIFY VAS — Bills Payment
// ⚠️  Email integration-support@monnify.com to activate first!
// ============================================

app.get('/api/vas/billers', async (req, res) => {
  const { category_code } = req.query;
  try {
    const token = await getMonnifyToken();
    const qs    = category_code ? `?category_code=${category_code}&size=50` : '?size=50';
    const r     = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/vas/bills-payment/billers${qs}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ status: true, data: r.data.responseBody });
  } catch (error) {
    console.error('❌ VAS Billers Error:', error.response?.data || error.message);
    res.status(500).json({
      error:   'Failed to fetch billers',
      message: error.response?.data?.responseMessage || error.message,
    });
  }
});

app.get('/api/vas/products', async (req, res) => {
  const { biller_code, category_code } = req.query;
  if (!biller_code) return res.status(400).json({ error: 'biller_code required' });
  try {
    const token = await getMonnifyToken();
    const r = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/vas/bills-payment/biller-products?biller_code=${biller_code}&size=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    let products = r.data.responseBody?.content || [];
    if (category_code)
      products = products.filter(p => p.categories?.some(c => c.code === category_code));
    res.json({ status: true, data: products });
  } catch (error) {
    console.error('❌ VAS Products Error:', error.response?.data || error.message);
    res.status(500).json({
      error:   'Failed to fetch products',
      message: error.response?.data?.responseMessage || error.message,
    });
  }
});

app.post('/api/vas/validate', async (req, res) => {
  const { productCode, customerId } = req.body;
  if (!productCode || !customerId)
    return res.status(400).json({ error: 'productCode and customerId required' });
  try {
    const token = await getMonnifyToken();
    const r = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/vas/bills-payment/validate-customer`,
      { productCode, customerId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!r.data.requestSuccessful)
      return res.json({ status: false, message: r.data.responseMessage });
    res.json({ status: true, data: r.data.responseBody });
  } catch (error) {
    console.error('❌ VAS Validate Error:', error.response?.data || error.message);
    res.status(500).json({
      error:   'Customer validation failed',
      message: error.response?.data?.responseMessage || error.message,
    });
  }
});

app.post('/api/vas/vend', async (req, res) => {
  const {
    userId, productCode, customerId, amount,
    phoneNumber, emailAddress, validationReference, description,
  } = req.body;

  if (!productCode || !customerId || !amount)
    return res.status(400).json({ error: 'productCode, customerId, amount required' });

  const reference      = `VAS-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const userRef        = userId ? db.collection('users').doc(userId) : null;
  let   balanceDebited = false;

  try {
    if (userRef) {
      await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw new Error('User not found');
        if ((snap.data().balance || 0) < amount) throw new Error('Insufficient balance');
        t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });
      });
      balanceDebited = true;
    }

    const token   = await getMonnifyToken();
    const payload = {
      productCode, customerId, amount, reference,
      phoneNumber: phoneNumber || customerId,
      ...(emailAddress        ? { emailAddress }        : {}),
      ...(validationReference ? { validationReference } : {}),
    };

    const r = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/vas/bills-payment/vend`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    if (!r.data.requestSuccessful || r.data.responseBody?.vendStatus === 'FAILED')
      throw new Error(r.data.responseMessage || 'Vend failed');

    const vend = r.data.responseBody;

    if (userId) {
      await db.collection('users').doc(userId).collection('transactions').add({
        reference,
        vendReference: vend.vendReference || reference,
        productCode,
        productName:   vend.productName || description || productCode,
        customerId,
        amount,
        type:     'debit',
        category: 'vas',
        status:   vend.vendStatus === 'SUCCESS' ? 'success' : 'processing',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log(`✅ VAS: ${vend.productName} → ${customerId} [${vend.vendStatus}]`);
    res.json({ status: true, data: vend });
  } catch (error) {
    console.error('❌ VAS Vend Error:', error.response?.data || error.message);
    if (balanceDebited && userRef) {
      try {
        await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
        console.log(`↩️ VAS reversed ₦${amount}`);
      } catch (e) {
        console.error('❌ CRITICAL: VAS reversal failed:', e.message);
      }
    }
    res.status(400).json({ error: error.response?.data?.responseMessage || error.message });
  }
});

app.get('/api/vas/requery', async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'reference required' });
  try {
    const token = await getMonnifyToken();
    const r = await axios.get(
      `${MONNIFY_BASE_URL}/api/v1/vas/bills-payment/requery?reference=${reference}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ status: true, data: r.data.responseBody });
  } catch (error) {
    console.error('❌ VAS Requery Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Requery failed' });
  }
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
app.post('/api/notifications/broadcast', async (req, res) => {
  try {
    const { title, body, type, data } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and Body required' });
    const snap = await db.collection('users').where('expoPushToken', '!=', null).get();
    if (snap.empty) return res.json({ success: true, sentCount: 0 });
    const messages = snap.docs.map(d => ({
      to:    d.data().expoPushToken,
      sound: 'default',
      title, body,
      data:  { ...data, type: type || 'admin_notification', sentAt: new Date().toISOString() },
    }));
    const chunks = [];
    const copy   = [...messages];
    while (copy.length) chunks.push(copy.splice(0, 100));
    await Promise.all(chunks.map(c =>
      axios.post('https://exp.host/--/api/v2/push/send', c, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-encoding': 'gzip, deflate' },
      })
    ));
    res.json({ success: true, sentCount: snap.size });
  } catch (e) {
    res.status(500).json({ error: 'Failed to broadcast' });
  }
});

app.post('/api/notifications/send-to-user', async (req, res) => {
  try {
    const { userId, notification } = req.body;
    if (!userId || !notification) return res.status(400).json({ error: 'Missing params' });
    const d = await db.collection('users').doc(userId).get();
    if (!d.exists) return res.status(404).json({ error: 'User not found' });
    const tok = d.data().expoPushToken;
    if (!tok) return res.json({ success: true, sentCount: 0 });
    await axios.post(
      'https://exp.host/--/api/v2/push/send',
      { to: tok, sound: 'default', title: notification.title, body: notification.body, data: notification.data ?? {} },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    res.json({ success: true, sentCount: 1 });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

app.post('/api/notifications/send', async (req, res) => {
  try {
    const { filters, notification } = req.body;
    if (!notification) return res.status(400).json({ error: 'Missing notification' });
    let q = db.collection('users');
    if (filters?.state) q = q.where('state', '==', filters.state);
    if (filters?.city)  q = q.where('city',  '==', filters.city);
    if (filters?.role)  q = q.where('role',  '==', filters.role);
    const snap = await q.get();
    const msgs = snap.docs
      .map(d => d.data())
      .filter(u => u.expoPushToken)
      .map(u => ({
        to:    u.expoPushToken,
        sound: 'default',
        title: notification.title,
        body:  notification.body,
        data:  notification.data ?? {},
      }));
    if (!msgs.length) return res.json({ success: true, sentCount: 0 });
    await axios.post('https://exp.host/--/api/v2/push/send', msgs, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-encoding': 'gzip, deflate' },
    });
    res.json({ success: true, sentCount: msgs.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// ============================================
// ERROR HANDLING
// ============================================
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server active on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
});