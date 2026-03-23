// ============================================================
//  MicroLease — Backend Server
//  Node.js + Express
//  Handles: Razorpay payments, Escrow logic,
//           Face++ KYC matching, Admin actions
// ============================================================

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const axios      = require('axios');
const FormData   = require('form-data');
const admin      = require('firebase-admin');
const Razorpay   = require('razorpay');
const { createWorker } = require('tesseract.js');
require('dotenv').config();

const app = express();

// ── CORS — allow your frontend origin ──
app.use(cors({
  origin: [
    'http://localhost:5500',       // Live Server local
    'http://127.0.0.1:5500',
    'https://microlease-cd760.web.app',  // Firebase Hosting
    'https://microlease-cd760.firebaseapp.com'
  ],
  credentials: true
}));

// Raw body needed for Razorpay webhook signature check
app.use('/webhook/razorpay', express.raw({ type: 'application/json' }));

// JSON for everything else
app.use(express.json({ limit: '10mb' }));

// ── FIREBASE ADMIN SDK ──
// serviceAccountKey.json is downloaded from Firebase Console
// Project Settings → Service Accounts → Generate New Private Key
let serviceAccount;
try {
  serviceAccount = require('./serviceAccountKey.json');
  console.log('✅ Using local serviceAccountKey.json');
} catch (e) {
  // On deployed environments, use env var if provided
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      serviceAccount = JSON.parse(raw);
      console.log('✅ Using FIREBASE_SERVICE_ACCOUNT from env');
    } catch (parseErr) {
      console.warn('⚠️ Invalid FIREBASE_SERVICE_ACCOUNT JSON. Falling back to default credentials.');
      serviceAccount = null;
    }
  } else {
    serviceAccount = null;
  }
}

const adminOptions = {};
if (serviceAccount) {
  adminOptions.credential = admin.credential.cert(serviceAccount);
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  adminOptions.credential = admin.credential.applicationDefault();
} else {
  adminOptions.credential = admin.credential.applicationDefault();
}
if (process.env.FIREBASE_PROJECT_ID) {
  adminOptions.projectId = process.env.FIREBASE_PROJECT_ID;
}

admin.initializeApp(adminOptions);
const db = admin.firestore();

// ── RAZORPAY ──
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── FACE++ CREDENTIALS ──
const FACEPP_KEY    = process.env.FACEPP_API_KEY;
const FACEPP_SECRET = process.env.FACEPP_API_SECRET;


// ============================================================
//  HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => {
  res.json({
    status: 'MicroLease backend running',
    version: '1.0.0',
    endpoints: [
      'POST /kyc/compare',
      'POST /payment/create-order',
      'POST /payment/verify',
      'POST /webhook/razorpay',
      'POST /escrow/release',
      'POST /escrow/refund',
      'POST /admin/ban-user',
      'POST /admin/approve-kyc',
      'POST /admin/reject-kyc',
    ]
  });
});

// ============================================================
//  KYC — FACE MATCHING + OCR NUMBER CROSS-CHECK via Face++
//  POST /kyc/compare
//  Body: { idImageBase64, selfieBase64, userId, idType, enteredIdNumber }
// ============================================================


