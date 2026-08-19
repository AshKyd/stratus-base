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
3. Select **Desktop app** (or **Desktop**) as the Application type.
4. Name your client ID (e.g., "Stratus Desktop Client").
5. Click **Create**.
6. Copy the generated **Client ID** (Desktop apps do not use or expose a Client Secret).

---

## 5. Implement the Auth Flow in Client-Side JS

Since `GoogleDriveStorage` runs exclusively in the client browser, it uses the secure **OAuth 2.0 Authorization Code Flow with PKCE**, which does not require exposing your Client Secret.

### Step A: Initialize the Backend
```typescript
import { GoogleDriveStorage } from 'stratus-base';

const backend = new GoogleDriveStorage({
  clientId: 'YOUR_GOOGLE_CLIENT_ID' // Found in Google Cloud Credentials
});
```

### Step B: Redirect to Google Login
```typescript
async function login() {
  const redirectUri = 'http://localhost:5173/test/google-drive';
  // Generates auth URL and automatically saves the PKCE code_verifier in sessionStorage
  const authUrl = await backend.getAuthUrl(redirectUri);
  window.location.href = authUrl;
}
```

### Step C: Handle the Redirect Callback
On your callback page (e.g., `/test/google-drive`):
```typescript
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

onMount(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const redirectUri = 'http://localhost:5173/test/google-drive';

  if (code) {
    // Exchanges code using the saved sessionStorage verifier and saves credentials internally
    const credentials = await backend.exchangeCode(code, redirectUri);
    
    // Save to localStorage for persistence across reloads
    localStorage.setItem('google_drive_creds', JSON.stringify(credentials));
    
    goto(resolve('/'));
  }
});
```

### Step D: Restore Credentials on Load
```typescript
const storedCreds = localStorage.getItem('google_drive_creds');
if (storedCreds) {
  backend.setCredentials(JSON.parse(storedCreds));
}

// Check if authenticated (automatic token refresh happens here if needed)
if (await backend.isConfigured()) {
  console.log('Google Drive is ready!');
}
```
