import type {
	StorageBackend,
	StorageFileInfo,
	StorageAuthCredentials,
	StorageOperation,
	WriteOptions
} from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';



/**
 * Configuration options for initializing the Google Drive storage backend.
 */
export interface GoogleDriveStorageOptions {
	/**
	 * The Google OAuth client ID.
	 */
	clientId: string;
	/**
	 * Optional stored credentials to restore an existing session.
	 */
	credentials?: StorageAuthCredentials;
	/**
	 * Optional custom root folder name to scope files.
	 */
	folderName?: string;
}

/**
 * StorageBackend implementation for Google Drive, running exclusively on the client side.
 * Supports OAuth 2.0 with PKCE authorization and files CRUD.
 */
export class GoogleDriveStorage implements StorageBackend {
	readonly id = 'google-drive';
	private clientId: string;
	private accessToken?: string;
	private refreshToken?: string;
	private expiresAt?: number;
	private folderName?: string;
	private rootFolderId?: string;

	// Local cache mapping paths to Google Drive file IDs
	private pathIdCache = new Map<string, string>();

	constructor(options: GoogleDriveStorageOptions) {
		this.clientId = options.clientId;
		this.folderName = options.folderName;
		if (options.credentials) {
			this.setCredentials(options.credentials);
		}
	}

	/**
	 * Checks if the backend has valid configuration/tokens to perform storage operations.
	 *
	 * @returns A promise that resolves to true if configured and authenticated, or false otherwise.
	 */
	async isConfigured(): Promise<boolean> {
		return !!(this.accessToken && (!this.expiresAt || this.expiresAt > Date.now()));
	}

