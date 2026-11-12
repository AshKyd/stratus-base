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

The `SevenZipWriter`/`SevenZipReader` codec that powers `MiddlewareZipChunk` is also exported
directly for building or reading standalone `.7z` archives outside the sync flow — see
[Direct 7z Archive Access](#7-direct-7z-archive-access-sevenzipwriter--sevenzipreader) below.

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

### 2. Checking Remote Setup

Check if the remote storage already contains existing data or if onboarding is required:

```typescript
const isSetUp = await client.isSetUp();
if (!isSetUp) {
	// First-time onboarding (e.g. prompt user to create/save password, seed initial files)
} else {
	// Existing data detected (e.g. prompt for existing vault password)
}
```

### 3. File Operations

Local client operations are simple Promise-based async methods. You can work with raw binary data or use built-in text helpers:

```typescript
// Working with Text (Helpers)
await client.writeTextFile('/todo.md', '- [ ] Task');
const todoText = await client.readTextFile('/todo.md');

// Working with Binary Data
await client.writeFile('/image.png', pngBytes);
const imageBytes = await client.readFile('/image.png');
```

### 4. Synchronization

Run `sync()` to push local edits and pull remote changes:

```typescript
const result = await client.sync();
console.log(result.created, result.updated, result.deleted);
```

> [!NOTE]
> Concurrent calls to `sync()` are queued and coalesced automatically. If multiple sync operations are requested while a sync is already active, they will wait and run exactly once in a single coalesced follow-up execution.

### 5. Cooperative Lockfile (Concurrency Control)

To prevent multiple clients from syncing concurrently, `StratusBase` creates a remote `/sync.lock` file while syncing.

- `client.canSync()` returns `true` if free, or `false` if locked.
- `client.sync()` will throw a `SyncLockedError` if locked.
- `client.forceSync()` clears the lockfile and starts a sync.

```typescript
// Check remote lock status
if (await client.canSync()) {
	await client.sync();
}
```

### 6. Session Reset & Logout

Call `reset()` to recursively delete the local cache folder in OPFS and clear credentials on the configured backend:

```typescript
await client.reset();
```

### 7. Direct 7z Archive Access (`SevenZipWriter` / `SevenZipReader`)

`SevenZipWriter` and `SevenZipReader` provide direct access to the underlying 7z WebAssembly codec.

```typescript
import { SevenZipWriter, SevenZipReader } from 'stratus-base';

// Create an archive
const writer = new SevenZipWriter('optional-password');
await writer.write({ path: 'todo.md', data: new TextEncoder().encode('- [ ] Task') });
await writer.write({ path: 'images/logo.png', data: pngBytes });

const archiveBytes = await writer.finalize((percent) => {
	console.log(`Compressing: ${percent}%`);
});

// Extract an archive
const reader = new SevenZipReader('optional-password');
await reader.appendChunk(archiveBytes);

for await (const entry of reader.extract()) {
	console.log(entry.path, entry.data);
}
```

#### Custom Formats and Options

Both constructors accept an optional `options` (`SevenZipOptions`) object to configure the archive format and compression flags:

```typescript
// Create a .zip archive instead of the default .7z
const writer = new SevenZipWriter(undefined, {
	filename: 'archive.zip', // Format is inferred from extension (.zip, .7z, .tar, etc.)
	extraArgs: ['-mx=1']     // Optional 7-Zip CLI arguments (e.g. compression level)
});
const archiveBytes = await writer.finalize();

// Read a .zip archive
const reader = new SevenZipReader(undefined, { filename: 'archive.zip' });
await reader.appendChunk(archiveBytes);
```

#### API Details

- **`options.filename`** (`string`, default: `'archive.7z'`): Sets the archive format inferred from the file extension (e.g., `.zip`, `.7z`, `.tar`).
- **`options.extraArgs`** (`string[]`): Custom CLI flags passed directly to 7-Zip (e.g., `['-mx=9']` for maximum compression).
- **Encryption**: Passing a `password` enables AES-256 encryption. For `.7z` archives, header encryption (`-mhe=on`) is enabled automatically to obscure filenames and archive metadata.
- **Streams**: Both classes provide a `writable` (`WritableStream`).
  - `SevenZipWriter.writable`: Accepts `{ path: string, data: Uint8Array }` objects.
  - `SevenZipReader.writable`: Accepts `Uint8Array` archive byte chunks (e.g., piped from `fetch` or a file stream).
- **Progress Tracking**: `SevenZipWriter.finalize(onProgress?: (percent: number) => void)` yields progress (`0`–`100`) between batch compression cycles.
- **Extraction**: `SevenZipReader.extract()` is an async generator yielding `{ path: string, data: Uint8Array }` entries.

---

## Development Setup

### WASM files

`MiddlewareZipChunk` and `SevenZipWriter`/`SevenZipReader` run 7-Zip as WebAssembly
([JS7z](https://github.com/GMH-Code/JS7z)). The library does not bundle the wasm: the consuming
app serves it and tells `stratus-base` where, by calling `configureWasm` once at startup, in the
main thread and in any worker that touches archives.

```typescript
import { configureWasm } from 'stratus-base';

configureWasm({ baseUrl: '/wasm', threads: 'auto' });
```

- Copy the files into a public folder (run before dev and build, and git-ignore the output):

  ```bash
  node node_modules/stratus-base/scripts/publish-wasm.mjs static/wasm
  ```

  This writes `single/` and `multi/`, each with `js7z.mjs` and `js7z.wasm`.

- `baseUrl`: absolute or root-relative folder holding `single/` and `multi/`. Default is the
  jsDelivr copy of this package's `wasm/` folder (`DEFAULT_WASM_BASE_URL`), which only runs
  single-threaded.
- `threads`:
  - `'auto'` (default): multi-threaded when the page is cross-origin isolated and `baseUrl` is
    same-origin, otherwise single-threaded.
  - `'single'` / `'multi'`: force one.
- Multi-threaded needs `SharedArrayBuffer`, so the page must send
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
  Its pthread workers start from the `multi/js7z.mjs` URL, so it must be same-origin. A CSP needs
  `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`.
- Node (tests, SSR) ignores `configureWasm` and loads the `js7z-tools` dependency directly.
- `smokeTestSevenZip()` reports a wrong path at its `load-wasm` step.

### Building the wasm folder

The multi-threaded build is the `js7z-tools` npm dependency (identical to the upstream
`js7z-mt-fs-ec-es6module` release). The single-threaded build has no npm package, so it is
fetched from the upstream release into `wasm/single/` by `npm run setup:js7z` (see
`scripts/setup-js7z.mjs`). `prepare`, `dev`, `build`, `test`, and `test:browser` run this
automatically first, so a plain `npm install` is enough; run it manually (add `--force` to
refetch) if you need to.

The script uses **only Node builtins** — `fetch`, `node:zlib` and `node:crypto` — with no
`curl`, `unzip` or third-party packages, because it runs during `npm install` on machines we
don't control (CI, Docker images, and consumers installing straight from git). The download is
pinned by version _and_ SHA-256; a mismatch fails loudly rather than vendoring an unexpected
build.

It writes `wasm/single/js7z.mjs` (the release's UMD glue with its export tail swapped for
`export default`, so the browser can `import()` it) and `wasm/single/js7z.wasm`. Both are
git-ignored but shipped in the npm package (`files`).

**Bumping the js7z version:** change `JS7Z_VERSION` in `scripts/setup-js7z.mjs`, run
`npm run setup:js7z -- --force` (it will fail on the checksum), then update
`JS7Z_RELEASE_SHA256` to the digest it reports and re-run. Also bump the exact `js7z-tools`
version in `package.json` and `PACKAGE_VERSION` in `src/lib/utils/wasmConfig.ts` when releasing.

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
