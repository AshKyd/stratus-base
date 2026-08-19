# Setup Guide: Dropbox Storage Backend

This guide outlines how to configure a Dropbox App Console and initialize the `DropboxStorage` backend in your client-side application.

---

## 1. Create a Dropbox App

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps).
2. Click **Create app**.
3. Choose an API: **Scoped access**.
4. Choose the type of access: **App folder** (recommended for single-app storage) or **Full Dropbox**.
5. Give your app a name and click **Create app**.

---

## 2. Configure Settings in Dropbox Console

In your app settings:

1. **OAuth 2.0 Redirect URIs**:
   - Add your application's callback URLs (e.g. `http://localhost:5173/oauth/callback` for development, or `https://your-app.com/oauth/callback` for production).
2. **Permissions (Scopes)**:
   - Navigate to the **Permissions** tab.
   - For file operations, ensure the following scopes are checked:
     - `files.metadata.read`
     - `files.metadata.write`
     - `files.content.read`
     - `files.content.write`
   - Click **Submit** at the bottom of the page to save.

---

## 3. Implement the Auth Flow in Client-Side JS

Since `DropboxStorage` runs exclusively in the client browser, it uses the secure **OAuth 2.0 Authorization Code Flow with PKCE**, which does not require exposing your Client Secret.

### Step A: Initialize the Backend
```typescript
import { DropboxStorage } from 'stratus-base';

const backend = new DropboxStorage({
  clientId: 'YOUR_DROPBOX_APP_KEY' // Found in the Dropbox App Console settings
});
```

### Step B: Redirect to Dropbox Login
```typescript
async function login() {
  const redirectUri = 'http://localhost:5173/oauth/callback';
  // Generates auth URL and automatically saves the PKCE code_verifier in sessionStorage
  const authUrl = await backend.getAuthUrl(redirectUri);
  window.location.href = authUrl;
}
```

### Step C: Handle the Redirect Callback
On your callback page (e.g., `/oauth/callback`):
```typescript
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

onMount(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const redirectUri = 'http://localhost:5173/oauth/callback';

  if (code) {
    // Exhanges code using the saved sessionStorage verifier and saves credentials internally
    const credentials = await backend.exchangeCode(code, redirectUri);
    
    // Save to localStorage for persistence across reloads
    localStorage.setItem('dropbox_creds', JSON.stringify(credentials));
    
    goto(resolve('/'));
  }
});
```

### Step D: Restore Credentials on Load
```typescript
const storedCreds = localStorage.getItem('dropbox_creds');
if (storedCreds) {
  backend.setCredentials(JSON.parse(storedCreds));
}

// Check if authenticated (automatic token refresh happens here if needed)
if (await backend.isConfigured()) {
  console.log('Dropbox is ready!');
}
```
