import { beforeEach, describe, test, expect } from 'vitest';
import { StratusBase, SyncConflictError } from './StratusBase.ts';
import { MiddlewareIndividualFile } from './MiddlewareIndividualFile.ts';
import type { StorageBackend, StorageFileInfo, StorageOperation } from './types.ts';
import { BaseStorageOperation } from './utils/BaseStorageOperation.ts';

const TEST_ROOT = 'stratus-browser-test';

// Simple remote mock backend
class MockRemoteBackend implements StorageBackend {
	id = 'mock-remote';
	files = new Map<string, { content: Uint8Array; modifiedAt: Date; etag?: string }>();

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

	writeFile(path: string, content: Uint8Array): StorageOperation<void> {
		return new BaseStorageOperation(async () => {
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

describe('StratusBase Browser Tests with Native OPFS', () => {
	let backend: MockRemoteBackend;
	let stratus: StratusBase;

	beforeEach(async () => {
		// Clean up the browser OPFS TEST_ROOT directory
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry(TEST_ROOT, { recursive: true });
		} catch {
			// Ignore if not present yet
		}

		backend = new MockRemoteBackend();
		stratus = new StratusBase({
			backend,
			localRoot: TEST_ROOT,
			middleware: new MiddlewareIndividualFile()
		});
	});

	test('Local CRUD operations write directly to native OPFS', async () => {
		// 1. Write file
		const content = new TextEncoder().encode('Hello OPFS Browser');
		await stratus.writeFile('/hello.txt', content).finished;

		// 2. Stat file
		const fileInfo = await stratus.stat('/hello.txt');
		expect(fileInfo).not.toBeNull();
		expect(fileInfo?.name).toBe('hello.txt');
		expect(fileInfo?.size).toBe(content.length);

		// 3. Read file
		const readContent = await stratus.readFile('/hello.txt').finished;
		expect(new TextDecoder().decode(readContent)).toBe('Hello OPFS Browser');

		// 4. Rename file
		await stratus.renameFile('/hello.txt', '/world.txt');
		const oldInfo = await stratus.stat('/hello.txt');
		expect(oldInfo).toBeNull();

		const newInfo = await stratus.stat('/world.txt');
		expect(newInfo).not.toBeNull();
		expect(newInfo?.name).toBe('world.txt');

		// 5. Delete file
		await stratus.deleteFile('/world.txt');
		const deletedInfo = await stratus.stat('/world.txt');
		expect(deletedInfo).toBeNull();
	});

	test('Real synchronization with native OPFS storage', async () => {
		// Seed remote
		backend.files.set('/remote.md', {
			content: new TextEncoder().encode('Remote Content'),
			modifiedAt: new Date(),
			etag: 'etag1'
		});

		// Local write
		await stratus.writeFile('/local.md', new TextEncoder().encode('Local Content')).finished;

		// Sync
		const result = await stratus.sync();
		expect(result.created).toContain('/remote.md');
		expect(result.created).toContain('/local.md');

		// Verify local exists
		const localStat = await stratus.stat('/remote.md');
		expect(localStat).not.toBeNull();

		const localData = await stratus.readFile('/remote.md').finished;
		expect(new TextDecoder().decode(localData)).toBe('Remote Content');

		// Verify remote exists
		const remoteFile = backend.files.get('/local.md');
		expect(remoteFile).toBeDefined();
		expect(new TextDecoder().decode(remoteFile!.content)).toBe('Local Content');
	});

	test('Sync Conflict triggers custom error and generates conflict helper files', async () => {
		// Seed remote
		backend.files.set('/conflict.md', {
			content: new TextEncoder().encode('Remote changes'),
			modifiedAt: new Date(Date.now() + 5000), // Newer
			etag: 'etag-remote'
		});

		// Local write
		await stratus.writeFile('/conflict.md', new TextEncoder().encode('Local changes')).finished;

		// Backdate metadata.json remoteModifiedAt to trigger conflict
		const meta = await stratus.getMetadata();
		meta.files['/conflict.md'].remoteModifiedAt = Date.now() - 10000;
		await stratus.saveMetadata(meta);

		// Sync and assert SyncConflictError
		await expect(stratus.sync()).rejects.toThrow(SyncConflictError);

		// Assert updates file exists
		const updatesInfo = await stratus.stat('/conflict_updates.md');
		expect(updatesInfo).not.toBeNull();

		const updatesContent = await stratus.readFile('/conflict_updates.md').finished;
		expect(new TextDecoder().decode(updatesContent)).toBe('Remote changes');

		// Local original should still have local changes
		const localContent = await stratus.readFile('/conflict.md').finished;
		expect(new TextDecoder().decode(localContent)).toBe('Local changes');
	});
});
