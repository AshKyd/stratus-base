import type { StorageBackend, StorageFileInfo, WriteOptions } from './types.ts';
import { debounceAsync } from './utils/debounceAsync.ts';

export interface FileMetadata {
	path: string;
	type: 'file' | 'directory';
	size: number;
	localModifiedAt: number;
	remoteModifiedAt: number;
	etag?: string;
	status: 'clean' | 'dirty' | 'deleted' | 'conflict';
}

export interface ChunkFileMetadata {
	size: number;
	modifiedAt: number;
}

export interface ChunkMetadata {
	uncompressedSize: number;
	files: Record<string, ChunkFileMetadata>;
	deleted?: string[];
}

export interface StratusMetadata {
	files: Record<string, FileMetadata>;
	chunks?: Record<string, ChunkMetadata>;
}

export interface SyncConflict {
	path: string;
	localModifiedAt: Date;
	remoteModifiedAt: Date;
	type: 'conflict';
}

export class SyncConflictError extends Error {
	public conflicts: SyncConflict[];
	constructor(conflicts: SyncConflict[]) {
		super(`Sync completed with ${conflicts.length} conflict(s).`);
		this.name = 'SyncConflictError';
		this.conflicts = conflicts;
	}
}

export class SyncLockedError extends Error {
	public lockDetails: { date: string; clientName: string; operation: string };
	constructor(lockDetails: { date: string; clientName: string; operation: string }) {
		super(`Sync is locked by ${lockDetails.clientName} since ${lockDetails.date} (Operation: ${lockDetails.operation})`);
		this.name = 'SyncLockedError';
		this.lockDetails = lockDetails;
	}
}

export interface SyncResult {
	created: string[];
	updated: string[];
	deleted: string[];
}

export interface StratusSyncContext {
	backend: StorageBackend;
	localRoot: string;
	sparse: boolean;
	getLocalMetadata(): Promise<StratusMetadata>;
	saveLocalMetadata(metadata: StratusMetadata): Promise<void>;
	readLocalFile(path: string): Promise<Uint8Array>;
	writeLocalFile(path: string, content: Uint8Array): Promise<void>;
	deleteLocalFile(path: string): Promise<void>;
	markClean(path: string, remoteModifiedAt: Date, etag?: string): Promise<void>;
}

export interface StratusMiddleware {
	sync(context: StratusSyncContext): Promise<SyncResult>;
	isSetUp(context: StratusSyncContext): Promise<boolean>;
}

export interface StratusBaseOptions {
	/** Remote storage provider implementation. */
	backend: StorageBackend;
	/** Path of the local directory inside the browser Origin Private File System (OPFS). Defaults to '/stratus'. */
	localRoot?: string;
	/** Synchronization strategy middleware. */
	middleware: StratusMiddleware;
	/** Delay downloading remote file contents until explicitly read. Defaults to false. */
	sparse?: boolean;
	/** Unique name identifying this client device. Fallbacks to a generated random string. */
	clientName?: string;
}

let storageManager: StorageManager | undefined =
	typeof navigator !== 'undefined' ? navigator.storage : undefined;

/**
 * Configure a mock storage manager for testing environments.
 */
export function setStorageManager(mock: any): void {
	storageManager = mock;
}

export class StratusBase extends EventTarget {
	private backend: StorageBackend;
	private localRoot: string;
	private middleware: StratusMiddleware;
	private sparse: boolean;
	private clientName: string;

	/**
	 * Initialises a new StratusBase sync client instance.
	 * @param options Configuration options including backend, local folder root, and middleware strategy.
	 */
	constructor(options: StratusBaseOptions) {
		super();
		this.backend = options.backend;
		this.localRoot = options.localRoot ?? '/stratus';
		this.middleware = options.middleware;
		this.sparse = options.sparse ?? false;
		this.clientName = options.clientName ?? `Client-${Math.random().toString(36).substring(2, 10)}`;
	}

	// --- OPFS Helper Methods ---

	/**
	 * Accesses the root directory handle for the browser Origin Private File System.
	 * Throws if the runtime environment does not support or initialise the storage manager.
	 */
	private async getRootHandle(): Promise<FileSystemDirectoryHandle> {
		if (!storageManager) {
			throw new Error(
				'Storage manager not available. Use setStorageManager in non-browser environments.'
			);
		}
		return await storageManager.getDirectory();
	}

