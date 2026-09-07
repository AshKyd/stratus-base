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

/**
 * `crypto.getRandomValues` rejects any single request larger than this, so bigger buffers are
 * filled one slice at a time.
 */
export const MAX_RANDOM_BYTES_PER_CALL = 65536;

/**
 * Fills a buffer of `byteLength` bytes with cryptographically secure random data, issuing as
 * many `getRandomValues` calls as needed to stay under its per-call size cap.
 */
export function generateSecureRandomBytes(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength);
	for (let offset = 0; offset < byteLength; offset += MAX_RANDOM_BYTES_PER_CALL) {
		globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + MAX_RANDOM_BYTES_PER_CALL));
	}
	return bytes;
}

/**
 * Returns a cryptographically secure random integer in the inclusive range
 * [minInclusive, maxInclusive]. Uses rejection sampling to discard the tail of the 32-bit space
 * that doesn't divide evenly by the range, so every value is equally likely (no modulo bias).
 */
export function secureRandomInt(minInclusive: number, maxInclusive: number): number {
	const range = maxInclusive - minInclusive + 1;
	if (range <= 0) throw new RangeError('maxInclusive must be greater than or equal to minInclusive');

	// Largest multiple of `range` that still fits in 32 bits; any draw at or above it is rejected.
	const rejectionLimit = Math.floor(0x1_0000_0000 / range) * range;
	const buffer = new Uint32Array(1);
	let value = rejectionLimit;
	while (value >= rejectionLimit) {
		globalThis.crypto.getRandomValues(buffer);
		[value] = buffer;
	}
	return minInclusive + (value % range);
}
