// ============================================================
//  MicroLease — js/app.js
//  Firebase CDN version (no npm, no build tools)
//  Covers: Auth, Firestore, all page helpers
// ============================================================

// ── Firebase Config ─────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDm_j4_DNeLnNSVESXER-xLhrREUsyBWb0",
  authDomain: "microlease-cd760.firebaseapp.com",
  projectId: "microlease-cd760",
  storageBucket: "microlease-cd760.firebasestorage.app",
  messagingSenderId: "990344436424",
  appId: "1:990344436424:web:ec896996ecdccfb2b2e3fd",
  measurementId: "G-0M37M4RR2K"
};

// ── Initialize Firebase ──────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// Google Auth Provider
const googleProvider = new firebase.auth.GoogleAuthProvider();

// ============================================================
//  AUTH HELPERS
// ============================================================

// Sign up with email + password, then create user doc in Firestore
async function signUpWithEmail(name, email, password, role = "user") {
  const cred = await auth.createUserWithEmailAndPassword(email, password);
  await cred.user.updateProfile({ displayName: name });
  await db.collection("users").doc(cred.user.uid).set({
    uid:       cred.user.uid,
    name:      name,
    email:     email,
    role:      role,          // "user" or "owner"
    phone:     "",
    kycStatus: "pending",
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return cred.user;
}

// Sign in with email + password
async function signInWithEmail(email, password) {
  const cred = await auth.signInWithEmailAndPassword(email, password);
  return cred.user;
}

// Sign in / sign up with Google
async function signInWithGoogle() {
  const cred = await auth.signInWithPopup(googleProvider);
  // Create user doc only on first sign-in
  const userDoc = await db.collection("users").doc(cred.user.uid).get();
  if (!userDoc.exists) {
    await db.collection("users").doc(cred.user.uid).set({
      uid:       cred.user.uid,
      name:      cred.user.displayName || "",
      email:     cred.user.email,
      role:      "user",
      phone:     "",
      kycStatus: "pending",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  return cred.user;
}

// Sign out
async function signOutUser() {
  await auth.signOut();
  window.location.href = "login.html";
}

// Get current logged-in user (returns null if not logged in)
function getCurrentUser() {
  return auth.currentUser;
}

// Get user Firestore doc by uid
async function getUserDoc(uid) {
  const doc = await db.collection("users").doc(uid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// ── Auth guard — call at top of any protected page ───────────
// Usage: requireAuth() on pages that need login
// Usage: requireAuth("owner") on owner-only pages
function requireAuth(requiredRole) {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }
    if (requiredRole) {
      const userData = await getUserDoc(user.uid);
      if (!userData || userData.role !== requiredRole) {
        alert("Access denied. This page is for " + requiredRole + "s only.");
        window.location.href = "index.html";
      }
    }
  });
}

// ── Admin emails — add all admin email addresses here ────────
// 🔧 IMPORTANT: Replace with your actual admin email(s)
const ADMIN_EMAILS = [
  "yashassai2@gmail.com"   // replace or add more admin emails here
];

// ── Admin guard — call at top of admin.html only ─────────────
// Redirects non-admins to index, unauthenticated users to admin-login
function requireAdmin() {
  // Hide page until auth is confirmed to prevent flash
  document.body.style.visibility = "hidden";
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = "admin-login.html";
      return;
    }
    if (!ADMIN_EMAILS.includes(user.email)) {
      window.location.href = "index.html";
      return;
    }
    // Confirmed admin — reveal the page
    document.body.style.visibility = "visible";
  });
}

// ── Update navbar with logged-in user name ───────────────────
function initNavbar() {
  auth.onAuthStateChanged(async (user) => {
    const navAuth = document.getElementById("nav-auth");
    if (!navAuth) return;
    if (user) {
      const userData = await getUserDoc(user.uid);
      const name = userData ? userData.name : (user.displayName || user.email);
      navAuth.innerHTML = `
        <span style="margin-right:12px;font-weight:500;color:#1b2a4a">Hi, ${name}</span>
        <button class="btn-outline" onclick="signOutUser()" style="padding:8px 18px;font-size:14px">Sign Out</button>
      `;
    } else {
      navAuth.innerHTML = `
        <a href="login.html" class="btn-outline" style="padding:8px 18px;font-size:14px;text-decoration:none">Login</a>
        <a href="signup.html" class="btn-primary" style="padding:8px 18px;font-size:14px;text-decoration:none;margin-left:8px">Sign Up</a>
      `;
    }
  });
}

// ============================================================
//  KYC HELPERS
// ============================================================

// Submit KYC — saves status to Firestore
// status: "verified" (auto-approved) | "manual_review" (pending admin)
async function submitKYC(userId, status) {
  const kycStatus = status || "verified";

  // Save to kyc_submissions collection (admin can review here)
  await db.collection("kyc_submissions").doc(userId).set({
    userId:      userId,
    status:      kycStatus,
    submittedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Always update the user doc so they can proceed to dashboard.
  // "manual_review" means owner can use the platform but listings
  //  won't go live until admin approves — both states unblock the UI.
  await db.collection("users").doc(userId).update({
    kycStatus:      kycStatus,
    kycSubmittedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Check KYC status — returns the raw value from Firestore
async function checkKYCStatus(userId) {
  const doc = await db.collection("users").doc(userId).get();
  if (!doc.exists) return "pending";
  return doc.data().kycStatus || "pending";
}

// Check if current user has completed KYC
async function checkKYCStatus(userId) {
  const doc = await db.collection("users").doc(userId).get();
  if (!doc.exists) return "pending";
  return doc.data().kycStatus || "pending";
}

// ============================================================
//  LISTINGS HELPERS
// ============================================================

// Create a new listing
async function createListing(data) {
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");
  // Fetch name from Firestore doc (reliable) rather than displayName (empty for email signups)
  const userDoc = await getUserDoc(user.uid);
  const ownerName = (userDoc && userDoc.name) ? userDoc.name : (user.displayName || user.email || "Owner");
  const ref = await db.collection("listings").add({
    ownerId:      user.uid,
    ownerName:    ownerName,
    title:        data.title,
    type:         data.type,         // pool | gym | theater | garden | sauna
    area:         data.area,
    city:         data.city,
    price:        Number(data.price),
    description:  data.description,
    guests:       Number(data.guests),
    availability: data.availability || [],
    lat:          Number(data.lat),
    lng:          Number(data.lng),
    photos:       data.photos || [],  // array of image URLs
    verified:     true,               // auto-verified for prototype
    createdAt:    firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

// Get all listings (for map.html)
async function getAllListings() {
  const snap = await db.collection("listings").get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Get a single listing by ID
async function getListingById(listingId) {
  const doc = await db.collection("listings").doc(listingId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// Get all listings owned by current user (owner-dashboard.html)
async function getMyListings() {
  const user = getCurrentUser();
  if (!user) return [];
  const snap = await db.collection("listings")
    .where("ownerId", "==", user.uid)
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Delete a listing
async function deleteListing(listingId) {
  await db.collection("listings").doc(listingId).delete();
}

// ============================================================
//  BOOKINGS HELPERS
// ============================================================

// Create a new booking (called after Razorpay payment success)
async function createBooking(data) {
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");
  if (!data.listingId) throw new Error("Missing listingId — cannot save booking");
  if (!data.ownerId)   throw new Error("Missing ownerId — cannot save booking");
  // Fetch real name from Firestore (displayName is empty for email signups)
  const userDoc  = await getUserDoc(user.uid);
  const userName = (userDoc && userDoc.name) ? userDoc.name : (user.displayName || user.email);
  const ref = await db.collection("bookings").add({
    userId:    user.uid,
    userName:  userName,
    ownerId:   data.ownerId,
    listingId: data.listingId,
    listingTitle: data.listingTitle,
    date:      data.date,
    slot:      data.slot,
    duration:  Number(data.duration),
    guests:    Number(data.guests),
    total:     Number(data.total),
    status:    "payment_held",   // escrow state 1
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

// Get bookings for the current user (booking-history.html)
async function getMyBookings() {
  const user = getCurrentUser();
  if (!user) return [];
  const snap = await db.collection("bookings")
    .where("userId", "==", user.uid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Get bookings for the current owner (owner-dashboard.html)
async function getOwnerBookings() {
  const user = getCurrentUser();
  if (!user) return [];
  const snap = await db.collection("bookings")
    .where("ownerId", "==", user.uid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Confirm arrival → release funds to owner
async function confirmArrival(bookingId) {
  await db.collection("bookings").doc(bookingId).update({
    status: "funds_released"
  });
}

// Report fake listing → refund user, flag owner
async function reportFakeListing(bookingId, listingId, reason) {
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");

  // Update booking to refunded
  await db.collection("bookings").doc(bookingId).update({
    status: "refunded"
  });

  // Create a report document
  await db.collection("reports").add({
    bookingId:  bookingId,
    listingId:  listingId,
    reportedBy: user.uid,
    reason:     reason || "Fake or misrepresented listing",
    status:     "pending",
    createdAt:  firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Real-time listener for a single booking's status
// Usage: listenToBooking(bookingId, (booking) => { update UI })
function listenToBooking(bookingId, callback) {
  return db.collection("bookings").doc(bookingId)
    .onSnapshot(doc => {
      if (doc.exists) callback({ id: doc.id, ...doc.data() });
    });
}

// ============================================================
//  ADMIN HELPERS  (admin.html)
// ============================================================

// Get all users
async function adminGetAllUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Get all bookings
async function adminGetAllBookings() {
  const snap = await db.collection("bookings")
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// Get all reports — enriched with listing title and reporter name
async function adminGetAllReports() {
  const snap = await db.collection("reports").orderBy("createdAt", "desc").get();
  const reports = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Enrich each report with listing title and reporter name
  await Promise.all(reports.map(async r => {
    try {
      if (r.listingId && !r.listingTitle) {
        const ldoc = await db.collection("listings").doc(r.listingId).get();
        if (ldoc.exists) r.listingTitle = ldoc.data().title;
      }
      if (r.reportedBy && !r.reporterName) {
        const udoc = await db.collection("users").doc(r.reportedBy).get();
        if (udoc.exists) {
          const ud = udoc.data();
          r.reporterName = (ud.name || '') + ' (' + (ud.email || '') + ')';
          r.ownerId = r.ownerId || (r.listingId ? null : null); // will be set from listing
        }
      }
      // Also get ownerId from listing if not set
      if (r.listingId && !r.ownerId) {
        const ldoc = await db.collection("listings").doc(r.listingId).get();
        if (ldoc.exists) r.ownerId = ldoc.data().ownerId;
      }
    } catch(e) {}
  }));

  return reports;
}

// Get all KYC submissions — doc ID is the userId
async function adminGetAllKYC() {
  const snap = await db.collection("kyc_submissions").get();
  return snap.docs.map(doc => ({
    id:     doc.id,
    userId: doc.id,   // kyc_submissions uses uid as doc ID
    ...doc.data()
  }));
}

// Get all listings (admin view) — ordered newest first
async function adminGetAllListings() {
  const snap = await db.collection("listings").orderBy("createdAt", "desc").get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}


// Ban a user (sets banned:true, role stays same)
async function adminBanUser(uid) {
  await db.collection("users").doc(uid).update({ banned: true });
}

// Resolve a report
async function adminResolveReport(reportId) {
  await db.collection("reports").doc(reportId).update({ status: "resolved" });
}

// ============================================================
//  REVIEWS HELPERS
// ============================================================

// Submit a review for a listing (only after completed booking)
async function submitReview(listingId, rating, text) {
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");
  const userDoc = await getUserDoc(user.uid);
  const reviewerName = (userDoc && userDoc.name) ? userDoc.name : (user.displayName || "Anonymous");

  // Save review document
  const ref = await db.collection("reviews").add({
    listingId:    listingId,
    userId:       user.uid,
    reviewerName: reviewerName,
    rating:       Number(rating),
    text:         text,
    createdAt:    firebase.firestore.FieldValue.serverTimestamp()
  });

  // Update listing's average rating
  const reviewsSnap = await db.collection("reviews")
    .where("listingId", "==", listingId).get();
  const reviews = reviewsSnap.docs.map(d => d.data());
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  await db.collection("listings").doc(listingId).update({
    avgRating:   Math.round(avg * 10) / 10,
    reviewCount: reviews.length
  });

  return ref.id;
}

// Get all reviews for a listing
async function getReviews(listingId) {
  const snap = await db.collection("reviews")
    .where("listingId", "==", listingId)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// ============================================================
//  UTILITY HELPERS
// ============================================================

// Format a Firestore Timestamp to a readable date string
function formatDate(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric"
  });
}

// Format currency in INR
function formatINR(amount) {
  return "₹" + Number(amount).toLocaleString("en-IN");
}

// Get URL query param
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Status badge HTML
function statusBadge(status) {
  const map = {
    payment_held:   { label: "Payment Held",   color: "#f59e0b" },
    funds_released: { label: "Funds Released", color: "#059669" },
    refunded:       { label: "Refunded",        color: "#dc2626" },
    pending:        { label: "Pending",         color: "#6b7280" },
    approved:       { label: "Approved",        color: "#059669" },
    rejected:       { label: "Rejected",        color: "#dc2626" }
  };
  const s = map[status] || { label: status, color: "#6b7280" };
  return `<span style="
    background:${s.color}20;
    color:${s.color};
    border:1px solid ${s.color}40;
    padding:3px 10px;
    border-radius:20px;
    font-size:12px;
    font-weight:600;
  ">${s.label}</span>`;
}

// ── Run navbar init on every page ────────────────────────────
document.addEventListener("DOMContentLoaded", initNavbar);
// Add at the bottom of app.js
const confirmArrival_db     = confirmArrival;
const reportFakeListing_db  = reportFakeListing;

// ============================================================
//  NAVBAR AVATAR + DROPDOWN  (Phase 3)
// ============================================================
function initNavbarAvatar() {
  auth.onAuthStateChanged(async (user) => {
    const avatar = document.getElementById('navAvatar');
    if (!avatar) return;

    if (user) {
      const userData = await getUserDoc(user.uid);
      const name = (userData && userData.name) ? userData.name : (user.displayName || user.email || 'User');
      const initial = name.charAt(0).toUpperCase();

      avatar.textContent = initial;
      avatar.style.cursor = 'pointer';
      avatar.title = name;

      avatar.onclick = function(e) {
        e.stopPropagation();
        const existing = document.getElementById('navDropdown');
        if (existing) { existing.remove(); return; }

        const dropdown = document.createElement('div');
        dropdown.id = 'navDropdown';
        dropdown.innerHTML = `
          <div class="nav-dropdown-name">${name}</div>
          <hr class="nav-dropdown-divider"/>
          <a href="booking-history.html" class="nav-dropdown-item">📋 My Bookings</a>
          <a href="map.html" class="nav-dropdown-item">🗺️ Browse Listings</a>
          <hr class="nav-dropdown-divider"/>
          <button class="nav-dropdown-item nav-dropdown-signout" onclick="signOutUser().then(()=>{ window.location.href='login.html'; })">🚪 Sign Out</button>
        `;
        dropdown.className = 'nav-dropdown';

        // Position below avatar
        const rect = avatar.getBoundingClientRect();
        dropdown.style.top  = (rect.bottom + 8 + window.scrollY) + 'px';
        dropdown.style.right = (window.innerWidth - rect.right) + 'px';
        document.body.appendChild(dropdown);

        // Close on outside click
        setTimeout(() => {
          document.addEventListener('click', function closeDropdown(ev) {
            if (!dropdown.contains(ev.target) && ev.target !== avatar) {
              dropdown.remove();
              document.removeEventListener('click', closeDropdown);
            }
          });
        }, 0);
      };

    } else {
      // Not logged in — show login link
      avatar.textContent = '?';
      avatar.title = 'Login';
      avatar.style.cursor = 'pointer';
      avatar.onclick = () => window.location.href = 'login.html';
    }
  });
}

// Run avatar init on every page (safe — no-op if #navAvatar absent)
document.addEventListener('DOMContentLoaded', initNavbarAvatar);
