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
