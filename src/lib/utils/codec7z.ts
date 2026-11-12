import type { JS7zFactory, JS7zInstance } from './js7zTypes.ts';
import { chooseWasmVariant, getWasmConfig, resolveBaseUrl, type WasmVariant } from './wasmConfig.ts';
import { generateSecureRandomBytes, secureRandomInt, MAX_RANDOM_BYTES_PER_CALL } from './crypto.ts';

export interface SevenZipEntry {
	path: string;
	data: Uint8Array;
}

/** Inclusive byte range for the random padding file. */
export interface PaddingOptions {
	/** Smallest padding size, in bytes. Default: 25 KB (25 * 1024). */
	minBytes?: number;
	/** Largest padding size, in bytes. Default: 64 KB (one getRandomValues call). */
	maxBytes?: number;
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
	/**
	 * Adds one padding file of cryptographically random, incompressible bytes so the finished
	 * archive's size doesn't leak the size of the real contents. `true` (the default) uses the
	 * 25-64 KB range; a {@link PaddingOptions} object overrides the range; `false` disables it.
	 * The reader filters this file out on extract, so it never surfaces to consumers.
	 */
	padding?: boolean | PaddingOptions;
}

// Smallest padding size; the default largest is MAX_RANDOM_BYTES_PER_CALL, so one
// getRandomValues call always fills the whole padding buffer.
const DEFAULT_PADDING_MIN_BYTES = 25 * 1024;

/**
 * In-archive path prefix for the size-masking padding file. Chosen to be recognisable so the
 * reader can drop it, and unlikely to collide with a real entry. A random hex suffix is appended
 * per archive.
 */
const PADDING_PATH_PREFIX = '.stratus-padding-';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// The wasm is not bundled. The consumer serves it and says where via `configureWasm`
// (see wasmConfig.ts); the default is a CDN copy. The glue is an ES module loaded by URL at
// runtime, so no bundler has to resolve a wasm asset. The glue's own `import.meta.url` is how
// the multi-threaded build starts its pthread workers, hence `multi` must be same-origin.
interface LoadedFactory {
	factory: JS7zFactory;
	/** Wasm location for Emscripten's `locateFile`; unset when the package resolves its own. */
	moduleUrl?: URL;
	variant: WasmVariant;
}

let loadedFactoryPromise: Promise<LoadedFactory> | undefined;
let loadedFactoryRevision = -1;

async function loadFactory(): Promise<LoadedFactory> {
	// Node: the `js7z-tools` package (multi-threaded build) straight from node_modules. It works
	// without cross-origin isolation, and the specifier is held in a variable so browser bundles
	// never try to pull it in.
	if (isNode) {
		const nodePackageName = 'js7z-tools';
		const { default: factory } = await import(/* @vite-ignore */ nodePackageName);
		return { factory, variant: 'multi' };
	}

	const config = getWasmConfig();
	const variant = chooseWasmVariant(config);
	const moduleUrl = new URL(`${variant}/js7z.mjs`, resolveBaseUrl(config.baseUrl));
	const { default: factory } = await import(/* @vite-ignore */ moduleUrl.href).catch(
		(cause: unknown) => {
			throw new Error(
				`Could not load the ${variant}-threaded js7z wasm from ${moduleUrl.href}. ` +
					`Call configureWasm({ baseUrl }) with the folder you published the wasm files to.`,
				{ cause }
			);
		}
	);
	return { factory, moduleUrl, variant };
}

/** Loads the glue once per configuration; `configureWasm` invalidates it. */
function getFactory(): Promise<LoadedFactory> {
	const { revision } = getWasmConfig();
	if (!loadedFactoryPromise || loadedFactoryRevision !== revision) {
		loadedFactoryRevision = revision;
		loadedFactoryPromise = loadFactory();
		// A failed load (bad path, offline) must not stick; the next call retries.
		loadedFactoryPromise.catch(() => {
			loadedFactoryPromise = undefined;
		});
	}
	return loadedFactoryPromise;
}

/**
 * Loads the glue and checks the wasm file is reachable, without instantiating it. Reports which
 * build is in use and where it came from, for diagnostics and the smoke test.
 */
