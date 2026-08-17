import test from 'node:test';
import assert from 'node:assert';
import { GoogleDriveStorage } from './GoogleDriveStorage.ts';

// Define a minimal sessionStorage mock on globalThis
const mockStorage: Record<string, string> = {};
(globalThis as any).window = {
	sessionStorage: {
		getItem: (key: string) => mockStorage[key] || null,
		setItem: (key: string, val: string) => {
			mockStorage[key] = val;
		},
		removeItem: (key: string) => {
			delete mockStorage[key];
		}
	}
} as any;

// Helper to mock global fetch response
interface MockResponseInit {
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
}

function createMockResponse(body: any, init?: MockResponseInit): Response {
	const status = init?.status ?? 200;
	const statusText = init?.statusText ?? 'OK';
	const headers = new Headers(init?.headers);

	let bodyStream: ReadableStream | null = null;
	let arrayBufferValue: ArrayBuffer;

	if (body instanceof Uint8Array) {
		arrayBufferValue = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
		bodyStream = new ReadableStream({
			start(controller) {
				controller.enqueue(body);
				controller.close();
			}
		});
	} else {
		const str = typeof body === 'string' ? body : JSON.stringify(body);
		const bytes = new TextEncoder().encode(str);
		arrayBufferValue = bytes.buffer as ArrayBuffer;
		bodyStream = new ReadableStream({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		});
	}

	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		headers,
		json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
		text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		arrayBuffer: async () => arrayBufferValue,
		body: bodyStream
	} as unknown as Response;
}

// Track mock call parameters
let fetchCalls: { url: string; options?: RequestInit }[] = [];
let deleteCalledWithId = '';
let patchCalledWithId = '';
let lastPatchBody: any = null;
let lastCreateBody: any = null;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const urlStr = typeof input === 'string' ? input : input.toString();
	fetchCalls.push({ url: urlStr, options: init });

	if (urlStr.includes('/token')) {
		return createMockResponse({
			access_token: 'new-access-token',
			refresh_token: 'new-refresh-token',
			expires_in: 3600
		});
	}

	if (urlStr.includes('files?q=')) {
		// Parsing q to return appropriate response
		const q = decodeURIComponent(urlStr.replace(/\+/g, ' '));
		if (q.includes("in parents") && !q.includes("name =")) {
			return createMockResponse({
				files: [
					{
						id: 'file1-id',
						name: 'file1.txt',
						mimeType: 'text/plain',
						size: 100,
						modifiedTime: '2026-08-17T00:00:00.000Z'
					}
				]
			});
		}
		if (q.includes("name = 'not-found'")) {
			return createMockResponse({ files: [] });
		}
		if (q.includes("name = 'notes'")) {
			return createMockResponse({
				files: [{ id: 'notes-dir-id', mimeType: 'application/vnd.google-apps.folder' }]
			});
		}
		if (q.includes("name = 'todo.md'")) {
			return createMockResponse({
				files: [{ id: 'todo-file-id', mimeType: 'text/plain' }]
			});
		}
		if (q.includes("name = 'file1.txt'")) {
			return createMockResponse({
				files: [{ id: 'file1-id', mimeType: 'text/plain' }]
			});
		}
		// Default fallback for walking directories during listings or writes
		return createMockResponse({ files: [] });
	}

	if (urlStr.includes('/files/') && init?.method === 'DELETE') {
		const match = urlStr.match(/\/files\/([^?]+)/);
		if (match) deleteCalledWithId = match[1];
		return createMockResponse(null, { status: 204 });
	}

	if (urlStr.includes('/files/') && init?.method === 'PATCH') {
		const match = urlStr.match(/\/files\/([^?]+)/);
		if (match) patchCalledWithId = match[1];
		lastPatchBody = init.body;
		return createMockResponse({ id: match ? match[1] : 'patched-id' });
	}

	if (urlStr.endsWith('/files') && init?.method === 'POST') {
		lastCreateBody = JSON.parse(init.body as string);
		return createMockResponse({ id: `${lastCreateBody.name}-id` });
	}

	if (urlStr.includes('/files/todo-file-id') && !urlStr.includes('alt=media')) {
		return createMockResponse({
			id: 'todo-file-id',
			name: 'todo.md',
			mimeType: 'text/plain',
			size: 100,
			modifiedTime: '2026-08-17T00:00:00.000Z'
		});
	}

	if (urlStr.includes('/files/notes-dir-id') && !urlStr.includes('alt=media')) {
		return createMockResponse({
			id: 'notes-dir-id',
			name: 'notes',
			mimeType: 'application/vnd.google-apps.folder',
			size: 0,
			modifiedTime: '2026-08-17T00:00:00.000Z'
		});
	}

	if (urlStr.includes('/files/') && urlStr.includes('alt=media')) {
		return createMockResponse(new Uint8Array([72, 101, 108, 108, 111]), {
			headers: { 'content-length': '5' }
		});
	}

	if (urlStr.includes('/files') && urlStr.includes('parents')) {
		// listDirectory
		return createMockResponse({
			files: [
				{
					id: 'file1-id',
					name: 'file1.txt',
					mimeType: 'text/plain',
					size: 100,
					modifiedTime: '2026-08-17T00:00:00.000Z'
				}
			]
		});
	}

	throw new Error(`Unhandled mock request: ${urlStr}`);
};

