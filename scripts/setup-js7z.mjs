#!/usr/bin/env node
// Fetches the vendored js7z WASM build (see src/lib/utils/codec7z.ts) from its upstream
// GitHub release. The build artifacts (js7z.cjs, js7z.mjs, js7z.wasm) are gitignored —
// this script is what reproduces them locally. Runs automatically before dev/build/test
// (see package.json); safe to re-run, and skips work if the files already exist.
import { $, fs, path, tempdir } from 'zx';

const JS7Z_VERSION = '2.5.0';
// Single-threaded + extended filesystem + exception catching — no SharedArrayBuffer/worker
// requirement, so no COOP/COEP headers are needed wherever the app is deployed.
const JS7Z_VARIANT = 'js7z-st-fs-ec';
const JS7Z_RELEASE_URL = `https://github.com/GMH-Code/JS7z/releases/download/v${JS7Z_VERSION}/${JS7Z_VARIANT}.zip`;

const VENDOR_DIR = path.resolve(import.meta.dirname, '../src/lib/vendor/js7z');
const OUTPUT_FILES = ['js7z.cjs', 'js7z.mjs', 'js7z.wasm'].map((name) => path.join(VENDOR_DIR, name));

// The Emscripten UMD build ends with a `module.exports=...` / AMD `define(...)` tail.
// Truncating right after the IIFE close and appending `export default JS7z;` turns it into
// plain ESM — needed so Vite's dev server doesn't have to interop a local relative-path CJS
// file, which it does incorrectly for this build's `module.exports.default = JS7z` shape.
const UMD_IIFE_CLOSE_MARKER = ';return moduleRtn}})();';

function toEsm(cjsSource) {
	const markerIndex = cjsSource.lastIndexOf(UMD_IIFE_CLOSE_MARKER);
	if (markerIndex === -1) {
		throw new Error(
			`Could not find the UMD IIFE close marker in the downloaded js7z build — the upstream build ` +
				`format may have changed. Expected to find: ${UMD_IIFE_CLOSE_MARKER}`
		);
	}
	return `${cjsSource.slice(0, markerIndex + UMD_IIFE_CLOSE_MARKER.length)}\nexport default JS7z;\n`;
}

const alreadySetUp =
	!process.argv.includes('--force') && (await Promise.all(OUTPUT_FILES.map((file) => fs.pathExists(file)))).every(Boolean);

if (alreadySetUp) {
	console.log(`[setup-js7z] Already set up at ${path.relative(process.cwd(), VENDOR_DIR)} (use --force to refetch)`);
	process.exit(0);
}

const workDir = await tempdir('js7z');
const zipPath = path.join(workDir, `${JS7Z_VARIANT}.zip`);

console.log(`[setup-js7z] Fetching ${JS7Z_RELEASE_URL}...`);
await $`curl -sL --fail -o ${zipPath} ${JS7Z_RELEASE_URL}`;

console.log('[setup-js7z] Extracting...');
await $`unzip -oq ${zipPath} js7z.js js7z.wasm -d ${workDir}`;

const cjsSource = await fs.readFile(path.join(workDir, 'js7z.js'), 'utf8');
const mjsSource = toEsm(cjsSource);

await fs.ensureDir(VENDOR_DIR);
await Promise.all([
	fs.writeFile(path.join(VENDOR_DIR, 'js7z.cjs'), cjsSource),
	fs.writeFile(path.join(VENDOR_DIR, 'js7z.mjs'), mjsSource),
	fs.copyFile(path.join(workDir, 'js7z.wasm'), path.join(VENDOR_DIR, 'js7z.wasm'))
]);
await fs.remove(workDir);

console.log(`[setup-js7z] Wrote js7z.cjs, js7z.mjs, js7z.wasm to ${path.relative(process.cwd(), VENDOR_DIR)}`);