	/**
	 * Retrieves the handle for the local client root folder within OPFS.
	 * @param create If true, creates the folder path if it does not exist.
	 */
	private async getLocalRootHandle(create = true): Promise<FileSystemDirectoryHandle> {
		const root = await this.getRootHandle();
		return await this.traverseDirectory(root, this.localRoot, { create });
	}

	/**
	 * Accesses the subfolder dedicated to cached user files ('/content').
	 * This prevents library metadata from conflicting with the user files.
	 * @param create If true, creates the content directory if it is missing.
	 */
	private async getContentRootHandle(create = true): Promise<FileSystemDirectoryHandle> {
		const localRoot = await this.getLocalRootHandle(create);
		return await localRoot.getDirectoryHandle('content', { create });
	}

	/**
	 * Recursively traverses a folder path segments to return the target directory handle.
	 * @param root Directory handle to start traversing from.
	 * @param path Slash-separated directory path.
	 * @param options Folder creation options.
	 */
	private async traverseDirectory(
		root: FileSystemDirectoryHandle,
		path: string,
		options: { create?: boolean } = {}
	): Promise<FileSystemDirectoryHandle> {
		const segments = path.split('/').filter(Boolean);
		let current = root;
		for (const segment of segments) {
			current = await current.getDirectoryHandle(segment, options);
		}
		return current;
	}

	/**
	 * Obtains a FileSystemFileHandle for a specific file path, traversing directories as needed.
	 * @param path File path relative to the content directory.
	 * @param options File creation options.
	 */
	private async getFileHandle(
		path: string,
		options: { create?: boolean } = {}
	): Promise<FileSystemFileHandle> {
		const contentRoot = await this.getContentRootHandle(options.create);
		const segments = path.split('/').filter(Boolean);
		const fileName = segments.pop();
		if (!fileName) {
			throw new Error('Invalid file path');
		}
		const dir = await this.traverseDirectory(contentRoot, segments.join('/'), options);
		return await dir.getFileHandle(fileName, options);
	}

	// --- Metadata Management ---

	/**
	 * Reads the local client synchronisation metadata (`metadata.json`).
	 * Returns an empty database representation if the file is empty, missing, or corrupted.
	 * @internal
	 */
	public async getMetadata(): Promise<StratusMetadata> {
		try {
			const localRoot = await this.getLocalRootHandle(true);
			const fileHandle = await localRoot.getFileHandle('metadata.json', { create: true });
			const file = await fileHandle.getFile();
			const text = await file.text();
			if (!text.trim()) {
				return { files: {} };
			}
			return JSON.parse(text);
		} catch {
			return { files: {} };
		}
	}