test('GoogleDriveStorage isConfigured returns true when access token is set and valid', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({
		accessToken: 'mock-token',
		expiresAt: Date.now() + 60000
	});
	const configured = await storage.isConfigured();
	assert.strictEqual(configured, true);
});

test('GoogleDriveStorage getAuthUrl returns URL with response_type=token', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	const url = await storage.getAuthUrl('https://redirect.uri', 'state-123');
	assert.ok(url.includes('https://accounts.google.com/o/oauth2/v2/auth'));
	assert.ok(url.includes('response_type=token'));
	assert.ok(url.includes('client_id=mock-client'));
	assert.ok(url.includes('redirect_uri=https%3A%2F%2Fredirect.uri'));
});

test('GoogleDriveStorage stat returns file metadata or null when not found', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	const metadata = await storage.stat('/notes/todo.md');
	assert.ok(metadata);
	assert.strictEqual(metadata.name, 'todo.md');
	assert.strictEqual(metadata.type, 'file');
	assert.strictEqual(metadata.size, 100);

	const dirMetadata = await storage.stat('/notes');
	assert.ok(dirMetadata);
	assert.strictEqual(dirMetadata.name, 'notes');
	assert.strictEqual(dirMetadata.type, 'directory');

	const nullMetadata = await storage.stat('/not-found');
	assert.strictEqual(nullMetadata, null);
});

test('GoogleDriveStorage readFile retrieves and parses file content with progress', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	const op = storage.readFile('/notes/todo.md');
	let progressCalled = false;
	op.on('progress', ({ loaded, total }) => {
		assert.strictEqual(loaded, 5);
		assert.strictEqual(total, 5);
		progressCalled = true;
	});

	const data = await op.finished;
	assert.deepStrictEqual(data, new Uint8Array([72, 101, 108, 108, 111]));
	assert.strictEqual(progressCalled, true);
});

test('GoogleDriveStorage writeFile uploads contents directly on standard mode', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	patchCalledWithId = '';
	const content = new Uint8Array([65, 66, 67]);
	const op = storage.writeFile('/notes/todo.md', content);
	await op.finished;
	assert.strictEqual(patchCalledWithId, 'todo-file-id');
	assert.deepStrictEqual(lastPatchBody, content);
});

test('GoogleDriveStorage writeFile uses write-then-rename on atomic mode', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	deleteCalledWithId = '';
	patchCalledWithId = '';
	lastCreateBody = null;
	const content = new Uint8Array([1, 2, 3]);
	
	const op = storage.writeFile('/notes/todo.md', content, { atomic: true });
	await op.finished;

	// Temp file metadata creation
	assert.strictEqual(lastCreateBody.name, 'todo.md.tmp');
	// Delete original file
	assert.strictEqual(deleteCalledWithId, 'todo-file-id');
	// Rename patch called
	assert.strictEqual(patchCalledWithId, 'todo.md.tmp-id');
});

test('GoogleDriveStorage listDirectory retrieves list of items', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	const items = await storage.listDirectory('/notes');
	assert.strictEqual(items.length, 1);
	assert.strictEqual(items[0].name, 'file1.txt');
	assert.strictEqual(items[0].type, 'file');
	assert.strictEqual(items[0].size, 100);
});

test('GoogleDriveStorage renameFile patches name and parents', async () => {
	const storage = new GoogleDriveStorage({ clientId: 'mock-client' });
	storage.setCredentials({ accessToken: 'mock-token' });

	patchCalledWithId = '';
	fetchCalls = [];
	await storage.renameFile('/notes/todo.md', '/notes/todo-new.md');
	
	assert.strictEqual(patchCalledWithId, 'todo-file-id');
	const renameCall = fetchCalls.find(c => c.url.includes('/files/todo-file-id'));
	assert.ok(renameCall);
	assert.strictEqual(JSON.parse(renameCall.options?.body as string).name, 'todo-new.md');
});
