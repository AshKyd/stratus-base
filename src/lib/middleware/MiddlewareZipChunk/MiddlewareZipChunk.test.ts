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

		// Every cached chunk must keep at least one freshness signal, or it can never be recognised as
		// changed (or unchanged) on a later sync.
		Object.entries(meta.chunks).forEach(([path, chunk]) => {
			assert.ok(
				chunk.etag !== undefined ||
					chunk.remoteSize !== undefined ||
					chunk.remoteModifiedAt !== undefined,
				`chunk ${path} has no freshness signal`
			);
		});
	});

	await t.test('isSetUp returns false when no chunks exist and true when at least one 7z chunk exists', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const middleware = new MiddlewareZipChunk({ password: 'test-pass' });
		const stratus = new StratusBase({
			backend,
			localRoot: '/app',
			middleware
		});

		// Empty storage
		assert.strictEqual(await stratus.isSetUp(), false);

		// Unrelated files or sync.lock only
		backend.getFilesMap().set('/sync.lock', {
			content: new TextEncoder().encode('lock'),
			modifiedAt: new Date()
		});
		backend.getFilesMap().set('/other_file.txt', {
			content: new TextEncoder().encode('other'),
			modifiedAt: new Date()
		});
		assert.strictEqual(await stratus.isSetUp(), false);

		// Valid archive chunk present
		backend.getFilesMap().set('/archive_chunk_00000000000000000001.7z', {
			content: new Uint8Array([1, 2, 3]),
			modifiedAt: new Date()
		});
		assert.strictEqual(await stratus.isSetUp(), true);
	});

	await t.test('Multi-client sync: two clients sharing backend see each others changes', async (sub) => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);
		const sharedBackend = new MemoryStorage();

		const client1 = new StratusBase({
			backend: sharedBackend,
			localRoot: '/client1',
			clientName: 'User-1',
			middleware: new MiddlewareZipChunk({ password: 'shared-pass', chunkSizeLimit: 5000 })
		});

		const client2 = new StratusBase({
			backend: sharedBackend,
			localRoot: '/client2',
			clientName: 'User-2',
			middleware: new MiddlewareZipChunk({ password: 'shared-pass', chunkSizeLimit: 5000 })
		});

		await sub.test('1. user1 syncs, 2. user2 syncs, 3. user1 creates file, 4. user1 syncs, 5. user2 syncs -> sees file', async () => {
			// 1. user 1 syncs (empty)
			const res1Init = await client1.sync();
			assert.deepStrictEqual(res1Init.created, []);

			// 2. user 2 syncs (empty)
			const res2Init = await client2.sync();
			assert.deepStrictEqual(res2Init.created, []);

			// 3. user 1 creates a file
			await client1.writeFile('/welcome.txt', new TextEncoder().encode('Hello from User 1!'));

			// 4. user 1 syncs
			const res1Push = await client1.sync();
			assert.deepStrictEqual(res1Push.created, ['/welcome.txt']);

			// 5. user 2 syncs - must see the remote changes
			const res2Pull = await client2.sync();
			assert.deepStrictEqual(res2Pull.created, ['/welcome.txt']);

			// Verify file content on user 2
			const u2Content = await client2.readFile('/welcome.txt');
			assert.strictEqual(new TextDecoder().decode(u2Content), 'Hello from User 1!');
		});

		await sub.test('Bi-directional sync: user 2 writes a file and user 1 pulls it', async () => {
			// User 2 creates a note
			await client2.writeFile('/user2-note.md', new TextEncoder().encode('User 2 note content'));
			const res2Push = await client2.sync();
			assert.deepStrictEqual(res2Push.created, ['/user2-note.md']);

			// User 1 syncs and receives the note
			const res1Pull = await client1.sync();
			assert.deepStrictEqual(res1Pull.created, ['/user2-note.md']);

			const u1Content = await client1.readFile('/user2-note.md');
			assert.strictEqual(new TextDecoder().decode(u1Content), 'User 2 note content');
		});

		await sub.test('Concurrent additions: both users create files before syncing', async () => {
			// User 1 creates fileA
			await client1.writeFile('/fileA.txt', new TextEncoder().encode('File A by U1'));

			// User 2 creates fileB
			await client2.writeFile('/fileB.txt', new TextEncoder().encode('File B by U2'));

			// User 1 syncs first
			await client1.sync();

			// User 2 syncs next (pulls fileA and pushes fileB)
			const res2 = await client2.sync();
			assert.ok(res2.created.includes('/fileA.txt'));
			assert.ok(res2.created.includes('/fileB.txt'));

			// User 1 syncs (pulls fileB)
			const res1 = await client1.sync();
			assert.ok(res1.created.includes('/fileB.txt'));

			// Both users should have both files
			assert.strictEqual(new TextDecoder().decode(await client1.readFile('/fileA.txt')), 'File A by U1');
			assert.strictEqual(new TextDecoder().decode(await client1.readFile('/fileB.txt')), 'File B by U2');
			assert.strictEqual(new TextDecoder().decode(await client2.readFile('/fileA.txt')), 'File A by U1');
			assert.strictEqual(new TextDecoder().decode(await client2.readFile('/fileB.txt')), 'File B by U2');
		});

		await sub.test('Conflict handling: concurrent edits to same file produce conflict and _updates file', async () => {
			// Setup a shared file
			await client1.writeFile('/shared.txt', new TextEncoder().encode('Initial content'));
			await client1.sync();
			await client2.sync();

			// User 1 edits shared file and syncs
			await client1.writeFile('/shared.txt', new TextEncoder().encode('User 1 update'));
			await client1.sync();

			// User 2 edits shared file locally
			await client2.writeFile('/shared.txt', new TextEncoder().encode('User 2 update'));

			// User 2 syncs -> should detect conflict
			let conflictThrown = false;
			try {
				await client2.sync();
			} catch (err: any) {
				conflictThrown = true;
				assert.strictEqual(err.name, 'SyncConflictError');
				assert.strictEqual(err.conflicts.length, 1);
				assert.strictEqual(err.conflicts[0].path, '/shared.txt');
			}
			assert.strictEqual(conflictThrown, true, 'SyncConflictError should be thrown');

			// Check client 2 status and files
			const metaLocal = await client2.getMetadata();
			assert.strictEqual(metaLocal.files['/shared.txt'].status, 'conflict');

			// _updates file should contain User 1's version
			const updatesContent = await client2.readFile('/shared_updates.txt');
			assert.strictEqual(new TextDecoder().decode(updatesContent), 'User 1 update');

			// Original local file should contain User 2's local edit
			const localContent = await client2.readFile('/shared.txt');
			assert.strictEqual(new TextDecoder().decode(localContent), 'User 2 update');
		});

		await sub.test('A resolved conflict sidecar stays gone after later syncs', async () => {
			// consolidate() packs sidecars so both versions of a conflict survive for the person to
			// choose between, which means resolving one has to propagate as a deletion.
			await client2.consolidate();

			await client2.resolveConflict('/shared.txt', new TextEncoder().encode('Merged by User 2'));
			assert.strictEqual(await client2.stat('/shared_updates.txt'), null);

			await client2.sync();
			await client2.sync();
			assert.strictEqual(
				await client2.stat('/shared_updates.txt'),
				null,
				'sidecar was recreated from the remote after being resolved'
			);

			// The resolution reaches the other client too
			await client1.sync();
			assert.strictEqual(await client1.stat('/shared_updates.txt'), null);
			assert.strictEqual(
				new TextDecoder().decode(await client1.readFile('/shared.txt')),
				'Merged by User 2'
			);
		});
	});

	await t.test('Chunk freshness: a same-size remote edit is still pulled', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);
		const backend = new MemoryStorage();

		const [client1, client2] = ['/fresh1', '/fresh2'].map(
			(localRoot) =>
				new StratusBase({
					backend,
					localRoot,
					middleware: new MiddlewareZipChunk({ password: 'shared-pass', chunkSizeLimit: 5000 })
				})
		);

		await client1.writeFile('/same-size.txt', new TextEncoder().encode('AAAAAAAAAA'));
		await client1.sync();
		await client2.sync();

		// Byte-identical length, so a size-only comparison cannot see this change
		await client1.writeFile('/same-size.txt', new TextEncoder().encode('BBBBBBBBBB'));
		await client1.sync();

		await client2.sync();
		assert.strictEqual(
			new TextDecoder().decode(await client2.readFile('/same-size.txt')),
			'BBBBBBBBBB'
		);
	});

	await t.test('Chunk freshness: converges when the backend reports no useful timestamp', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		// Mirrors GithubStorage, whose listing hardcodes the epoch to avoid rate limits and relies
		// entirely on the commit sha to signal a change.
		class TimestampBlindStorage extends MemoryStorage {
			async listDirectory(path: string) {
				const items = await super.listDirectory(path);
				return items.map((item) => ({ ...item, modifiedAt: new Date(0) }));
			}
		}

		const backend = new TimestampBlindStorage();
		const [client1, client2] = ['/blind1', '/blind2'].map(
			(localRoot) =>
				new StratusBase({
					backend,
					localRoot,
					middleware: new MiddlewareZipChunk({ password: 'shared-pass', chunkSizeLimit: 5000 })
				})
		);

		await client1.writeFile('/note.txt', new TextEncoder().encode('0123456789'));
		await client1.sync();
		await client2.sync();

		await client1.writeFile('/note.txt', new TextEncoder().encode('9876543210'));
		await client1.sync();

		await client2.sync();
		assert.strictEqual(new TextDecoder().decode(await client2.readFile('/note.txt')), '9876543210');
	});

	await t.test('Chunk freshness: a backend that cannot stat never wedges a chunk', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		class UnstattableStorage extends MemoryStorage {
			async stat() {
				return null;
			}
		}

		const backend = new UnstattableStorage();
		const [client1, client2] = ['/nostat1', '/nostat2'].map(
			(localRoot) =>
				new StratusBase({
					backend,
					localRoot,
					middleware: new MiddlewareZipChunk({ password: 'shared-pass', chunkSizeLimit: 5000 })
				})
		);

		await client1.writeFile('/note.txt', new TextEncoder().encode('first'));
		await client1.sync();

		// A missing stat must not be papered over with the local clock: a fabricated timestamp would
		// look permanently newer than the server's and the chunk would never be downloaded again.
		const chunks = (await client1.getMetadata()).chunks!;
		Object.entries(chunks).forEach(([path, chunk]) => {
			assert.strictEqual(chunk.remoteModifiedAt, undefined, `chunk ${path} invented a timestamp`);
			assert.ok(chunk.remoteSize !== undefined, `chunk ${path} has no fallback size`);
		});

		await client2.sync();
		await client1.writeFile('/note.txt', new TextEncoder().encode('second revision'));
		await client1.sync();

		await client2.sync();
		assert.strictEqual(
			new TextDecoder().decode(await client2.readFile('/note.txt')),
			'second revision'
		);
	});

	await t.test('Legacy metadata written without leading slashes is migrated on load', async () => {
		const storageMock = new MockStorageManager();
		setStorageManager(storageMock);

		const backend = new MemoryStorage();
		const stratus = new StratusBase({
			backend,
			localRoot: '/legacy',
			middleware: new MiddlewareZipChunk({ password: 'test-pass', chunkSizeLimit: 5000 })
		});

		await stratus.writeFile('Notes/note1.md', new TextEncoder().encode('legacy content'));
		await stratus.sync();

		// Rewrite the document the way an older client keyed it: bare paths, no leading slash
		const current = await stratus.getMetadata();
		await stratus.saveMetadata({
			files: {
				'Notes/note1.md': { ...current.files['/Notes/note1.md'], path: 'Notes/note1.md' }
			},
			chunks: {
				'archive_chunk_001.7z': current.chunks!['/archive_chunk_001.7z']
			}
		});

		const migrated = await stratus.getMetadata();
		assert.deepStrictEqual(Object.keys(migrated.files), ['/Notes/note1.md']);
		assert.strictEqual(migrated.files['/Notes/note1.md'].path, '/Notes/note1.md');
		assert.deepStrictEqual(Object.keys(migrated.chunks!), ['/archive_chunk_001.7z']);

		// Callers may still pass either form
		assert.strictEqual(
			new TextDecoder().decode(await stratus.readFile('Notes/note1.md')),
			'legacy content'
		);
		assert.strictEqual(
			new TextDecoder().decode(await stratus.readFile('/Notes/note1.md')),
			'legacy content'
		);

		const listed = await stratus.listDirectory('Notes');
		assert.deepStrictEqual(
			listed.map((f) => f.path),
			['/Notes/note1.md']
		);
	});
});
