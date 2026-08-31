import type { StorageBackend } from '../../types.ts';
import type {
	StratusMiddleware,
	StratusSyncContext,
	SyncConflict,
	SyncResult,
	ChunkMetadata
} from '../../StratusBase.ts';
import { SyncConflictError } from '../../StratusBase.ts';
import { SevenZipWriter, SevenZipReader, getJS7zWasmByteLength } from '../../utils/codec7z.ts';
import { normalize } from 'pathe';

export interface MiddlewareZipChunkOptions {
	chunkSizeLimit?: number; // Target chunk size limit, default 5MB
	atomic?: boolean; // Perform atomic writes on backend if supported
	password?: string; // Password for AES-256 encryption (required)
}

/** Ordered steps the 7z smoke test walks through, for step-by-step debug logging. */
export type SmokeTestStep =
	| 'decode-wasm-binary'
	| 'construct-writer'
	| 'write-entry'
	| 'finalize-archive'
	| 'construct-reader'
	| 'append-chunk'
	| 'extract-archive'
	| 'verify-content';

/** Reports the outcome of a single smoke test step, for external debug logging. */
export type SmokeTestStepReporter = (
	step: SmokeTestStep,
	status: 'start' | 'ok' | 'fail',
	detail?: unknown
) => void;

/**
 * MiddlewareZipChunk splits and appends local changes into zip chunks of a target size (default 5MB).
 * Both local metadata and ZIP archives maintain a mirrored ChunkMetadata structure.
 */
export class MiddlewareZipChunk implements StratusMiddleware {
	private chunkSizeLimit: number;
	private atomic: boolean;
	private password?: string;

	constructor(options: MiddlewareZipChunkOptions = {}) {
		if (!options.password) {
			throw new Error('MiddlewareZipChunk requires a password option for encryption.');
		}
		this.password = options.password;
		this.chunkSizeLimit = options.chunkSizeLimit ?? 5 * 1024 * 1024;
		this.atomic = options.atomic ?? false;
	}

	/**
	 * Checks whether the remote storage contains at least one 7z archive chunk.
	 */
	async isSetUp(context: StratusSyncContext): Promise<boolean> {
		const chunks = await this.listRemoteChunks(context.backend);
		return chunks.length > 0;
	}

	/**
	 * Lists all remote chunks matching archive_chunk_*.7z, sorted numerically.
	 */
	private async listRemoteChunks(
		backend: StorageBackend
	): Promise<{ path: string; num: number; size: number; modifiedAt: Date }[]> {
		const files = await backend.listDirectory('/');
		const chunkRegex = /^archive_chunk_(\d+)\.7z$/;
		return files
			.filter((f) => f.type === 'file' && chunkRegex.test(f.name))
			.map((f) => {
				const match = f.name.match(chunkRegex);
				return {
					path: f.path,
					num: match ? Number(match[1]) : 0,
					size: f.size,
					modifiedAt: f.modifiedAt
				};
			})
			.sort((a, b) => a.num - b.num);
	}

