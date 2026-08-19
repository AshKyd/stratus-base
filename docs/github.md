# Setup Guide: GitHub Storage Backend

This guide outlines how to generate a Personal Access Token (PAT) on GitHub and initialize the `GithubStorage` backend in your client-side application.

---

## 1. Create a GitHub Personal Access Token

Since the GitHub storage backend runs exclusively in the browser and does not require a backend OAuth proxy/client secret, it authenticates using a user-provided **GitHub Personal Access Token (PAT)**.

### Option A: Fine-grained Personal Access Token (Recommended)
1. Go to [GitHub Developer Settings](https://github.com/settings/tokens?type=beta).
2. Click **Generate new token**.
3. Under **Repository access**, select **Only select repositories** and pick the repository you want to sync with.
4. Under **Permissions**, click **Repository permissions** and enable:
   - **Contents**: Read and Write
5. Click **Generate token** and copy it safely.

### Option B: Classic Personal Access Token
1. Go to [GitHub Tokens Classic](https://github.com/settings/tokens).
2. Click **Generate new token (classic)**.
3. Select the **repo** scope (Full control of private and public repositories).
4. Click **Generate token** and copy it safely.

---

## 2. Initialize and Configure the Backend

Initialize the `GithubStorage` instance with the repository options and pass your token credentials.

```typescript
import { GithubStorage } from 'stratus-base';

// 1. Initialize backend configuration
const backend = new GithubStorage({
  owner: 'AshKyd',          // Repository owner username or org
  repo: 'stratus-base',     // Repository name
  branch: 'main'            // Branch to target (optional, defaults to 'main')
});

// 2. Set credentials
backend.setCredentials({
  accessToken: 'YOUR_GITHUB_PERSONAL_ACCESS_TOKEN'
});

// 3. Verify configuration
if (await backend.isConfigured()) {
  console.log('GitHub storage backend is ready!');
}
```

---

## 3. Persistent Session Storage

To keep the user authenticated across page refreshes, serialize and store the credentials in `localStorage`:

```typescript
// Save credentials after user input
const credentials = backend.getCredentials();
localStorage.setItem('github_creds', JSON.stringify(credentials));

// Restore on application load
const cached = localStorage.getItem('github_creds');
if (cached) {
  backend.setCredentials(JSON.parse(cached));
}
```
