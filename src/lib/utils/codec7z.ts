import type { JS7zInstance } from '../vendor/js7z/js7z.cjs.d.ts';

export interface SevenZipEntry {
	path: string;
	data: Uint8Array;
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// Two copies of the same vendored build are kept: `js7z.cjs` (real CommonJS, so Node's
// native ESM/CJS interop loads it correctly) and `js7z.mjs` (real ESM, so Vite's dev server
// doesn't have to interop a local relative-path CJS file — which it does incorrectly,
// throwing "doesn't provide an export named: 'default'"). Loaded lazily so neither module
// is evaluated in the environment it isn't meant for.
let js7zFactoryPromise:
	Promise<(moduleArg?: Record<string, unknown>) => Promise<JS7zInstance>> | undefined;

function loadJS7zFactory() {
	js7zFactoryPromise ??= isNode
		? // @vite-ignore — this branch never runs in a browser bundle (isNode is always
			// false there); skip static analysis so bundlers don't try to pull the
			// Node-only CJS build into the client build.
			import(/* @vite-ignore */ '../vendor/js7z/js7z.cjs').then((mod) => mod.default)
		: import('../vendor/js7z/js7z.mjs').then((mod) => mod.default);
	return js7zFactoryPromise;
}

// The wasm is vendored base64-encoded inside a plain ESM module rather than shipped as a .wasm
// asset. Emscripten takes the bytes directly via `wasmBinary`, so nothing downstream has to
// resolve an asset URL at runtime — no `?url` import, no `locateFile`, no `import.meta.url`.
// That keeps the published `dist/` free of bundler-specific syntax, so Vite, other bundlers and
// plain Node all load it identically. Imported lazily so the ~2MB payload stays in its own async
// chunk and is only fetched when an archive is actually read or written.
let js7zWasmBinaryPromise: Promise<Uint8Array> | undefined;

function loadJS7zWasmBinary() {
	js7zWasmBinaryPromise ??= import('../vendor/js7z/js7z-wasm.js').then(({ default: base64 }) =>
		// `atob` is a global in browsers and in Node 16+.
		Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
	);
	return js7zWasmBinaryPromise;
}

/** Size in bytes of the decoded js7z wasm binary, exposed for diagnostics/logging. */
export async function getJS7zWasmByteLength(): Promise<number> {
	return (await loadJS7zWasmBinary()).length;
}

/** Loads the js7z glue and its wasm binary together, and instantiates the module. */
async function createJS7z(): Promise<JS7zInstance> {
	const [JS7z, wasmBinary] = await Promise.all([loadJS7zFactory(), loadJS7zWasmBinary()]);
	return JS7z({ wasmBinary });
}

export class SevenZipWriter {
	private password?: string;
	private entries: SevenZipEntry[] = [];

	/**
	 * WritableStream interface to pipe SevenZipEntry objects directly.
	 */
	public readonly writable: WritableStream<SevenZipEntry>;

	constructor(password?: string) {
		this.password = password;
		this.writable = new WritableStream({
			write: async (entry) => {
				await this.write(entry);
			}
		});
	}

	/**
	 * Streams a single file entry into the buffer.
	 */
	async write(entry: SevenZipEntry): Promise<void> {
		this.entries.push(entry);
	}

