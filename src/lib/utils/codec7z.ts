import JS7z from 'js7z-tools';
import { createRequire } from 'node:module';

import { resolve } from 'node:path';

// Resolve WASM path directly relative to import.meta.dirname for Node.js
const wasmPath = resolve(import.meta.dirname, '../../../node_modules/js7z-tools/js7z.wasm');

/**
 * Resolves the location of the .wasm file.
 */
function locateFile(path: string): string {
	if (path.endsWith('.wasm')) {
		if (wasmPath) {
			return wasmPath;
		}
		return new URL('js7z-tools/js7z.wasm', import.meta.url).href;
	}
	return path;
}

export interface SevenZipEntry {
	path: string;
	data: Uint8Array;
}

/**
 * Progressive writer to compile files into a 7z archive in virtual memory.
 *
 * @example
 * // Archive files from the Origin Private File System (OPFS) and upload
 * const writer = new SevenZipWriter('my-secure-password');
 *
 * for (const path of pathsToArchive) {
 *   const fileHandle = await opfsRootDirectory.getFileHandle(path);
 *   const file = await fileHandle.getFile();
 *   const data = new Uint8Array(await file.arrayBuffer());
 *
 *   await writer.write({ path, data });
 * }
 *
 * const archiveBytes = await writer.finalize();
 */
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

		const js7z = await JS7z({ locateFile });

		// Prepare directories
		js7z.FS.mkdir('/in');
		js7z.FS.mkdir('/out');
		js7z.FS.writeFile('/in/archive.7z', archiveBytes);

		const args = ['x', '/in/archive.7z', '-o/out'];
		if (this.password) {
			args.push(`-p${this.password}`);
		}

		const exitCode: number = await new Promise((resolve) => {
			js7z.onExit = function (code: number) {
				resolve(code);
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
