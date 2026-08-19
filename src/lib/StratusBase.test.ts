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

class MockBackend implements StorageBackend {
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

	// Check updates file is deleted and metadata is removed
	const postMeta = await stratus.getMetadata();
	assert.strictEqual(postMeta.files['/conflict_updates.txt'], undefined);
	assert.ok(postMeta.files['/conflict.txt']);
	assert.strictEqual(postMeta.files['/conflict.txt'].status, 'dirty');
	assert.strictEqual(postMeta.files['/conflict.txt'].size, resolvedContent.length);

	// Check final file content
	const fileBytes = await stratus.readFile('/conflict.txt');
	assert.strictEqual(new TextDecoder().decode(fileBytes), 'Merged Content');
});
