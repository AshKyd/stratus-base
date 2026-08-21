import test from 'node:test';
import assert from 'node:assert';
import { StratusBase, setStorageManager } from '../../StratusBase.ts';
import { MiddlewareZipChunk } from './MiddlewareZipChunk.ts';
import { MemoryStorage } from '../../backends/MemoryStorage.ts';
import { SevenZipWriter, SevenZipReader } from '../../utils/codec7z.ts';

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

// --- Helper to read 7z files in tests ---
async function readZipEntries(zipBytes: Uint8Array, password = 'test-pass'): Promise<Map<string, string>> {
	const filesMap = new Map<string, string>();
	const reader = new SevenZipReader(password);
	await reader.appendChunk(zipBytes);
	for await (const entry of reader.extract()) {
		const filename = entry.path === '.metadata.json'
			? '.metadata.json'
			: (entry.path.startsWith('/') ? entry.path : '/' + entry.path);
		filesMap.set(filename, new TextDecoder().decode(entry.data));
	}
	return filesMap;
}

test('MiddlewareZipChunk configuration validation', () => {
	assert.throws(() => {
		new MiddlewareZipChunk({ chunkSizeLimit: 1000 } as any);
	}, /MiddlewareZipChunk requires a password option/);
});

test('MiddlewareZipChunk sync runs', async (t) => {
	await t.test('Initial push creates archive_chunk_001.7z', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		await stratus.writeFile('/file1.md', new TextEncoder().encode('Hello Chunk'));
		const result = await stratus.sync();

		assert.deepStrictEqual(result.created, ['/file1.md']);

		// Verify chunk created on backend
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.7z');
		assert.ok(zipFile);

		// Read chunk using reader helper
		const filesMap = await readZipEntries(zipFile.content, 'test-pass');
		assert.strictEqual(filesMap.get('/file1.md'), 'Hello Chunk');

		const chunkMeta = JSON.parse(filesMap.get('.metadata.json')!);
		assert.strictEqual(chunkMeta.uncompressedSize, 11);
		assert.ok(chunkMeta.files['/file1.md']);

		// Verify local chunks cache
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks['/archive_chunk_001.7z']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.7z'].uncompressedSize, 11);
	});

	await t.test('Push when local metadata is missing but remote chunks exist', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();

		// Create a remote chunk 001 with an existing file
		const writer = new SevenZipWriter('test-pass');
		await writer.write({ path: 'existing.md', data: new TextEncoder().encode('Existing file content') });
		const meta1 = { uncompressedSize: 21, files: { '/existing.md': { size: 21, modifiedAt: Date.now() } }, deleted: [] };
		await writer.write({ path: '.metadata.json', data: new TextEncoder().encode(JSON.stringify(meta1)) });
		const content = await writer.finalize();
		backend.getFilesMap().set('/archive_chunk_001.7z', {
			content,
			modifiedAt: new Date()
		});

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Ensure local client starts with /existing.md as clean
		const localMeta = await stratus.getMetadata();
		localMeta.files['/existing.md'] = {
			path: '/existing.md',
			type: 'file',
			size: 21,
			localModifiedAt: Date.now(),
			remoteModifiedAt: Date.now(),
			status: 'clean'
		};
		localMeta.chunks = localMeta.chunks || {};
		localMeta.chunks['/archive_chunk_001.7z'] = meta1;
		await stratus.saveMetadata(localMeta);

		const opfsRoot = await storageMock.getDirectory();
		const file = await opfsRoot.getFileHandle('existing.md', { create: true });
		const writable = await file.createWritable();
		await writable.write(new TextEncoder().encode('Existing file content'));
		await writable.close();

		// Add a new file locally
		await stratus.writeFile('/new_file.md', new TextEncoder().encode('New content'));

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created, ['/new_file.md']);

		// Verify chunk 001 is overwritten containing BOTH files
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.7z');
		assert.ok(zipFile);

		const filesMap = await readZipEntries(zipFile.content, 'test-pass');
		assert.strictEqual(filesMap.get('/existing.md'), 'Existing file content');
		assert.strictEqual(filesMap.get('/new_file.md'), 'New content');

		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks['/archive_chunk_001.7z']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.7z'].uncompressedSize, 32); // 21 + 11
		assert.ok(meta.chunks['/archive_chunk_001.7z'].files['/existing.md']);
		assert.ok(meta.chunks['/archive_chunk_001.7z'].files['/new_file.md']);
	});

	await t.test('Rollover to next chunk when size limit is exceeded', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 20, password: 'test-pass' }); // tiny size limit
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Write file 1 (15 bytes) -> should go to chunk 001
		await stratus.writeFile('/file1.md', new TextEncoder().encode('123456789012345'));
		await stratus.sync();

		assert.ok(backend.getFilesMap().has('/archive_chunk_001.7z'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_002.7z'));

		// Write file 2 (10 bytes) -> chunk 001 has 15 bytes + metadata. Adding file 2 exceeds 20 bytes.
		// Should roll over to chunk 002.
		await stratus.writeFile('/file2.md', new TextEncoder().encode('1234567890'));
		await stratus.sync();

		assert.ok(backend.getFilesMap().has('/archive_chunk_002.7z'));

		const zipFile2 = backend.getFilesMap().get('/archive_chunk_002.7z')!;
		const filesMap2 = await readZipEntries(zipFile2.content, 'test-pass');
		assert.ok(filesMap2.has('/file2.md'));
		assert.ok(!filesMap2.has('/file1.md')); // file 1 remains in chunk 001

		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks['/archive_chunk_001.7z']);
		assert.ok(meta.chunks['/archive_chunk_002.7z']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.7z'].uncompressedSize, 15);
		assert.strictEqual(meta.chunks['/archive_chunk_002.7z'].uncompressedSize, 10);
	});

	await t.test('Deletions are tracked and carried over during rollover', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		// limit=16: file1 (15 bytes) fits in chunk 001; file2 (15 bytes) rolls to chunk 002
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 16, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// 1. Write file1 (15 bytes) -> chunk 001
		await stratus.writeFile('/file1.md', new TextEncoder().encode('123456789012345'));
		await stratus.sync();
		assert.ok(backend.getFilesMap().has('/archive_chunk_001.7z'));

		// 2. Write file2 (15 bytes) -> 15+15=30 >= 16, rolls to chunk 002
		await stratus.writeFile('/file2.md', new TextEncoder().encode('abcdefghijklmno'));
		await stratus.sync();
		assert.ok(backend.getFilesMap().has('/archive_chunk_002.7z'), 'chunk 002 should exist');

		// 3. Delete file1 (in chunk 001) -> deletion tracked and written to active chunk 002
		await stratus.deleteFile('/file1.md');
		await stratus.sync();

		// Verify chunk 002 now carries the deletion
		const zipFile2 = backend.getFilesMap().get('/archive_chunk_002.7z')!;
		const filesMap2 = await readZipEntries(zipFile2.content, 'test-pass');
		const chunkMeta2 = JSON.parse(filesMap2.get('.metadata.json')!);
		assert.deepStrictEqual(chunkMeta2.deleted, ['/file1.md'], 'deletion must appear in active chunk 002');

		// 4. Write file3 (15 bytes) -> chunk 002 has file2 (15 bytes), so 15+15=30 >= 16 -> rolls to chunk 003
		await stratus.writeFile('/file3.md', new TextEncoder().encode('ABCDEFGHIJKLMNO'));
		await stratus.sync();

		const zipFile3 = backend.getFilesMap().get('/archive_chunk_003.7z')!;
		assert.ok(zipFile3, 'chunk 003 should be created after second rollover');
		const filesMap3 = await readZipEntries(zipFile3.content, 'test-pass');
		const chunkMeta3 = JSON.parse(filesMap3.get('.metadata.json')!);

		// Deletion of file1 must carry over to chunk 003
		assert.deepStrictEqual(chunkMeta3.deleted, ['/file1.md'], 'deletion must carry over to chunk 003');
		assert.ok(chunkMeta3.files['/file3.md'], 'file3.md should be in chunk 003');
	});

	await t.test('Pull & Extract: sequential download of multiple remote chunks on empty local client', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();

		// Create remote chunk 001
		const writer1 = new SevenZipWriter('test-pass');
		await writer1.write({ path: 'file1.md', data: new TextEncoder().encode('Content 1') });
		const meta1 = { uncompressedSize: 9, files: { '/file1.md': { size: 9, modifiedAt: Date.now() - 10000 } }, deleted: [] };
		await writer1.write({ path: '.metadata.json', data: new TextEncoder().encode(JSON.stringify(meta1)) });
		const content1 = await writer1.finalize();
		backend.getFilesMap().set('/archive_chunk_001.7z', { content: content1, modifiedAt: new Date() });

		// Create remote chunk 002
		const writer2 = new SevenZipWriter('test-pass');
		await writer2.write({ path: 'file2.md', data: new TextEncoder().encode('Content 2') });
		const meta2 = { uncompressedSize: 9, files: { '/file2.md': { size: 9, modifiedAt: Date.now() } }, deleted: [] };
		await writer2.write({ path: '.metadata.json', data: new TextEncoder().encode(JSON.stringify(meta2)) });
		const content2 = await writer2.finalize();
		backend.getFilesMap().set('/archive_chunk_002.7z', { content: content2, modifiedAt: new Date() });

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created.sort(), ['/file1.md', '/file2.md'].sort());

		// Verify files extracted locally
		const f1 = await stratus.readFile('/file1.md');
		const f2 = await stratus.readFile('/file2.md');
		assert.strictEqual(new TextDecoder().decode(f1), 'Content 1');
		assert.strictEqual(new TextDecoder().decode(f2), 'Content 2');
	});

	await t.test('Pull & Extract: applies remote deletions and conflicts', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();

		// Create remote chunk 001 with cumulative deletion of /note1.md
		const writer = new SevenZipWriter('test-pass');
		const meta = {
			uncompressedSize: 0,
			files: {},
			deleted: ['/note1.md']
		};
		await writer.write({ path: '.metadata.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
		const content = await writer.finalize();
		backend.getFilesMap().set('/archive_chunk_001.7z', { content, modifiedAt: new Date() });

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Create a local clean file /note1.md (simulating it was present before sync)
		await stratus.writeFile('/note1.md', new TextEncoder().encode('Local content'));
		// Mark it clean manually so it can be deleted by sync
		const localMeta = await stratus.getMetadata();
		localMeta.files['/note1.md'].status = 'clean';
		await stratus.saveMetadata(localMeta);

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.deleted, ['/note1.md']);

		// Verify it was deleted locally
		assert.strictEqual(await stratus.stat('/note1.md'), null);
	});

	await t.test('Defragmentation/Consolidation: cleans up stale file versions and deletes old empty chunks', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 20, password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// 1. Write file1 (15 bytes) -> chunk 001
		await stratus.writeFile('/file1.md', new TextEncoder().encode('123456789012345'));
		await stratus.sync();

		// 2. Overwrite file1 with new content (15 bytes) -> exceeds limit, rollover to chunk 002
		await stratus.writeFile('/file1.md', new TextEncoder().encode('543210987654321'));
		await stratus.sync();

		// 3. Write file2 (15 bytes) -> exceeds limit, rollover to chunk 003
		await stratus.writeFile('/file2.md', new TextEncoder().encode('abcde12345abcde'));
		await stratus.sync();

		// 4. Delete file2
		await stratus.deleteFile('/file2.md');
		await stratus.sync();

		// Verify initial layout: chunk 001, 002, 003 exist on backend
		assert.ok(backend.getFilesMap().has('/archive_chunk_001.7z'));
		assert.ok(backend.getFilesMap().has('/archive_chunk_002.7z'));
		assert.ok(backend.getFilesMap().has('/archive_chunk_003.7z'));

		// 5. Trigger consolidate
		await stratus.consolidate();

		// Verify defragmented state:
		// - Only archive_chunk_001.7z should exist now because file1.md (15 bytes) is the only active file,
		//   and archive_chunk_002/003 are deleted as file2 was deleted.
		assert.ok(backend.getFilesMap().has('/archive_chunk_001.7z'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_002.7z'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_003.7z'));

		// Verify chunk 001 contains the latest content of file1.md and empty deleted list
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.7z')!;
		const filesMap = await readZipEntries(zipFile.content, 'test-pass');
		assert.strictEqual(filesMap.get('/file1.md'), '543210987654321');

		const chunkMeta = JSON.parse(filesMap.get('.metadata.json')!);
		assert.deepStrictEqual(chunkMeta.deleted, []);

		// Verify local chunks cache matches
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks);
		assert.ok(meta.chunks['/archive_chunk_001.7z']);
		assert.strictEqual(meta.chunks['/archive_chunk_002.7z'], undefined);
	});
});
