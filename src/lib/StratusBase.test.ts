import test from 'node:test';
import assert from 'node:assert';
import { StratusBase, setStorageManager } from './StratusBase.ts';
import type { StorageBackend } from './types.ts';

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
			this.file.content = data as any;
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

class MockBackend extends EventTarget implements StorageBackend {
	id = 'mock';
	async isConfigured() { return true; }
	async stat() { return null; }
	readFile(): any { return {}; }
	writeFile(): any { return {}; }
	async deleteFile() {}
	async listDirectory() { return []; }
	async renameFile() {}
}

const mockMiddleware = {
	async sync() {
		return { created: [], updated: [], deleted: [] };
	},
	async isSetUp() {
		return true;
	}
};

test('StratusBase local operations', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: mockMiddleware
	});

	await t.test('writeFile and stat', async () => {
		const content = new TextEncoder().encode('Hello, OPFS!');
		await stratus.writeFile('/test.txt', content);

		const fileInfo = await stratus.stat('/test.txt');
		assert.ok(fileInfo);
		assert.strictEqual(fileInfo.name, 'test.txt');
		assert.strictEqual(fileInfo.size, content.length);
		assert.strictEqual(fileInfo.type, 'file');

		const meta = await stratus.getMetadata();
		assert.strictEqual(meta.files['/test.txt'].status, 'dirty');
	});

	await t.test('readFile', async () => {
		const content = await stratus.readFile('/test.txt');
		const text = new TextDecoder().decode(content);
		assert.strictEqual(text, 'Hello, OPFS!');
	});

	await t.test('writeTextFile and readTextFile', async () => {
		await stratus.writeTextFile('/text-helper.txt', 'Hello, StratusBase Text Helper!');
		const textContent = await stratus.readTextFile('/text-helper.txt');
		assert.strictEqual(textContent, 'Hello, StratusBase Text Helper!');
		await stratus.deleteFile('/text-helper.txt');
	});

	await t.test('renameFile', async () => {
		await stratus.renameFile('/test.txt', '/renamed.txt');

		const oldInfo = await stratus.stat('/test.txt');
		assert.strictEqual(oldInfo, null);

		const newInfo = await stratus.stat('/renamed.txt');
		assert.ok(newInfo);
		assert.strictEqual(newInfo.name, 'renamed.txt');

		const content = await stratus.readFile('/renamed.txt');
		const text = new TextDecoder().decode(content);
		assert.strictEqual(text, 'Hello, OPFS!');
	});

	await t.test('listDirectory', async () => {
		const files = await stratus.listDirectory('/');
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].name, 'renamed.txt');
	});

	await t.test('deleteFile', async () => {
		await stratus.deleteFile('/renamed.txt');
		const fileInfo = await stratus.stat('/renamed.txt');
		assert.strictEqual(fileInfo, null);

		const meta = await stratus.getMetadata();
		assert.strictEqual(meta.files['/renamed.txt'].status, 'deleted');
	});
});

test('StratusBase EventTarget events', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	
	await t.test('dispatches syncstart and sync events successfully', async () => {
		const syncResult = { created: ['/a.txt'], updated: [], deleted: [] };
		const mockMw = {
			async sync() {
				return syncResult;
			}
		};
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware: mockMw
		});

		const events: string[] = [];
		let receivedResult: any = null;

		stratus.addEventListener('syncstart', () => {
			events.push('syncstart');
		});

		stratus.addEventListener('sync', (e) => {
			events.push('sync');
			receivedResult = (e as CustomEvent).detail;
		});

		await stratus.sync();

		assert.deepStrictEqual(events, ['syncstart', 'sync']);
		assert.deepStrictEqual(receivedResult, syncResult);
	});

	await t.test('dispatches conflict and error events on sync conflict', async () => {
		const conflictObj = {
			path: '/b.txt',
			localModifiedAt: new Date(),
			remoteModifiedAt: new Date(),
			type: 'conflict' as const
		};
		const mockMw = {
			async sync() {
				const { SyncConflictError } = await import('./StratusBase.ts');
				throw new SyncConflictError([conflictObj]);
			}
		};
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware: mockMw
		});

		const events: string[] = [];
		const conflictsReceived: any[] = [];
		let receivedError: any = null;

		stratus.addEventListener('conflict', (e) => {
			events.push('conflict');
			conflictsReceived.push((e as CustomEvent).detail);
		});

		stratus.addEventListener('error', (e) => {
			events.push('error');
			receivedError = (e as CustomEvent).detail;
		});

		await assert.rejects(async () => {
			await stratus.sync();
		});

		assert.ok(events.includes('conflict'));
		assert.ok(events.includes('error'));
		assert.deepStrictEqual(conflictsReceived, [conflictObj]);
		assert.ok(receivedError instanceof Error);
	});
});

