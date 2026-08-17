import test from 'node:test';
import assert from 'node:assert';
import { GithubStorage } from './GithubStorage.ts';

// Save original fetch
const originalFetch = globalThis.fetch;

// Mock variables to track operations
let mockRequests: { url: string; options?: RequestInit }[] = [];
let fileStorage = new Map<string, { content: Uint8Array; sha: string }>();

// Seed initial files
fileStorage.set('notes/todo.md', {
	content: new TextEncoder().encode('Buy milk'),
	sha: 'sha-todo-123'
});

// Setup mock fetch
(globalThis as any).fetch = async (url: string, options?: RequestInit): Promise<Response> => {
	mockRequests.push({ url, options });

	const headers = (options?.headers || {}) as Record<string, string>;

	// Helper to create JSON response
	const jsonResponse = (status: number, body: any): Response => {
		const resObj = {
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? 'OK' : 'Error',
			headers: new Headers({
				'content-type': 'application/json'
			}),
			json: async () => body,
			text: async () => JSON.stringify(body),
			clone: () => jsonResponse(status, body)
		};
		return resObj as unknown as Response;
	};

	// 1. Commits API
	if (url.includes('/commits?path=')) {
		const match = url.match(/path=([^&]+)/);
		const path = match ? decodeURIComponent(match[1]) : '';
		if (fileStorage.has(path)) {
			return jsonResponse(200, [
				{
					commit: {
						committer: {
							date: '2026-08-17T12:00:00Z'
						}
					}
				}
			]);
		}
		return jsonResponse(200, []);
	}

	// 2. Contents API
	if (url.includes('/contents/')) {
		if (url.includes('/repos/EmptyOwner/')) {
			return jsonResponse(404, {
				message: 'This repository is empty.',
				documentation_url: 'https://docs.github.com/v3/repos/contents/#get-contents'
			});
		}

		const pathPart = url.split('/contents/')[1];
		const path = cleanPathForTest(pathPart.split('?')[0]);

		// DELETE request
		if (options?.method === 'DELETE') {
			if (fileStorage.has(path)) {
				fileStorage.delete(path);
				return jsonResponse(200, { message: 'Deleted' });
			}
			return jsonResponse(404, { message: 'Not Found' });
		}

		// PUT request
		if (options?.method === 'PUT') {
			const body = JSON.parse(options.body as string);
			const contentBytes = base64ToUint8Array(body.content);
			
			// If updating, check sha
			const existing = fileStorage.get(path);
			if (existing && body.sha !== existing.sha) {
				return jsonResponse(409, { message: 'SHA mismatch conflict' });
			}

			const newSha = 'sha-' + Math.random().toString(36).substring(2);
			fileStorage.set(path, {
				content: contentBytes,
				sha: newSha
			});
			return jsonResponse(200, { content: { sha: newSha } });
		}

		// GET request
		if (!options?.method || options.method === 'GET') {
			// Check if we want raw content
			if (headers['Accept'] === 'application/vnd.github.v3.raw') {
				const file = fileStorage.get(path);
				if (file) {
					return {
						ok: true,
						status: 200,
						statusText: 'OK',
						headers: new Headers({
							'content-length': String(file.content.length)
						}),
						body: {
							getReader() {
								let read = false;
								return {
									read: async () => {
										if (read) return { done: true, value: undefined };
										read = true;
										return { done: false, value: file.content };
									}
								};
							}
						} as any,
						arrayBuffer: async () => file.content.buffer
					} as unknown as Response;
				}
				return jsonResponse(404, { message: 'Not Found' });
			}

			// Normal contents API
			const file = fileStorage.get(path);
			if (file) {
				return jsonResponse(200, {
					name: path.split('/').pop() || '',
					path: path,
					size: file.content.length,
					type: 'file',
					sha: file.sha
				});
			}

			// Check if it's a directory
			const dirPrefix = path === '' ? '' : path + '/';
			const dirItems = Array.from(fileStorage.keys())
				.filter((k) => k.startsWith(dirPrefix))
				.map((k) => {
					const subPath = k.substring(dirPrefix.length);
					const name = subPath.split('/')[0];
					const isDir = subPath.includes('/');
					return {
						name,
						path: dirPrefix + name,
						size: isDir ? 0 : fileStorage.get(k)!.content.length,
						type: isDir ? 'dir' : 'file',
						sha: isDir ? 'sha-dir' : fileStorage.get(k)!.sha
					};
				});

			// Filter out duplicates (e.g. if multiple files in same subdirectory)
			const uniqueItems = Array.from(new Map(dirItems.map((item) => [item.path, item])).values());

			if (uniqueItems.length > 0) {
				return jsonResponse(200, uniqueItems);
			}

			return jsonResponse(404, { message: 'Not Found' });
		}
	}

	return jsonResponse(404, { message: 'Not Found' });
};

