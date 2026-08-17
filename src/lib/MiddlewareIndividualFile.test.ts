import test from 'node:test';
import assert from 'node:assert';
import { StratusBase, setStorageManager, SyncConflictError } from './StratusBase.ts';
import { MiddlewareIndividualFile } from './MiddlewareIndividualFile.ts';
import type { StorageBackend, StorageFileInfo, StorageOperation } from './types.ts';
import { BaseStorageOperation } from './utils/BaseStorageOperation.ts';

// --- OPFS Mocks ---

class MockWritableFileStream {
	private file: MockFileHandle;
	constructor(file: MockFileHandle) {
		this.file = file;
	}
	async write(data: any) {
		if (typeof data === 'string') {
			this.file.content = new TextEncoder().encode(data);
		} else if (data instanceof Uint8Array) {
			this.file.content = data;
		} else {
			this.file.content = new Uint8Array(data);
		}
	}
	async close() {}
}

class MockFileHandle {
	kind = 'file' as const;
	content = new Uint8Array();
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	async getFile() {
		return {
			size: this.content.length,
			lastModified: Date.now(),
			text: async () => new TextDecoder().decode(this.content),
			arrayBuffer: async () => this.content.buffer.slice(0, this.content.byteLength)
		};
	}
	async createWritable() {
		return new MockWritableFileStream(this);
	}
}

class MockDirectoryHandle {
	kind = 'directory' as const;
	entries = new Map<string, MockDirectoryHandle | MockFileHandle>();
	name: string;
	constructor(name: string) {
		this.name = name;
	}

	async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
		let entry = this.entries.get(name);
		if (!entry) {
			if (options.create) {
				entry = new MockDirectoryHandle(name);
				this.entries.set(name, entry);
			} else {
				throw new Error(`Directory not found: ${name}`);
			}
		}
		return entry as MockDirectoryHandle;
	}

	async getFileHandle(name: string, options: { create?: boolean } = {}) {
		let entry = this.entries.get(name);
		if (!entry) {
			if (options.create) {
				entry = new MockFileHandle(name);
				this.entries.set(name, entry);
			} else {
				throw new Error(`File not found: ${name}`);
			}
		}
		return entry as MockFileHandle;
	}

	async removeEntry(name: string) {
		this.entries.delete(name);
	}

	async *values() {
		for (const entry of this.entries.values()) {
			yield entry;
		}
	}
}

class MockStorageManager {
	root = new MockDirectoryHandle('root');
	async getDirectory() {
		return this.root;
	}
}

// --- Mock Storage Backend ---

class MockRemoteBackend implements StorageBackend {
	id = 'mock-remote';
	files = new Map<string, { content: Uint8Array; modifiedAt: Date; etag?: string }>();
	atomicWritesTracked: string[] = [];

	async isConfigured() {
		return true;
	}

	async stat(path: string): Promise<StorageFileInfo | null> {
		const file = this.files.get(path);
		if (!file) return null;
		return {
			path,
			name: path.split('/').pop() || '',
			type: 'file',
			size: file.content.length,
			modifiedAt: file.modifiedAt,
			etag: file.etag
		};
	}

	readFile(path: string): StorageOperation<Uint8Array> {
		return new BaseStorageOperation(async () => {
			const file = this.files.get(path);
			if (!file) throw new Error(`Remote file not found: ${path}`);
			return file.content;
		});
	}

	writeFile(path: string, content: Uint8Array, options?: { atomic?: boolean }): StorageOperation<void> {
		return new BaseStorageOperation(async () => {
			if (options?.atomic) {
				this.atomicWritesTracked.push(path);
			}
			this.files.set(path, {
				content,
				modifiedAt: new Date(),
				etag: 'etag-' + Math.random().toString(36).substring(2)
			});
		});
	}

	async deleteFile(path: string): Promise<void> {
		this.files.delete(path);
	}

	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const results: StorageFileInfo[] = [];
		for (const [filePath, file] of this.files.entries()) {
			if (path === '/' || filePath.startsWith(path)) {
				// Simple flat list mapping for recursive walk test support
				results.push({
					path: filePath,
					name: filePath.split('/').pop() || '',
					type: 'file',
					size: file.content.length,
					modifiedAt: file.modifiedAt,
					etag: file.etag
				});
			}
		}
		return results;
	}

	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const existing = this.files.get(oldPath);
		if (existing) {
			this.files.set(newPath, existing);
			this.files.delete(oldPath);
		}
	}
}

