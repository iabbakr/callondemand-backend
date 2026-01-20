const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

dotenv.config();

let db;
try {
  if (!process.env.FIREBASE_CREDENTIALS_JSON) {
    throw new Error("FIREBASE_CREDENTIALS_JSON environment variable is missing.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK initialized securely.');
} catch (error) {
  console.error('❌ CRITICAL ERROR:', error.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_BASE_API = 'https://api.paystack.co';

// --- CONFIGURATIONS ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors());

// --- ROUTES ---

/**
 * 1. PAYSTACK WEBHOOK
 * Must stay above express.json() to handle raw body signature verification
 */
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
  
  if (hash !== req.headers['x-paystack-signature']) return res.status(200).send('Invalid Signature');

  const event = JSON.parse(req.body.toString());
  if (event.event === 'charge.success') {
    const reference = event.data?.reference;
    try {
      const vRes = await axios.get(`${PAYSTACK_BASE_API}/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      const verifiedData = vRes.data.data;

      if (verifiedData.status === 'success') {
        const amountInNGN = verifiedData.amount / 100;
        const txnRef = db.collection('transactions').doc(reference);
        const txnSnap = await txnRef.get();
        
        if (!txnSnap.exists || txnSnap.data().status === 'success') return res.status(200).send('Done');

        const userId = txnSnap.data().userId;
        const userRef = db.collection('users').doc(userId);

        await db.runTransaction(async (t) => {
          t.update(userRef, { balance: admin.firestore.FieldValue.increment(amountInNGN) });
          t.update(txnRef, { status: 'success', verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
        });
      }
    } catch (error) {
      console.error('Webhook Error:', error.message);
    }
  }
  res.status(200).send('Webhook Received');
});

// Middleware for parsing JSON (Applied after raw webhook to allow large image payloads)
app.use(express.json({ limit: '10mb' }));

/**
 * 2. SECURE CLOUDINARY UPLOAD
 */
app.post('/api/upload/image', async (req, res) => {
  try {
    const { fileUri } = req.body; // Base64 string from Expo
    if (!fileUri) return res.status(400).json({ error: "No image data provided" });

    const result = await cloudinary.uploader.upload(fileUri, {
      folder: 'profile_pictures',
      resource_type: 'image'
    });

    res.json({ url: result.secure_url });
  } catch (error) {
    console.error('Cloudinary Upload Error:', error);
    res.status(500).json({ error: 'Failed to upload image to Cloudinary' });
  }
});

/**
 * 3. SECURE WITHDRAWAL (TRANSFER)
 */
app.post('/api/paystack/transfer', async (req, res) => {
  const { userId, amount, recipientCode } = req.body;
  if (!userId || !amount || !recipientCode) return res.status(400).json({ error: 'Missing required fields' });

  const userRef = db.collection('users').doc(userId);
  const transferId = `WITHDRAW-${Date.now()}`;

  try {
    const result = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const balance = userSnap.data().balance || 0;
      if (balance < amount) throw new Error('Insufficient wallet balance');

      // Deduct balance locally
      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });

      // Trigger Paystack
      const pRes = await axios.post(`${PAYSTACK_BASE_API}/transfer`, {
        source: "balance",
        amount: amount * 100,
        recipient: recipientCode,
        reason: "Wallet Withdrawal",
        reference: transferId
      }, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });

      // Log Transaction
      const txnRef = db.collection('transactions').doc(transferId);
      t.set(txnRef, {
        userId, amount, type: 'debit', status: 'success',
        category: 'Withdrawal', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return pRes.data;
    });
    res.json({ status: true, data: result });
  } catch (error) {
    console.error('Transfer Error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * 4. INITIALIZE PAYMENT (DEPOSIT)
 */
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    const response = await axios.post(`${PAYSTACK_BASE_API}/transaction/initialize`,
      { amount: amount * 100, email, reference },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Init failed' });
  }
});

/**
 * 5. RESOLVE BANK ACCOUNT
 */
app.get('/api/paystack/resolve', async (req, res) => {
  const { account_number, bank_code } = req.query;

  if (!account_number || !bank_code) {
    return res.status(400).json({ error: 'Account number and bank code are required' });
  }

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_API}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Paystack Resolve Error:', error.response?.data || error.message);
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || 'Could not verify account';
    res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => console.log(`🚀 Production server on port ${PORT}`));