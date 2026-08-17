import test from 'node:test';
import assert from 'node:assert';
import { S3Storage } from './S3Storage.ts';
import S3rver from 's3rver';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

// We run s3rver on a dynamic port to avoid conflicts
const PORT = 4569;
const BUCKET_NAME = 'test-bucket';

test('S3Storage Integration Tests with s3rver', async (t) => {
	let s3rverInstance: any;

	// Set up the local mock S3 server
	await t.test('Start s3rver', () => {
		return new Promise((resolve, reject) => {
			s3rverInstance = new S3rver({
				port: PORT,
				address: 'localhost',
				silent: true,
				directory: './scratch/s3rver'
			}).run((err) => {
				if (err) return reject(err);
				resolve();
			});
		});
	});

	// Create test bucket using a direct S3Client setup
	const directClient = new S3Client({
		region: 'us-east-1',
		endpoint: `http://localhost:${PORT}`,
		forcePathStyle: true,
		credentials: {
			accessKeyId: 'S3RVER',
			secretAccessKey: 'S3RVER'
		}
	});

	try {
		await directClient.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
	} catch (err: any) {
		if (err.name !== 'BucketAlreadyExists' && err.name !== 'BucketAlreadyOwnedByYou') {
			throw err;
		}
	}

	const storage = new S3Storage({
		accessKeyId: 'S3RVER',
		secretAccessKey: 'S3RVER',
		region: 'us-east-1',
		bucket: BUCKET_NAME,
		endpoint: `http://localhost:${PORT}`,
		forcePathStyle: true
	});

	await t.test('isConfigured returns true', async () => {
		const configured = await storage.isConfigured();
		assert.strictEqual(configured, true);
	});

	await t.test('stat returns null for non-existent file', async () => {
		const info = await storage.stat('/not-found.txt');
		assert.strictEqual(info, null);
	});

	await t.test('writeFile and stat file details', async () => {
		const content = new TextEncoder().encode('Hello S3');
		const op = storage.writeFile('/notes/todo.txt', content);
		await op.finished;

		const info = await storage.stat('/notes/todo.txt');
		assert.ok(info);
		assert.strictEqual(info.name, 'todo.txt');
		assert.strictEqual(info.type, 'file');
		assert.strictEqual(info.size, content.length);
		assert.ok(info.modifiedAt instanceof Date);
	});

	await t.test('readFile file contents', async () => {
		const op = storage.readFile('/notes/todo.txt');
		const bytes = await op.finished;
		const text = new TextDecoder().decode(bytes);
		assert.strictEqual(text, 'Hello S3');
	});

	await t.test('writeFile atomic updates', async () => {
		const initialContent = new TextEncoder().encode('Original');
		await storage.writeFile('/atomic.txt', initialContent).finished;

		const nextContent = new TextEncoder().encode('Updated Atomically');
		await storage.writeFile('/atomic.txt', nextContent, { atomic: true }).finished;

		const bytes = await storage.readFile('/atomic.txt').finished;
		assert.strictEqual(new TextDecoder().decode(bytes), 'Updated Atomically');
	});

	await t.test('listDirectory lists files and folders', async () => {
		// Populate some sub files to simulate directories
		await storage.writeFile('/notes/other.txt', new TextEncoder().encode('Other')).finished;
		await storage.writeFile('/root-file.txt', new TextEncoder().encode('Root File')).finished;

		const rootListing = await storage.listDirectory('/');
		// Should contain /notes (directory) and /root-file.txt (file) and /atomic.txt (file)
		const rootFiles = rootListing.map(item => item.name);
		assert.ok(rootFiles.includes('notes'));
		assert.ok(rootFiles.includes('root-file.txt'));
		assert.ok(rootFiles.includes('atomic.txt'));

		const notesDir = rootListing.find(item => item.name === 'notes');
		assert.ok(notesDir);
		assert.strictEqual(notesDir.type, 'directory');

		const notesListing = await storage.listDirectory('/notes');
		const notesFiles = notesListing.map(item => item.name);
		assert.ok(notesFiles.includes('todo.txt'));
		assert.ok(notesFiles.includes('other.txt'));
	});

	await t.test('stat directory returns directory type', async () => {
		const info = await storage.stat('/notes');
		assert.ok(info);
		assert.strictEqual(info.type, 'directory');
		assert.strictEqual(info.name, 'notes');
	});

	await t.test('renameFile moves files', async () => {
		await storage.renameFile('/root-file.txt', '/moved-file.txt');

		const oldInfo = await storage.stat('/root-file.txt');
		assert.strictEqual(oldInfo, null);

		const newInfo = await storage.stat('/moved-file.txt');
		assert.ok(newInfo);
		assert.strictEqual(newInfo.type, 'file');
		
		const bytes = await storage.readFile('/moved-file.txt').finished;
		assert.strictEqual(new TextDecoder().decode(bytes), 'Root File');
	});

	await t.test('deleteFile removes files and recursively directories', async () => {
		// Delete file
		await storage.deleteFile('/moved-file.txt');
		const fileInfo = await storage.stat('/moved-file.txt');
		assert.strictEqual(fileInfo, null);

		// Delete directory /notes
		await storage.deleteFile('/notes');
		const dirInfo = await storage.stat('/notes');
		assert.strictEqual(dirInfo, null);

		const todoInfo = await storage.stat('/notes/todo.txt');
		assert.strictEqual(todoInfo, null);

		const otherInfo = await storage.stat('/notes/other.txt');
		assert.strictEqual(otherInfo, null);
	});

	// Tear down S3rver
	await t.test('Stop s3rver', () => {
		return new Promise((resolve) => {
			s3rverInstance.close(resolve);
		});
	});
});
