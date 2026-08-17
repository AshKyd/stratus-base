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
		const writeOp = stratus.writeFile('/test.txt', content);
		await writeOp.finished;

		const fileInfo = await stratus.stat('/test.txt');
		assert.ok(fileInfo);
		assert.strictEqual(fileInfo.name, 'test.txt');
		assert.strictEqual(fileInfo.size, content.length);
		assert.strictEqual(fileInfo.type, 'file');

		const meta = await stratus.getMetadata();
		assert.strictEqual(meta.files['/test.txt'].status, 'dirty');
	});

	await t.test('readFile', async () => {
		const readOp = stratus.readFile('/test.txt');
		const content = await readOp.finished;
		const text = new TextDecoder().decode(content);
		assert.strictEqual(text, 'Hello, OPFS!');
	});

	await t.test('renameFile', async () => {
		await stratus.renameFile('/test.txt', '/renamed.txt');

		const oldInfo = await stratus.stat('/test.txt');
		assert.strictEqual(oldInfo, null);

		const newInfo = await stratus.stat('/renamed.txt');
		assert.ok(newInfo);
		assert.strictEqual(newInfo.name, 'renamed.txt');

		const readOp = stratus.readFile('/renamed.txt');
		const content = await readOp.finished;
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
