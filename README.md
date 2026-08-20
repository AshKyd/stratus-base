# StratusBase

`StratusBase` is a client-side file synchronisation library that maps a local directory in the browser Origin Private File System (OPFS) to a remote storage provider.

## Architecture

The library consists of three main components:

1. **Client (`StratusBase`)**: Provides the CRUD filesystem interface (`readFile`, `writeFile`, `deleteFile`, `listDirectory`) and exposes the `sync()` method to process remote updates.
2. **Backends (`StorageBackend`)**: Abstract class implementations for remote providers:
   - [Google Drive](docs/google-drive.md)
   - [Dropbox](docs/dropbox.md)
   - [GitHub](docs/github.md)
   - [Amazon S3](docs/s3.md)
   - [MemoryStorage](src/lib/backends/MemoryStorage.ts) (In-memory implementation for testing)
3. **Middleware (`StratusMiddleware`)**: Defines the synchronisation strategy:
   - `MiddlewareIndividualFile`: Synchronises files individually. Supports `sparse` mode (on-demand download of file contents).
   - `MiddlewareZipChunk`: Compresses files into password-protected sequential ZIP archives, hiding file names and folder structures from the remote host. Practical, portable e2e encryption.

---

## Quick Start

### 1. Initialization

Initialize the storage backend, middleware, and the `StratusBase` instance:

```typescript
import { StratusBase, MiddlewareZipChunk, S3Storage, generateSecurePassword } from 'stratus-base';

const backend = new S3Storage({
	bucket: 'my-bucket',
	region: 'us-east-1',
	accessKeyId: 'ACCESS_KEY_ID',
	secretAccessKey: 'SECRET_ACCESS_KEY'
});

const password = generateSecurePassword(64);

const middleware = new MiddlewareZipChunk({
	chunkSizeLimit: 5 * 1024 * 1024,
	password: password,
	atomic: true
});

const client = new StratusBase({
	backend,
	middleware,
	sparse: false
});
```

### 2. File Operations

Local client operations are simple Promise-based async methods. You can work with raw binary data or use built-in text helpers:

```typescript
// Working with Text (Helpers)
await client.writeTextFile('/todo.md', '- [ ] Task');
const todoText = await client.readTextFile('/todo.md');

// Working with Binary Data
await client.writeFile('/image.png', pngBytes);
const imageBytes = await client.readFile('/image.png');
```

### 3. Synchronization

Run `sync()` to push local edits and pull remote changes:

```typescript
const result = await client.sync();
console.log(result.created, result.updated, result.deleted);
```

> [!NOTE]
> Concurrent calls to `sync()` are queued and coalesced automatically. If multiple sync operations are requested while a sync is already active, they will wait and run exactly once in a single coalesced follow-up execution.

### 4. Session Reset & Logout

Call `reset()` to recursively delete the local cache folder in OPFS and clear credentials on the configured backend:

```typescript
await client.reset();
```

---

## Testing

The project has two test suites: unit tests using Node's native test runner and E2E integration tests running in a headless Chromium browser via Vitest and Playwright.

### 1. Unit Tests (Mocked)
Runs unit tests locally in Node using mocked remote storage environments:
```bash
npm run test
```

### 2. E2E Browser Integration Tests
Runs tests inside native browser environments against real remote backends (e.g., Google Drive):
```bash
npm run test:browser
```
> [!NOTE]
> E2E integration tests are skipped by default unless valid authentication credentials exist in your local `.env` file.

#### Setting up Credentials for E2E Tests
To run E2E tests against your real accounts:
1. Start the local Svelte development server:
   ```bash
   npm run dev
   ```
2. Navigate to the tester pages in your browser:
   - Google Drive: `http://localhost:5173/test/google-drive`
   - Dropbox: `http://localhost:5173/test/dropbox`
3. Enter your OAuth Client ID and click **Connect**. Complete the login flow.
4. Once authenticated, the Svelte client UI automatically posts the resulting tokens and configurations to a development-only API endpoint, saving them to your local `.env` file.
5. You can now close the server and run the E2E tests:
   ```bash
   npm run test:browser
   ```

#### Debug Logs
When E2E tests are run, detailed logs outlining actions taken, zip archive uncompressed sizes, compressed sizes, and packed files are written to `debug.txt` at the root of the project directory.

---

## Documentation

For detailed configurations, see the following documentation:

- [Getting Started Guide](docs/getting-started.md)
- [Google Drive Integration](docs/google-drive.md)
- [Dropbox Integration](docs/dropbox.md)
- [GitHub Integration](docs/github.md)
- [Amazon S3 Integration](docs/s3.md)
- [Core Design Plan](plans/index.md)
- [API Reference](plans/API.md)
