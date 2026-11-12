#!/usr/bin/env node
// Fetches the single-threaded js7z WASM build (see src/lib/utils/codec7z.ts) from its upstream
// GitHub release and writes it into wasm/single/ as `js7z.mjs` + `js7z.wasm`.
//
// The multi-threaded build is not fetched here: it is the `js7z-tools` npm dependency, which is
// byte-identical to the release's `js7z-mt-fs-ec-es6module`. Only the single-threaded build has no
// npm package (and no ES module release), which is why it is fetched and wrapped here.
// `scripts/publish-wasm.mjs` copies both builds into a consumer's public folder.
//
// This runs during `npm install` (via `prepare`) on machines we don't control — CI, Docker
// images, and consumers installing straight from git — so it deliberately uses nothing but
// Node builtins. No `zx`, no `curl`, no `unzip`: a missing system binary or an unhoisted
// dependency here breaks the consumer's install, which is exactly what used to happen.
//
// Safe to re-run; skips the download entirely if the outputs already exist (`--force` refetches).
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const JS7Z_VERSION = '2.5.0';
// Single-threaded + extended filesystem + exception catching — no SharedArrayBuffer/worker
// requirement, so no COOP/COEP headers are needed to run it.
const JS7Z_VARIANT = 'js7z-st-fs-ec';
const JS7Z_RELEASE_URL = `https://github.com/GMH-Code/JS7z/releases/download/v${JS7Z_VERSION}/${JS7Z_VARIANT}.zip`;
// Pinned so a corrupted, truncated or substituted download fails loudly here rather than
// silently producing a broken build. Update alongside JS7Z_VERSION.
const JS7Z_RELEASE_SHA256 = 'c80dac23a605c6571d5716b9d9b702e800f77df2c83d1e5c50e21a4899c3f413';

const OUTPUT_DIR = path.resolve(import.meta.dirname, '../wasm/single');
const OUTPUT_FILE_NAMES = ['js7z.mjs', 'js7z.wasm'];

// --- Minimal ZIP reader -----------------------------------------------------------------

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;

/**
 * The End Of Central Directory record sits at the tail of the archive behind a
 * variable-length comment, so it can only be located by scanning backwards for its signature.
 */
function findEndOfCentralDirectory(view, byteLength) {
	for (let offset = byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= 0; offset--) {
		if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
	}
	throw new Error(
		'Downloaded file is not a ZIP archive: no End Of Central Directory record found.'
	);
}

/** Reads and decompresses one entry, given the offset of its central directory header. */
function readZipEntryData(zipBytes, view, centralHeaderOffset) {
	const compressionMethod = view.getUint16(centralHeaderOffset + 10, true);
	const compressedSize = view.getUint32(centralHeaderOffset + 20, true);
	const localHeaderOffset = view.getUint32(centralHeaderOffset + 42, true);

	// The local header repeats the name and extra-field lengths, and they are allowed to differ
	// from the central directory's, so the data offset must come from the local header itself.
	const dataOffset =
		localHeaderOffset +
		LOCAL_FILE_HEADER_SIZE +
		view.getUint16(localHeaderOffset + 26, true) +
		view.getUint16(localHeaderOffset + 28, true);
	const data = zipBytes.subarray(dataOffset, dataOffset + compressedSize);

	if (compressionMethod === 0) return data;
	if (compressionMethod === 8) return new Uint8Array(inflateRawSync(data));
	throw new Error(
		`Unsupported ZIP compression method ${compressionMethod} — expected stored (0) or deflate (8).`
	);
}

// --- UMD -> ESM ---------------------------------------------------------------------------

// The upstream build ends in a UMD export tail: `if(typeof exports==="object"&&...){module.exports
// =JS7z;...}else if(typeof define==="function"&&...)`. Left in place it is inert under ESM —
// `typeof` on an undeclared identifier does not throw — but bundlers still see a bare `module`
// reference and warn (rolldown's COMMONJS_VARIABLE_IN_ESM) in every consumer's build, so it is
// trimmed off. Recognising the tail is best-effort: if upstream ever reformats, the tail is left
// alone rather than failing the install, since it does no harm beyond that warning.
const UMD_EXPORT_TAIL_START = 'if(typeof exports===';
const UMD_EXPORT_TAIL_MAX_LENGTH = 500;

