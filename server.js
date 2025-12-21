const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); 
const admin = require('firebase-admin'); 

dotenv.config();

let db;
try {
  if (!process.env.FIREBASE_CREDENTIALS_JSON) {
    throw new Error("FIREBASE_CREDENTIALS_JSON variable is missing.");
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

app.use(cors()); 

// Webhook logic (express.raw) remains identical for signature verification...
app.post('/api/paystack/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
  if (hash !== signature) return res.status(200).send('Invalid Signature');

  const event = JSON.parse(req.body.toString()); 
  const reference = event.data?.reference;

  if (event.event === 'charge.success' && reference) {
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
                t.set(userRef.collection('transactions').doc(), {
                    description: `Wallet Top-up`,
                    amount: amountInNGN,
                    type: 'credit',
                    category: 'Wallet Deposit',
                    status: 'success',
                    date: admin.firestore.FieldValue.serverTimestamp(),
                });
              });
          }
      } catch (error) { console.error('Webhook Error:', error.message); }
  }
  res.status(200).send('Webhook Received');
});

app.use(express.json({ limit: '5mb' })); 

// --- SECURE TRANSFER ENDPOINT ---
app.post('/api/paystack/transfer', async (req, res) => {
  const { userId, amount, recipientCode } = req.body;
  if (!userId || !amount || !recipientCode) return res.status(400).json({ error: 'Missing data' });

  const userRef = db.collection('users').doc(userId);
  const transferId = `WITHDRAW-${Date.now()}`;

  try {
    const result = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');
      
      const balance = userSnap.data().balance || 0;
      if (balance < amount) throw new Error('Insufficient balance');

      // 1. DEDUCT LOCALLY FIRST
      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });

      // 2. TRIGGER PAYSTACK
      const pRes = await axios.post(`${PAYSTACK_BASE_API}/transfer`, {
        source: "balance",
        amount: amount * 100,
        recipient: recipientCode,
        reason: "Wallet Withdrawal",
        reference: transferId
      }, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });

      // 3. LOG TRANSACTION
      const txnRef = db.collection('transactions').doc(transferId);
      t.set(txnRef, {
        userId, amount, type: 'debit', status: 'success',
        category: 'Withdrawal', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return pRes.data;
    });
    res.json({ status: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    const response = await axios.post(`${PAYSTACK_BASE_API}/transaction/initialize`,
      { amount: amount * 100, email, reference },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json(response.data);
  } catch (error) { res.status(500).json({ error: 'Init failed' }); }
});

app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));