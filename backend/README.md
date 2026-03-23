# MicroLease Backend

Node.js + Express backend for Razorpay payments, Face++ KYC, and admin escrow actions.

## Quick Start (Local)

```bash
cd backend
npm install        # already done ✓
npm run dev        # starts on http://localhost:3000 with auto-reload
```

Or without auto-reload:
```bash
npm start
```

## Required Files

Both files must exist in the `backend/` folder before starting:

### 1. `serviceAccountKey.json`  ✅ (already created)
Downloaded from Firebase Console → Project Settings → Service Accounts → Generate New Private Key.

### 2. `.env`  ✅ (already created)
```
RAZORPAY_KEY_ID=rzp_test_SRBSIx86BrpMw2
RAZORPAY_KEY_SECRET=GaT7KhGKeE8W6e6HCOmyyJiP
FACEPP_API_KEY=4jFi6cwH7IS4cfi43kcO5FxR-xpk5nAC
FACEPP_API_SECRET=HrodJ7SBLKFnBuZFPuJUS1XetjFBG8N8
FIREBASE_PROJECT_ID=microlease-cd760
PORT=3000
```

## Test it's running

Open: http://localhost:3000/health  
Should return: `{"status":"ok","routes":[...]}`

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Health check |
| POST | /kyc/compare | Face++ identity verification |
| POST | /payment/create-order | Create Razorpay order |
| POST | /payment/verify | Verify payment signature |
| POST | /payment/release | Release escrow to owner |
| POST | /webhook/razorpay | Razorpay webhook |
| POST | /admin/approve-kyc | Admin: approve KYC |
| POST | /admin/reject-kyc | Admin: reject KYC |
| POST | /admin/ban-user | Admin: ban user |

## Deploy to Railway

1. Push the `backend/` folder to a GitHub repo
2. Create new project on [railway.app](https://railway.app)
3. Connect the repo, set root directory to `backend/`
4. Add all env vars from `.env` in Railway dashboard
5. Add `FIREBASE_SERVICE_ACCOUNT` as the entire contents of `serviceAccountKey.json` (one line JSON)
6. Update `BACKEND_URL` in `kyc.html` and `booking.html` to the Railway URL

## KYC Flow

- confidence ≥ 80% → `kycStatus: "verified"` (auto-approved)
- confidence 65–79% → `kycStatus: "manual_review"` (admin reviews)
- confidence < 65% → face match failed, user retries
- Backend offline → frontend fallback sets `kycStatus: "manual_review"` directly in Firestore
