const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

dotenv.config();

// ============================================
// FIREBASE INITIALIZATION
// ============================================
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

// ============================================
// SERVER CONFIGURATION
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_BASE_API = 'https://api.paystack.co';

// ============================================
// CLOUDINARY CONFIGURATION
// ============================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Verify Cloudinary config on startup
console.log('🔧 Cloudinary Config:');
console.log('Cloud Name:', process.env.CLOUDINARY_CLOUD_NAME ? '✅ Set' : '❌ Missing');
console.log('API Key:', process.env.CLOUDINARY_API_KEY ? '✅ Set' : '❌ Missing');
console.log('API Secret:', process.env.CLOUDINARY_API_SECRET ? '✅ Set' : '❌ Missing');

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());

// ============================================
// UTILITY FUNCTIONS
// ============================================
const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken) return;
  try {
    await axios.post("https://exp.host/--/api/v2/push/send", {
      to: expoPushToken,
      sound: "default",
      title,
      body,
      data,
    });
    console.log(`🔔 Notification sent to ${expoPushToken}`);
  } catch (error) {
    console.error("❌ Expo Notification Error:", error.message);
  }
};

// ============================================
// ROUTES - HEALTH & MONITORING
// ============================================

/**
 * HEALTH CHECK (For Render Monitoring)
 */
app.get('/health', (req, res) => {
  res.status(200).send('Server is alive');
});

// ============================================
// ROUTES - PAYSTACK WEBHOOKS (Raw body parser)
// ============================================

/**
 * PAYSTACK WEBHOOK
 * Must come BEFORE express.json() middleware
 */
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
  
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(200).send('Invalid Signature');
  }

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
        
        if (!txnSnap.exists || txnSnap.data().status === 'success') {
          return res.status(200).send('Already processed');
        }

        const userId = txnSnap.data().userId;
        const userRef = db.collection('users').doc(userId);

        await db.runTransaction(async (t) => {
          t.update(userRef, { balance: admin.firestore.FieldValue.increment(amountInNGN) });
          t.update(txnRef, { 
            status: 'success', 
            verifiedAt: admin.firestore.FieldValue.serverTimestamp() 
          });
        });

        console.log(`✅ Payment verified: ₦${amountInNGN} for user ${userId}`);
      }
    } catch (error) {
      console.error('❌ Webhook Error:', error.message);
    }
  }
  
  res.status(200).send('Webhook Received');
});

// ============================================
// JSON BODY PARSER (10MB limit for Base64 images)
// ============================================
app.use(express.json({ limit: '10mb' }));

// ============================================
// ROUTES - CLOUDINARY
// ============================================

/**
 * SECURE CLOUDINARY UPLOAD & CLEANUP
 */
