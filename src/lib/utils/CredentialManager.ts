import type { StorageAuthCredentials } from '../types.ts';

export const STRATUS_CREDENTIALS_KEY = 'stratus_credentials';

export interface StoredSession {
	configHash: string;
	credentials: StorageAuthCredentials;
}

/**
 * Loads credentials from localStorage for the given configuration hash.
 * If credentials exist under a different configuration hash, they are cleared.
 *
 * @param configHash The configuration hash identifying the backend session.
 * @returns The stored credentials if matching, or null.
 */
export function loadCredentials(configHash: string): StorageAuthCredentials | null {
	if (typeof window === 'undefined' || !window.localStorage) {
		return null;
	}

	const raw = window.localStorage.getItem(STRATUS_CREDENTIALS_KEY);
	if (!raw) {
		return null;
	}

	try {
		const session: StoredSession = JSON.parse(raw);
		if (session && session.configHash === configHash && session.credentials) {
			return session.credentials;
		}
		// Config mismatch: discard obsolete credentials
		window.localStorage.removeItem(STRATUS_CREDENTIALS_KEY);
	} catch {
		window.localStorage.removeItem(STRATUS_CREDENTIALS_KEY);
	}

	return null;
}

/**
 * Persists session credentials to localStorage with the given configuration hash.
 *
 * @param configHash The configuration hash identifying the backend session.
 * @param credentials The credentials to persist.
 */
export function saveCredentials(
	configHash: string,
	credentials: StorageAuthCredentials
): void {
	if (typeof window === 'undefined' || !window.localStorage) {
		return;
	}

	const session: StoredSession = {
		configHash,
		credentials
	};

	window.localStorage.setItem(STRATUS_CREDENTIALS_KEY, JSON.stringify(session));
}

/**
 * Clears stored credentials from localStorage.
 */
export function clearCredentials(): void {
	if (typeof window === 'undefined' || !window.localStorage) {
		return;
	}

	window.localStorage.removeItem(STRATUS_CREDENTIALS_KEY);
}
