import test from 'node:test';
import assert from 'node:assert';
import {
	STRATUS_CREDENTIALS_KEY,
	loadCredentials,
	saveCredentials,
	clearCredentials
} from './CredentialManager.ts';

// Mock localStorage for Node test environment
function createMockLocalStorage() {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, String(value)),
		removeItem: (key: string) => store.delete(key),
		clear: () => store.clear()
	};
}

test('CredentialManager: saveCredentials, loadCredentials, and clearCredentials', () => {
	const mockStorage = createMockLocalStorage();
	(globalThis as any).window = { localStorage: mockStorage };

	// 1. Initially empty
	assert.strictEqual(loadCredentials('dropbox:app-123'), null);

	// 2. Save credentials
	const creds = { accessToken: 'token-abc', refreshToken: 'refresh-xyz', expiresAt: 123456789 };
	saveCredentials('dropbox:app-123', creds);

	// Verify in localStorage
	const raw = mockStorage.getItem(STRATUS_CREDENTIALS_KEY);
	assert.ok(raw);
	const parsed = JSON.parse(raw!);
	assert.strictEqual(parsed.configHash, 'dropbox:app-123');
	assert.strictEqual(parsed.credentials.accessToken, 'token-abc');

	// 3. Load with matching hash
	const loaded = loadCredentials('dropbox:app-123');
	assert.deepStrictEqual(loaded, creds);

	// 4. Load with different hash (should clear and return null)
	const mismatch = loadCredentials('dropbox:different-app');
	assert.strictEqual(mismatch, null);
	assert.strictEqual(mockStorage.getItem(STRATUS_CREDENTIALS_KEY), null);

	// 5. Clear credentials
	saveCredentials('dropbox:app-123', creds);
	assert.ok(mockStorage.getItem(STRATUS_CREDENTIALS_KEY));
	clearCredentials();
	assert.strictEqual(mockStorage.getItem(STRATUS_CREDENTIALS_KEY), null);

	delete (globalThis as any).window;
});

test('CredentialManager: safe when window or localStorage is undefined', () => {
	delete (globalThis as any).window;
	assert.strictEqual(loadCredentials('test:123'), null);
	assert.doesNotThrow(() => saveCredentials('test:123', { accessToken: 'abc' }));
	assert.doesNotThrow(() => clearCredentials());
});
