import { normalize } from 'pathe';

/**
 * Canonical form for a path in the StratusBase virtual namespace: always leading-slash, never
 * trailing-slash, `.`/`..` segments resolved.
 *
 * Every metadata key, chunk entry name and public path goes through here so a file can only ever be
 * keyed one way. The dual `Notes/x.md` / `/Notes/x.md` forms that used to coexist meant local files
 * silently failed to match their remote chunk entries.
 *
 * Note this is the opposite convention to the `cleanPath` helpers inside the storage backends, which
 * strip the leading slash because that is the provider key form.
 */
export function normalisePath(path: string): string {
	const clean = normalize(path ?? '');
	// pathe returns '.' for an empty input, which would otherwise canonicalise to a bogus '/.'
	if (!clean || clean === '.' || clean === '/') return '/';
	return clean.startsWith('/') ? clean : '/' + clean;
}

const CONFLICT_SUFFIX = '_updates';

/**
 * Returns true if the path points to an ephemeral conflict sidecar file (e.g. `/Notes/123_updates.md`).
 */
export function isConflictSidecar(path: string): boolean {
	const lastSlash = path.lastIndexOf('/');
	const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
	const lastDot = filename.lastIndexOf('.');
	const stem = lastDot === -1 ? filename : filename.slice(0, lastDot);
	return stem.endsWith(CONFLICT_SUFFIX);
}