	/**
	 * Smoke test for the 7-Zip implementation. Loads the WASM module, writes a test file
	 * into an archive via `SevenZipWriter`, reads it back through `SevenZipReader`, and
	 * verifies the extracted content matches what was originally written.
	 *
	 * This is **not** part of the sync pipeline — its only purpose is to confirm that the
	 * vendored single-threaded js7z WASM binary resolves and initializes correctly in this
	 * project's build configuration (Vite / ESBuild / etc.). If this method throws, the
	 * WASM file path is likely misconfigured.
	 *
	 * Pass `onStep` to observe each stage as it happens (e.g. to `console.debug` from a
	 * calling app) — this pinpoints exactly which stage a "wasm module not found" style
	 * failure happens at, rather than only seeing the final rejection.
	 *
	 * @returns `true` if the round-trip succeeded.
	 */
	async smokeTestSevenZip(onStep?: SmokeTestStepReporter): Promise<boolean> {
		const testName = '__smoke_test__.txt';
		const testContent = new TextEncoder().encode('smoke-test-ok');

		const runStep = async <T>(
			step: SmokeTestStep,
			detail: unknown,
			fn: () => Promise<T> | T
		): Promise<T> => {
			onStep?.(step, 'start', detail);
			try {
				const result = await fn();
				onStep?.(step, 'ok', result);
				return result;
			} catch (err) {
				onStep?.(step, 'fail', err);
				throw err;
			}
		};

		// 0. Decode the wasm binary before touching any wasm code, so a build that dropped or
		// mangled the vendored payload is visible up front rather than as a later hang.
		await runStep('decode-wasm-binary', undefined, () => getJS7zWasmByteLength());

		// 1. Build archive in memory
		const writer = await runStep(
			'construct-writer',
			undefined,
			() => new SevenZipWriter(this.password)
		);
		await runStep('write-entry', { path: testName, size: testContent.length }, () =>
			writer.write({ path: testName, data: testContent })
		);

		// 2. Finalize with a timeout guard — hangs usually mean the WASM failed to initialise
		const archiveBytes = await runStep('finalize-archive', undefined, () =>
			Promise.race([
				writer.finalize(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									'[7z] finalize timed out after 30s — the js7z wasm module likely failed to instantiate'
								)
							),
						30_000
					)
				)
			])
		);

		// 3. Read back and verify
		const reader = await runStep(
			'construct-reader',
			undefined,
			() => new SevenZipReader(this.password)
		);
		await runStep('append-chunk', { size: archiveBytes.length }, () =>
			reader.appendChunk(archiveBytes)
		);

		const entries = await runStep('extract-archive', undefined, async () => {
			const collected: { path: string; data: Uint8Array }[] = [];
			for await (const entry of reader.extract()) {
				collected.push(entry);
			}
			return collected;
		});

		return runStep('verify-content', { entryCount: entries.length }, () => {
			const match = entries.find(
				(entry) =>
					entry.path === testName &&
					new Uint8Array(entry.data).toString() === testContent.toString()
			);
			if (!match) {
				throw new Error('7z smoke test failed: extracted content mismatch or missing file');
			}
			return true;
		});
	}

	/**
	 * Formats a chunk number as archive_chunk_XXX.7z.
	 */
	private formatChunkPath(num: number): string {
		const padded = String(num).padStart(3, '0');
		return `/archive_chunk_${padded}.7z`;
	}

	/**
	 * Appends the _updates suffix to a filename for conflicts.
	 */
	private appendUpdatesSuffix(filePath: string): string {
		const lastDot = filePath.lastIndexOf('.');
		const lastSlash = filePath.lastIndexOf('/');
		if (lastDot > lastSlash && lastDot !== -1) {
			return filePath.slice(0, lastDot) + '_updates' + filePath.slice(lastDot);
		}
		return filePath + '_updates';
	}

	/**
	 * Decodes 7z bytes into a file content map.
	 */
	private async decodeZip(zipBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
		const filesMap = new Map<string, Uint8Array>();
		if (zipBytes.length === 0) {
			return filesMap;
		}
		const reader = new SevenZipReader(this.password);
		await reader.appendChunk(zipBytes);
		for await (const entry of reader.extract()) {
			const filename =
				entry.path === '.metadata.json'
					? '.metadata.json'
					: entry.path.startsWith('/')
						? entry.path
						: '/' + entry.path;
			filesMap.set(filename, entry.data);
		}
		return filesMap;
	}

	/**
	 * Encodes a file content map into a 7z Uint8Array.
	 */
	private async encodeZip(filesMap: Map<string, Uint8Array>): Promise<Uint8Array> {
		const writer = new SevenZipWriter(this.password);
		for (const [filename, content] of filesMap.entries()) {
			const entryName = filename.startsWith('/') ? filename.slice(1) : filename;
			await writer.write({ path: entryName, data: content });
		}
		return await writer.finalize();
	}

	/**
	 * Extracts and parses chunk metadata from a files map.
	 */
	private parseChunkMetadata(filesMap: Map<string, Uint8Array>): ChunkMetadata {
		const metaBytes = filesMap.get('.metadata.json');
		if (!metaBytes) {
			return { uncompressedSize: 0, files: {}, deleted: [] };
		}
		try {
			return JSON.parse(new TextDecoder().decode(metaBytes));
		} catch {
			return { uncompressedSize: 0, files: {}, deleted: [] };
		}
	}

	/**
	 * Encodes a files map and metadata into a ZIP and writes to the backend.
	 */
	private async writeChunk(
		context: StratusSyncContext,
		chunkPath: string,
		filesMap: Map<string, Uint8Array>,
		chunkMeta: ChunkMetadata
	): Promise<void> {
		const metaContent = new TextEncoder().encode(JSON.stringify(chunkMeta, null, 2));
		filesMap.set('.metadata.json', metaContent);

		const zipBytes = await this.encodeZip(filesMap);
		const op = context.backend.writeFile(chunkPath, zipBytes, { atomic: this.atomic });
		await op.finished;
	}

	/**
	 * Downloads a remote chunk, extracts its entries, and handles conflicts.
	 */
	private async downloadAndExtractChunk(
		context: StratusSyncContext,
		rc: { path: string },
		metadata: any,
		conflicts: SyncConflict[],
		created: string[],
		updated: string[]
	): Promise<void> {
		const op = context.backend.readFile(rc.path);
		const bytes = await op.finished;
		const filesMap = await this.decodeZip(bytes);
		const chunkMeta = this.parseChunkMetadata(filesMap);

		// Store metadata in local cache
		metadata.chunks![rc.path] = chunkMeta;

		// Extract entries
		const entries = Array.from(filesMap.entries()).filter(([name]) => name !== '.metadata.json');
		await Promise.all(
			entries.map(async ([entryPath, content]) => {
				const path = normalize(entryPath).replace(/^\/+/, '');
				const localFiles = metadata.files;
				const localFile = localFiles[path];
				const remoteFileMeta =
					chunkMeta.files[path] || chunkMeta.files[entryPath] || chunkMeta.files['/' + path];
				const remoteModifiedAt = remoteFileMeta?.modifiedAt ?? Date.now();

				const isLocalModified =
					localFile && (localFile.status === 'dirty' || localFile.status === 'deleted');

				if (!isLocalModified) {
					// Non-modified locally, safe to extract/lazy-load
					localFiles[path] = {
						path,
						type: 'file',
						size: content.length,
						localModifiedAt: remoteModifiedAt,
						remoteModifiedAt,
						status: 'clean'
					};

					if (context.sparse) {
						await context.deleteLocalFile(path); // Ensure clean OPFS state for lazy load
					} else {
						await context.writeLocalFile(path, content);
					}

					if (!localFile) {
						created.push(path);
					} else {
						updated.push(path);
					}
					return;
				}

				// Conflict check:
				const remoteChanged = remoteModifiedAt > localFile.remoteModifiedAt;
				if (!remoteChanged) {
					// Remote is not newer, keep local changes.
					return;
				}

				const updatesPath = this.appendUpdatesSuffix(path);
				await context.writeLocalFile(updatesPath, content);

				localFiles[path] = {
					...localFile,
					status: 'conflict',
					remoteModifiedAt
				};

				localFiles[updatesPath] = {
					path: updatesPath,
					type: 'file',
					size: content.length,
					localModifiedAt: Date.now(),
					remoteModifiedAt: 0,
					status: 'clean'
				};

				conflicts.push({
					path,
					localModifiedAt: new Date(localFile.localModifiedAt),
					remoteModifiedAt: new Date(remoteModifiedAt),
					type: 'conflict'
				});
			})
		);
	}

	/**
	 * Initialises active chunk cache metadata, downloading if needed.
	 */
	private async initialiseActiveChunk(
		context: StratusSyncContext,
		activeChunkPath: string,
		remoteChunks: { path: string }[],
		chunksCache: Record<string, ChunkMetadata>
	): Promise<ChunkMetadata> {
		let activeChunk = chunksCache[activeChunkPath];
		if (activeChunk) {
			return activeChunk;
		}

		// Try downloading metadata of the active chunk if it exists but wasn't in cache
		const activeExists = remoteChunks.some((c) => c.path === activeChunkPath);
		if (activeExists) {
			const op = context.backend.readFile(activeChunkPath);
			const activeBytes = await op.finished;
			const filesMap = await this.decodeZip(activeBytes);
			activeChunk = this.parseChunkMetadata(filesMap);
			chunksCache[activeChunkPath] = activeChunk;
		}

		if (!activeChunk) {
			activeChunk = {
				uncompressedSize: 0,
				files: {},
				deleted: []
			};
			chunksCache[activeChunkPath] = activeChunk;
		}

		return activeChunk;
	}

	/**
	 * Sequentially writes dirty and deleted files across one or more chunks, performing
	 * dynamic chunk rollovers when a chunk size limit is exceeded.
	 */
	private async writeChangesToChunks(
		context: StratusSyncContext,
		metadata: any,
		initialChunkNum: number,
		initialChunkPath: string,
		initialChunk: ChunkMetadata,
		remoteChunks: { path: string }[],
		dirtyPaths: string[],
		deletedPaths: string[],
		created: string[],
		updated: string[],
		deleted: string[]
	): Promise<void> {
		const localFiles = metadata.files;

		let currentChunkNum = initialChunkNum;
		let currentChunkPath = initialChunkPath;
		let currentChunk = { ...initialChunk };

		// Ensure internal structures are clean
		currentChunk.files = { ...(currentChunk.files || {}) };
		currentChunk.deleted = [...(currentChunk.deleted || [])];

		let activeExists = remoteChunks.some((c) => c.path === currentChunkPath);

		let filesMap = new Map<string, Uint8Array>();
		if (activeExists) {
			const op = context.backend.readFile(currentChunkPath);
			const bytes = await op.finished;
			filesMap = await this.decodeZip(bytes);
		}

		const cumulativeDeleted = new Set(currentChunk.deleted);
		deletedPaths.forEach((path) => cumulativeDeleted.add(path));

		let hasUnwrittenChanges = false;

		await dirtyPaths.reduce(async (promise, path) => {
			await promise;
			const content = await context.readLocalFile(path);
			const fileMeta = localFiles[path];

			// If adding this file meets or exceeds the threshold and we already have files in the current chunk, rollover
			const currentSize = currentChunk.uncompressedSize;
			if (
				currentSize + content.length >= this.chunkSizeLimit &&
				(filesMap.size > 0 || Object.keys(currentChunk.files).length > 0)
			) {
				// 1. Write the current chunk to backend
				currentChunk.deleted = Array.from(cumulativeDeleted);
				currentChunk.uncompressedSize = Array.from(filesMap.entries())
					.filter(([name]) => name !== '.metadata.json')
					.reduce((acc, [, bytes]) => acc + bytes.length, 0);
				const tempPath = `/temp_sync_archive_chunk_${String(currentChunkNum).padStart(3, '0')}.7z`;
				await this.writeChunk(context, tempPath, filesMap, currentChunk);
				await context.backend.renameFile(tempPath, currentChunkPath);
				metadata.chunks[currentChunkPath] = { ...currentChunk };

				// 2. Rollover to new chunk
				currentChunkNum++;
				currentChunkPath = this.formatChunkPath(currentChunkNum);
				currentChunk = {
					uncompressedSize: 0,
					files: {},
					deleted: Array.from(cumulativeDeleted)
				};
				filesMap = new Map<string, Uint8Array>();
				activeExists = false;
				hasUnwrittenChanges = false;
			}

			// Add/overwrite file in the current chunk
			const normalizedPath = normalize(path).replace(/^\/+/, '');
			filesMap.set(normalizedPath, content);

			const isNew = !currentChunk.files[normalizedPath];
			if (isNew) {
				created.push(normalizedPath);
			} else {
				updated.push(normalizedPath);
			}

			currentChunk.files[normalizedPath] = {
				size: content.length,
				modifiedAt: fileMeta.localModifiedAt
			};

			localFiles[normalizedPath] = {
				...fileMeta,
				path: normalizedPath,
				status: 'clean',
				remoteModifiedAt: Date.now()
			};

			cumulativeDeleted.delete(path);
			currentChunk.deleted = Array.from(cumulativeDeleted);

			currentChunk.uncompressedSize = Array.from(filesMap.entries())
				.filter(([name]) => name !== '.metadata.json')
				.reduce((acc, [, bytes]) => acc + bytes.length, 0);

			hasUnwrittenChanges = true;
		}, Promise.resolve());

		// Process deleted paths
		deletedPaths.forEach((path) => {
			filesMap.delete(path);
			if (currentChunk.files[path]) {
				delete currentChunk.files[path];
			}
			deleted.push(path);
			delete localFiles[path];
			hasUnwrittenChanges = true;
		});

		// Finalize and write the last active chunk
		if (hasUnwrittenChanges || !activeExists) {
			currentChunk.deleted = Array.from(cumulativeDeleted);
			currentChunk.uncompressedSize = Array.from(filesMap.entries())
				.filter(([name]) => name !== '.metadata.json')
				.reduce((acc, [, bytes]) => acc + bytes.length, 0);

			const tempPath = `/temp_sync_archive_chunk_${String(currentChunkNum).padStart(3, '0')}.7z`;
			await this.writeChunk(context, tempPath, filesMap, currentChunk);
			await context.backend.renameFile(tempPath, currentChunkPath);
			metadata.chunks[currentChunkPath] = currentChunk;
		}
	}

	async sync(context: StratusSyncContext): Promise<SyncResult> {
		const metadata = await context.getLocalMetadata();
		const localFiles = metadata.files;

		// Ensure chunks cache is initialised
		if (!metadata.chunks) {
			metadata.chunks = {};
		}

		const conflicts: SyncConflict[] = [];
		const created: string[] = [];
		const updated: string[] = [];
		const deleted: string[] = [];

		const remoteChunks = await this.listRemoteChunks(context.backend);

		// ==========================================
		// Phase 1: Pull & Extract (Remote updates)
		// ==========================================
		const chunksToDownload = remoteChunks.filter((rc) => {
			const cached = metadata.chunks![rc.path];
			return !cached || cached.uncompressedSize === 0;
		});

		await chunksToDownload.reduce(async (promise, rc) => {
			await promise;
			await this.downloadAndExtractChunk(context, rc, metadata, conflicts, created, updated);
		}, Promise.resolve());

		// ==========================================
		// Phase 2: Apply Cumulative Deletions
		// ==========================================
		let activeChunkNum = 1;
		let activeChunkPath = this.formatChunkPath(activeChunkNum);

		if (remoteChunks.length > 0) {
			const highest = remoteChunks[remoteChunks.length - 1];
			activeChunkNum = highest.num;
			activeChunkPath = highest.path;
		}

		const activeChunk = await this.initialiseActiveChunk(
			context,
			activeChunkPath,
			remoteChunks,
			metadata.chunks
		);

		// Apply deletions from active chunk cumulative deleted list
		if (activeChunk.deleted) {
			await Promise.all(
				activeChunk.deleted.map(async (path) => {
					const localFile = localFiles[path];
					if (localFile && localFile.status === 'clean') {
						await context.deleteLocalFile(path);
						delete localFiles[path];
						deleted.push(path);
					}
				})
			);
		}

		// ==========================================
		// Phase 3: Push & Append (Local changes)
		// ==========================================
		const dirtyPaths = Object.keys(localFiles).filter(
			(path) => localFiles[path].status === 'dirty'
		);
		const deletedPaths = Object.keys(localFiles).filter(
			(path) => localFiles[path].status === 'deleted'
		);

		if (dirtyPaths.length > 0 || deletedPaths.length > 0) {
			await this.writeChangesToChunks(
				context,
				metadata,
				activeChunkNum,
				activeChunkPath,
				activeChunk,
				remoteChunks,
				dirtyPaths,
				deletedPaths,
				created,
				updated,
				deleted
			);
		}

		await context.saveLocalMetadata(metadata);

		if (conflicts.length > 0) {
			throw new SyncConflictError(conflicts);
		}

		return { created, updated, deleted };
	}

	async consolidate(context: StratusSyncContext): Promise<void> {
		// 1. Sync first to make sure everything is completely synchronised
		await this.sync(context);

		// 2. Read the latest metadata
		const metadata = await context.getLocalMetadata();
		const localFiles = metadata.files;

		// Ensure chunks cache is initialised
		if (!metadata.chunks) {
			metadata.chunks = {};
		}

		// Find active files (exclude 'deleted' status and '_updates' files)
		const activePaths = Object.keys(localFiles).filter(
			(path) => localFiles[path].status !== 'deleted' && !path.endsWith('_updates')
		);

		// 3. Pack active files into a new set of temp chunks
		const tempChunks: { path: string; meta: ChunkMetadata }[] = [];

		let currentTempChunkNum = 1;
		let currentTempChunkPath = `/temp_archive_chunk_${String(currentTempChunkNum).padStart(3, '0')}.7z`;

		let currentFilesMap = new Map<string, Uint8Array>();
		let currentChunkMeta: ChunkMetadata = {
			uncompressedSize: 0,
			files: {},
			deleted: []
		};

		// We will pack files sequentially to respect chunk boundaries
		await activePaths.reduce(async (promise, path) => {
			await promise;
			const content = await context.readLocalFile(path);
			const fileMeta = localFiles[path];

			// If adding this file exceeds the threshold and we already have files in the current chunk, close it and start a new one
			if (
				currentChunkMeta.uncompressedSize + content.length >= this.chunkSizeLimit &&
				currentFilesMap.size > 0
			) {
				// Serialize metadata and write the current temp chunk
				currentChunkMeta.uncompressedSize = Array.from(currentFilesMap.entries())
					.filter(([name]) => name !== '.metadata.json')
					.reduce((acc, [, bytes]) => acc + bytes.length, 0);

				await this.writeChunk(context, currentTempChunkPath, currentFilesMap, currentChunkMeta);

				tempChunks.push({
					path: currentTempChunkPath,
					meta: { ...currentChunkMeta }
				});

				// Start next temp chunk
				currentTempChunkNum++;
				currentTempChunkPath = `/temp_archive_chunk_${String(currentTempChunkNum).padStart(3, '0')}.7z`;
				currentFilesMap = new Map<string, Uint8Array>();
				currentChunkMeta = {
					uncompressedSize: 0,
					files: {},
					deleted: []
				};
			}

			// Add file to current chunk
			currentFilesMap.set(path, content);
			currentChunkMeta.files[path] = {
				size: content.length,
				modifiedAt: fileMeta.localModifiedAt
			};
			currentChunkMeta.uncompressedSize += content.length;
		}, Promise.resolve());

		// Add the final temp chunk
		if (currentFilesMap.size > 0 || tempChunks.length === 0) {
			currentChunkMeta.uncompressedSize = Array.from(currentFilesMap.entries())
				.filter(([name]) => name !== '.metadata.json')
				.reduce((acc, [, bytes]) => acc + bytes.length, 0);

			await this.writeChunk(context, currentTempChunkPath, currentFilesMap, currentChunkMeta);

			tempChunks.push({
				path: currentTempChunkPath,
				meta: { ...currentChunkMeta }
			});
		}

		// 4. Delete all old remote chunks archive_chunk_*.7z
		const oldRemoteChunks = await this.listRemoteChunks(context.backend);
		await oldRemoteChunks.reduce(async (promise, chunk) => {
			await promise;
			await context.backend.deleteFile(chunk.path);
		}, Promise.resolve());

		// 5. Rename temp chunks to final names archive_chunk_*.7z
		const newChunksCache: Record<string, ChunkMetadata> = {};
		await tempChunks.reduce(async (promise, chunk, index) => {
			await promise;
			const finalChunkNum = index + 1;
			const finalChunkPath = this.formatChunkPath(finalChunkNum);
			await context.backend.renameFile(chunk.path, finalChunkPath);

			// Populate cache for local metadata
			newChunksCache[finalChunkPath] = {
				...chunk.meta
			};
		}, Promise.resolve());

		// Update local chunks cache and save
		metadata.chunks = newChunksCache;
		await context.saveLocalMetadata(metadata);
	}
}