	/**
	 * Finalizes compression, executes 7-Zip in MEMFS, and returns the final archive bytes.
	 */
	async finalize(): Promise<Uint8Array> {
		const js7z = await createJS7z();

		// Prepare workspace directories in virtual MEMFS
		js7z.FS.mkdir('/in');
		js7z.FS.mkdir('/out');

		// Write all accumulated entries to the virtual FS
		for (const entry of this.entries) {
			const parts = entry.path.split('/');
			if (parts.length > 1) {
				const parentDir = parts.slice(0, -1).join('/');
				js7z.FS.createPath('/in', parentDir, true, true);
			}
			js7z.FS.writeFile(`/in/${entry.path}`, entry.data);
		}

		const args = ['a', '/out/archive.7z', '/in/*'];
		if (this.password) {
			args.push(`-p${this.password}`, '-mhe=on');
		}

		return new Promise((resolve, reject) => {
			js7z.onExit = function (exitCode: number) {
				if (exitCode !== 0) {
					reject(new Error(`7-Zip compression exited with code ${exitCode}`));
					return;
				}
				try {
					const archiveBytes = js7z.FS.readFile('/out/archive.7z');
					resolve(archiveBytes);
				} catch (err) {
					reject(err);
				}
			};

			js7z.onAbort = function (reason?: string) {
				reject(new Error(`7-Zip WASM aborted: ${reason ?? 'unknown'}`));
			};

			js7z.callMain(args);
		});
	}
}

/**
 * Progressive reader to stream archive bytes in and extract files one by one.
 *
 * @example
 * const reader = new SevenZipReader('my-secure-password');
 *
 * // 1. Fetch the remote archive stream
 * const response = await fetch('https://example.com/archive.7z');
 * if (!response.body) throw new Error('Response body is null');
 *
 * // 2. Pipe the download response body into the reader's writable stream
 * await response.body.pipeTo(reader.writable);
 *
 * // 3. Extract files progressively as an async generator
 * for await (const entry of reader.extract()) {
 *   const fileHandle = await opfsRootDirectory.getFileHandle(entry.path, { create: true });
 *   const writable = await fileHandle.createWritable();
 *   await writable.write(entry.data);
 *   await writable.close();
 * }
 */
export class SevenZipReader {
	private password?: string;
	private chunks: Uint8Array[] = [];

	/**
	 * WritableStream interface to pipe raw downloaded archive chunks directly.
	 */
	public readonly writable: WritableStream<Uint8Array>;

	constructor(password?: string) {
		this.password = password;
		this.writable = new WritableStream({
			write: async (chunk) => {
				await this.appendChunk(chunk);
			}
		});
	}

	/**
	 * Streams a chunk of the downloaded archive bytes into the local buffer.
	 */
	async appendChunk(chunk: Uint8Array): Promise<void> {
		this.chunks.push(chunk);
	}

	/**
	 * Runs extraction and yields file entries one by one.
	 */
	async *extract(): AsyncGenerator<SevenZipEntry, void, unknown> {
		// Concatenate all accumulated chunks into a single archive buffer
		let totalLength = 0;
		for (const chunk of this.chunks) {
			totalLength += chunk.length;
		}
		const archiveBytes = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of this.chunks) {
			archiveBytes.set(chunk, offset);
			offset += chunk.length;
		}

		const js7z = await createJS7z();

		// Prepare directories
		js7z.FS.mkdir('/in');
		js7z.FS.mkdir('/out');
		js7z.FS.writeFile('/in/archive.7z', archiveBytes);

		const args = ['x', '/in/archive.7z', '-o/out'];
		if (this.password) {
			args.push(`-p${this.password}`);
		}

		const exitCode: number = await new Promise<number>((resolve, reject) => {
			js7z.onExit = function (code: number) {
				resolve(code);
			};
			js7z.onAbort = function (reason?: string) {
				reject(new Error(`7-Zip WASM aborted during extract: ${reason ?? 'unknown'}`));
			};
			js7z.callMain(args);
		});

		if (exitCode !== 0) {
			throw new Error(`7-Zip extraction exited with code ${exitCode}`);
		}

		// Traverse output directory recursively and yield files
		const fs = js7z.FS;
		const yieldFiles = function* (dir: string): Generator<string> {
			const entries = fs.readdir(dir);
			for (const entry of entries) {
				if (entry === '.' || entry === '..') continue;
				const fullPath = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
				const stat = fs.stat(fullPath);
				if (fs.isDir(stat.mode)) {
					yield* yieldFiles(fullPath);
				} else {
					yield fullPath;
				}
			}
		};

		const paths = Array.from(yieldFiles('/out'));
		for (const fullPath of paths) {
			const data = fs.readFile(fullPath);
			// Reconstruct path relative to '/out/'
			const relativePath = fullPath.substring('/out/'.length);
			yield {
				path: relativePath,
				data
			};
			// Clean up to free virtual memory immediately
			fs.unlink(fullPath);
		}
	}
}
