/* Vaani Firebase settings: the production project "vaani-accounts" (team/accounts/FIREBASE-CONFIG.md).
   These values are public by design: every visitor's browser receives them. What protects the data is
   backend/firestore.rules. They are used only while sign-in is switched on (VAANI_ACCOUNTS_ENABLED in accounts.js,
   or a tester's ?accounts=1); with it off, this file is never loaded.
   The project's measurementId is deliberately left out: Vaani never loads Google Analytics or any Firebase analytics module.
   The project ID is also pinned in the CSP of index.html (tests/csp.py PROJECT_ID) and admin.html; change all three together. */
export const VAANI_FIREBASE_CONFIG = {
  apiKey: "AIzaSyD5g-dZPZtza5vZlI_ni0huDLQ5URICuUs",
  authDomain: "vaani-accounts.firebaseapp.com",
  projectId: "vaani-accounts",
  storageBucket: "vaani-accounts.firebasestorage.app",
  messagingSenderId: "263573145051",
  appId: "1:263573145051:web:86b8fbdf8fada6711ed3fe",
};

/* The OAuth "Web client" for Google sign-in (Google Identity Services + signInWithCredential). Not the Calendar
   client in calendar.js. Its Authorised JavaScript origins must include https://pradeep411.github.io. */
export const VAANI_GOOGLE_SIGNIN_CLIENT_ID = "263573145051-4o59c4mnou8qlu8n8uja9fki97qtnoak.apps.googleusercontent.com";

/* The only account the dashboard opens for. firestore.rules checks the same address on the server. */
export const VAANI_ADMIN_EMAIL = "pradeepzille111@gmail.com";
