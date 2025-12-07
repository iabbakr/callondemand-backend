const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const cloudinary = require('cloudinary').v2; // For secure image uploads

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_BASE_API = 'https://api.paystack.co';

// --- Middlewares ---
app.use(cors()); // Configure CORS to allow access from your mobile app domain
app.use(express.json()); // To parse incoming JSON requests

// --- Cloudinary Configuration (Secure Method) ---
// Initialize Cloudinary with the secure URL from the environment
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// ====================================================================
// PAYSTACK PROXY ENDPOINTS (All use SECRET KEY stored on server)
// ====================================================================

// --- 1. Paystack Proxy Endpoint: Initialize Transaction ---
// Used by lib/paystack.ts initializePayment
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
})

// --- 1.1. Paystack Proxy Endpoint: Resolve Bank Account (NEWLY ADDED) ---
// Used by AuthScreen.tsx verifyAccount to check user bank details
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

// --- 1.2. Paystack Proxy Endpoint: Verify Transaction (NEWLY ADDED) ---
// Needed to replace the insecure call in lib/paystack.ts verifyPayment
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

// --- 1.3. Paystack Proxy Endpoint: Create Transfer Recipient (NEWLY ADDED) ---
// Needed to replace the insecure call in lib/paystack.ts createTransferRecipient
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

// --- 1.4. Paystack Proxy Endpoint: Initiate Transfer/Withdrawal (NEWLY ADDED) ---
// Needed to replace the insecure call in lib/paystack.ts withdrawToBank
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


// ====================================================================
// VTPASS PROXY ENDPOINTS (All use SECRET KEY stored on server)
// ====================================================================

// --- 2. VTPASS Proxy Endpoint: Purchase Service ---
// Used by lib/vtpass.ts buyAirtime, buyData, buyElectricity
app.post('/api/vtpass/purchase', async (req, res) => {
  try {
    const { serviceID, amount, phone, request_id, billersCode, variation_code } = req.body;
    
    if (!serviceID || !request_id) {
        return res.status(400).json({ error: 'Missing required VTPASS fields (serviceID, request_id).' });
    }

    const vtpassResponse = await axios.post(
      `${process.env.VTPASS_BASE_URL}/pay`, // VTPASS pay endpoint
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

// --- 2.1. VTPASS Proxy Endpoint: Requery Transaction Status (NEWLY ADDED) ---
// Used by lib/vtpass.ts queryTransactionStatus
app.post('/api/vtpass/requery', async (req, res) => {
  try {
    const { request_id } = req.body;
    
    if (!request_id) {
        return res.status(400).json({ error: 'Missing request_id' });
    }

    const vtpassResponse = await axios.post(
      `${process.env.VTPASS_BASE_URL}/requery`, // VTPASS requery endpoint
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
// Used by lib/cloudinary.ts uploadImageToCloudinary
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