test('StratusBase conflict resolution', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: mockMiddleware
	});

	// Prepare metadata with a conflict file and an updates file
	const metadata = await stratus.getMetadata();
	metadata.files['/conflict.txt'] = {
		path: '/conflict.txt',
		type: 'file',
		size: 10,
		localModifiedAt: Date.now() - 5000,
		remoteModifiedAt: Date.now() - 2000,
		status: 'conflict'
	};
	metadata.files['/conflict_updates.txt'] = {
		path: '/conflict_updates.txt',
		type: 'file',
		size: 15,
		localModifiedAt: Date.now(),
		remoteModifiedAt: 0,
		status: 'clean'
	};
	await stratus.saveMetadata(metadata);

	// Write content for the updates file
	await stratus.writeFile('/conflict_updates.txt', new TextEncoder().encode('Remote content'));
	// Write content for original file
	await stratus.writeFile('/conflict.txt', new TextEncoder().encode('Local cont'));

	// Reset original to conflict status manually (since writeFile marked it dirty)
	const prepMeta = await stratus.getMetadata();
	prepMeta.files['/conflict.txt'].status = 'conflict';
	await stratus.saveMetadata(prepMeta);

	// Perform resolution
	const resolvedContent = new TextEncoder().encode('Merged Content');
	await stratus.resolveConflict('/conflict.txt', resolvedContent);

	// The updates file is tombstoned rather than dropped, so the deletion reaches other clients
	// instead of the sidecar being recreated from the remote on the next download.
	const postMeta = await stratus.getMetadata();
	assert.strictEqual(postMeta.files['/conflict_updates.txt'].status, 'deleted');
	// A tombstoned sidecar must not be readable or listed any more
	assert.strictEqual(await stratus.stat('/conflict_updates.txt'), null);
	assert.ok(postMeta.files['/conflict.txt']);
	assert.strictEqual(postMeta.files['/conflict.txt'].status, 'dirty');
	assert.strictEqual(postMeta.files['/conflict.txt'].size, resolvedContent.length);

	// Check final file content
	const fileBytes = await stratus.readFile('/conflict.txt');
	assert.strictEqual(new TextDecoder().decode(fileBytes), 'Merged Content');
});

test('StratusBase sync queueing and coalescing', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	let syncStartCount = 0;
	let resolveActiveSync: ((value: any) => void) | null = null;

	const slowSyncMiddleware = {
		sync: async () => {
			syncStartCount++;
			return new Promise((resolve) => {
				resolveActiveSync = resolve;
			});
		}
	};

	const backend = new MockBackend();
	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: slowSyncMiddleware
	});

	// Trigger first sync
	const p1 = stratus.sync();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.strictEqual(syncStartCount, 1);
	assert.ok(resolveActiveSync !== null);
	const resolver1 = resolveActiveSync!;

	// Queue subsequent syncs
	const p2 = stratus.sync();
	const p3 = stratus.sync();

	// Ensure no new sync started while first is active
	assert.strictEqual(syncStartCount, 1);

	// Resolve the first sync
	resolver1({ created: [], updated: [], deleted: [] });
	await p1;

	// Wait for the next tick to start the queued run
	await new Promise((resolve) => setTimeout(resolve, 0));

	// The queued run should have started now
	assert.strictEqual(syncStartCount, 2);
	assert.ok(resolveActiveSync !== null);
	const resolver2 = resolveActiveSync!;

	// Resolve the second run
	resolver2({ created: ['/a.txt'], updated: [], deleted: [] });

	const res2 = await p2;
	const res3 = await p3;

	// Both subsequent calls should have resolved to the same result
	assert.deepStrictEqual(res2.created, ['/a.txt']);
	assert.deepStrictEqual(res3.created, ['/a.txt']);
	assert.strictEqual(syncStartCount, 2);
});

test('StratusBase secure storage logout and reset', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const mockLocalStorage = {
		store: new Map<string, string>(),
		getItem(key: string) { return this.store.get(key) ?? null; },
		setItem(key: string, val: string) { this.store.set(key, val); },
		removeItem(key: string) { this.store.delete(key); },
		clear() { this.store.clear(); }
	};
	(globalThis as any).window = { localStorage: mockLocalStorage };

	let disconnected = false;
	const backend = new MockBackend();
	(backend as any).disconnect = async () => {
		disconnected = true;
	};
	(backend as any).getConfigHash = () => 'mock:client1';
	(backend as any).getCredentials = () => ({ accessToken: 'secret-123' });

	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: mockMiddleware
	});

	// Write some metadata and files to establish OPFS structure
	await stratus.writeFile('/hello.txt', new TextEncoder().encode('Hello World'));
	const statBefore = await stratus.stat('/hello.txt');
	assert.ok(statBefore !== null);

	// Verify credentials were saved to localStorage
	assert.ok(mockLocalStorage.getItem('stratus_credentials'));

	// Perform logout
	await stratus.logout();

	// Check backend disconnect was called
	assert.strictEqual(disconnected, true);

	// Check credentials cleared from localStorage
	assert.strictEqual(mockLocalStorage.getItem('stratus_credentials'), null);

	// Check files are deleted and no longer exist in OPFS
	const statAfter = await stratus.stat('/hello.txt');
	assert.strictEqual(statAfter, null);

	delete (globalThis as any).window;
});

