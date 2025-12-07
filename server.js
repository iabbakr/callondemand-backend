const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const cloudinary = require('cloudinary').v2; 
const crypto = require('crypto'); 
const admin = require('firebase-admin'); 

// Load environment variables from .env file
dotenv.config();

// =================================================================
// ⚠️ START: SECURE FIREBASE ADMIN SDK INITIALIZATION (Production Ready)
// =================================================================

// 1. Check for the secure environment variable and parse the JSON string.
// This relies on you setting FIREBASE_CREDENTIALS_JSON in your hosting environment.
let db;
try {
  if (!process.env.FIREBASE_CREDENTIALS_JSON) {
    throw new Error("FIREBASE_CREDENTIALS_JSON environment variable is missing.");
  }
  
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
  
  // 2. Initialize Firebase Admin SDK with the credentials.
  admin.initializeApp({ 
    credential: admin.credential.cert(serviceAccount) 
  });
  
  db = admin.firestore(); // Assign the Firestore instance
  console.log('✅ Firebase Admin SDK initialized securely.');
  
} catch (error) {
  // If initialization fails (missing variable, invalid JSON, etc.), log and exit.
  console.error('❌ CRITICAL ERROR: Firebase Admin SDK initialization failed.', error.message);
  // In a production app, stopping startup is usually the safest action.
  process.exit(1); 
}

// =================================================================
// ⚠️ END: SECURE FIREBASE ADMIN SDK INITIALIZATION
// =================================================================


const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_BASE_API = 'https://api.paystack.co';

// --- Middlewares ---
app.use(cors()); 
// General JSON parser for all non-webhook endpoints
app.use(express.json({ limit: '5mb' })); 

// --- Cloudinary Configuration (Secure Method) ---
// Note: Relying on environment variables set in .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// ====================================================================
// PAYSTACK PROXY ENDPOINTS
// ====================================================================

// --- 1. Paystack Proxy Endpoint: Initialize Transaction ---
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    
    if (!amount || !email) {
        return res.status(400).json({ error: 'Missing amount or email' });
    }

    const paystackResponse = await axios.post(
      `${PAYSTACK_BASE_API}/transaction/initialize`,
      { amount: amount * 100, email, reference }, // Paystack uses Kobo/Cent
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Initialization Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.message || 'Payment initialization failed.';
    res.status(500).json({ error: errorMessage });
  }
});

