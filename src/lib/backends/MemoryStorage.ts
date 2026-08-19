import type { StorageBackend, StorageFileInfo, StorageOperation, WriteOptions } from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';

/**
 * StorageBackend implementation that stores files entirely in memory.
 * Useful for testing and offline scenarios, requiring no setup or API keys.
 */
export class MemoryStorage implements StorageBackend {
	readonly id = 'memory';
	private files = new Map<string, { content: Uint8Array; modifiedAt: Date; etag?: string }>();
	readonly atomicWritesTracked: string[] = [];

	/**
	 * Checks if the backend is configured. Memory storage is always ready.
	 *
	 * @returns A promise resolving to true.
	 */
	async isConfigured(): Promise<boolean> {
		return true;
	}

	/**
	 * Normalises path to standard absolute path.
	 *
	 * @param path The path to clean.
	 * @returns The normalised path.
	 */
	private cleanPath(path: string): string {
		const parts = path.split('/').filter(Boolean);
		return '/' + parts.join('/');
	}

	/**
	 * Retrieves metadata for a file or directory.
	 *
	 * @param path The path to query.
	 * @returns File info if found, otherwise null.
	 */
	async stat(path: string): Promise<StorageFileInfo | null> {
		const clean = this.cleanPath(path);

		// Check if it's a file
		const file = this.files.get(clean);
		if (file) {
			const name = clean.split('/').pop() || '';
			return {
				path: clean,
				name,
				type: 'file',
				size: file.content.length,
				modifiedAt: file.modifiedAt,
				etag: file.etag
			};
		}

		// Check if it's a directory
		const isRoot = clean === '/';
		const dirPrefix = isRoot ? '/' : clean + '/';

		let hasChildren = false;
		if (isRoot) {
			hasChildren = this.files.size > 0;
		} else {
			for (const filePath of this.files.keys()) {
				if (filePath.startsWith(dirPrefix)) {
					hasChildren = true;
					break;
				}
			}
		}

		if (isRoot || hasChildren) {
			const name = isRoot ? '' : clean.split('/').pop() || '';
			return {
				path: clean,
				name,
				type: 'directory',
				size: 0,
				modifiedAt: new Date(0)
			};
		}

		return null;
	}

	/**
	 * Reads file contents from memory.
	 *
	 * @param path The path of the file.
	 * @returns The storage operation resolving to file contents.
	 */
	readFile(path: string): StorageOperation<Uint8Array> {
		const clean = this.cleanPath(path);
		return new BaseStorageOperation(async (signal, onProgress) => {
			if (signal.aborted) {
				throw new DOMException('Operation aborted', 'AbortError');
			}
			const file = this.files.get(clean);
			if (!file) {
				throw new Error(`File not found: ${path}`);
			}
			onProgress(file.content.length, file.content.length);
			return file.content;
		});
	}

	/**
	 * Writes file contents to memory.
	 *
	 * @param path The path of the file.
	 * @param content The byte contents.
	 * @param _options Ignored for memory storage as writes are always atomic.
	 * @returns The storage operation.
	 */
	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void> {
		const clean = this.cleanPath(path);
		return new BaseStorageOperation(async (signal) => {
			if (signal.aborted) {
				throw new DOMException('Operation aborted', 'AbortError');
			}
			const etag = 'etag-' + Math.random().toString(36).substring(2);
			this.files.set(clean, {
				content: new Uint8Array(content),
				modifiedAt: new Date(),
				etag
			});
			if (options?.atomic) {
				this.atomicWritesTracked.push(clean);
			}
		});
	}

	/**
	 * Deletes a file or recursively deletes a directory.
	 *
	 * @param path The path to delete.
	 */
	async deleteFile(path: string): Promise<void> {
		const clean = this.cleanPath(path);
		const file = this.files.get(clean);
		if (file) {
			this.files.delete(clean);
			return;
		}

		// Delete directory recursively
		const isRoot = clean === '/';
		const dirPrefix = isRoot ? '/' : clean + '/';

		const toDelete: string[] = [];
		for (const filePath of this.files.keys()) {
			if (isRoot || filePath.startsWith(dirPrefix)) {
				toDelete.push(filePath);
			}
		}

		toDelete.forEach((p) => this.files.delete(p));
	}

	/**
	 * Lists all direct files and directories under the specified directory path.
	 *
	 * @param path The directory path to list.
	 * @returns A list of child file and directory details.
	 */
	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const clean = this.cleanPath(path);
		const dirPrefix = clean === '/' ? '/' : clean + '/';

		const itemsMap = new Map<string, StorageFileInfo>();

		for (const [filePath, file] of this.files.entries()) {
			if (clean === '/' || filePath.startsWith(dirPrefix)) {
				const relativePath = clean === '/' ? filePath.slice(1) : filePath.slice(dirPrefix.length);
				const parts = relativePath.split('/');
				const nextSegment = parts[0];
				if (!nextSegment) continue;

				const itemPath = clean === '/' ? '/' + nextSegment : clean + '/' + nextSegment;

				if (parts.length > 1) {
					if (!itemsMap.has(itemPath)) {
						itemsMap.set(itemPath, {
							path: itemPath,
							name: nextSegment,
							type: 'directory',
							size: 0,
							modifiedAt: new Date(0)
						});
					}
				} else {
					itemsMap.set(itemPath, {
						path: itemPath,
						name: nextSegment,
						type: 'file',
						size: file.content.length,
						modifiedAt: file.modifiedAt
					});
				}
			}
		}

		return Array.from(itemsMap.values());
	}

	/**
	 * Renames a file or directory.
	 *
	 * @param oldPath The path to rename.
	 * @param newPath The destination path.
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const cleanOld = this.cleanPath(oldPath);
		const cleanNew = this.cleanPath(newPath);

		const file = this.files.get(cleanOld);
		if (file) {
			this.files.set(cleanNew, file);
			this.files.delete(cleanOld);
			return;
		}

		const dirPrefix = cleanOld + '/';
		const renames: [string, string][] = [];

		for (const filePath of this.files.keys()) {
			if (filePath.startsWith(dirPrefix)) {
				const subPath = filePath.slice(dirPrefix.length);
				renames.push([filePath, cleanNew + '/' + subPath]);
			}
		}

		if (renames.length === 0) {
			throw new Error(`Path not found: ${oldPath}`);
		}

		renames.forEach(([oldKey, newKey]) => {
			const f = this.files.get(oldKey);
			if (f) {
				this.files.set(newKey, f);
				this.files.delete(oldKey);
			}
		});
	}

	/**
	 * Exposes the internal files map for testing/introspection.
	 */
	getFilesMap(): Map<string, { content: Uint8Array; modifiedAt: Date; etag?: string }> {
		return this.files;
	}
}
