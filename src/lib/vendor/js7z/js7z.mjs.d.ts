// Vendored single-threaded build of JS7z (7-Zip 25.01, ST+FS+EC variant), converted to a
// genuine ES module (the UMD tail's `module.exports` assignment is swapped for a plain
// `export default`) so Vite's dev server can load it without CJS interop.
// Source: https://github.com/GMH-Code/JS7z — license in licenses/7-zip-LICENSE.txt.
export type { JS7zFS, JS7zInstance } from './js7z.cjs.d.ts';

import type { JS7zInstance } from './js7z.cjs.d.ts';

declare function JS7z(moduleArg?: Record<string, unknown>): Promise<JS7zInstance>;

export default JS7z;
