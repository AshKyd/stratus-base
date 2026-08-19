import test from 'node:test';
import assert from 'node:assert';
import { MemoryStorage } from './MemoryStorage.ts';

test('MemoryStorage Backend Tests', async (t) => {
	const storage = new MemoryStorage();

	await t.test('isConfigured returns true', async () => {
		const configured = await storage.isConfigured();
		assert.strictEqual(configured, true);
	});

	await t.test('stat returns null for non-existent file', async () => {
		const info = await storage.stat('/not-found.txt');
		assert.strictEqual(info, null);
	});

	await t.test('writeFile and stat file details', async () => {
		const content = new TextEncoder().encode('Hello Memory');
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
		assert.strictEqual(text, 'Hello Memory');
	});

	await t.test('listDirectory lists files and virtual directories', async () => {
		// Write more files
		await storage.writeFile('/notes/other.txt', new TextEncoder().encode('Other')).finished;
		await storage.writeFile('/root-file.txt', new TextEncoder().encode('Root File')).finished;

		const rootListing = await storage.listDirectory('/');
		const rootFiles = rootListing.map((item) => item.name);
		
		assert.ok(rootFiles.includes('notes'));
		assert.ok(rootFiles.includes('root-file.txt'));

		const notesDir = rootListing.find((item) => item.name === 'notes');
		assert.ok(notesDir);
		assert.strictEqual(notesDir.type, 'directory');

		const notesListing = await storage.listDirectory('/notes');
		const notesFiles = notesListing.map((item) => item.name);
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

	await t.test('renameFile moves directories recursively', async () => {
		await storage.renameFile('/notes', '/docs');

		const oldDir = await storage.stat('/notes');
		assert.strictEqual(oldDir, null);

		const newDir = await storage.stat('/docs');
		assert.ok(newDir);
		assert.strictEqual(newDir.type, 'directory');

		const docListing = await storage.listDirectory('/docs');
		const docFiles = docListing.map((item) => item.name);
		assert.ok(docFiles.includes('todo.txt'));
		assert.ok(docFiles.includes('other.txt'));
	});

	await t.test('deleteFile removes files and directories recursively', async () => {
		await storage.deleteFile('/moved-file.txt');
		const fileInfo = await storage.stat('/moved-file.txt');
		assert.strictEqual(fileInfo, null);

		await storage.deleteFile('/docs');
		const dirInfo = await storage.stat('/docs');
		assert.strictEqual(dirInfo, null);

		const todoInfo = await storage.stat('/docs/todo.txt');
		assert.strictEqual(todoInfo, null);
	});
});
