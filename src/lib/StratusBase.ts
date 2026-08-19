import type {
	StorageBackend,
	StorageFileInfo,
	StorageOperation,
	WriteOptions
} from './types.ts';
import { BaseStorageOperation } from './utils/BaseStorageOperation.ts';

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
}

export interface StratusBaseOptions {
	backend: StorageBackend;
	localRoot: string;
	middleware: StratusMiddleware;
	sparse?: boolean;
}

let storageManager: StorageManager | undefined =
	typeof navigator !== 'undefined' ? navigator.storage : undefined;

/**
 * Configure a mock storage manager for testing environments.
 */
export function setStorageManager(mock: any): void {
	storageManager = mock;
}

export class StratusBase {
	private backend: StorageBackend;
	private localRoot: string;
	private middleware: StratusMiddleware;
	private sparse: boolean;

	constructor(options: StratusBaseOptions) {
		this.backend = options.backend;
		this.localRoot = options.localRoot;
		this.middleware = options.middleware;
		this.sparse = options.sparse ?? false;
	}

	// --- OPFS Helper Methods ---

	private async getRootHandle(): Promise<FileSystemDirectoryHandle> {
		if (!storageManager) {
			throw new Error('Storage manager not available. Use setStorageManager in non-browser environments.');
		}
		return await storageManager.getDirectory();
	}

	private async getLocalRootHandle(create = true): Promise<FileSystemDirectoryHandle> {
		const root = await this.getRootHandle();
		return await this.traverseDirectory(root, this.localRoot, { create });
	}

	private async getContentRootHandle(create = true): Promise<FileSystemDirectoryHandle> {
		const localRoot = await this.getLocalRootHandle(create);
		return await localRoot.getDirectoryHandle('content', { create });
	}

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

	public async saveMetadata(metadata: StratusMetadata): Promise<void> {
		const localRoot = await this.getLocalRootHandle(true);
		const fileHandle = await localRoot.getFileHandle('metadata.json', { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(JSON.stringify(metadata, null, 2));
		await writable.close();
	}

	// --- Public File System API ---

	async stat(path: string): Promise<StorageFileInfo | null> {
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

	readFile(path: string): StorageOperation<Uint8Array> {
		return new BaseStorageOperation<Uint8Array>(async () => {
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
		});
	}

	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void> {
		return new BaseStorageOperation<void>(async () => {
			const fileHandle = await this.getFileHandle(path, { create: true });
			const writable = await fileHandle.createWritable();
			await writable.write(content as BufferSource);
			await writable.close();

			const metadata = await this.getMetadata();
			const existing = metadata.files[path];
			metadata.files[path] = {
				path,
				type: 'file',
				size: content.length,
				localModifiedAt: Date.now(),
				remoteModifiedAt: existing ? existing.remoteModifiedAt : 0,
				etag: existing?.etag,
				status: 'dirty'
			};

			await this.saveMetadata(metadata);
		});
	}

	async deleteFile(path: string): Promise<void> {
		const metadata = await this.getMetadata();
		const existing = metadata.files[path];
		if (!existing) return;

		try {
			const contentRoot = await this.getContentRootHandle(false);
			const segments = path.split('/').filter(Boolean);
			const fileName = segments.pop();
			if (fileName) {
				const dir = await this.traverseDirectory(contentRoot, segments.join('/'), { create: false });
				await dir.removeEntry(fileName);
			}
		} catch {
			// File might already not exist locally
		}

		existing.status = 'deleted';
		existing.localModifiedAt = Date.now();
		await this.saveMetadata(metadata);
	}

	async listDirectory(path: string): Promise<StorageFileInfo[]> {
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

	async renameFile(oldPath: string, newPath: string): Promise<void> {
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
				const dir = await this.traverseDirectory(contentRoot, segments.join('/'), { create: false });
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

	async sync(): Promise<SyncResult> {
		const context: StratusSyncContext = {
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
						const dir = await this.traverseDirectory(contentRoot, segments.join('/'), { create: false });
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

		return await this.middleware.sync(context);
	}

	async consolidate(): Promise<void> {
		const context: StratusSyncContext = {
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
						const dir = await this.traverseDirectory(contentRoot, segments.join('/'), { create: false });
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

		if (typeof (this.middleware as any).consolidate === 'function') {
			await (this.middleware as any).consolidate(context);
		}
	}
}
