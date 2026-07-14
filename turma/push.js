// turma — mobile push (Firebase Cloud Messaging) fan-out for the alert bus.
//
// The hub already funnels every edge-triggered alert through server.js's
// notify() (host offline/recovered, restart loop, cost threshold, question
// waiting, PR created, turn finished). This module lets notify() ALSO deliver
// those alerts to registered mobile devices (the Android client) via FCM, in
// addition to the existing ntfy push — so the phone gets OS-level notifications
// even when the app is backgrounded.
//
// stdlib only — no npm dependencies (matches the repo's zero-dep stance). FCM's
// HTTP v1 API needs an OAuth2 access token minted from a service-account key;
// we sign the JWT with node:crypto (RS256) and exchange it with a plain fetch,
// caching the short-lived token. Messages are sent as DATA messages (not
// `notification`) so the app builds the notification itself and controls the
// channel + deep-link even in the background.
//
// Config (inline env, DockerOps convention): FCM_SERVICE_ACCOUNT_JSON = the
// service-account JSON, inline. Unset ⇒ this module is a no-op, exactly like
// notify() when NTFY_URL is unset — "graceful when unconfigured".

"use strict";

const crypto = require("crypto");

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

// The service account, parsed once from the env. Overridable at runtime for
// tests via _setServiceAccount().
let SA = null;
try {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON || "";
  if (raw.trim()) SA = JSON.parse(raw);
} catch (e) {
  console.error(`FCM_SERVICE_ACCOUNT_JSON parse failed: ${e.message}`);
}

// Cached OAuth2 access token: { accessToken, expEpochMs }.
let tokenCache = null;

function fcmEnabled() {
  return !!(SA && SA.private_key && SA.client_email && SA.project_id);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Mint (or reuse a cached) Google OAuth2 access token for the FCM scope by
// signing a JWT with the service-account private key (RS256) and exchanging it
// at the token endpoint. Cached until ~1 min before expiry.
async function accessToken(now = Date.now()) {
  if (tokenCache && tokenCache.expEpochMs - now > 60 * 1000) return tokenCache.accessToken;
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: SA.client_email,
      scope: FCM_SCOPE,
      aud: SA.token_uri || TOKEN_URI,
      iat,
      exp,
    })
  );
  const signingInput = `${header}.${claim}`;
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), SA.private_key));
  const assertion = `${signingInput}.${signature}`;
  const res = await fetch(SA.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const data = await res.json();
  tokenCache = {
    accessToken: data.access_token,
    expEpochMs: now + (data.expires_in || 3600) * 1000,
  };
  return tokenCache.accessToken;
}

// Send one data-message to each device token. Returns { sent, dead } where
// `dead` is the tokens FCM reported as unregistered/not-found — the caller
// prunes them from the registry so a stale device stops being retried. A
// no-op returning { sent:0, dead:[] } when FCM is unconfigured or there are no
// tokens. Never throws — a push failure must never break the alert path.
async function sendFcm(tokens, { title, body, data = {} } = {}) {
  if (!fcmEnabled() || !tokens || !tokens.length) return { sent: 0, dead: [] };
  let access;
  try {
    access = await accessToken();
  } catch (e) {
    console.error(`fcm token mint failed: ${e.message}`);
    return { sent: 0, dead: [] };
  }
  const url = `https://fcm.googleapis.com/v1/projects/${SA.project_id}/messages:send`;
  // FCM data payload values must all be strings.
  const strData = {};
  for (const [k, v] of Object.entries({ title, body, ...data })) {
    if (v != null && v !== "") strData[k] = String(v);
  }
  const dead = [];
  let sent = 0;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: { token, data: strData, android: { priority: "high" } },
          }),
        });
        if (r.ok) {
          sent++;
          return;
        }
        const errBody = await r.text().catch(() => "");
        // A stale/unregistered token: 404 UNREGISTERED / NOT_FOUND. Prune it.
        // Other non-2xx (auth, quota, transient) are logged, not pruned, so a
        // server-side hiccup can't wipe the registry.
        if (r.status === 404 || /UNREGISTERED|NOT_FOUND/.test(errBody)) {
          dead.push(token);
        } else {
          console.error(`fcm send ${r.status} for token …${String(token).slice(-6)}`);
        }
      } catch (e) {
        console.error(`fcm send failed: ${e.message}`);
      }
    })
  );
  return { sent, dead };
}

// Test hooks: swap the service account and reset the token cache so push.js can
// be exercised offline with a generated key + a stubbed fetch.
function _setServiceAccount(sa) {
  SA = sa;
  tokenCache = null;
}
function _resetTokenCache() {
  tokenCache = null;
}

module.exports = {
  sendFcm,
  accessToken,
  fcmEnabled,
  _setServiceAccount,
  _resetTokenCache,
};
