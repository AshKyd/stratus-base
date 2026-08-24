import test from 'node:test';
import assert from 'node:assert';
import { DropboxStorage } from './DropboxStorage.ts';
import { Dropbox, DropboxAuth } from 'dropbox';

// Define a minimal sessionStorage mock on globalThis for testing the client-side redirect verifier persistence
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

// Mock DropboxAuth prototype methods
let mockAuthAccessToken = 'mock-access-token';
let mockAuthRefreshToken = 'mock-refresh-token';
let mockAuthExpiresAt: Date | undefined = new Date(Date.now() + 60000);

DropboxAuth.prototype.getAccessToken = () => mockAuthAccessToken;
DropboxAuth.prototype.getAccessTokenExpiresAt = () => mockAuthExpiresAt;
DropboxAuth.prototype.getRefreshToken = () => mockAuthRefreshToken;
DropboxAuth.prototype.setAccessToken = (token: string) => { mockAuthAccessToken = token; };
DropboxAuth.prototype.setRefreshToken = (token: string) => { mockAuthRefreshToken = token; };
DropboxAuth.prototype.setAccessTokenExpiresAt = (date: any) => { mockAuthExpiresAt = date; };
DropboxAuth.prototype.getCodeVerifier = () => 'mock-code-verifier';
DropboxAuth.prototype.setCodeVerifier = () => {};
DropboxAuth.prototype.getAuthenticationUrl = async () => 'https://auth.dropbox.com/mock';
DropboxAuth.prototype.getAccessTokenFromCode = async () => ({
	status: 200,
	headers: {},
	result: {
		access_token: 'new-access-token',
		refresh_token: 'new-refresh-token',
		expires_in: 3600
	}
} as any);

// Mock Dropbox prototype request method
let lastUploadedPath = '';
let lastUploadedContents: any = null;
let lastDeletedPath = '';
let lastMovedFrom = '';
let lastMovedTo = '';

(Dropbox.prototype as any).request = async function (
	path: string,
	args: any,
	auth: any,
	host: any,
	style: any,
	scope: any,
	options: any
): Promise<any> {
	if (path === 'files/get_metadata') {
		if (args.path === '/auth-error') {
			const err: any = new Error('Unauthorized');
			err.status = 401;
			throw err;
		}
		if (args.path === '/not-found') {
			const err = new Error('Not found') as any;
			err.status = 409;
			err.error = { path: { '.tag': 'not_found' } };
			throw err;
		}
		return {
			status: 200,
			result: {
				'.tag': args.path.includes('dir') ? 'folder' : 'file',
				name: 'test-file.txt',
				path_display: args.path,
				size: 1024,
				server_modified: '2026-08-17T00:00:00Z',
				rev: 'mock-rev'
			}
		};
	}
	if (path === 'files/download') {
		return {
			status: 200,
			result: {
				fileBinary: new Uint8Array([72, 101, 108, 108, 111])
			}
		};
	}
	if (path === 'files/upload') {
		lastUploadedPath = args.path;
		lastUploadedContents = args.contents;
		return { status: 200, result: {} };
	}
	if (path === 'files/delete_v2') {
		lastDeletedPath = args.path;
		return { status: 200, result: {} };
	}
	if (path === 'files/move_v2') {
		lastMovedFrom = args.from_path;
		lastMovedTo = args.to_path;
		return { status: 200, result: {} };
	}
	if (path === 'files/list_folder') {
		return {
			status: 200,
			result: {
				entries: [
					{
						'.tag': 'file',
						name: 'file1.txt',
						path_display: '/file1.txt',
						size: 100,
						server_modified: '2026-08-17T00:00:00Z',
						rev: 'rev1'
					}
				],
				has_more: false,
				cursor: 'cursor1'
			}
		};
	}
	throw new Error(`Unhandled mock request: ${path}`);
};

test('DropboxStorage isConfigured returns true when access token is set and valid', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const configured = await storage.isConfigured();
	assert.strictEqual(configured, true);
});

