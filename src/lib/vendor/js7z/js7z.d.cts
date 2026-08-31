// Type sidecar for the generated `js7z.cjs`. TypeScript resolves types for a `.cjs` module from
// a `.d.cts` of the same name, so without this it infers them from 100KB of minified Emscripten
// output and lands on `Promise<{}>`. The shared interfaces live in js7z.cjs.d.ts.
import type { JS7zInstance } from './js7z.cjs.d.ts';

declare function JS7z(moduleArg?: Record<string, unknown>): Promise<JS7zInstance>;

// `export =`, not `export default`: the UMD build assigns the factory to `module.exports`
// itself, so this is what makes `(await import(...)).default` the function under ESM interop.
export = JS7z;
