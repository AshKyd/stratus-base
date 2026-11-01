type StorageKind = 'localStorage' | 'sessionStorage';

/** The `Storage` methods used here; every one is safe to call anywhere. */
export type SafeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The usable `window` storage, or `null` when there isn't one: workers and SSR have no `window`,
 * Node 25+ defines a method-less global `localStorage` unless `--localstorage-file` is set, and
 * merely reading the property can throw (blocked site data, sandboxed iframes).
 */
function resolveStorage(kind: StorageKind): Storage | null {
	try {
		if (typeof window === 'undefined') return null;
		const storage = window[kind];
		return typeof storage?.getItem === 'function' ? storage : null;
	} catch {
		return null;
	}
}

/**
 * Browser storage that never throws. Reads return `null` and writes do nothing when storage is
 * missing, blocked, or full (older Safari private mode throws on `setItem`). Storage is looked up
 * on every call, so it is safe to create at module level.
 */
export function createSafeStorage(kind: StorageKind): SafeStorage {
	return {
		getItem(key) {
			try {
				return resolveStorage(kind)?.getItem(key) ?? null;
			} catch {
				return null;
			}
		},
		setItem(key, value) {
			try {
				resolveStorage(kind)?.setItem(key, value);
			} catch {
				// Best-effort persistence.
			}
		},
		removeItem(key) {
			try {
				resolveStorage(kind)?.removeItem(key);
			} catch {
				// Best-effort persistence.
			}
		}
	};
}

export const safeLocalStorage = createSafeStorage('localStorage');
export const safeSessionStorage = createSafeStorage('sessionStorage');