	/**
	 * Generates the redirect URL to start the Google OAuth 2.0 flow.
	 *
	 * @param redirectUri The callback URL registered in the Google Cloud Console.
	 * @param state Optional state parameter.
	 * @returns The Google OAuth URL.
	 */
	async getAuthUrl(redirectUri: string, state?: string): Promise<string> {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'token',
			scope: 'https://www.googleapis.com/auth/drive.file'
		});

		if (state) {
			params.set('state', state);
		}

		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	/**
	 * Retrieves the current credentials from the active session.
	 * Use this to serialize and save credentials locally (e.g. in localStorage).
	 *
	 * @returns The active credentials.
	 */
	getCredentials(): StorageAuthCredentials {
		return {
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			expiresAt: this.expiresAt
		};
	}

	/**
	 * Restores a previous session by setting the credentials.
	 *
	 * @param credentials The credentials to set.
	 */
	setCredentials(credentials: StorageAuthCredentials): void {
		this.accessToken = credentials.accessToken;
		this.refreshToken = credentials.refreshToken;
		this.expiresAt = credentials.expiresAt;
	}

	/**
	 * Clears credentials and cached metadata, disconnecting Google Drive.
	 */
	async disconnect(): Promise<void> {
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.expiresAt = undefined;
		this.rootFolderId = undefined;
	}


	/**
	 * Resolves the root folder ID, creating the custom folder if configured.
	 */
	private async getRootFolderId(): Promise<string> {
		if (!this.folderName) {
			return 'root';
		}
		if (this.rootFolderId) {
			return this.rootFolderId;
		}

		const escapedName = this.folderName.replace(/'/g, "\\'");
		const q = `name = '${escapedName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
		const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.accessToken}` }
		});

		if (!res.ok) {
			const errBody = await res.text().catch(() => '');
			throw new Error(`Failed to find root folder '${this.folderName}' (HTTP ${res.status}): ${res.statusText || ''} - ${errBody}`);
		}

		const data = await res.json();
		const folder = data.files?.[0];

		if (folder) {
			this.rootFolderId = folder.id;
			return this.rootFolderId!;
		}

		const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				name: this.folderName,
				mimeType: 'application/vnd.google-apps.folder',
				parents: ['root']
			})
		});

		if (!createRes.ok) {
			throw new Error(`Failed to create root folder '${this.folderName}': ${createRes.statusText}`);
		}

		const createData = await createRes.json();
		this.rootFolderId = createData.id;
		return this.rootFolderId!;
	}

	/**
	 * Helper method to resolve an absolute path to a Google Drive file/folder ID.
	 * Walks down the path hierarchy, query and caching resolved folder/file IDs.
	 *
	 * @param path The absolute path (e.g. "/notes/todo.md").
	 * @param createDirectories If true, automatically creates missing intermediate directories.
	 * @returns The resolved ID, or null if not found.
	 */
	private async resolvePath(path: string, createDirectories = false): Promise<string | null> {
		const cleanPath = '/' + path.split('/').filter(Boolean).join('/');
		const rootId = await this.getRootFolderId();

		if (cleanPath === '/') {
			return rootId;
		}

		if (this.pathIdCache.has(cleanPath)) {
			return this.pathIdCache.get(cleanPath)!;
		}

		const segments = cleanPath.split('/').filter(Boolean);
		let currentId = rootId;
		let currentPath = '';

		for (const segment of segments) {
			currentPath += '/' + segment;

			if (this.pathIdCache.has(currentPath)) {
				currentId = this.pathIdCache.get(currentPath)!;
				continue;
			}

			const escapedSegment = segment.replace(/'/g, "\\'");
			const q = `name = '${escapedSegment}' and '${currentId}' in parents and trashed = false`;
			const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,mimeType)`;
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${this.accessToken}` }
			});

			if (!res.ok) {
				throw new Error(`Failed to resolve path segment ${segment} at ${currentPath}: ${res.statusText}`);
			}

			const data = await res.json();
			const file = data.files?.[0];

			if (file) {
				currentId = file.id;
				this.pathIdCache.set(currentPath, currentId);
			} else {
				if (createDirectories) {
					// Create folder
					const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.accessToken}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							name: segment,
							mimeType: 'application/vnd.google-apps.folder',
							parents: [currentId]
						})
					});

					if (!createRes.ok) {
						throw new Error(`Failed to create directory ${currentPath}: ${createRes.statusText}`);
					}

					const createData = await createRes.json();
					currentId = createData.id;
					this.pathIdCache.set(currentPath, currentId);
				} else {
					return null;
				}
			}
		}

		return currentId;
	}

	/**
	 * Invalidates path caches for a path and all its child subpaths.
	 */
	private invalidateCache(path: string) {
		const cleanPath = '/' + path.split('/').filter(Boolean).join('/');
		for (const key of this.pathIdCache.keys()) {
			if (key === cleanPath || key.startsWith(cleanPath + '/')) {
				this.pathIdCache.delete(key);
			}
		}
	}

	/**
	 * Retrieves metadata for a file or directory at the specified path.
	 *
	 * @param path The absolute path (e.g., "/notes/todo.md").
	 * @returns Metadata for the file/directory, or null if it does not exist.
	 */
	async stat(path: string): Promise<StorageFileInfo | null> {
		try {
			const fileId = await this.resolvePath(path);
			if (!fileId) return null;

			const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime`;
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${this.accessToken}` }
			});

			if (res.status === 404) {
				this.invalidateCache(path);
				return null;
			}
			if (!res.ok) {
				throw new Error(`Failed to get metadata: ${res.statusText}`);
			}

			const file = await res.json();
			const isDir = file.mimeType === 'application/vnd.google-apps.folder';

			return {
				path: '/' + path.split('/').filter(Boolean).join('/'),
				name: file.name,
				type: isDir ? 'directory' : 'file',
				size: isDir ? 0 : Number(file.size || 0),
				modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(0),
				etag: file.id
			};
		} catch {
			return null;
		}
	}

	/**
	 * Reads a file's content as a binary array.
	 *
	 * @param path The absolute file path to read.
	 * @returns A cancellable StorageOperation yielding the binary content.
	 */
	readFile(path: string): StorageOperation<Uint8Array> {
		return new BaseStorageOperation(async (signal, onProgress) => {
			const fileId = await this.resolvePath(path);
			if (!fileId) {
				throw new Error(`File not found: ${path}`);
			}

			const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
				headers: { Authorization: `Bearer ${this.accessToken}` },
				signal
			});

			if (!response.ok) {
				throw new Error(`Failed to download file: ${response.statusText}`);
			}

			const total = Number(response.headers.get('content-length') || 0);
			const reader = response.body?.getReader();
			if (!reader) {
				const buf = await response.arrayBuffer();
				return new Uint8Array(buf);
			}

			let loaded = 0;
			const chunks: Uint8Array[] = [];
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value);
					loaded += value.length;
					onProgress(loaded, total || loaded);
				}
			}

			const result = new Uint8Array(loaded);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}
			return result;
		});
	}

	/**
	 * Writes content to a file.
	 * Supports atomic writes via write-then-rename technique if `options.atomic` is enabled.
	 *
	 * @param path The absolute file path to write to.
	 * @param content The binary content to write.
	 * @param options Write configuration, such as atomic mode.
	 * @returns A cancellable StorageOperation.
	 */
	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void> {
		return new BaseStorageOperation(async (signal) => {
			const writeToDest = async (targetPath: string) => {
				const fileId = await this.resolvePath(targetPath);
				if (fileId) {
					// Update existing file
					const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
						method: 'PATCH',
						headers: {
							Authorization: `Bearer ${this.accessToken}`,
							'Content-Type': 'application/octet-stream'
						},
						body: content as any,
						signal
					});
					if (!res.ok) {
						throw new Error(`Failed to upload contents: ${res.statusText}`);
					}
				} else {
					// Create folders up to parent directory
					const pathParts = targetPath.split('/').filter(Boolean);
					const fileName = pathParts.pop() || '';
					const parentPath = '/' + pathParts.join('/');
					const parentId = await this.resolvePath(parentPath, true);

					// Create empty file metadata
					const metadataRes = await fetch('https://www.googleapis.com/drive/v3/files', {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.accessToken}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							name: fileName,
							parents: [parentId]
						}),
						signal
					});

					if (!metadataRes.ok) {
						throw new Error(`Failed to create file metadata: ${metadataRes.statusText}`);
					}

					const metadata = await metadataRes.json();

					// Upload content
					const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${metadata.id}?uploadType=media`, {
						method: 'PATCH',
						headers: {
							Authorization: `Bearer ${this.accessToken}`,
							'Content-Type': 'application/octet-stream'
						},
						body: content as any,
						signal
					});

					if (!res.ok) {
						throw new Error(`Failed to upload content for new file: ${res.statusText}`);
					}

					// Cache the path to new ID mapping
					const cleanTargetPath = '/' + targetPath.split('/').filter(Boolean).join('/');
					this.pathIdCache.set(cleanTargetPath, metadata.id);
				}
			};

			if (options?.atomic) {
				const tempPath = `${path}.tmp`;
				await writeToDest(tempPath);

				// Delete original file if it exists
				try {
					await this.deleteFile(path);
				} catch {
					// Ignore delete failure if it didn't exist
				}

				// Rename temp file to final destination
				await this.renameFile(tempPath, path);
			} else {
				await writeToDest(path);
			}
		});
	}

	/**
	 * Deletes a file or recursively deletes a directory.
	 *
	 * @param path The absolute path to delete.
	 */
	async deleteFile(path: string): Promise<void> {
		const fileId = await this.resolvePath(path);
		if (!fileId) return;

		const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${this.accessToken}` }
		});

		if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
			throw new Error(`Failed to delete file: ${res.statusText}`);
		}

		this.invalidateCache(path);
	}

	/**
	 * Lists all files and directories directly under the specified path (non-recursively).
	 * Handles pagination automatically if the directory has many files.
	 *
	 * @param path The absolute directory path to list.
	 * @returns An array of child metadata entries.
	 */
	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const dirId = await this.resolvePath(path);
		if (!dirId) {
			throw new Error(`Directory not found: ${path}`);
		}

		const fetchPage = async (pageToken?: string): Promise<any[]> => {
			const q = `'${dirId}' in parents and trashed = false`;
			const params = new URLSearchParams({
				q,
				fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)'
			});
			if (pageToken) {
				params.set('pageToken', pageToken);
			}

			const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${this.accessToken}` }
			});

			if (!res.ok) {
				throw new Error(`Failed to list directory: ${res.statusText}`);
			}

			const data = await res.json();
			const files = data.files || [];

			if (data.nextPageToken) {
				const nextFiles = await fetchPage(data.nextPageToken);
				return [...files, ...nextFiles];
			}

			return files;
		};

		const files = await fetchPage();
		const normalizedPath = '/' + path.split('/').filter(Boolean).join('/');

		return files.map((file) => {
			const isDir = file.mimeType === 'application/vnd.google-apps.folder';
			const itemPath = normalizedPath === '/' ? `/${file.name}` : `${normalizedPath}/${file.name}`;
			
			// Cache intermediate items if we find them
			this.pathIdCache.set(itemPath, file.id);

			return {
				path: itemPath,
				name: file.name,
				type: isDir ? 'directory' : 'file',
				size: isDir ? 0 : Number(file.size || 0),
				modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : new Date(0),
				etag: file.id
			};
		});
	}

	/**
	 * Renames or moves a file or directory to a new path.
	 *
	 * @param oldPath The original path.
	 * @param newPath The target destination path.
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const fileId = await this.resolvePath(oldPath);
		if (!fileId) {
			throw new Error(`Source path not found: ${oldPath}`);
		}

		const oldPathParts = oldPath.split('/').filter(Boolean);
		const oldParentPath = '/' + oldPathParts.slice(0, -1).join('/');

		const newPathParts = newPath.split('/').filter(Boolean);
		const newFileName = newPathParts[newPathParts.length - 1] || '';
		const newParentPath = '/' + newPathParts.slice(0, -1).join('/');

		const oldParentId = await this.resolvePath(oldParentPath);
		const newParentId = await this.resolvePath(newParentPath, true);

		if (!oldParentId || !newParentId) {
			throw new Error('Failed to resolve parent directories for move/rename');
		}

		const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
		const queryParams = new URLSearchParams();

		if (oldParentId !== newParentId) {
			queryParams.set('addParents', newParentId);
			queryParams.set('removeParents', oldParentId);
		}

		const res = await fetch(`${url}?${queryParams.toString()}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				name: newFileName
			})
		});

		if (!res.ok) {
			throw new Error(`Failed to rename/move file: ${res.statusText}`);
		}

		this.invalidateCache(oldPath);
		
		const cleanNewPath = '/' + newPath.split('/').filter(Boolean).join('/');
		this.pathIdCache.set(cleanNewPath, fileId);
	}
}
