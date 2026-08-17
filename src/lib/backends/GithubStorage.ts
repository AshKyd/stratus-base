import type {
	StorageBackend,
	StorageFileInfo,
	StorageAuthCredentials,
	StorageOperation,
	WriteOptions
} from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';

/**
 * Configuration options for initializing the GitHub storage backend.
 */
export interface GithubStorageOptions {
	/**
	 * The GitHub repository owner (username or organisation).
	 */
	owner: string;
	/**
	 * The GitHub repository name.
	 */
	repo: string;
	/**
	 * The branch name to write/read files (default: 'main').
	 */
	branch?: string;
	/**
	 * Optional stored credentials to restore an existing session.
	 */
	credentials?: StorageAuthCredentials;
}

/**
 * Helper to clean and normalize paths for the GitHub API.
 * Returns a path without leading/trailing slashes.
 */
function cleanPath(path: string): string {
	return path.split('/').filter(Boolean).join('/');
}

/**
 * Converts a Uint8Array to a Base64 string safely in a browser/client environment.
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
	const chunks: string[] = [];
	const chunkSize = 0x8000; // 32kb chunks to avoid stack overflow
	for (let i = 0; i < arr.length; i += chunkSize) {
		const chunk = arr.subarray(i, i + chunkSize);
		chunks.push(String.fromCharCode.apply(null, chunk as any));
	}
	return btoa(chunks.join(''));
}

/**
 * StorageBackend implementation for GitHub, running exclusively on the client side.
 * Authenticates using a Personal Access Token (PAT) or fine-grained token.
 */
export class GithubStorage implements StorageBackend {
	readonly id = 'github';
	private owner: string;
	private repo: string;
	private branch: string;
	private accessToken?: string;

	constructor(options: GithubStorageOptions) {
		this.owner = options.owner;
		this.repo = options.repo;
		this.branch = options.branch || 'main';
		if (options.credentials) {
			this.setCredentials(options.credentials);
		}
	}

	/**
	 * Checks if the backend has enough credentials/configuration to perform operations.
	 */
	async isConfigured(): Promise<boolean> {
		return !!(this.owner && this.repo && this.accessToken);
	}

	/**
	 * Returns current credentials. Useful for serializing and storing them locally.
	 */
	getCredentials(): StorageAuthCredentials {
		return {
			accessToken: this.accessToken,
			owner: this.owner,
			repo: this.repo,
			branch: this.branch
		};
	}

	/**
	 * Sets credentials, allowing the application to restore a previous session.
	 */
	setCredentials(credentials: StorageAuthCredentials): void {
		this.accessToken = credentials.accessToken;
		if (credentials.owner) this.owner = credentials.owner;
		if (credentials.repo) this.repo = credentials.repo;
		if (credentials.branch) this.branch = credentials.branch;
	}

	/**
	 * Helper to generate default GitHub API headers.
	 */
	private getHeaders(): HeadersInit {
		const headers: HeadersInit = {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		};
		if (this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}
		return headers;
	}

