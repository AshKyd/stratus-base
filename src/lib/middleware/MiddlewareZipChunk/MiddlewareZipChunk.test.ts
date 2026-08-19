import test from 'node:test';
import assert from 'node:assert';
import { StratusBase, setStorageManager } from '../../StratusBase.ts';
import { MiddlewareZipChunk } from './MiddlewareZipChunk.ts';
import { MemoryStorage } from '../../backends/MemoryStorage.ts';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

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

// --- Helper to read zip files in tests ---
async function readZipEntries(zipBytes: Uint8Array): Promise<Map<string, string>> {
	const filesMap = new Map<string, string>();
	const reader = new ZipReader(new Uint8ArrayReader(zipBytes));
	const entries = await reader.getEntries();
	await entries.reduce(async (promise, entry) => {
		await promise;
		if (entry.directory) return;
		const contentBytes = await entry.getData(new Uint8ArrayWriter());
		const filename = entry.filename === '.metadata.json'
			? '.metadata.json'
			: (entry.filename.startsWith('/') ? entry.filename : '/' + entry.filename);
		filesMap.set(filename, new TextDecoder().decode(contentBytes));
	}, Promise.resolve());
	await reader.close();
	return filesMap;
}

test('MiddlewareZipChunk sync runs', async (t) => {
	await t.test('Initial push creates archive_chunk_001.zip', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Create a local file
		await stratus.writeFile('/note1.md', new TextEncoder().encode('Hello Chunk')).finished;

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created, ['/note1.md']);

		// Verify chunk uploaded to remote
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.zip');
		assert.ok(zipFile);

		const filesMap = await readZipEntries(zipFile.content);
		assert.strictEqual(filesMap.get('/note1.md'), 'Hello Chunk');

		// Check active chunk .metadata.json inside zip
		const metadataStr = filesMap.get('.metadata.json');
		assert.ok(metadataStr);
		const chunkMeta = JSON.parse(metadataStr);
		assert.strictEqual(chunkMeta.uncompressedSize, 11);
		assert.ok(chunkMeta.files['/note1.md']);
		assert.strictEqual(chunkMeta.files['/note1.md'].size, 11);

		// Local cache should match
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks);
		assert.ok(meta.chunks['/archive_chunk_001.zip']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.zip'].uncompressedSize, 11);
	});

	await t.test('Push when local metadata is missing but remote chunks exist', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		// Create a pre-existing chunk on remote
		const initialChunkMeta = {
			uncompressedSize: 20,
			files: {
				'/existing.md': { size: 20, modifiedAt: Date.now() }
			},
			deleted: []
		};
		const writer = new Uint8ArrayWriter();
		const { ZipWriter } = await import('@zip.js/zip.js');
		const zipWriter = new ZipWriter(writer);
		await zipWriter.add('existing.md', new Uint8ArrayReader(new TextEncoder().encode('Existing file content')));
		await zipWriter.add('.metadata.json', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(initialChunkMeta))));
		await zipWriter.close();
		const zipBytes = await writer.getData();

		backend.getFilesMap().set('/archive_chunk_001.zip', {
			content: zipBytes,
			modifiedAt: new Date()
		});

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Local metadata doesn't contain chunks cache yet
		const initialMeta = await stratus.getMetadata();
		assert.strictEqual(initialMeta.chunks, undefined);

		// Create a local dirty file
		await stratus.writeFile('/new_file.md', new TextEncoder().encode('New file content')).finished;

		// Sync should list remote, find chunk 001, download it, reconstruct cache, and repack it
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created.sort(), ['/existing.md', '/new_file.md'].sort());

		// Verify repacked chunk 001 contains both files
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.zip');
		assert.ok(zipFile);
		const filesMap = await readZipEntries(zipFile.content);
		assert.strictEqual(filesMap.get('/existing.md'), 'Existing file content');
		assert.strictEqual(filesMap.get('/new_file.md'), 'New file content');

		// Local metadata chunks cache should be fully populated
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks);
		assert.ok(meta.chunks['/archive_chunk_001.zip']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.zip'].uncompressedSize, 37);
		assert.ok(meta.chunks['/archive_chunk_001.zip'].files['/existing.md']);
		assert.ok(meta.chunks['/archive_chunk_001.zip'].files['/new_file.md']);
	});

	await t.test('Rollover to next chunk when size limit is exceeded', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		// Set limit to 20 bytes (very small to easily trigger rollover)
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 20 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// 1. Initial write (15 bytes) - fits in chunk 001
		await stratus.writeFile('/note1.md', new TextEncoder().encode('123456789012345')).finished;
		await stratus.sync();

		assert.ok(backend.getFilesMap().has('/archive_chunk_001.zip'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_002.zip'));

		// 2. Second write (10 bytes) - total becomes 25 bytes (exceeds 20 limit) -> Rollover!
		await stratus.writeFile('/note2.md', new TextEncoder().encode('1234567890')).finished;
		const result = await stratus.sync();

		assert.deepStrictEqual(result.created, ['/note2.md']);
		assert.ok(backend.getFilesMap().has('/archive_chunk_002.zip'));

		// Verify chunk 002 contains ONLY note2.md and the .metadata.json
		const zipFile2 = backend.getFilesMap().get('/archive_chunk_002.zip');
		assert.ok(zipFile2);
		const filesMap2 = await readZipEntries(zipFile2.content);
		assert.strictEqual(filesMap2.get('/note1.md'), undefined);
		assert.strictEqual(filesMap2.get('/note2.md'), '1234567890');

		// Local cache should contain both chunks
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks);
		assert.ok(meta.chunks['/archive_chunk_001.zip']);
		assert.ok(meta.chunks['/archive_chunk_002.zip']);
		assert.strictEqual(meta.chunks['/archive_chunk_001.zip'].uncompressedSize, 15);
		assert.strictEqual(meta.chunks['/archive_chunk_002.zip'].uncompressedSize, 10);
	});

	await t.test('Deletions are tracked and carried over during rollover', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 20 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// 1. Initial write
		await stratus.writeFile('/note1.md', new TextEncoder().encode('12345')).finished;
		await stratus.sync();

		// 2. Delete file
		await stratus.deleteFile('/note1.md');
		await stratus.sync();

		// Verify deletion is recorded in chunk 001's metadata
		let zipFile = backend.getFilesMap().get('/archive_chunk_001.zip');
		let filesMap = await readZipEntries(zipFile!.content);
		let chunkMeta = JSON.parse(filesMap.get('.metadata.json')!);
		assert.deepStrictEqual(chunkMeta.deleted, ['/note1.md']);

		// 3. Write new file that triggers rollover (exceeds 20 bytes)
		await stratus.writeFile('/note2.md', new TextEncoder().encode('1234567890123456789012345')).finished;
		await stratus.sync();

		// Verify chunk 002 exists and its metadata has carried over the deletion list
		const zipFile2 = backend.getFilesMap().get('/archive_chunk_002.zip');
		assert.ok(zipFile2);
		const filesMap2 = await readZipEntries(zipFile2.content);
		const chunkMeta2 = JSON.parse(filesMap2.get('.metadata.json')!);
		assert.deepStrictEqual(chunkMeta2.deleted, ['/note1.md']);
	});

	await t.test('Pull & Extract: sequential download of multiple remote chunks on empty local client', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const { ZipWriter } = await import('@zip.js/zip.js');

		// Create remote chunk 001
		const writer1 = new Uint8ArrayWriter();
		const zipWriter1 = new ZipWriter(writer1);
		await zipWriter1.add('file1.md', new Uint8ArrayReader(new TextEncoder().encode('Content 1')));
		const meta1 = { uncompressedSize: 9, files: { '/file1.md': { size: 9, modifiedAt: Date.now() - 10000 } }, deleted: [] };
		await zipWriter1.add('.metadata.json', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(meta1))));
		await zipWriter1.close();
		backend.getFilesMap().set('/archive_chunk_001.zip', { content: await writer1.getData(), modifiedAt: new Date() });

		// Create remote chunk 002
		const writer2 = new Uint8ArrayWriter();
		const zipWriter2 = new ZipWriter(writer2);
		await zipWriter2.add('file2.md', new Uint8ArrayReader(new TextEncoder().encode('Content 2')));
		const meta2 = { uncompressedSize: 9, files: { '/file2.md': { size: 9, modifiedAt: Date.now() } }, deleted: [] };
		await zipWriter2.add('.metadata.json', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(meta2))));
		await zipWriter2.close();
		backend.getFilesMap().set('/archive_chunk_002.zip', { content: await writer2.getData(), modifiedAt: new Date() });

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Sync
		const result = await stratus.sync();
		assert.deepStrictEqual(result.created.sort(), ['/file1.md', '/file2.md'].sort());

		// Verify files extracted locally
		const f1 = await stratus.readFile('/file1.md').finished;
		const f2 = await stratus.readFile('/file2.md').finished;
		assert.strictEqual(new TextDecoder().decode(f1), 'Content 1');
		assert.strictEqual(new TextDecoder().decode(f2), 'Content 2');
	});

	await t.test('Pull & Extract: applies remote deletions and conflicts', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const { ZipWriter } = await import('@zip.js/zip.js');

		// Create remote chunk 001 with cumulative deletion of /note1.md
		const writer = new Uint8ArrayWriter();
		const zipWriter = new ZipWriter(writer);
		const meta = {
			uncompressedSize: 0,
			files: {},
			deleted: ['/note1.md']
		};
		await zipWriter.add('.metadata.json', new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(meta))));
		await zipWriter.close();
		backend.getFilesMap().set('/archive_chunk_001.zip', { content: await writer.getData(), modifiedAt: new Date() });

		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 1000 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Create a local clean file /note1.md (simulating it was present before sync)
		await stratus.writeFile('/note1.md', new TextEncoder().encode('Local content')).finished;
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
		const middleware = new MiddlewareZipChunk({ chunkSizeLimit: 20 });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// 1. Write file1 (15 bytes) -> chunk 001
		await stratus.writeFile('/file1.md', new TextEncoder().encode('123456789012345')).finished;
		await stratus.sync();

		// 2. Overwrite file1 with new content (15 bytes) -> exceeds limit, rollover to chunk 002
		await stratus.writeFile('/file1.md', new TextEncoder().encode('543210987654321')).finished;
		await stratus.sync();

		// 3. Write file2 (15 bytes) -> exceeds limit, rollover to chunk 003
		await stratus.writeFile('/file2.md', new TextEncoder().encode('abcde12345abcde')).finished;
		await stratus.sync();

		// 4. Delete file2
		await stratus.deleteFile('/file2.md');
		await stratus.sync();

		// Verify initial layout: chunk 001, 002, 003 exist on backend
		assert.ok(backend.getFilesMap().has('/archive_chunk_001.zip'));
		assert.ok(backend.getFilesMap().has('/archive_chunk_002.zip'));
		assert.ok(backend.getFilesMap().has('/archive_chunk_003.zip'));

		// 5. Trigger consolidate
		await stratus.consolidate();

		// Verify defragmented state:
		// - Only archive_chunk_001.zip should exist now because file1.md (15 bytes) is the only active file,
		//   and archive_chunk_002/003 are deleted as file2 was deleted.
		assert.ok(backend.getFilesMap().has('/archive_chunk_001.zip'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_002.zip'));
		assert.ok(!backend.getFilesMap().has('/archive_chunk_003.zip'));

		// Verify chunk 001 contains the latest content of file1.md and empty deleted list
		const zipFile = backend.getFilesMap().get('/archive_chunk_001.zip')!;
		const filesMap = await readZipEntries(zipFile.content);
		assert.strictEqual(filesMap.get('/file1.md'), '543210987654321');

		const chunkMeta = JSON.parse(filesMap.get('.metadata.json')!);
		assert.deepStrictEqual(chunkMeta.deleted, []);

		// Verify local chunks cache matches
		const meta = await stratus.getMetadata();
		assert.ok(meta.chunks);
		assert.ok(meta.chunks['/archive_chunk_001.zip']);
		assert.strictEqual(meta.chunks['/archive_chunk_002.zip'], undefined);
	});
});