// --- 1.1. Paystack Proxy Endpoint: Resolve Bank Account ---
app.get('/api/paystack/resolve', async (req, res) => {
  try {
    const { account_number, bank_code } = req.query;

    if (!account_number || !bank_code) {
      return res.status(400).json({ error: 'Missing account_number or bank_code' });
    }

    const paystackResponse = await axios.get(
      `${PAYSTACK_BASE_API}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Resolve Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.message || 'Bank verification failed.';
    res.status(500).json({ error: errorMessage });
  }
});

// --- 1.2. Paystack Proxy Endpoint: Verify Transaction ---
app.get('/api/paystack/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const paystackResponse = await axios.get(
      `${PAYSTACK_BASE_API}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Verify Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.message || 'Transaction verification failed.';
    res.status(500).json({ error: errorMessage });
  }
});

// --- 1.3. Paystack Proxy Endpoint: Create Transfer Recipient ---
app.post('/api/paystack/recipient', async (req, res) => {
  try {
    const { name, account_number, bank_code, currency = 'NGN' } = req.body;

    const paystackResponse = await axios.post(
      `${PAYSTACK_BASE_API}/transferrecipient`,
      { type: 'nuban', name, account_number, bank_code, currency },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Recipient Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.message || 'Error creating transfer recipient.';
    res.status(500).json({ error: errorMessage });
  }
});

// --- 1.4. Paystack Proxy Endpoint: Initiate Transfer/Withdrawal ---
app.post('/api/paystack/transfer', async (req, res) => {
  try {
    const { recipient, amount, reason = 'Wallet withdrawal' } = req.body;
    
    if (!recipient || !amount) {
      return res.status(400).json({ error: 'Missing recipient or amount' });
    }

    const paystackResponse = await axios.post(
      `${PAYSTACK_BASE_API}/transfer`,
      { recipient, amount: amount * 100, reason, source: 'balance' }, // Amount in Kobo
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Transfer Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.message || 'Withdrawal/Transfer failed.';
    res.status(500).json({ error: errorMessage });
  }
});

// --------------------------------------------------------------------
// ✅ PAYSTACK WEBHOOK ENDPOINT (Uses express.raw for signature verification)
// --------------------------------------------------------------------
// Use express.raw() middleware ONLY for this endpoint to get the raw body
app.post('/api/paystack/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  
  // 1. Verify Signature (must use raw body)
  const hash = crypto.createHmac('sha512', secret)
                     .update(req.body) 
                     .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
      console.warn('Webhook signature mismatch. Request ignored.');
      return res.status(200).send('Signature verification failed.');
  }

  // Parse the raw body into a JSON object AFTER verification
  const event = JSON.parse(req.body.toString()); 
  const reference = event.data?.reference;

  // 2. Process only successful charges
  if (event.event === 'charge.success' && reference) {
      try {
          // 3. (Recommended) Final Verification to prevent spoofing
          const verificationResponse = await axios.get(
              `${PAYSTACK_BASE_API}/transaction/verify/${reference}`,
              { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
          );

          const verifiedData = verificationResponse.data.data;

          if (verifiedData.status === 'success') {
              const amountInKobo = verifiedData.amount;
              const amountInNGN = amountInKobo / 100;
              
              // 4. Find the transaction and associated user in Firestore
              const txnRef = db.collection('transactions').doc(reference);
              const txnSnap = await txnRef.get();

              if (!txnSnap.exists) {
                  console.error(`Transaction record not found for reference: ${reference}`);
                  return res.status(200).send('Transaction record not found.');
              }

              const txnData = txnSnap.data();
              const userId = txnData.userId; 
              const userRef = db.collection('users').doc(userId);

              // Check if the transaction has already been processed (idempotency)
              if (txnData.status === 'success') {
                  console.warn(`Transaction ${reference} already processed.`);
                  return res.status(200).send('Transaction already processed.');
              }
              
              // 5. Update Wallet Balance and Transaction Status (Atomic Operation)
              await db.runTransaction(async (t) => {
                const userDoc = await t.get(userRef);
                if (!userDoc.exists) throw new Error("User not found for crediting.");
                
                // Credit the user's balance
                const newBalance = (userDoc.data().balance || 0) + amountInNGN;
                t.update(userRef, { balance: newBalance });
                
                // Update transaction status to prevent double-crediting
                t.update(txnRef, { 
                    status: 'success', 
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    amount_credited: amountInNGN,
                });

                // Add a transaction record to the user's subcollection
                const userTxRef = userRef.collection('transactions');
                t.set(userTxRef.doc(), {
                    description: `Wallet Top-up (Paystack)`,
                    amount: amountInNGN,
                    type: 'credit',
                    category: 'Wallet Deposit',
                    status: 'success',
                    date: admin.firestore.FieldValue.serverTimestamp(),
                    reference: reference,
                });
              });

              console.log(`Successfully credited NGN ${amountInNGN} to user ${userId} for reference ${reference}.`);

          } else {
              // Verification failed (e.g., status is 'failed' or 'abandoned')
              console.warn(`Paystack verification status not successful for reference: ${reference}. Status: ${verifiedData.status}`);
          }
      } catch (error) {
          console.error('Webhook processing failed:', error.message);
      }
  } else if (event.event === 'charge.failed') {
      console.log(`Charge failed for reference: ${reference}`);
  }

  // Paystack expects a 200 response to stop retrying.
  res.status(200).send('Webhook Received');
});


// ====================================================================
// VTPASS PROXY ENDPOINTS
// ====================================================================

// --- 2. VTPASS Proxy Endpoint: Purchase Service ---
app.post('/api/vtpass/purchase', async (req, res) => {
  try {
    const { serviceID, amount, phone, request_id, billersCode, variation_code } = req.body;
    
    if (!serviceID || !request_id) {
        return res.status(400).json({ error: 'Missing required VTPASS fields (serviceID, request_id).' });
    }

    const vtpassResponse = await axios.post(
      `${process.env.VTPASS_BASE_URL}pay`, 
      { serviceID, amount, phone, request_id, billersCode, variation_code },
      {
        headers: {
          'api-key': process.env.VTPASS_API_KEY,
          'secret-key': process.env.VTPASS_SECRET_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(vtpassResponse.data);
  } catch (error) {
    console.error('VTPASS Purchase Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.response_description || 'VTPASS transaction failed.';
    res.status(500).json({ error: errorMessage });
  }
});

// --- 2.1. VTPASS Proxy Endpoint: Requery Transaction Status ---
app.post('/api/vtpass/requery', async (req, res) => {
  try {
    const { request_id } = req.body;
    
    if (!request_id) {
        return res.status(400).json({ error: 'Missing request_id' });
    }

    const vtpassResponse = await axios.post(
      `${process.env.VTPASS_BASE_URL}requery`, 
      { request_id },
      {
        headers: {
          'api-key': process.env.VTPASS_API_KEY, 
          'secret-key': process.env.VTPASS_SECRET_KEY, 
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(vtpassResponse.data);
  } catch (error) {
    console.error('VTPASS Requery Error:', error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.response_description || 'VTPASS transaction requery failed.';
    res.status(500).json({ error: errorMessage });
  }
});


// ====================================================================
// CLOUDINARY PROXY ENDPOINTS
// ====================================================================

// --- 3. Cloudinary Secure Upload Endpoint ---
app.post('/api/upload/image', async (req, res) => {
    try {
        const { fileUri } = req.body;
        if (!fileUri) {
            return res.status(400).json({ error: 'Missing fileUri (Base64 data URI)' });
        }
        
        // This is a secure upload call using the server's private keys
        const result = await cloudinary.uploader.upload(fileUri, {
            upload_preset: process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET,
            resource_type: 'auto'
        });

        // Return only the public URL
        res.status(200).json({ url: result.secure_url });
    } catch (error) {
        console.error('Cloudinary Upload Error:', error.message);
        res.status(500).json({ error: 'Secure image upload failed.' });
    }
});


// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 Secure backend running on http://localhost:${PORT}`);
});