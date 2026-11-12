#!/usr/bin/env node
// Copies the js7z wasm builds into a consumer's public folder, for `configureWasm({ baseUrl })`.
//
//   node node_modules/stratus-base/scripts/publish-wasm.mjs static/wasm
//
// Writes `<folder>/single/{js7z.mjs,js7z.wasm}` and `<folder>/multi/{js7z.mjs,js7z.wasm}`.
// Unchanged files are not rewritten, so it is cheap to run before every dev/build.
// Uses only Node builtins, like setup-js7z.mjs.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const [targetArgument] = process.argv.slice(2);
if (!targetArgument) {
	console.error('Usage: publish-wasm.mjs <public-folder>   e.g. static/wasm');
	process.exit(1);
}
const targetRoot = path.resolve(process.cwd(), targetArgument);

const singleSourceDir = path.resolve(import.meta.dirname, '../wasm/single');
// `js7z-tools` is stratus-base's dependency, so resolve it from here, not from the consumer.
const multiSourceDir = path.dirname(
	createRequire(import.meta.url).resolve('js7z-tools/package.json')
);

const copies = [
	{ sourceDir: singleSourceDir, targetDir: path.join(targetRoot, 'single') },
	{ sourceDir: multiSourceDir, targetDir: path.join(targetRoot, 'multi') }
].flatMap(({ sourceDir, targetDir }) =>
	['js7z.mjs', 'js7z.wasm'].map((name) => ({
		source: path.join(sourceDir, name),
		target: path.join(targetDir, name)
	}))
);

const isSameFile = async (source, target) =>
	Buffer.compare(await readFile(source), await readFile(target).catch(() => Buffer.alloc(0))) === 0;

await Promise.all(
	copies.map(async ({ source, target }) => {
		await mkdir(path.dirname(target), { recursive: true });
		if (await isSameFile(source, target)) return;
		await copyFile(source, target);
	})
);

console.log(`[publish-wasm] ${copies.length} files in ${path.relative(process.cwd(), targetRoot)}`);
