import type { JS7zInstance } from '../vendor/js7z/js7z.cjs.d.ts';

export interface SevenZipEntry {
	path: string;
	data: Uint8Array;
}

// The single-threaded build is vendored next to this module (no SharedArrayBuffer / worker
// requirement, so no COOP/COEP headers needed). A static `new URL(...)` lets Vite emit the
// .wasm as a hashed asset in browser builds, while Node resolves it straight from the
// filesystem.
const js7zWasmUrl = new URL('../vendor/js7z/js7z.wasm', import.meta.url);

/** The resolved js7z.wasm asset URL, exposed for diagnostics/logging. */
export const JS7Z_WASM_URL = js7zWasmUrl.href;

/** Resolve the .wasm asset URL for js7z. */
function locateFile(path: string): string {
	return path.endsWith('.wasm') ? js7zWasmUrl.href : path;
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// Two copies of the same vendored build are kept: `js7z.cjs` (real CommonJS, so Node's
// native ESM/CJS interop loads it correctly) and `js7z.mjs` (real ESM, so Vite's dev server
// doesn't have to interop a local relative-path CJS file — which it does incorrectly,
// throwing "doesn't provide an export named: 'default'"). Loaded lazily so neither module
// is evaluated in the environment it isn't meant for.
let js7zFactoryPromise: Promise<(moduleArg?: Record<string, unknown>) => Promise<JS7zInstance>> | undefined;

function loadJS7zFactory() {
	js7zFactoryPromise ??= isNode
		? // @vite-ignore — this branch never runs in a browser bundle (isNode is always
			// false there); skip static analysis so bundlers don't try to pull the
			// Node-only CJS build into the client build.
			import(/* @vite-ignore */ '../vendor/js7z/js7z.cjs').then((mod) => mod.default)
		: import('../vendor/js7z/js7z.mjs').then((mod) => mod.default);
	return js7zFactoryPromise;
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
		const JS7z = await loadJS7zFactory();
		const js7z = await JS7z({ locateFile });

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

		const JS7z = await loadJS7zFactory();
		const js7z = await JS7z({ locateFile });

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