function toEsm(source) {
	const tailStart = source.lastIndexOf(UMD_EXPORT_TAIL_START);
	// The length guard is what makes this safe: it confirms the match really is the trailing
	// export block and not a similar-looking expression somewhere inside the runtime.
	const isExportTail = tailStart !== -1 && source.length - tailStart <= UMD_EXPORT_TAIL_MAX_LENGTH;

	if (!isExportTail) {
		console.warn(
			'[setup-js7z] Could not recognise the UMD export tail — leaving it in place. It is inert ' +
				'under ESM, but consumers may see a COMMONJS_VARIABLE_IN_ESM bundler warning.'
		);
		return `${source}\nexport default JS7z;\n`;
	}
	return `${source.slice(0, tailStart)}\nexport default JS7z;\n`;
}

/** Extracts the named entries from an in-memory ZIP archive. */
function readZipEntries(zipBytes, wantedNames) {
	const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	const decoder = new TextDecoder();
	const eocdOffset = findEndOfCentralDirectory(view, zipBytes.byteLength);

	const entries = new Map();
	let offset = view.getUint32(eocdOffset + 16, true);

	for (let remaining = view.getUint16(eocdOffset + 10, true); remaining > 0; remaining--) {
		const nameLength = view.getUint16(offset + 28, true);
		const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
		const name = decoder.decode(zipBytes.subarray(nameStart, nameStart + nameLength));

		if (wantedNames.includes(name)) entries.set(name, readZipEntryData(zipBytes, view, offset));

		offset =
			nameStart +
			nameLength +
			view.getUint16(offset + 30, true) +
			view.getUint16(offset + 32, true);
	}

	const missing = wantedNames.filter((name) => !entries.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Release archive is missing expected ${missing.join(', ')} — the upstream release layout may have changed.`
		);
	}
	return entries;
}

// --- Fetch and vendor -------------------------------------------------------------------

const outputPaths = OUTPUT_FILE_NAMES.map((name) => path.join(OUTPUT_DIR, name));
const alreadySetUp =
	!process.argv.includes('--force') &&
	(
		await Promise.all(
			outputPaths.map((file) =>
				access(file).then(
					() => true,
					() => false
				)
			)
		)
	).every(Boolean);

if (alreadySetUp) {
	console.log(
		`[setup-js7z] Already set up at ${path.relative(process.cwd(), OUTPUT_DIR)} (use --force to refetch)`
	);
	process.exit(0);
}

console.log(`[setup-js7z] Fetching ${JS7Z_RELEASE_URL}...`);
const response = await fetch(JS7Z_RELEASE_URL);
if (!response.ok) {
	throw new Error(
		`Failed to download js7z release: HTTP ${response.status} ${response.statusText}`
	);
}
const zipBytes = new Uint8Array(await response.arrayBuffer());

const digest = createHash('sha256').update(zipBytes).digest('hex');
if (digest !== JS7Z_RELEASE_SHA256) {
	throw new Error(
		`Checksum mismatch for ${JS7Z_VARIANT}.zip.\n  expected ${JS7Z_RELEASE_SHA256}\n  actual   ${digest}\n` +
			`Refusing to vendor an unexpected build. If the upstream release was legitimately re-cut, ` +
			`update JS7Z_RELEASE_SHA256 in this script.`
	);
}

console.log('[setup-js7z] Extracting...');
const entries = readZipEntries(zipBytes, ['js7z.js', 'js7z.wasm']);
const umdSource = new TextDecoder().decode(entries.get('js7z.js'));

// The browser loads the glue with `import()` (see codec7z.ts), so it must be a real ES module;
// the release only ships UMD for the single-threaded build.
const esmSource =
	`// Generated by scripts/setup-js7z.mjs — do not edit.\n` +
	`// js7z ${JS7Z_VERSION} (${JS7Z_VARIANT}) glue, converted to ESM.\n${toEsm(umdSource)}`;

await mkdir(OUTPUT_DIR, { recursive: true });
await Promise.all([
	writeFile(path.join(OUTPUT_DIR, 'js7z.mjs'), esmSource),
	writeFile(path.join(OUTPUT_DIR, 'js7z.wasm'), entries.get('js7z.wasm'))
]);

console.log(
	`[setup-js7z] Wrote ${OUTPUT_FILE_NAMES.join(', ')} to ${path.relative(process.cwd(), OUTPUT_DIR)}`
);
