# Setup Guide: Google Drive Storage Backend

This guide outlines how to configure a Google Cloud Project and initialize the `GoogleDriveStorage` backend in your client-side application.

---

## 1. Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown and select **New Project**.
3. Give your project a name and click **Create**.

---

## 2. Enable Google Drive API

1. In the Google Cloud Console, search for **Google Drive API** in the top search bar.
2. Click **Google Drive API** from the Marketplace results.
3. Click the **Enable** button.

---

## 3. Configure OAuth Consent Screen

1. Navigate to **APIs & Services > OAuth consent screen** from the left navigation menu.
2. Choose **External** User Type (unless you are a Google Workspace organization user and want to restrict to internal users) and click **Create**.
3. Fill in the required App Information:
   - **App name**: E.g., "Stratus"
   - **User support email**: Your email address
   - **Developer contact information**: Your email address
4. Click **Save and Continue**.
5. Under **Scopes**, click **Add or Remove Scopes**:
   - Add/check `https://www.googleapis.com/auth/drive.file` (allows managing files and folders created or opened by the app).
   - Click **Update** at the bottom.
6. Click **Save and Continue** until you reach the dashboard.

---

## 4. Create OAuth Credentials

1. Go to **APIs & Services > Credentials** from the left navigation menu.
2. Click **Create Credentials** at the top and select **OAuth client ID**.
3. Select **Web application** as the Application type. Browser flows require this type —
   a Desktop app client only permits loopback redirect URIs and will reject your site's URL.
4. Name your client ID (e.g., "Stratus Web Client").
5. Under **Authorised JavaScript origins**, add each origin the app is served from:
   - `http://localhost:5173` (development)
   - `https://your-domain.example` (production)
6. Under **Authorised redirect URIs**, add your callback route on each origin. Use one route
   for every flow — see section 5:
   - `http://localhost:5173/auth/callback`
   - `https://your-domain.example/auth/callback`
7. Click **Create** and copy the generated **Client ID**.

A Web application client also issues a Client Secret. `GoogleDriveStorage` never uses it, and
it must not be shipped to the browser. Leave it unused.

---

## 5. Add the Callback Route

`GoogleDriveStorage` uses one redirect URI for everything: first-time authorisation, returning
sign-in, and silent renewal. Register that single URL in the console and point the backend at
it.

Create a route at the path you registered (e.g. `/auth/callback`) and call
`GoogleDriveStorage.handleAuthCallback()` from it. It reads the OAuth response out of the URL
fragment and tells you which kind of callback this was:

| `mode` | Meaning | What to do |
|---|---|---|
| `popup` | A silent renewal completed. The result has already been posted to the opening window, which is closing itself. | Nothing. Render a placeholder. |
| `redirect` | A full interactive flow completed. `credentials` and `state` are returned. | Save the credentials and route the user onward. |
| `error` | Google declined the request. | Show the error and offer to sign in again. |

A `null` return means the URL carries no OAuth response — someone navigated to the route
directly.

```typescript
import { GoogleDriveStorage } from 'stratus-base';

const result = GoogleDriveStorage.handleAuthCallback();

if (!result) {
  goto(resolve('/login'));
} else if (result.mode === 'redirect') {
  backend.setCredentials(result.credentials);
  localStorage.setItem('google_drive_creds', JSON.stringify(result.credentials));
  goto(resolve('/'));
} else if (result.mode === 'error') {
  console.error(result.error);
}
```

`handleAuthCallback()` strips the access token from the address bar before returning, so it
does not linger in browser history.

---

## 6. Start the Interactive Flow

### Initialise the backend
```typescript
import { GoogleDriveStorage } from 'stratus-base';

const backend = new GoogleDriveStorage({
  clientId: 'YOUR_GOOGLE_CLIENT_ID',
  redirectUri: window.location.origin + '/auth/callback'
});
```

Setting `redirectUri` here means `getAuthUrl()` and `renewAccessToken()` both use it without
being told each time.

### Send the user to Google
```typescript
const authUrl = await backend.getAuthUrl(undefined, 'login');
window.location.href = authUrl;
```

The second argument is an optional `state` value, returned unchanged on the callback.

### Restore credentials on load
```typescript
const storedCreds = localStorage.getItem('google_drive_creds');
if (storedCreds) {
  backend.setCredentials(JSON.parse(storedCreds));
}

if (await backend.isConfigured()) {
  console.log('Google Drive is ready!');
}
```

---

## 7. Keeping the Session Alive

Google access tokens are short-lived. `renewAccessToken()` obtains a new one without showing
the consent screen, by opening a brief popup against Google with `prompt=none`.

**This must be called from a user gesture.** Browsers block popups that are not opened during
a click or keypress, so the token cannot be renewed from a timer or a background task.

The backend emits three events to drive this:

| Event | Payload | Meaning |
|---|---|---|
| `token-expiring` | `{ expiresAt }` | The token is inside its warning window (10 minutes by default, configurable via `expiryWarningMs`). Renew on the next gesture. |
| `token-renewed` | `StorageAuthCredentials` | A new token was obtained. Persist it. |
| `reauth-required` | `{ reason }` | Silent renewal is not possible. Run the full interactive flow. |

`on()` returns an unsubscribe function.

The pattern is to renew *early*, on ordinary interaction, rather than at the point of failure:

```typescript
let pendingRenewal = false;

backend.on('token-expiring', () => { pendingRenewal = true; });
backend.on('token-renewed', (credentials) => {
  pendingRenewal = false;
  localStorage.setItem('google_drive_creds', JSON.stringify(credentials));
});
backend.on('reauth-required', ({ reason }) => {
  pendingRenewal = false;
  showReconnectPrompt(reason);
});

// Attach to any click or keypress. Cheap — it returns immediately unless a renewal is due.
async function onInteraction() {
  if (!pendingRenewal) return;
  pendingRenewal = false;
  await backend.renewAccessToken().catch(() => {});
}
```

In an app the user interacts with regularly, the renewal lands well before the token lapses
and nothing is visible. `reason` on `reauth-required` distinguishes `popup-blocked`,
`popup-closed`, `timeout`, `unauthorised`, and Google's own `login_required`,
`consent_required`, and `interaction_required`.

### What is not possible

`GoogleDriveStorage` does not use refresh tokens, and cannot. Minting or redeeming one
requires a POST to Google's token endpoint, which demands the Client Secret even when PKCE is
used, and does not send CORS headers. Both rule it out from a browser. Silent renewal via
`renewAccessToken()` is the client-side substitute, with the limits described above: it needs
a gesture, and it stops working once the user's Google session ends.