app.post('/api/upload/image', async (req, res) => {
  try {
    console.log('📥 Received upload request');
    
    const { fileUri, oldImagePublicId } = req.body; 
    
    if (!fileUri) {
      console.error('❌ No image data provided');
      return res.status(400).json({ error: "No image data provided" });
    }

    console.log('📊 File URI length:', fileUri.length);
    console.log('🗑️  Old Public ID:', oldImagePublicId || 'None');

    // Verify Cloudinary config
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('❌ Cloudinary credentials missing');
      return res.status(500).json({ error: "Cloudinary not configured properly" });
    }

    // Delete old asset if it exists
    if (oldImagePublicId) {
      try {
        console.log('🗑️  Attempting to delete old image:', oldImagePublicId);
        const deleteResult = await cloudinary.uploader.destroy(oldImagePublicId);
        console.log('🗑️  Delete result:', deleteResult);
      } catch (err) {
        console.warn("⚠️ Cleanup failed:", err.message);
        // Continue with upload even if deletion fails
      }
    }

    console.log('📤 Uploading to Cloudinary...');
    const result = await cloudinary.uploader.upload(fileUri, {
      folder: 'profile_pictures',
      resource_type: 'image',
      transformation: [
        { width: 500, height: 500, crop: 'limit' },
        { quality: 'auto' }
      ]
    });

    console.log('✅ Upload successful!');
    console.log('URL:', result.secure_url);
    console.log('Public ID:', result.public_id);

    res.json({ 
      url: result.secure_url,
      publicId: result.public_id 
    });
  } catch (error) {
    console.error('❌ Cloudinary Route Error:');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Failed to upload to Cloudinary',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============================================
// ROUTES - PAYSTACK TRANSACTIONS
// ============================================

/**
 * INITIALIZE PAYMENT
 */
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { amount, email, reference } = req.body;
    
    if (!amount || !email || !reference) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const response = await axios.post(
      `${PAYSTACK_BASE_API}/transaction/initialize`,
      { amount: amount * 100, email, reference },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('❌ Payment initialization error:', error.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

/**
 * SECURE WITHDRAWAL
 */
app.post('/api/paystack/transfer', async (req, res) => {
  const { userId, amount, recipientCode } = req.body;
  
  if (!userId || !amount || !recipientCode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const userRef = db.collection('users').doc(userId);
  const transferId = `WITHDRAW-${Date.now()}`;

  try {
    const result = await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const balance = userSnap.data().balance || 0;
      if (balance < amount) throw new Error('Insufficient balance');

      t.update(userRef, { balance: admin.firestore.FieldValue.increment(-amount) });

      const pRes = await axios.post(
        `${PAYSTACK_BASE_API}/transfer`, 
        {
          source: "balance",
          amount: amount * 100,
          recipient: recipientCode,
          reason: "Wallet Withdrawal",
          reference: transferId
        }, 
        {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        }
      );

      const txnRef = db.collection('transactions').doc(transferId);
      t.set(txnRef, {
        userId, 
        amount, 
        type: 'debit', 
        status: 'success',
        category: 'Withdrawal', 
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return pRes.data;
    });
    
    console.log(`✅ Withdrawal successful: ₦${amount} for user ${userId}`);
    res.json({ status: true, data: result });
  } catch (error) {
    console.error('❌ Withdrawal error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

/**
 * RESOLVE BANK ACCOUNT
 */
app.get('/api/paystack/resolve', async (req, res) => {
  const { account_number, bank_code } = req.query;
  
  if (!account_number || !bank_code) {
    return res.status(400).json({ error: 'Missing account_number or bank_code' });
  }

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_API}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json(response.data);
  } catch (error) {
    console.error('❌ Account resolution error:', error.message);
    res.status(500).json({ error: 'Account resolution failed' });
  }
});

/**
 * SYSTEM BROADCAST (Target all users)
 * Triggered from Admin Dashboard
 */
app.post('/api/notifications/broadcast', async (req, res) => {
  try {
    const { title, body, type, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and Body are required' });
    }

    console.log('📢 Starting system-wide broadcast...');

    // 1. Fetch all users who have a valid push token
    const usersSnap = await db.collection('users')
      .where('expoPushToken', '!=', null)
      .get();

    if (usersSnap.empty) {
      return res.json({ success: true, sentCount: 0, message: 'No devices registered' });
    }

    // 2. Map tokens into Expo message format
    const messages = usersSnap.docs.map(doc => ({
      to: doc.data().expoPushToken,
      sound: 'default',
      title: title,
      body: body,
      data: { 
        ...data, 
        type: type || 'admin_notification',
        sentAt: new Date().toISOString() 
      },
    }));

    // 3. Chunk messages (Expo recommends batches of 100)
    const chunks = [];
    while (messages.length > 0) {
      chunks.push(messages.splice(0, 100));
    }

    // 4. Send chunks to Expo API
    const sendPromises = chunks.map(chunk => 
      axios.post('https://exp.host/--/api/v2/push/send', chunk, {
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate'
        },
      })
    );

    await Promise.all(sendPromises);

    console.log(`✅ Broadcast complete: ${usersSnap.size} notifications pushed.`);
    res.json({ 
      success: true, 
      sentCount: usersSnap.size 
    });

  } catch (error) {
    console.error('❌ Broadcast Error:', error.message);
    res.status(500).json({ error: 'Failed to process broadcast' });
  }
});

// ============================================
// ROUTES - PUSH NOTIFICATIONS
// ============================================

/**
 * SEND PUSH NOTIFICATION TO SPECIFIC USER
 */
app.post('/api/notifications/send-to-user', async (req, res) => {
  try {
    const { userId, notification } = req.body;

    if (!userId || !notification) {
      return res.status(400).json({ error: 'Missing userId or notification' });
    }

    // Get user's push token
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const expoPushToken = userData.expoPushToken;

    if (!expoPushToken) {
      return res.json({ 
        success: true, 
        sentCount: 0, 
        message: 'User has no push token' 
      });
    }

    // Send to Expo Push API
    const message = {
      to: expoPushToken,
      sound: 'default',
      title: notification.title,
      body: notification.body,
      data: notification.data ?? {},
    };

    await axios.post('https://exp.host/--/api/v2/push/send', message, {
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    console.log(`🔔 Push notification sent to user ${userId}`);
    res.json({ success: true, sentCount: 1 });
  } catch (error) {
    console.error('❌ User Notification Error:', error.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * SEND BULK PUSH NOTIFICATIONS (with filters)
 */
app.post('/api/notifications/send', async (req, res) => {
  try {
    const { filters, notification } = req.body;
    
    if (!notification) {
      return res.status(400).json({ error: 'Missing notification' });
    }

    const usersRef = db.collection("users");
    let query = usersRef;

    // Apply filters if they exist
    if (filters?.state) query = query.where("state", "==", filters.state);
    if (filters?.city) query = query.where("city", "==", filters.city);
    if (filters?.role) query = query.where("role", "==", filters.role);

    const snap = await query.get();

    // Prepare messages for Expo
    const messages = snap.docs
      .map(d => d.data())
      .filter(u => u.expoPushToken) // Only users with tokens
      .map(user => ({
        to: user.expoPushToken,
        sound: "default",
        title: notification.title,
        body: notification.body,
        data: notification.data ?? {},
      }));

    if (messages.length === 0) {
      return res.json({ success: true, sentCount: 0 });
    }

    // Send to Expo Push API using axios
    await axios.post("https://exp.host/--/api/v2/push/send", messages, {
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-encoding": "gzip, deflate"
      },
    });

    console.log(`🔔 Bulk notifications sent to ${messages.length} users`);
    res.json({ success: true, sentCount: messages.length });
  } catch (error) {
    console.error('❌ Bulk Notification Error:', error.message);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});



// ============================================
// ROUTES - VTPASS PROXY (Airtime, Data, Electricity, Education)
// ============================================
const VTPASS_BASE_URL = "https://vtpass.com/api"; 

/**
 * GENERIC VTPASS PAY PROXY
 */
app.post('/api/vtpass/pay', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/pay`, req.body, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
        "Content-Type": "application/json",
      },
    });
    
    // Log this to see the response in Render Logs
    console.log("VTPass Response:", response.data); 
    res.json(response.data);
  } catch (error) {
    // This will show you exactly what VTpass said was wrong
    console.error("❌ VTpass Detailed Error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data?.response_description || "VTpass service error",
      raw: error.response?.data // Sending this back helps you debug on the frontend console
    });
  }
});

/**
 * VTPASS MERCHANT VERIFICATION (Electricity/TV)
 */
app.post('/api/vtpass/verify', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/merchant-verify`, req.body, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Verification failed" });
  }
});


app.get('/api/vtpass/get-plans', async (req, res) => {
  const { serviceID } = req.query;
  try {
    const response = await axios.get(
      `https://vtpass.com/api/service-variations?serviceID=${serviceID}`,
      {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "public-key": process.env.VTPASS_PUBLIC_KEY,
        }
      }
    );
    res.json({ status: true, data: response.data });
  } catch (error) {
    res.status(500).json({ status: false, error: "Failed to fetch plans" });
  }
});

/**
 * VTPASS REQUERY PROXY
 */
app.post('/api/vtpass/requery', async (req, res) => {
  try {
    const response = await axios.post(`${VTPASS_BASE_URL}/requery`, req.body, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY,
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Requery failed" });
  }
});

/**
 * VTPASS WEBHOOK (For 099 Pending Transactions)
 */
app.post('/api/vtpass/webhook', async (req, res) => {
  const { requestId, code, amount } = req.body;
  res.status(200).json({ response: "success" }); // Required by VTpass

  try {
    if (req.body.type === 'transaction-update') {
      const txnRef = db.collection('transactions').doc(requestId);
      const txnSnap = await txnRef.get();

      if (txnSnap.exists && txnSnap.data().status !== 'success') {
        if (code === '000') {
          await txnRef.update({ status: 'success', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        } else if (code !== '099') {
          // Refund logic if failed
          const userId = txnSnap.data().userId;
          await db.collection('users').doc(userId).update({
            balance: admin.firestore.FieldValue.increment(txnSnap.data().amount)
          });
          await txnRef.update({ status: 'failed' });
        }
      }
    }
  } catch (e) {
    console.error("Webhook Logic Error:", e.message);
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Render Server active on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
});