function cleanPathForTest(path: string): string {
	return path.split('/').filter(Boolean).join('/');
}

function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i);
	}
	return bytes;
}

test('GithubStorage isConfigured returns true if owner, repo, and token are set', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});
	const ok = await storage.isConfigured();
	assert.strictEqual(ok, true);

	const unconfigured = new GithubStorage({ owner: '', repo: '' });
	assert.strictEqual(await unconfigured.isConfigured(), false);
});

test('GithubStorage stat retrieves file info and commit date', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	const info = await storage.stat('/notes/todo.md');
	assert.ok(info);
	assert.strictEqual(info.name, 'todo.md');
	assert.strictEqual(info.type, 'file');
	assert.strictEqual(info.size, 8);
	assert.strictEqual(info.etag, 'sha-todo-123');
	assert.strictEqual(info.modifiedAt.getTime(), new Date('2026-08-17T12:00:00Z').getTime());

	const notFound = await storage.stat('/not-found.txt');
	assert.strictEqual(notFound, null);
});

test('GithubStorage readFile downloads content successfully', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	const op = storage.readFile('/notes/todo.md');
	const content = await op.finished;
	assert.deepStrictEqual(content, new TextEncoder().encode('Buy milk'));
});

test('GithubStorage writeFile uploads standard and atomic content', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	// Standard write
	const op = storage.writeFile('/notes/new.md', new TextEncoder().encode('Hello World'));
	await op.finished;
	assert.ok(fileStorage.has('notes/new.md'));
	assert.strictEqual(new TextDecoder().decode(fileStorage.get('notes/new.md')!.content), 'Hello World');

	// Atomic write
	const opAtomic = storage.writeFile('/notes/new.md', new TextEncoder().encode('Updated World'), { atomic: true });
	await opAtomic.finished;
	assert.strictEqual(new TextDecoder().decode(fileStorage.get('notes/new.md')!.content), 'Updated World');
	assert.strictEqual(fileStorage.has('notes/new.md.tmp'), false);
});

test('GithubStorage deleteFile deletes content', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	assert.ok(fileStorage.has('notes/new.md'));
	await storage.deleteFile('/notes/new.md');
	assert.strictEqual(fileStorage.has('notes/new.md'), false);
});

test('GithubStorage listDirectory returns directory contents', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	const items = await storage.listDirectory('/notes');
	assert.ok(items.length >= 1);
	const todo = items.find((i) => i.name === 'todo.md');
	assert.ok(todo);
	assert.strictEqual(todo.type, 'file');
	assert.strictEqual(todo.size, 8);
});

test('GithubStorage renameFile moves a file', async () => {
	const storage = new GithubStorage({
		owner: 'TestOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	assert.ok(fileStorage.has('notes/todo.md'));
	await storage.renameFile('/notes/todo.md', '/notes/done.md');
	assert.strictEqual(fileStorage.has('notes/todo.md'), false);
	assert.ok(fileStorage.has('notes/done.md'));
	assert.strictEqual(new TextDecoder().decode(fileStorage.get('notes/done.md')!.content), 'Buy milk');
});

test('GithubStorage listDirectory handles empty repository', async () => {
	const storage = new GithubStorage({
		owner: 'EmptyOwner',
		repo: 'TestRepo',
		credentials: { accessToken: 'token123' }
	});

	const items = await storage.listDirectory('/');
	assert.deepStrictEqual(items, []);
});