test('MiddlewareIndividualFile sync runs', async (t) => {
	await t.test('Remote only (new remote files)', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MockRemoteBackend();
		backend.files.set('/note1.md', {
			content: new TextEncoder().encode('Hello remote 1'),
			modifiedAt: new Date(),
			etag: 'etag1'
		});

		const middleware = new MiddlewareIndividualFile();
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Check initial state
		assert.strictEqual(await stratus.stat('/note1.md'), null);

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created, ['/note1.md']);

		// Verify downloaded locally
		const fileInfo = await stratus.stat('/note1.md');
		assert.ok(fileInfo);
		assert.strictEqual(fileInfo.size, 14);

		const content = await stratus.readFile('/note1.md').finished;
		assert.strictEqual(new TextDecoder().decode(content), 'Hello remote 1');
	});

	await t.test('Local only (new local files)', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MockRemoteBackend();
		const middleware = new MiddlewareIndividualFile();
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Create local file
		await stratus.writeFile('/local.md', new TextEncoder().encode('Hello local')).finished;

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created, ['/local.md']);

		// Verify uploaded to remote
		const remoteFile = backend.files.get('/local.md');
		assert.ok(remoteFile);
		assert.strictEqual(new TextDecoder().decode(remoteFile.content), 'Hello local');

		// Local should be clean
		const meta = await stratus.getMetadata();
		assert.strictEqual(meta.files['/local.md'].status, 'clean');
	});

	await t.test('Sync Conflict (Remote newer, local dirty)', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MockRemoteBackend();
		backend.files.set('/conflict.md', {
			content: new TextEncoder().encode('Remote content'),
			modifiedAt: new Date(Date.now() + 5000), // Future / newer
			etag: 'etag-remote'
		});

		const middleware = new MiddlewareIndividualFile();
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Write locally (sets status to dirty)
		await stratus.writeFile('/conflict.md', new TextEncoder().encode('Local content')).finished;

		// Manually backdate local remoteModifiedAt to trigger newer check
		const meta = await stratus.getMetadata();
		meta.files['/conflict.md'].remoteModifiedAt = Date.now() - 10000;
		await stratus.saveMetadata(meta);

		// Sync and catch conflict
		try {
			await stratus.sync();
			assert.fail('Should have thrown SyncConflictError');
		} catch (err) {
			assert.ok(err instanceof SyncConflictError);
			assert.strictEqual(err.conflicts.length, 1);
			assert.strictEqual(err.conflicts[0].path, '/conflict.md');
		}

		// Verify _updates file exists locally
		const updatesInfo = await stratus.stat('/conflict_updates.md');
		assert.ok(updatesInfo);

		const updatesContent = await stratus.readFile('/conflict_updates.md').finished;
		assert.strictEqual(new TextDecoder().decode(updatesContent), 'Remote content');

		// Original local file should still contain local changes
		const localContent = await stratus.readFile('/conflict.md').finished;
		assert.strictEqual(new TextDecoder().decode(localContent), 'Local content');
	});

	await t.test('Sparse mode sync and lazy read', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MockRemoteBackend();
		backend.files.set('/sparse.md', {
			content: new TextEncoder().encode('Lazy Loaded'),
			modifiedAt: new Date(),
			etag: 'etag-sparse'
		});

		const middleware = new MiddlewareIndividualFile();
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware,
			sparse: true
		});

		// Sync in sparse mode
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created, ['/sparse.md']);

		// Metadata should be present, but file contents not yet in OPFS
		const meta = await stratus.getMetadata();
		assert.strictEqual(meta.files['/sparse.md'].status, 'clean');

		// Read file should trigger lazy load from remote
		const content = await stratus.readFile('/sparse.md').finished;
		assert.strictEqual(new TextDecoder().decode(content), 'Lazy Loaded');
	});

	await t.test('Atomic write options propagation', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MockRemoteBackend();
		const middleware = new MiddlewareIndividualFile({ atomic: true });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		await stratus.writeFile('/atomic.md', new TextEncoder().encode('Atomic data')).finished;
		await stratus.sync();

		assert.ok(backend.atomicWritesTracked.includes('/atomic.md'));
	});
});