	/**
	 * Overwrites the local metadata state on the client file system.
	 * @param metadata New client state representation.
	 * @internal
	 */
	public async saveMetadata(metadata: StratusMetadata): Promise<void> {
		const localRoot = await this.getLocalRootHandle(true);
		const fileHandle = await localRoot.getFileHandle('metadata.json', { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(metadata, null, 2));
		await writable.close();
	}

	// --- Public File System API ---

	/**
	 * Checks status and gets metadata for a local file.
	 * Returns null if the file does not exist locally or is flagged as deleted.
	 * @param path Relative path to the target file.
	 */
	public async stat(path: string): Promise<StorageFileInfo | null> {
		const metadata = await this.getMetadata();
		const fileMeta = metadata.files[path];

		if (!fileMeta || fileMeta.status === 'deleted') {
			return null;
		}

		return {
			path,
			name: path.split('/').pop() || '',
			type: fileMeta.type,
			size: fileMeta.size,
			modifiedAt: new Date(fileMeta.localModifiedAt),
			etag: fileMeta.etag
		};
	}

	/**
	 * Reads file contents from the local cache.
	 * In sparse mode, if the file is not yet cached locally, it downloads it on-demand from remote storage.
	 * @param path Relative path to the file.
	 */
	public async readFile(path: string): Promise<Uint8Array> {
		const metadata = await this.getMetadata();
		const fileMeta = metadata.files[path];

		if (!fileMeta || fileMeta.status === 'deleted') {
			throw new Error(`File not found: ${path}`);
		}

		try {
			const fileHandle = await this.getFileHandle(path);
			const file = await fileHandle.getFile();
			const buffer = await file.arrayBuffer();
			return new Uint8Array(buffer);
		} catch (err) {
			if (fileMeta.status === 'clean' || fileMeta.status === 'conflict') {
				const op = this.backend.readFile(path);
				const content = await op.finished;

				const fileHandle = await this.getFileHandle(path, { create: true });
				const writable = await fileHandle.createWritable();
				await writable.write(content as BufferSource);
				await writable.close();

				return content;
			}
			throw err;
		}
	}

	/**
	 * Writes content to a local file and marks its synchronization status.
	 * If content is identical to existing file, marks as clean. Otherwise marks as dirty.
	 * @param path Relative path of the file.
	 * @param content Binary content to write.
	 * @param options Write-then-rename configurations for atomic writes.
	 */
	public async writeFile(
		path: string,
		content: Uint8Array,
		options?: WriteOptions
	): Promise<void> {
		const metadata = await this.getMetadata();
		const existing = metadata.files[path];

		// Check if content has actually changed by reading existing file first
		let hasContentChanged = true;
		if (existing && existing.status !== 'deleted' && existing.size === content.length) {
			try {
				const fileHandle = await this.getFileHandle(path, { create: false });
				const file = await fileHandle.getFile();
				const existingBuffer = await file.arrayBuffer();
				const existingContent = new Uint8Array(existingBuffer);
				// Compare content byte-by-byte
				hasContentChanged = !existingContent.every((byte, i) => byte === content[i]);
			} catch {
				// File doesn't exist or can't be read, treat as changed
				hasContentChanged = true;
			}
		}

		const fileHandle = await this.getFileHandle(path, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(content as BufferSource);
		await writable.close();

		metadata.files[path] = {
			path,
			type: 'file',
			size: content.length,
			localModifiedAt: Date.now(),
			remoteModifiedAt: existing ? existing.remoteModifiedAt : 0,
			etag: existing?.etag,
			status: hasContentChanged ? 'dirty' : 'clean'
		};

		await this.saveMetadata(metadata);
	}

	/**
	 * Reads file contents from the local cache as a UTF-8 string.
	 * Respects sparse mode by fetching from remote storage on-demand if missing locally.
	 * @param path Relative path to the file.
	 */
	public async readTextFile(path: string): Promise<string> {
		const bytes = await this.readFile(path);
		return new TextDecoder().decode(bytes);
	}

	/**
	 * Writes a UTF-8 string directly to a local file and marks its status as dirty.
	 * @param path Relative path of the file.
	 * @param content Text content to write.
	 * @param options Write-then-rename configurations for atomic writes.
	 */
	public async writeTextFile(
		path: string,
		content: string,
		options?: WriteOptions
	): Promise<void> {
		const bytes = new TextEncoder().encode(content);
		await this.writeFile(path, bytes, options);
	}

	/**
	 * Deletes a file locally and flags it as deleted in the client metadata.
	 * The deletion is propagated to remote storage on the next sync.
	 * @param path Relative path of the file.
	 */
	public async deleteFile(path: string): Promise<void> {
		const metadata = await this.getMetadata();
		const existing = metadata.files[path];
		if (!existing) return;

		try {
			const contentRoot = await this.getContentRootHandle(false);
			const segments = path.split('/').filter(Boolean);
			const fileName = segments.pop();
			if (fileName) {
				const dir = await this.traverseDirectory(contentRoot, segments.join('/'), {
					create: false
				});
				await dir.removeEntry(fileName);
			}
		} catch {
			// File might already not exist locally
		}

		existing.status = 'deleted';
		existing.localModifiedAt = Date.now();
		await this.saveMetadata(metadata);
	}

	/**
	 * Lists files directly inside the specified directory (non-recursive).
	 * Filters out deleted metadata tracks.
	 * @param path Directory path.
	 */
	public async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const metadata = await this.getMetadata();
		const prefix = path.endsWith('/') ? path : path + '/';
		const targetDir = path === '/' ? '/' : path;

		return Object.values(metadata.files)
			.filter((file) => {
				if (file.status === 'deleted') return false;
				if (targetDir === '/') {
					const parts = file.path.split('/').filter(Boolean);
					return parts.length === 1;
				} else {
					if (!file.path.startsWith(prefix)) return false;
					const subPath = file.path.slice(prefix.length);
					const parts = subPath.split('/').filter(Boolean);
					return parts.length === 1;
				}
			})
			.map((file) => ({
				path: file.path,
				name: file.path.split('/').pop() || '',
				type: file.type,
				size: file.size,
				modifiedAt: new Date(file.localModifiedAt),
				etag: file.etag
			}));
	}

	/**
	 * Renames and moves a file locally. Marks the old path as deleted and the new path as dirty.
	 * @param oldPath Old path relative to content directory.
	 * @param newPath New path relative to content directory.
	 */
	public async renameFile(oldPath: string, newPath: string): Promise<void> {
		const metadata = await this.getMetadata();
		const existing = metadata.files[oldPath];
		if (!existing || existing.status === 'deleted') {
			throw new Error(`File not found: ${oldPath}`);
		}

		// Read content
		const fileHandle = await this.getFileHandle(oldPath);
		const file = await fileHandle.getFile();
		const buffer = await file.arrayBuffer();
		const content = new Uint8Array(buffer);

		// Write to new path
		const newFileHandle = await this.getFileHandle(newPath, { create: true });
		const writable = await newFileHandle.createWritable();
		await writable.write(content);
		await writable.close();

		// Remove old path locally
		try {
			const contentRoot = await this.getContentRootHandle(false);
			const segments = oldPath.split('/').filter(Boolean);
			const fileName = segments.pop();
			if (fileName) {
				const dir = await this.traverseDirectory(contentRoot, segments.join('/'), {
					create: false
				});
				await dir.removeEntry(fileName);
			}
		} catch {
			// Ignore local file deletion errors
		}

		// Update metadata
		existing.status = 'deleted';
		existing.localModifiedAt = Date.now();

		metadata.files[newPath] = {
			path: newPath,
			type: 'file',
			size: content.length,
			localModifiedAt: Date.now(),
			remoteModifiedAt: 0,
			status: 'dirty'
		};

		await this.saveMetadata(metadata);
	}

	// --- Sync Operation ---

	/**
	 * Checks if the remote storage is currently locked by another client.
	 * @returns True if synchronization is possible, false if it is locked.
	 */
	public async canSync(): Promise<boolean> {
		try {
			const stat = await this.backend.stat('/sync.lock');
			return stat === null;
		} catch {
			return true;
		}
	}

	/**
	 * Forcefully clears any existing sync lock and starts a synchronisation.
	 */
	public async forceSync(): Promise<SyncResult> {
		try {
			await this.backend.deleteFile('/sync.lock');
		} catch {
			// Ignore if lockfile did not exist
		}
		return this.sync();
	}

	/**
	 * Creates a standard sync context bound to this StratusBase instance.
	 */
	private createSyncContext(): StratusSyncContext {
		return {
			backend: this.backend,
			localRoot: this.localRoot,
			sparse: this.sparse,
			getLocalMetadata: () => this.getMetadata(),
			saveLocalMetadata: (meta) => this.saveMetadata(meta),
			readLocalFile: async (path) => {
				const handle = await this.getFileHandle(path);
				const file = await handle.getFile();
				return new Uint8Array(await file.arrayBuffer());
			},
			writeLocalFile: async (path, content) => {
				const handle = await this.getFileHandle(path, { create: true });
				const writable = await handle.createWritable();
				await writable.write(content as BufferSource);
				await writable.close();
			},
			deleteLocalFile: async (path) => {
				try {
					const contentRoot = await this.getContentRootHandle(false);
					const segments = path.split('/').filter(Boolean);
					const fileName = segments.pop();
					if (fileName) {
						const dir = await this.traverseDirectory(contentRoot, segments.join('/'), {
							create: false
						});
						await dir.removeEntry(fileName);
					}
				} catch {
					// File might already not exist locally
				}
			},
			markClean: async (path, remoteModifiedAt, etag) => {
				const meta = await this.getMetadata();
				const existing = meta.files[path];
				if (existing) {
					existing.status = 'clean';
					existing.remoteModifiedAt = remoteModifiedAt.getTime();
					existing.etag = etag;
					await this.saveMetadata(meta);
				}
			}
		};
	}

	/**
	 * Checks whether the remote storage backend has already been set up with existing data.
	 * Defers to the configured middleware to determine whether initial onboarding is needed.
	 * @returns True if remote storage is already set up, false if onboarding is required.
	 */
	public async isSetUp(): Promise<boolean> {
		const context = this.createSyncContext();
		return await this.middleware.isSetUp(context);
	}

	/**
	 * Synchronises client local files and metadata with the remote storage backend.
	 * Dispatches `syncstart`, `sync`, `conflict`, and `error` events.
	 * Throws `SyncLockedError` if the remote storage is locked, or `SyncConflictError` if conflict conditions arise.
	 */
	public sync = debounceAsync(async (): Promise<SyncResult> => {
		// Concurrency Check (Cooperative Lockfile)
		const lockStat = await this.backend.stat('/sync.lock');
		if (lockStat) {
			let lockDetails = { date: new Date().toISOString(), clientName: 'Unknown Client', operation: 'sync' };
			try {
				const op = this.backend.readFile('/sync.lock');
				const bytes = await op.finished;
				lockDetails = JSON.parse(new TextDecoder().decode(bytes));
			} catch {
				if (lockStat.modifiedAt) {
					lockDetails.date = lockStat.modifiedAt.toISOString();
				}
			}
			const lockError = new SyncLockedError(lockDetails);
			this.dispatchEvent(new CustomEvent('error', { detail: lockError }));
			throw lockError;
		}

		// Write lockfile
		const lockDetails = {
			date: new Date().toISOString(),
			clientName: this.clientName,
			operation: 'sync'
		};
		const lockBytes = new TextEncoder().encode(JSON.stringify(lockDetails, null, 2));
		await this.backend.writeFile('/sync.lock', lockBytes).finished;

		try {
			const context = this.createSyncContext();

			this.dispatchEvent(new CustomEvent('syncstart'));

			try {
				const result = await this.middleware.sync(context);
				this.dispatchEvent(new CustomEvent('sync', { detail: result }));
				return result;
			} catch (err) {
				if (err instanceof SyncConflictError) {
					for (const conflict of err.conflicts) {
						this.dispatchEvent(new CustomEvent('conflict', { detail: conflict }));
					}
				}
				this.dispatchEvent(new CustomEvent('error', { detail: err }));
				throw err;
			}
		} finally {
			try {
				await this.backend.deleteFile('/sync.lock');
			} catch {
				// Ignore errors deleting lockfile on cleanup
			}
		}
	});

	/**
	 * Defragments the database storage layout on support middleware.
	 * Packs clean active files sequentially and prunes remote history chunks.
	 */
	public async consolidate(): Promise<void> {
		const context = this.createSyncContext();

		if (typeof (this.middleware as any).consolidate === 'function') {
			await (this.middleware as any).consolidate(context);
		}
	}

	/**
	 * Appends `_updates` suffix before the extension of a file path during conflicts.
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
	 * Prunes the local OPFS copy of a conflict file and removes it from metadata structures.
	 */
	private async deleteLocalFileRecord(metadata: StratusMetadata, path: string): Promise<void> {
		try {
			const contentRoot = await this.getContentRootHandle(false);
			const segments = path.split('/').filter(Boolean);
			const fileName = segments.pop();
			if (fileName) {
				const dir = await this.traverseDirectory(contentRoot, segments.join('/'), {
					create: false
				});
				await dir.removeEntry(fileName);
			}
		} catch {
			// File might already not exist locally
		}
		delete metadata.files[path];
	}

	/**
	 * Resolves a conflict on a given file by writing the final resolved content,
	 * marking the file as dirty (so it pushes to remote on next sync),
	 * and deleting the temporary updates file.
	 * @param path The relative path to the file in conflict.
	 * @param content The final content representing the merged/resolved file.
	 */
	public async resolveConflict(path: string, content: Uint8Array): Promise<void> {
		const metadata = await this.getMetadata();
		const fileMeta = metadata.files[path];
		if (!fileMeta || fileMeta.status !== 'conflict') {
			throw new Error(`File is not in conflict status: ${path}`);
		}

		// Write content to original file
		const fileHandle = await this.getFileHandle(path, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(content as BufferSource);
		await writable.close();

		// Mark status as dirty so it gets synced/pushed next time
		fileMeta.status = 'dirty';
		fileMeta.size = content.length;
		fileMeta.localModifiedAt = Date.now();

		// Delete the updates file
		const updatesPath = this.appendUpdatesSuffix(path);
		await this.deleteLocalFileRecord(metadata, updatesPath);

		await this.saveMetadata(metadata);
	}

	/**
	 * Securely deletes all local OPFS files and configuration under the client root folder,
	 * and disconnects/resets the backend.
	 */
	public async reset(): Promise<void> {
		// 1. Wipe local OPFS storage
		try {
			const root = await this.getRootHandle();
			const segments = this.localRoot.split('/').filter(Boolean);
			if (segments.length > 0) {
				const lastSegment = segments.pop()!;
				const parentPath = segments.join('/');
				const parentHandle = await this.traverseDirectory(root, parentPath, { create: false });
				await parentHandle.removeEntry(lastSegment, { recursive: true });
			}
		} catch {
			// Ignore if directory doesn't exist or deletion fails
		}

		// 2. Disconnect backend
		if (typeof this.backend.disconnect === 'function') {
			await this.backend.disconnect();
		} else if (typeof this.backend.setCredentials === 'function') {
			this.backend.setCredentials({});
		}
	}
}
