const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const cloudinary = require('cloudinary').v2; // For secure image uploads

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(cors()); // Configure CORS to allow access from your mobile app domain
app.use(express.json()); // To parse incoming JSON requests

// --- Cloudinary Configuration (Secure Method) ---
// Initialize Cloudinary with the secure URL from the environment
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // You may need to extract this from the URL or add it separately
  api_key: process.env.CLOUDINARY_API_KEY,      // Same as above
  api_secret: process.env.CLOUDINARY_API_SECRET, // Same as above
  secure: true
});
// Alternatively, just use the CLOUDINARY_URL if the SDK supports it:
// cloudinary.config(process.env.CLOUDINARY_URL);

// --- 1. Paystack Proxy Endpoint: Initialize Transaction ---
// App sends amount/email/reference. Backend uses SECRET KEY to initialize.
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    
    // Check for required input
    if (!amount || !email) {
        return res.status(400).json({ error: 'Missing amount or email' });
    }

    const paystackResponse = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      { amount: amount * 100, email, reference }, // Paystack uses Kobo/Cent
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Send only the necessary public data back to the mobile app
    res.json(paystackResponse.data);
  } catch (error) {
    console.error('Paystack Initialization Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Payment initialization failed.' });
  }
});

// --- 2. VTPASS Proxy Endpoint: Purchase Service ---
// App sends service ID, phone, etc. Backend uses SECRET KEY to purchase.
app.post('/api/vtpass/purchase', async (req, res) => {
  try {
    const { serviceID, amount, phone, request_id } = req.body;
    
    // VTPASS uses Basic Auth/API Key. We'll use the Secret Key in the payload/header 
    // depending on their latest documentation. Assuming API key for auth here.
    const vtpassResponse = await axios.post(
      `${process.env.VTPASS_BASE_URL}pay`, // Example endpoint
      { serviceID, amount, phone, request_id },
      {
        headers: {
          'api-key': process.env.VTPASS_API_KEY, // Use API Key for Authorization
          'secret-key': process.env.VTPASS_SECRET_KEY, // May be required in header/payload
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(vtpassResponse.data);
  } catch (error) {
    console.error('VTPASS Purchase Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'VTPASS transaction failed.' });
  }
});


// --- 3. Cloudinary Secure Upload Endpoint ---
// App sends a base64 encoded image or file URI. Backend uploads it securely.
app.post('/api/upload/image', async (req, res) => {
    try {
        const { fileUri } = req.body;
        if (!fileUri) {
            return res.status(400).json({ error: 'Missing fileUri' });
        }
        
        // This is a secure upload call using the server's private keys
        const result = await cloudinary.uploader.upload(fileUri, {
            upload_preset: process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET, // Use the app's public preset if you need consistent tagging
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