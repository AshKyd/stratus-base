import test from 'node:test';
import assert from 'node:assert';
import { generateSecurePassword } from './crypto.ts';

test('generateSecurePassword utility', async (t) => {
	await t.test('generates password of requested length', () => {
		const pass1 = generateSecurePassword(32);
		assert.strictEqual(pass1.length, 32);

		const pass2 = generateSecurePassword(64);
		assert.strictEqual(pass2.length, 64);

		const pass3 = generateSecurePassword();
		assert.strictEqual(pass3.length, 64);
	});

	await t.test('generates unique passwords', () => {
		const pass1 = generateSecurePassword(64);
		const pass2 = generateSecurePassword(64);
		assert.notStrictEqual(pass1, pass2);
	});

	await t.test('only contains characters from expected charset', () => {
		const MIN_PRINTABLE_ASCII = 33;
		const MAX_PRINTABLE_ASCII = 126;
		const pass = generateSecurePassword(100);
		for (const char of pass) {
			const code = char.charCodeAt(0);
			assert.ok(
				code >= MIN_PRINTABLE_ASCII && code <= MAX_PRINTABLE_ASCII,
				`Character ${char} (code ${code}) is outside printable ASCII range`
			);
		}
	});
});
