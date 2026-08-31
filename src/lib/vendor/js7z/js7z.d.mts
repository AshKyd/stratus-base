// Type sidecar for the generated `js7z.mjs` — the `.d.mts` counterpart of js7z.d.cts.
// The shared interfaces live in js7z.cjs.d.ts.
import type { JS7zInstance } from './js7z.cjs.d.ts';

declare function JS7z(moduleArg?: Record<string, unknown>): Promise<JS7zInstance>;

export default JS7z;
