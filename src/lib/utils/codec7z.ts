import type { JS7zInstance } from '../vendor/js7z/js7z.cjs.d.ts';

export interface SevenZipEntry {
	path: string;
	data: Uint8Array;
}

export interface SevenZipOptions {
	/**
	 * In-archive filename 7-Zip uses to infer the archive format, e.g. 'archive.zip' for a real
	 * ZIP instead of 7z — the vendored build is 7-Zip's full "Alone2" variant, which picks the
	 * format purely from this extension. Default: 'archive.7z'.
	 */
	filename?: string;
	/** Raw extra CLI arguments appended after the wrapper's own path/password/format args. */
	extraArgs?: string[];
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
	private filename: string;
	private extraArgs: string[];
	private entries: SevenZipEntry[] = [];

	/**
	 * WritableStream interface to pipe SevenZipEntry objects directly.
	 */
	public readonly writable: WritableStream<SevenZipEntry>;

	constructor(password?: string, options?: SevenZipOptions) {
		this.password = password;
		this.filename = options?.filename ?? 'archive.7z';
		this.extraArgs = options?.extraArgs ?? [];
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
	 * Runs a single `7z a` (add/update) invocation against a fresh WASM instance, optionally
	 * seeding it with a previously-produced archive so the new entries are appended to it, and
	 * returns the resulting archive bytes.
	 */
	private async runAdd(entries: SevenZipEntry[], existingArchive?: Uint8Array): Promise<Uint8Array> {
		const js7z = await createJS7z();
		const archivePath = `/out/${this.filename}`;

		js7z.FS.mkdir('/in');
		js7z.FS.mkdir('/out');
		if (existingArchive) {
			js7z.FS.writeFile(archivePath, existingArchive);
		}

		for (const entry of entries) {
			const parts = entry.path.split('/');
			if (parts.length > 1) {
				const parentDir = parts.slice(0, -1).join('/');
				js7z.FS.createPath('/in', parentDir, true, true);
			}
			js7z.FS.writeFile(`/in/${entry.path}`, entry.data);
		}

		const args = ['a', archivePath, '/in/*'];
		if (this.password) {
			args.push(`-p${this.password}`);
			// Header encryption is a 7z-specific switch; forcing it onto e.g. a .zip target
			// would either be rejected or silently misapplied, so it only applies to .7z.
			if (this.filename.toLowerCase().endsWith('.7z')) {
				args.push('-mhe=on');
			}
		}
		args.push(...this.extraArgs);

		return new Promise((resolve, reject) => {
			js7z.onExit = function (exitCode: number) {
				if (exitCode !== 0) {
					reject(new Error(`7-Zip compression exited with code ${exitCode}`));
					return;
				}
				try {
					resolve(js7z.FS.readFile(archivePath));
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

	/**
	 * Finalizes compression and returns the final archive bytes.
	 *
	 * 7-Zip's `callMain` runs fully synchronously, so a single call for a large entry set would
	 * block the main thread for the whole compression with no chance to repaint a progress
	 * update in between. Instead, entries are added in small batches — each batch re-opens the
	 * archive produced by the previous one and appends to it — with an `await` between batches
	 * so the caller (and the browser) gets a turn before the next batch's blocking call starts.
	 * `onProgress` reports the fraction of entries compressed so far (0-100).
	 */
	async finalize(onProgress?: (percent: number) => void): Promise<Uint8Array> {
		const BATCH_SIZE = 25;
		let archiveBytes: Uint8Array | undefined;

		for (let start = 0; start < this.entries.length; start += BATCH_SIZE) {
			const batch = this.entries.slice(start, start + BATCH_SIZE);
			archiveBytes = await this.runAdd(batch, archiveBytes);

			const compressed = Math.min(start + batch.length, this.entries.length);
			onProgress?.(Math.round((compressed / this.entries.length) * 100));

			// Yield to the event loop so the browser can paint the progress update before the
			// next batch's synchronous compression call blocks the main thread again.
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		}

		return archiveBytes ?? this.runAdd([]);
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
	private filename: string;
	private extraArgs: string[];
	private chunks: Uint8Array[] = [];

	/**
	 * WritableStream interface to pipe raw downloaded archive chunks directly.
	 */
	public readonly writable: WritableStream<Uint8Array>;

	constructor(password?: string, options?: SevenZipOptions) {
		this.password = password;
		this.filename = options?.filename ?? 'archive.7z';
		this.extraArgs = options?.extraArgs ?? [];
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
		const archivePath = `/in/${this.filename}`;

		// Prepare directories
		js7z.FS.mkdir('/in');
		js7z.FS.mkdir('/out');
		js7z.FS.writeFile(archivePath, archiveBytes);

		const args = ['x', archivePath, '-o/out'];
		if (this.password) {
			args.push(`-p${this.password}`);
		}
		args.push(...this.extraArgs);

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
