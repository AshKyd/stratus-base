# Getting Started with StratusBase

`StratusBase` is a client-side synchronisation library that lets you build offline-first web applications using browser Origin Private File System (OPFS) storage and sync with remote storage backends (Dropbox, Google Drive, GitHub, S3). It supports end-to-end AES-256 encrypted chunking.

---

## 1. Installation & Imports

```typescript
import { StratusBase, generateSecurePassword } from 'stratus-base';
import { MiddlewareZipChunk } from 'stratus-base';
import { S3Storage } from 'stratus-base';
```

---

## 2. Choosing and Initialising a Backend

Choose the storage provider you want to use. For key-based setups like Amazon S3:

```typescript
const backend = new S3Storage({
	bucket: 'my-app-vault',
	region: 'us-east-1',
	accessKeyId: 'YOUR_ACCESS_KEY',
	secretAccessKey: 'YOUR_SECRET_KEY'
});
```

*(For interactive OAuth backends like Dropbox or Google Drive, consult their specific setup guides in the `docs/` folder.)*

---

## 3. Configuring Middleware

Middlewares control how files are stored remotely. 

### Encrypted ZIP Chunking (`MiddlewareZipChunk`)
Packs files into sequential, password-encrypted ZIP archives. This hides filenames, sizes, and file structures from the remote host (ideal for privacy/Obsidian-style apps).

```typescript
// Always generate or load a strong password (at least 16 chars, ideally 64)
const password = localStorage.getItem('vault_password') || generateSecurePassword(64);

const middleware = new MiddlewareZipChunk({
	chunkSizeLimit: 5 * 1024 * 1024, // 5MB target chunk size
	password: password,              // Enforces AES-256 encryption
	atomic: true                     // Enables atomic write-then-rename if supported
});
```

---

## 4. Initialising StratusBase

Pass the backend and middleware into the main sync client:

```typescript
const client = new StratusBase({
	backend,
	localRoot: '/my-notes-vault',  // Cache directory inside browser OPFS
	middleware,
	sparse: false                  // If true, downloads file contents on-demand (lazy)
});
```

---

## 5. Working with Files (CRUD)

`StratusBase` exposes standard filesystem operations that interact with the local OPFS cache:

### Writing a file
```typescript
const content = new TextEncoder().encode('# Welcome to StratusBase');
const writeOp = client.writeFile('/notes/intro.md', content);

// Wait for operation to write locally
await writeOp.finished;
```

### Reading a file
```typescript
const readOp = client.readFile('/notes/intro.md');
const bytes = await readOp.finished;
const markdownText = new TextDecoder().decode(bytes);
```

### Listing a directory
```typescript
const files = await client.listDirectory('/notes');
for (const file of files) {
	console.log(file.name, file.size, file.modifiedAt);
}
```

### Deleting a file
```typescript
await client.deleteFile('/notes/intro.md');
```

---

## 6. Synchronising with Remote

To push local updates and pull remote changes, run the `sync()` method:

```typescript
try {
	const result = await client.sync();
	console.log(`Sync completed! Created: ${result.created.length}, Updated: ${result.updated.length}`);
} catch (err) {
	if (err.name === 'SyncConflictError') {
		console.warn('Sync finished with conflicts. Handle resolution.');
	} else {
		console.error('Sync failed:', err);
	}
}
```

---

## 7. Event System

`StratusBase` extends the native browser `EventTarget` class. You can attach standard event listeners to monitor sync lifecycles:

```typescript
client.addEventListener('syncstart', () => {
	console.log('Sync process started...');
});

client.addEventListener('sync', (e) => {
	const result = (e as CustomEvent).detail;
	console.log('Sync finished successfully:', result);
});

client.addEventListener('conflict', (e) => {
	const conflict = (e as CustomEvent).detail;
	console.warn(`File in conflict: ${conflict.path}`);
	
	// Trigger conflict resolution flow
});

client.addEventListener('error', (e) => {
	const error = (e as CustomEvent).detail;
	console.error('Sync error occurred:', error);
});
```

---

## 8. Handling Conflicts

When a conflict occurs (i.e. both local and remote have newer modifications), `StratusBase` writes the remote content to an updates file (`/path/to/file_updates.ext`) and flags the original file in a `'conflict'` state.

To resolve it, invoke `resolveConflict` with the target path and the final resolved bytes:

```typescript
// Resolve conflict by keeping local or remote content, or custom merges:
const resolvedBytes = new TextEncoder().encode('Merged Content Here');

await client.resolveConflict('/notes/intro.md', resolvedBytes);
// The temporary updates file is automatically cleaned up and the file is marked dirty to push next sync.
```