	/**
	 * Retrieves metadata for a file or directory. Returns null if not found.
	 */
	async stat(path: string): Promise<StorageFileInfo | null> {
		const clean = cleanPath(path);
		if (clean === '') {
			return {
				path: '/',
				name: '',
				type: 'directory',
				size: 0,
				modifiedAt: new Date(0)
			};
		}

		try {
			const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${clean}?ref=${this.branch}`;
			const res = await fetch(url, {
				headers: this.getHeaders()
			});

			if (res.status === 404) {
				return null;
			}
			if (!res.ok) {
				throw new Error(`Failed to stat path ${path}: ${res.statusText}`);
			}

			const data = await res.json();

			if (Array.isArray(data)) {
				// It's a directory
				return {
					path: '/' + clean,
					name: clean.split('/').pop() || '',
					type: 'directory',
					size: 0,
					modifiedAt: new Date(0)
				};
			}

			// It's a file. Get its modification time from the commits API.
			let modifiedAt = new Date(0);
			try {
				const commitsUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/commits?path=${clean}&sha=${this.branch}&per_page=1`;
				const commitsRes = await fetch(commitsUrl, {
					headers: this.getHeaders()
				});
				if (commitsRes.ok) {
					const commits = await commitsRes.json();
					if (commits && commits[0]?.commit?.committer?.date) {
						modifiedAt = new Date(commits[0].commit.committer.date);
					}
				}
			} catch {
				// Fallback to epoch on commits API failure
			}

			return {
				path: '/' + clean,
				name: data.name,
				type: 'file',
				size: data.size,
				modifiedAt,
				etag: data.sha
			};
		} catch {
			return null;
		}
	}

	/**
	 * Reads a file's content as a binary array.
	 */
	readFile(path: string): StorageOperation<Uint8Array> {
		return new BaseStorageOperation(async (signal, onProgress) => {
			const clean = cleanPath(path);
			const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${clean}?ref=${this.branch}`;
			
			const headers = this.getHeaders() as Record<string, string>;
			headers['Accept'] = 'application/vnd.github.v3.raw';

			const res = await fetch(url, {
				headers,
				signal
			});

			if (!res.ok) {
				throw new Error(`Failed to read file ${path}: ${res.statusText}`);
			}

			const total = Number(res.headers.get('content-length') || 0);
			const reader = res.body?.getReader();
			if (!reader) {
				const buf = await res.arrayBuffer();
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
	 */
	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void> {
		return new BaseStorageOperation(async (signal) => {
			const writeToDest = async (targetPath: string) => {
				const clean = cleanPath(targetPath);
				const existing = await this.stat(targetPath);

				const base64Content = uint8ArrayToBase64(content);
				const body: Record<string, any> = {
					message: `Write ${targetPath}`,
					content: base64Content,
					branch: this.branch
				};

				if (existing && existing.type === 'file' && existing.etag) {
					body.sha = existing.etag;
				}

				const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${clean}`;
				const res = await fetch(url, {
					method: 'PUT',
					headers: this.getHeaders(),
					body: JSON.stringify(body),
					signal
				});

				if (!res.ok) {
					const errData = await res.json().catch(() => ({}));
					throw new Error(errData.message || `Failed to write file ${targetPath}: ${res.statusText}`);
				}
			};

			if (options?.atomic) {
				const tempPath = `${path}.tmp`;
				await writeToDest(tempPath);

				// Delete target destination if it exists
				try {
					await this.deleteFile(path);
				} catch {
					// Ignore if target didn't exist
				}

				// Rename temp file to destination
				await this.renameFile(tempPath, path);
			} else {
				await writeToDest(path);
			}
		});
	}

	/**
	 * Deletes a file.
	 */
	async deleteFile(path: string): Promise<void> {
		const clean = cleanPath(path);
		const existing = await this.stat(path);
		if (!existing || existing.type !== 'file' || !existing.etag) {
			return; // File doesn't exist or is not a deleteable file
		}

		const body = {
			message: `Delete ${path}`,
			sha: existing.etag,
			branch: this.branch
		};

		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${clean}`;
		const res = await fetch(url, {
			method: 'DELETE',
			headers: this.getHeaders(),
			body: JSON.stringify(body)
		});

		if (res.status !== 200 && res.status !== 404) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(errData.message || `Failed to delete file ${path}: ${res.statusText}`);
		}
	}

	/**
	 * Lists all files and directories directly under the specified path (non-recursive).
	 */
	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const clean = cleanPath(path);
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${clean}?ref=${this.branch}`;

		const res = await fetch(url, {
			headers: this.getHeaders()
		});

		if (res.status === 404) {
			try {
				const errData = await res.clone().json();
				if (errData.message && errData.message.includes('This repository is empty')) {
					return [];
				}
			} catch {
				// Ignore JSON parse errors
			}
			throw new Error(`Directory not found: ${path}`);
		}
		if (!res.ok) {
			throw new Error(`Failed to list directory ${path}: ${res.statusText}`);
		}

		const data = await res.json();
		const items = Array.isArray(data) ? data : [data];

		return items.map((item: any) => ({
			path: '/' + cleanPath(item.path),
			name: item.name,
			type: item.type === 'dir' ? 'directory' : 'file',
			size: item.type === 'dir' ? 0 : item.size,
			modifiedAt: new Date(0), // Default to epoch to avoid rate limits
			etag: item.sha
		}));
	}

	/**
	 * Helper to recursively list all files and subdirectories.
	 */
	private async listDirectoryRecursive(path: string): Promise<StorageFileInfo[]> {
		const items = await this.listDirectory(path);
		const results: StorageFileInfo[] = [];
		for (const item of items) {
			results.push(item);
			if (item.type === 'directory') {
				const subItems = await this.listDirectoryRecursive(item.path);
				results.push(...subItems);
			}
		}
		return results;
	}

	/**
	 * Renames or moves a file or directory.
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const oldStat = await this.stat(oldPath);
		if (!oldStat) {
			throw new Error(`Source path not found: ${oldPath}`);
		}

		if (oldStat.type === 'directory') {
			const files = await this.listDirectoryRecursive(oldPath);
			// Move files from deepest paths first
			const sortedFiles = files.sort((a, b) => b.path.length - a.path.length);
			for (const file of sortedFiles) {
				if (file.type === 'file') {
					const relativePath = file.path.substring(oldPath.length);
					const targetPath = newPath + relativePath;
					await this.renameFile(file.path, targetPath);
				}
			}
		} else {
			const contentOp = this.readFile(oldPath);
			const content = await contentOp.finished;
			const writeOp = this.writeFile(newPath, content);
			await writeOp.finished;
			await this.deleteFile(oldPath);
		}
	}
}
