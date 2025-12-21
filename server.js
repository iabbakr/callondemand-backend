const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const cloudinary = require('cloudinary').v2; 
const crypto = require('crypto'); 
const admin = require('firebase-admin'); 

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
  console.error('❌ CRITICAL ERROR: Firebase Admin SDK initialization failed.', error.message);
  process.exit(1); 
}

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_BASE_API = 'https://api.paystack.co';

app.use(cors()); 

// Webhook endpoint MUST use express.raw for signature verification
app.post('/api/paystack/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const signature = req.headers['x-paystack-signature'];
  
  const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

  if (hash !== signature) {
      return res.status(200).send('Signature verification failed.');
  }

  const event = JSON.parse(req.body.toString()); 
  const reference = event.data?.reference;

  if (event.event === 'charge.success' && reference) {
      try {
          const verificationResponse = await axios.get(
              `${PAYSTACK_BASE_API}/transaction/verify/${reference}`,
              { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
          );

          const verifiedData = verificationResponse.data.data;

          if (verifiedData.status === 'success') {
              const amountInNGN = verifiedData.amount / 100;
              const txnRef = db.collection('transactions').doc(reference);
              const txnSnap = await txnRef.get();

              if (!txnSnap.exists) return res.status(200).send('Transaction record not found.');

              const txnData = txnSnap.data();
              if (txnData.status === 'success') return res.status(200).send('Already processed.');
              
              const userRef = db.collection('users').doc(txnData.userId);

              await db.runTransaction(async (t) => {
                const userDoc = await t.get(userRef);
                if (!userDoc.exists) throw new Error("User not found.");
                
                t.update(userRef, { balance: admin.firestore.FieldValue.increment(amountInNGN) });
                t.update(txnRef, { 
                    status: 'success', 
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    amount_credited: amountInNGN,
                });

                const userTxRef = userRef.collection('transactions').doc();
                t.set(userTxRef, {
                    description: `Wallet Top-up (Paystack)`,
                    amount: amountInNGN,
                    type: 'credit',
                    category: 'Wallet Deposit',
                    status: 'success',
                    date: admin.firestore.FieldValue.serverTimestamp(),
                    reference: reference,
                });
              });
          }
      } catch (error) {
          console.error('Webhook processing failed:', error.message);
      }
  }
  res.status(200).send('Webhook Received');
});

// Regular JSON parser for other routes
app.use(express.json({ limit: '5mb' })); 

app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    const response = await axios.post(
      `${PAYSTACK_BASE_API}/transaction/initialize`,
      { amount: amount * 100, email, reference },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data?.message || 'Payment init failed' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));