test('StratusBase auto-restores credentials from localStorage and dispatches reauthrequired', async () => {
	const mockLocalStorage = {
		store: new Map<string, string>(),
		getItem(key: string) { return this.store.get(key) ?? null; },
		setItem(key: string, val: string) { this.store.set(key, val); },
		removeItem(key: string) { this.store.delete(key); },
		clear() { this.store.clear(); }
	};
	(globalThis as any).window = { localStorage: mockLocalStorage };

	// Pre-populate localStorage with credentials for 'google-drive:clientA'
	mockLocalStorage.setItem(
		'stratus_credentials',
		JSON.stringify({
			configHash: 'google-drive:clientA',
			credentials: { accessToken: 'saved-token', refreshToken: 'saved-refresh' }
		})
	);

	let backendCreds: any = {};

	class MockAuthBackend extends EventTarget implements Partial<StorageBackend> {
		id = 'google-drive';
		getConfigHash() { return 'google-drive:clientA'; }
		getCredentials() { return backendCreds; }
		setCredentials(creds: any) { backendCreds = creds; }
		async isConfigured() { return true; }
		async stat() { return null; }
		async getAuthUrl(redirectUri: string) { return `https://auth.example.com?redirect=${redirectUri}`; }
	}

	const authBackend = new MockAuthBackend() as any;

	const stratus = new StratusBase({
		backend: authBackend,
		localRoot: '/app',
		middleware: mockMiddleware
	});

	// Credentials should have been restored into backend
	assert.strictEqual(backendCreds.accessToken, 'saved-token');
	assert.strictEqual(backendCreds.refreshToken, 'saved-refresh');
	assert.strictEqual(stratus.getConfigHash(), 'google-drive:clientA');
	assert.strictEqual(await stratus.getAuthUrl('http://localhost'), 'https://auth.example.com?redirect=http://localhost');

	// Test reauthrequired event propagation
	let reauthDetail: any = null;
	stratus.addEventListener('reauthrequired', (e: any) => {
		reauthDetail = e.detail;
	});

	authBackend.dispatchEvent(new CustomEvent('reauthrequired', { detail: { reason: 'unauthorised' } }));
	assert.ok(reauthDetail);
	assert.strictEqual(reauthDetail.backend, 'google-drive');
	assert.strictEqual(reauthDetail.reason, 'unauthorised');

	// Test client.setCredentials triggers authrenewed and saves to localStorage
	let authRenewedDetail: any = null;
	stratus.addEventListener('authrenewed', (e: any) => {
		authRenewedDetail = e.detail;
	});

	// Trigger token renewed from backend (or via setCredentials)
	authBackend.dispatchEvent(new CustomEvent('tokenrenewed', { detail: { accessToken: 'newer-token', refreshToken: 'newer-refresh' } }));
	assert.ok(authRenewedDetail);
	assert.strictEqual(authRenewedDetail.accessToken, 'newer-token');
	const storedAfterRenew = JSON.parse(mockLocalStorage.getItem('stratus_credentials')!);
	assert.strictEqual(storedAfterRenew.credentials.accessToken, 'newer-token');

	// Test client.setCredentials passthrough
	stratus.setCredentials({ accessToken: 'manual-token' });
	assert.strictEqual(backendCreds.accessToken, 'manual-token');

	// Test non-OAuth backend errors on getAuthUrl and exchangeCode
	const nonOAuthBackend = new MockBackend();
	const nonOAuthClient = new StratusBase({ backend: nonOAuthBackend, localRoot: '/app', middleware: mockMiddleware });
	await assert.rejects(async () => {
		await nonOAuthClient.getAuthUrl('http://localhost');
	}, /does not support OAuth authentication/);
	await assert.rejects(async () => {
		await nonOAuthClient.exchangeCode('code', 'http://localhost');
	}, /does not support OAuth code exchange/);

	delete (globalThis as any).window;
});


