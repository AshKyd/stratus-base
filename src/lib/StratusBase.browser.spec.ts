import { beforeEach, describe, test, expect } from 'vitest';
import { StratusBase, SyncConflictError } from './StratusBase.ts';
import { MiddlewareIndividualFile } from './middleware/MiddlewareIndividualFile/MiddlewareIndividualFile.ts';
import { MemoryStorage } from './backends/MemoryStorage.ts';

const TEST_ROOT = 'stratus-browser-test';

describe('StratusBase Browser Tests with Native OPFS', () => {
	let backend: MemoryStorage;
	let stratus: StratusBase;

	beforeEach(async () => {
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry(TEST_ROOT, { recursive: true });
		} catch {
			// Ignore if not present yet
		}

		backend = new MemoryStorage();
		stratus = new StratusBase({
			backend,
			localRoot: TEST_ROOT,
			middleware: new MiddlewareIndividualFile()
		});
	});

	test('Local CRUD operations write directly to native OPFS', async () => {
		const content = new TextEncoder().encode('Hello OPFS Browser');
		await stratus.writeFile('/hello.txt', content);

		const fileInfo = await stratus.stat('/hello.txt');
		expect(fileInfo).not.toBeNull();
		expect(fileInfo?.name).toBe('hello.txt');
		expect(fileInfo?.size).toBe(content.length);

		const readContent = await stratus.readFile('/hello.txt');
		expect(new TextDecoder().decode(readContent)).toBe('Hello OPFS Browser');

		await stratus.renameFile('/hello.txt', '/world.txt');
		const oldInfo = await stratus.stat('/hello.txt');
		expect(oldInfo).toBeNull();

		const newInfo = await stratus.stat('/world.txt');
		expect(newInfo).not.toBeNull();
		expect(newInfo?.name).toBe('world.txt');

		await stratus.deleteFile('/world.txt');
		const deletedInfo = await stratus.stat('/world.txt');
		expect(deletedInfo).toBeNull();
	});

	test('Real synchronization with native OPFS storage', async () => {
		backend.getFilesMap().set('/remote.md', {
			content: new TextEncoder().encode('Remote Content'),
			modifiedAt: new Date(),
			etag: 'etag1'
		});

		await stratus.writeFile('/local.md', new TextEncoder().encode('Local Content'));

		const result = await stratus.sync();
		expect(result.created).toContain('/remote.md');
		expect(result.created).toContain('/local.md');

		const localStat = await stratus.stat('/remote.md');
		expect(localStat).not.toBeNull();

		const localData = await stratus.readFile('/remote.md');
		expect(new TextDecoder().decode(localData)).toBe('Remote Content');

		const remoteFile = backend.getFilesMap().get('/local.md');
		expect(remoteFile).toBeDefined();
		expect(new TextDecoder().decode(remoteFile!.content)).toBe('Local Content');
	});

	test('Sync Conflict triggers custom error and generates conflict helper files', async () => {
		backend.getFilesMap().set('/conflict.md', {
			content: new TextEncoder().encode('Remote changes'),
			modifiedAt: new Date(Date.now() + 5000),
			etag: 'etag-remote'
		});

		await stratus.writeFile('/conflict.md', new TextEncoder().encode('Local changes'));

		const meta = await stratus.getMetadata();
		meta.files['/conflict.md'].remoteModifiedAt = Date.now() - 10000;
		await stratus.saveMetadata(meta);

		await expect(stratus.sync()).rejects.toThrow(SyncConflictError);

		const updatesInfo = await stratus.stat('/conflict_updates.md');
		expect(updatesInfo).not.toBeNull();

		const updatesContent = await stratus.readFile('/conflict_updates.md');
		expect(new TextDecoder().decode(updatesContent)).toBe('Remote changes');

		const localContent = await stratus.readFile('/conflict.md');
		expect(new TextDecoder().decode(localContent)).toBe('Local changes');
	});
});
