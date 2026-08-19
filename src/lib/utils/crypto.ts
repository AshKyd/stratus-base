/**
 * Generates a cryptographically secure random password of the specified length.
 * @param length The length of the password to generate (default: 64, max recommended: 64 for ZIP compatibility)
 */
export function generateSecurePassword(length = 64): string {
	// ASCII character 33 ('!') is the first printable non-whitespace character.
	const MIN_PRINTABLE_ASCII = 33;
	// ASCII character 126 ('~') is the last printable character.
	// The range size from 33 to 126 inclusive is 94.
	const PRINTABLE_ASCII_RANGE = 94;

	const values = new Uint32Array(length);
	globalThis.crypto.getRandomValues(values);
	return Array.from(values)
		.map((val) => String.fromCharCode(MIN_PRINTABLE_ASCII + (val % PRINTABLE_ASCII_RANGE)))
		.join('');
}