test('StratusBase remote lockfile concurrency control', async (t) => {
	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	let lockFileExists = false;
	let lockFileContent = new Uint8Array();

	(backend as any).stat = async (path: string) => {
		if (path === '/sync.lock' && lockFileExists) {
			return { path: '/sync.lock', name: 'sync.lock', type: 'file', size: lockFileContent.length, modifiedAt: new Date() };
		}
		return null;
	};
	(backend as any).readFile = (path: string) => {
		if (path === '/sync.lock' && lockFileExists) {
			return { finished: Promise.resolve(lockFileContent) };
		}
		throw new Error('File not found');
	};
	(backend as any).writeFile = (path: string, content: Uint8Array) => {
		if (path === '/sync.lock') {
			lockFileExists = true;
			lockFileContent = content;
		}
		return { finished: Promise.resolve() };
	};
	(backend as any).deleteFile = async (path: string) => {
		if (path === '/sync.lock') {
			lockFileExists = false;
		}
	};

	const stratus1 = new StratusBase({
		backend,
		localRoot: '/app1',
		middleware: mockMiddleware,
		clientName: 'Device A'
	});

	const stratus2 = new StratusBase({
		backend,
		localRoot: '/app2',
		middleware: mockMiddleware,
		clientName: 'Device B'
	});

	// Initially we can sync
	assert.strictEqual(await stratus1.canSync(), true);

	// Simulate concurrent sync by setting the lock manually
	lockFileExists = true;
	lockFileContent = new TextEncoder().encode(JSON.stringify({
		date: new Date().toISOString(),
		clientName: 'Device A',
		operation: 'sync'
	}, null, 2));

	// Device B should see it cannot sync
	assert.strictEqual(await stratus2.canSync(), false);

	// Running sync on Device B should reject with SyncLockedError
	const { SyncLockedError } = await import('./StratusBase.ts');
	await assert.rejects(async () => {
		await stratus2.sync();
	}, (err: any) => {
		assert.ok(err instanceof SyncLockedError);
		assert.strictEqual(err.lockDetails.clientName, 'Device A');
		return true;
	});

	// Force sync should break the lock and succeed
	const res = await stratus2.forceSync();
	assert.deepStrictEqual(res, { created: [], updated: [], deleted: [] });
	assert.strictEqual(lockFileExists, false); // Lock is cleaned up after successful forceSync
});

test('StratusBase isSetUp delegates to middleware', async () => {
	let isSetUpCalledWithContext = false;
	const customMiddleware = {
		async sync() {
			return { created: [], updated: [], deleted: [] };
		},
		async isSetUp(context: any) {
			if (context && context.backend && typeof context.getLocalMetadata === 'function') {
				isSetUpCalledWithContext = true;
			}
			return true;
		}
	};

	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: customMiddleware
	});

	const result = await stratus.isSetUp();
	assert.strictEqual(result, true);
	assert.strictEqual(isSetUpCalledWithContext, true);
});

test('StratusBase isConfigured delegates to backend.isConfigured', async () => {
	let backendConfigured = false;
	class CustomMockBackend extends EventTarget {
		id = 'mock';
		async isConfigured() {
			return backendConfigured;
		}
		async stat() {
			return null;
		}
	}
	const backend: any = new CustomMockBackend();

	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: mockMiddleware
	});

	assert.strictEqual(await stratus.isConfigured(), false);
	backendConfigured = true;
	assert.strictEqual(await stratus.isConfigured(), true);
});

test('StratusBase emits progress events via reportProgress and .on() listener', async () => {
	const progressEvents: any[] = [];
	const customMiddleware = {
		async sync(context: any) {
			context.reportProgress({
				phase: 'listing',
				message: 'Listing remote chunks...'
			});
			context.reportProgress({
				phase: 'downloading',
				totalBytes: 2048,
				loadedBytes: 1024,
				percentage: 50,
				currentFile: '/archive_chunk_001.7z'
			});
			context.reportProgress({
				phase: 'complete',
				percentage: 100,
				message: 'Synchronisation complete.'
			});
			return { created: [], updated: [], deleted: [] };
		},
		async isSetUp() {
			return true;
		}
	};

	const storageMock = new MockStorageManager();
	setStorageManager(storageMock);

	const backend = new MockBackend();
	const stratus = new StratusBase({
		backend,
		localRoot: '/app',
		middleware: customMiddleware
	});

	const unsubscribe = stratus.on('progress', (p) => {
		progressEvents.push(p);
	});

	await stratus.sync();
	unsubscribe();

	assert.strictEqual(progressEvents.length, 3);
	assert.strictEqual(progressEvents[0].phase, 'listing');
	assert.strictEqual(progressEvents[1].phase, 'downloading');
	assert.strictEqual(progressEvents[1].percentage, 50);
	assert.strictEqual(progressEvents[1].loadedBytes, 1024);
	assert.strictEqual(progressEvents[2].phase, 'complete');
	assert.strictEqual(progressEvents[2].percentage, 100);
});