test('DropboxStorage getAuthUrl stores code verifier in sessionStorage', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const url = await storage.getAuthUrl('https://redirect.uri', 'state-123');
	assert.strictEqual(url, 'https://auth.dropbox.com/mock');
	assert.strictEqual(mockStorage['dropbox_code_verifier'], 'mock-code-verifier');
});

test('DropboxStorage exchangeCode retrieves verifier and exchanges code for credentials', async () => {
	mockStorage['dropbox_code_verifier'] = 'mock-code-verifier';
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const creds = await storage.exchangeCode('auth-code-123', 'https://redirect.uri');
	assert.strictEqual(creds.accessToken, 'new-access-token');
	assert.strictEqual(creds.refreshToken, 'new-refresh-token');
	assert.ok(creds.expiresAt && creds.expiresAt > Date.now());
	assert.strictEqual(mockStorage['dropbox_code_verifier'], undefined);
});

test('DropboxStorage stat returns file metadata or null when not found', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const metadata = await storage.stat('/test-file.txt');
	assert.ok(metadata);
	assert.strictEqual(metadata.name, 'test-file.txt');
	assert.strictEqual(metadata.type, 'file');
	assert.strictEqual(metadata.size, 1024);
	assert.strictEqual(metadata.etag, 'mock-rev');

	const nullMetadata = await storage.stat('/not-found');
	assert.strictEqual(nullMetadata, null);
});

test('DropboxStorage readFile retrieves and parses file content', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const op = storage.readFile('/test-file.txt');
	const data = await op.finished;
	assert.deepStrictEqual(data, new Uint8Array([72, 101, 108, 108, 111]));
});

test('DropboxStorage writeFile uploads contents directly on standard mode', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const content = new Uint8Array([65, 66, 67]);
	const op = storage.writeFile('/test-file.txt', content);
	await op.finished;
	assert.strictEqual(lastUploadedPath, '/test-file.txt');
	assert.deepStrictEqual(lastUploadedContents, content);
});

test('DropboxStorage writeFile uses write-then-rename on atomic mode', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const content = new Uint8Array([1, 2, 3]);
	const op = storage.writeFile('/test-file.txt', content, { atomic: true });
	await op.finished;
	// Upload should target temp file
	assert.strictEqual(lastUploadedPath, '/test-file.txt.tmp');
	assert.deepStrictEqual(lastUploadedContents, content);
	// Should delete the original file
	assert.strictEqual(lastDeletedPath, '/test-file.txt');
	// Should rename the temp file to the final destination
	assert.strictEqual(lastMovedFrom, '/test-file.txt.tmp');
	assert.strictEqual(lastMovedTo, '/test-file.txt');
});

test('DropboxStorage listDirectory retrieves list of items', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	const items = await storage.listDirectory('/');
	assert.strictEqual(items.length, 1);
	assert.strictEqual(items[0].name, 'file1.txt');
	assert.strictEqual(items[0].type, 'file');
	assert.strictEqual(items[0].size, 100);
});

test('DropboxStorage getConfigHash and native auth EventTarget events', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	assert.strictEqual(storage.getConfigHash(), 'dropbox:mock-client');

	let reauthFired = false;
	const handler = (e: Event) => {
		reauthFired = true;
		assert.strictEqual((e as CustomEvent).detail.reason, 'unauthorised');
	};
	storage.addEventListener('reauthrequired', handler);

	try {
		await storage.stat('/auth-error');
	} catch {
		// ignored
	}

	assert.strictEqual(reauthFired, true);
	storage.removeEventListener('reauthrequired', handler);
});

test('DropboxStorage setCredentials dispatches tokenrenewed event', async () => {
	const storage = new DropboxStorage({ clientId: 'mock-client' });
	let renewedDetail: any = null;
	const handler = (e: Event) => {
		renewedDetail = (e as CustomEvent).detail;
	};
	storage.addEventListener('tokenrenewed', handler);

	storage.setCredentials({ accessToken: 'new-token', refreshToken: 'new-refresh' });
	assert.ok(renewedDetail);
	assert.strictEqual(renewedDetail.accessToken, 'new-token');
	assert.strictEqual(renewedDetail.refreshToken, 'new-refresh');

	storage.removeEventListener('tokenrenewed', handler);
});