export async function probeJS7z(): Promise<{ variant: WasmVariant; url: string }> {
	const { variant, moduleUrl } = await getFactory();
	if (!moduleUrl) return { variant, url: 'js7z-tools (node_modules)' };

	const wasmUrl = new URL('js7z.wasm', moduleUrl);
	const response = await fetch(wasmUrl, { method: 'HEAD' });
	if (!response.ok) {
		throw new Error(`js7z wasm not found at ${wasmUrl.href} (HTTP ${response.status})`);
	}
	return { variant, url: wasmUrl.href };
}

async function createJS7z(): Promise<JS7zInstance> {
	const { factory, moduleUrl } = await getFactory();
	// The glue can't reliably find its wasm itself in a worker (its location is the worker's),
	// so point at it explicitly, next to the glue file.
	return factory(moduleUrl ? { locateFile: (file: string) => new URL(file, moduleUrl).href } : {});
}

/** Copies bytes off the wasm heap. With the multi-threaded build that heap is a SharedArrayBuffer. */
const copyOffHeap = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

export class SevenZipWriter {
	private password?: string;
	private filename: string;
	private extraArgs: string[];
	private entries: SevenZipEntry[] = [];
	/** Resolved padding byte range, or `undefined` when padding is disabled. */
	private padding?: { minBytes: number; maxBytes: number };

	/**
	 * WritableStream interface to pipe SevenZipEntry objects directly.
	 */
	public readonly writable: WritableStream<SevenZipEntry>;

	constructor(password?: string, options?: SevenZipOptions) {
		this.password = password;
		this.filename = options?.filename ?? 'archive.7z';
		this.extraArgs = options?.extraArgs ?? [];

		// Padding is on by default; only an explicit `false` disables it. An options object
		// overrides either end of the range.
		const { padding = true } = options ?? {};
		if (padding !== false) {
			const range = typeof padding === 'object' ? padding : {};
			this.padding = {
				minBytes: range.minBytes ?? DEFAULT_PADDING_MIN_BYTES,
				maxBytes: range.maxBytes ?? MAX_RANDOM_BYTES_PER_CALL
			};
		}

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
					resolve(copyOffHeap(js7z.FS.readFile(archivePath)));
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

		// The padding file is compressed alongside the real entries so it sits inside the same
		// (encrypted) archive; being random bytes it doesn't compress, so its length carries
		// through to the final size and masks how big the real contents are.
		const entriesToCompress = this.padding
			? [...this.entries, this.createPaddingEntry()]
			: this.entries;

		for (let start = 0; start < entriesToCompress.length; start += BATCH_SIZE) {
			const batch = entriesToCompress.slice(start, start + BATCH_SIZE);
			archiveBytes = await this.runAdd(batch, archiveBytes);

			const compressed = Math.min(start + batch.length, entriesToCompress.length);
			onProgress?.(Math.round((compressed / entriesToCompress.length) * 100));

			// Yield to the event loop so the browser can paint the progress update before the
			// next batch's synchronous compression call blocks the main thread again.
			await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		}

		return archiveBytes ?? this.runAdd([]);
	}

	/**
	 * Builds one padding entry whose length is a cryptographically secure random value in the
	 * configured range and whose contents are cryptographically secure random bytes. Random
	 * content is essential: it's incompressible, so the padding survives compression at close to
	 * its raw size. A random hex suffix keeps the path from colliding with a real entry.
	 */
	private createPaddingEntry(): SevenZipEntry {
		const { minBytes, maxBytes } = this.padding!;
		const byteLength = secureRandomInt(minBytes, maxBytes);
		const suffix = Array.from(generateSecureRandomBytes(8), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');
		return { path: `${PADDING_PATH_PREFIX}${suffix}`, data: generateSecureRandomBytes(byteLength) };
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
			// Reconstruct path relative to '/out/'
			const relativePath = fullPath.substring('/out/'.length);
			// The size-masking padding file the writer adds is an implementation detail — drop it
			// so it never surfaces to consumers.
			if (relativePath.startsWith(PADDING_PATH_PREFIX)) {
				fs.unlink(fullPath);
				continue;
			}
			const data = copyOffHeap(fs.readFile(fullPath));
			yield {
				path: relativePath,
				data
			};
			// Clean up to free virtual memory immediately
			fs.unlink(fullPath);
		}
	}
}