app.post('/kyc/compare', async (req, res) => {
  const { idImageBase64, selfieBase64, userId, idType, enteredIdNumber } = req.body;

  if (!idImageBase64 || !selfieBase64 || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify user is authenticated via Firebase token
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== userId) {
      return res.status(403).json({ error: 'Token mismatch' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // ── STEP 1: Claude Vision OCR — verify ID number matches document ──
    const idBase64          = idImageBase64.replace(/^data:image\/\w+;base64,/, '');
    const selfieBase64Clean = selfieBase64.replace(/^data:image\/\w+;base64,/, '');


    // ── OCR: extract text from ID image using Tesseract, cross-check entered number ──
    if (idType && enteredIdNumber) {
      const docLabels = {
        aadhaar: 'Aadhaar Card', pan: 'PAN Card',
        passport: 'Passport', licence: 'Driving Licence', voter: 'Voter ID'
      };
      const docLabel = docLabels[idType] || idType;

      const ID_PATTERNS = {
        aadhaar:  /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
        pan:      /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
        passport: /\b[A-Z][0-9]{7}\b/g,
        licence:  /\b[A-Z]{2}[0-9]{13}\b/g,
        voter:    /\b[A-Z]{3}[0-9]{7}\b/g,
      };

      let ocrPassed = false;
      try {
        const worker = await createWorker('eng');
        const { data: { text } } = await worker.recognize(
          Buffer.from(idBase64, 'base64')
        );
        await worker.terminate();

        const upper = text.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
        console.log(`Tesseract OCR (${idType}):`, upper.slice(0, 200));

        if (!upper.trim()) {
          return res.status(400).json({
            error: 'Not an ID document',
            message: `No text found in the uploaded image. Please upload a clear photo of your actual ${docLabel}.`
          });
        }

        const pat = ID_PATTERNS[idType];
        const candidates = pat ? [...upper.matchAll(pat)].map(m => m[0].replace(/\s/g,'')) : [];
        console.log(`Candidates for ${idType}:`, candidates);

        if (candidates.length === 0) {
          return res.status(400).json({
            error: 'ID number not found on document',
            message: `Could not find a ${docLabel} number in the uploaded image. Make sure the number is clearly visible.`
          });
        }

        const entered = enteredIdNumber.replace(/[\s-]/g, '').toUpperCase();
        if (!candidates.some(c => c === entered)) {
          return res.status(400).json({
            error: 'ID number mismatch',
            message: `The number you entered doesn't match what's printed on the ${docLabel}. Please re-enter it exactly as shown.`
          });
        }

        ocrPassed = true;
        console.log(`OCR check passed for ${idType}`);
      } catch(ocrErr) {
        // Tesseract failed — don't block the user, proceed to face match
        console.error('Tesseract OCR error:', ocrErr.message);
      }
    }

    // ── STEP 2: Face++ Compare API ──
    const form = new FormData();
    form.append('api_key',    FACEPP_KEY);
    form.append('api_secret', FACEPP_SECRET);

    form.append('image_base64_1', idBase64);
    form.append('image_base64_2', selfieBase64Clean);

    const response = await axios.post(
      'https://api-us.faceplusplus.com/facepp/v3/compare',
      form,
      { headers: form.getHeaders(), timeout: 15000 }
    );

    // Face++ can return a 200 with an error_message instead of throwing
    // e.g. NO_FACE_FOUND, INVALID_IMAGE, IMAGE_DOWNLOAD_TIMEOUT etc.
    const faceApiError = response.data.error_message;
    if (faceApiError) {
      console.warn('Face++ returned error in 200 response:', faceApiError);
      if (faceApiError.includes('NO_FACE') || faceApiError.includes('FACE_NOT_FOUND')) {
        return res.status(400).json({
          error:   'No face found',
          message: 'No face detected in one or both images. Make sure your ID photo clearly shows your face and retake your selfie.'
        });
      }
      if (faceApiError.includes('IMAGE') || faceApiError.includes('INVALID')) {
        return res.status(400).json({
          error:   'Image quality issue',
          message: 'Please upload a clearer photo ID and retake your selfie in good lighting.'
        });
      }
      // Any other Face++ error → manual review fallback
      await db.collection('kyc_submissions').doc(userId).set({
        userId, status: 'manual_review',
        reason: `Face++ error: ${faceApiError}`,
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return res.json({ matched: false, confidence: 0, manual: true,
        message: 'Automatic comparison unavailable — submitted for manual review' });
    }

    // confidence is null/undefined (not just 0) when faces weren't detected
    // A genuine 0% match is extremely rare; treat missing confidence as detection failure
    if (response.data.confidence === null || response.data.confidence === undefined) {
      return res.status(400).json({
        error:   'No face found',
        message: 'Could not detect faces in the provided images. Please use a clear photo ID and ensure your face is fully visible in the selfie.'
      });
    }

    const confidence = response.data.confidence;
    const threshold  = response.data.thresholds?.['1e-3'] || 65;
    const matched    = confidence >= threshold;

    // Save KYC result to Firestore
    // Determine final status:
    // confidence >= 80 → auto-verified, 65-79 → manual_review, <65 → failed
    const kycFinalStatus = matched
      ? (confidence >= 80 ? 'verified' : 'manual_review')
      : 'failed';

    await db.collection('kyc_submissions').doc(userId).set({
      userId,
      confidence,
      threshold,
      matched,
      status:      kycFinalStatus,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Update user doc so they can access dashboard immediately
    if (matched) {
      await db.collection('users').doc(userId).update({
        kycStatus:      kycFinalStatus,
        kycSubmittedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.json({
      matched,
      confidence: Math.round(confidence),
      threshold:  Math.round(threshold),
      message: matched
        ? 'Face match successful — pending admin review'
        : 'Face match failed'
    });

  } catch(err) {
    console.error('Face++ error:', err?.response?.data || err.message);

    // Face++ error codes
    const faceErr = err?.response?.data?.error_message;
    if (faceErr === 'INVALID_IMAGE_SIZE' || faceErr === 'IMAGE_ERROR') {
      return res.status(400).json({
        error: 'Image quality issue',
        message: 'Please upload a clearer photo and retake your selfie'
      });
    }
    if (faceErr === 'NO_FACE_FOUND') {
      return res.status(400).json({
        error: 'No face found',
        message: 'No face detected in one or both images'
      });
    }

    // If Face++ is down, fall back to manual review
    await db.collection('kyc_submissions').doc(userId).set({
      userId,
      status:      'manual_review',
      reason:      'Automatic comparison unavailable',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.json({
      matched:    false,
      confidence: 0,
      manual:     true,
      message:    'Automatic comparison unavailable — submitted for manual review'
    });
  }
});

// ============================================================
//  PAYMENT — Create Razorpay Order
//  POST /payment/create-order
//  Body: { amount, listingTitle, userId }
// ============================================================
app.post('/payment/create-order', async (req, res) => {
  const { amount, listingTitle, userId } = req.body;

  if (!amount || !userId) {
    return res.status(400).json({ error: 'Missing amount or userId' });
  }

  // Verify Firebase token
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== userId) {
      return res.status(403).json({ error: 'Token mismatch' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount * 100), // paise
      currency: 'INR',
      notes: {
        userId,
        listingTitle: listingTitle || 'MicroLease Booking',
        platform: 'microlease'
      }
    });

    return res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID
    });
  } catch(err) {
    console.error('Razorpay order error:', err);
    return res.status(500).json({ error: 'Could not create payment order' });
  }
});

// ============================================================
//  PAYMENT — Verify Razorpay Payment Signature
//  POST /payment/verify
//  Body: { razorpay_order_id, razorpay_payment_id,
//          razorpay_signature, bookingData, userId }
// ============================================================
app.post('/payment/verify', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    bookingData,
    userId
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }

  // Verify Firebase token
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    await admin.auth().verifyIdToken(token);
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Verify Razorpay signature
  const body      = razorpay_order_id + '|' + razorpay_payment_id;
  const expected  = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  // Signature valid — save booking to Firestore
  try {
    const bookingRef = await db.collection('bookings').add({
      ...bookingData,
      userId,
      paymentId:  razorpay_payment_id,
      orderId:    razorpay_order_id,
      status:     'payment_held',
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success:   true,
      bookingId: bookingRef.id,
      paymentId: razorpay_payment_id
    });
  } catch(err) {
    console.error('Booking save error:', err);
    return res.status(500).json({ error: 'Payment verified but booking save failed' });
  }
});

// ============================================================
//  RAZORPAY WEBHOOK
//  POST /webhook/razorpay
//  Razorpay calls this when payment events happen
// ============================================================
app.post('/webhook/razorpay', async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature     = req.headers['x-razorpay-signature'];

  // Verify webhook signature
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.body)
    .digest('hex');

  if (expected !== signature) {
    console.error('Invalid webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const payload = typeof req.body === 'string' ? req.body : req.body.toString();
  const event = JSON.parse(payload);
  console.log('Razorpay webhook event:', event.event);

  if (event.event === 'payment.captured') {
    const payment  = event.payload.payment.entity;
    const orderId  = payment.order_id;

    // Find booking by orderId and mark as payment confirmed
    const snap = await db.collection('bookings')
      .where('orderId', '==', orderId)
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        paymentConfirmed: true,
        paymentCapturedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }

  if (event.event === 'payment.failed') {
    const payment = event.payload.payment.entity;
    console.log('Payment failed:', payment.id);
    // Could notify user here
  }

  return res.json({ status: 'ok' });
});

// ============================================================
//  ESCROW — Release Funds to Owner
//  POST /escrow/release
//  Body: { bookingId, userId }
//  Called when renter confirms arrival
// ============================================================
app.post('/escrow/release', async (req, res) => {
  const { bookingId, userId } = req.body;

  if (!bookingId || !userId) {
    return res.status(400).json({ error: 'Missing bookingId or userId' });
  }

  // Verify Firebase token
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== userId) {
      return res.status(403).json({ error: 'Token mismatch' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingDoc.data();

    // Security checks
    if (booking.userId !== userId) {
      return res.status(403).json({ error: 'Only the renter can confirm arrival' });
    }
    if (booking.status !== 'payment_held') {
      return res.status(400).json({
        error: `Cannot release — current status is: ${booking.status}`
      });
    }

    // Update escrow state to funds_released
    await bookingRef.update({
      status:     'funds_released',
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // In production: trigger Razorpay payout to owner's bank account here
    // razorpay.payouts.create({ ... })

    return res.json({
      success:   true,
      bookingId,
      newStatus: 'funds_released',
      message:   'Funds released to owner successfully'
    });

  } catch(err) {
    console.error('Escrow release error:', err);
    return res.status(500).json({ error: 'Failed to release funds' });
  }
});

// ============================================================
//  ESCROW — Refund to User (fake listing report)
//  POST /escrow/refund
//  Body: { bookingId, userId, reason }
// ============================================================
app.post('/escrow/refund', async (req, res) => {
  const { bookingId, userId, reason } = req.body;

  if (!bookingId || !userId) {
    return res.status(400).json({ error: 'Missing bookingId or userId' });
  }

  // Verify Firebase token
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== userId) {
      return res.status(403).json({ error: 'Token mismatch' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingDoc.data();

    if (booking.userId !== userId) {
      return res.status(403).json({ error: 'Only the renter can report a fake listing' });
    }
    if (booking.status !== 'payment_held') {
      return res.status(400).json({
        error: `Cannot refund — current status is: ${booking.status}`
      });
    }

    // Update escrow state to refunded
    await bookingRef.update({
      status:     'refunded',
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      refundReason: reason || 'Fake or misrepresented listing',
    });

    // Create a fraud report
    await db.collection('reports').add({
      bookingId,
      listingId:  booking.listingId,
      ownerId:    booking.ownerId,
      reportedBy: userId,
      reason:     reason || 'Fake or misrepresented listing',
      status:     'pending',
      amount:     booking.total,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    // Flag the owner
    await db.collection('users').doc(booking.ownerId).update({
      flagged:    true,
      flagReason: 'Fraud report filed against their listing',
    });

    // In production: trigger Razorpay refund here
    // razorpay.payments.refund(booking.paymentId, { amount: booking.total * 100 })

    return res.json({
      success:   true,
      bookingId,
      newStatus: 'refunded',
      message:   'Refund processed and fraud report filed'
    });

  } catch(err) {
    console.error('Escrow refund error:', err);
    return res.status(500).json({ error: 'Failed to process refund' });
  }
});

// ============================================================
//  ADMIN — Ban User
//  POST /admin/ban-user
//  Body: { targetUserId }
//  Requires admin Firebase token
// ============================================================
app.post('/admin/ban-user', async (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);

    // Check caller is admin
    const callerDoc = await db.collection('users').doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    // Disable in Firebase Auth
    await admin.auth().updateUser(targetUserId, { disabled: true });

    // Mark in Firestore
    await db.collection('users').doc(targetUserId).update({
      banned:    true,
      bannedAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, message: 'User banned successfully' });
  } catch(err) {
    console.error('Ban user error:', err);
    return res.status(500).json({ error: 'Failed to ban user' });
  }
});

// ============================================================
//  ADMIN — Approve KYC
//  POST /admin/approve-kyc
//  Body: { targetUserId }
// ============================================================
app.post('/admin/approve-kyc', async (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const callerDoc = await db.collection('users').doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    await db.collection('users').doc(targetUserId).update({
      kycStatus: 'verified',
      kycApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('kyc_submissions').doc(targetUserId).update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, message: 'KYC approved' });
  } catch(err) {
    return res.status(500).json({ error: 'Failed to approve KYC' });
  }
});

// ============================================================
//  ADMIN — Reject KYC
//  POST /admin/reject-kyc
//  Body: { targetUserId, reason }
// ============================================================
app.post('/admin/reject-kyc', async (req, res) => {
  const { targetUserId, reason } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const token   = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const callerDoc = await db.collection('users').doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    await db.collection('users').doc(targetUserId).update({
      kycStatus: 'rejected',
    });
    await db.collection('kyc_submissions').doc(targetUserId).update({
      status:     'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectReason: reason || 'Documents did not meet requirements',
    });

    return res.json({ success: true, message: 'KYC rejected' });
  } catch(err) {
    return res.status(500).json({ error: 'Failed to reject KYC' });
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MicroLease backend running on port ${PORT}`);
});