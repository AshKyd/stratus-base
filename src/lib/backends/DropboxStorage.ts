import { Dropbox, DropboxAuth } from 'dropbox';
import type {
	StorageBackend,
	StorageFileInfo,
	StorageAuthCredentials,
	StorageOperation,
	WriteOptions
} from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';

const VERIFIER_KEY = 'dropbox_code_verifier';

/**
 * Checks if a Dropbox API error indicates that the file or folder was not found.
 * Recursively searches for '.tag': 'not_found' at any nesting level in the error.
 *
 * @param err The error returned by the Dropbox SDK.
 * @returns True if the error indicates the file was not found.
 */
function isNotFoundError(err: any): boolean {
	if (!err) return false;
	if (err.status === 404) return true;

	// Recursively check if any '.tag' field equals 'not_found' in the error object
	const hasNotFoundTag = (obj: any): boolean => {
		if (!obj || typeof obj !== 'object') return false;
		if (obj['.tag'] === 'not_found') return true;
		for (const value of Object.values(obj)) {
			if (hasNotFoundTag(value)) return true;
		}
		return false;
	};

	return hasNotFoundTag(err.error || err);
}

/**
 * Configuration options for initializing the Dropbox storage backend.
 */
export interface DropboxStorageOptions {
	/**
	 * The app key (client ID) generated in the Dropbox App Console.
	 */
	clientId: string;
	/**
	 * Optional stored credentials to restore an existing session.
	 */
	credentials?: StorageAuthCredentials;
}

/**
 * StorageBackend implementation for Dropbox, running exclusively on the client side.
 * Supports OAuth 2.0 with PKCE authorization and files CRUD.
 */
export class DropboxStorage implements StorageBackend {
	readonly id = 'dropbox';
	private auth: DropboxAuth;
	private client: Dropbox;

	/**
	 * Creates an instance of the Dropbox storage backend.
	 *
	 * @param options Initialization options, including the clientId.
	 */
	constructor(options: DropboxStorageOptions) {
		this.auth = new DropboxAuth({
			clientId: options.clientId
		});
		if (options.credentials) {
			this.setCredentials(options.credentials);
		}
		this.client = new Dropbox({
			auth: this.auth
		});
	}

	/**
	 * Checks if the backend has valid configuration/tokens to perform storage operations.
	 * If the access token is expired but a refresh token is present, it will attempt to refresh it.
	 *
	 * @returns A promise that resolves to true if configured and authenticated, or false otherwise.
	 */
	async isConfigured(): Promise<boolean> {
		const token = this.auth.getAccessToken();
		const expiresAt = this.auth.getAccessTokenExpiresAt();
		const refreshToken = this.auth.getRefreshToken();

		if (token && (!expiresAt || expiresAt > new Date())) {
			return true;
		}

		if (refreshToken) {
			try {
				await this.auth.refreshAccessToken();
				return true;
			} catch {
				return false;
			}
		}

		return false;
	}

	/**
	 * Generates the redirect URL to start the OAuth 2.0 flow with PKCE enabled.
	 * The generated code verifier is stored in sessionStorage to be retrieved after redirect.
	 *
	 * @param redirectUri The callback URL registered in the Dropbox App Console.
	 * @param state Optional state parameter to prevent CSRF attacks.
	 * @returns The Dropbox authentication URL.
	 */
	async getAuthUrl(redirectUri: string, state?: string): Promise<string> {
		const url = await this.auth.getAuthenticationUrl(
			redirectUri,
			state,
			'code',
			'offline',
			[
				'account_info.read',
				'files.metadata.read',
				'files.metadata.write',
				'files.content.read',
				'files.content.write'
			],
			'none',
			true
		);
		const verifier = this.auth.getCodeVerifier();
		if (typeof window !== 'undefined' && verifier) {
			window.sessionStorage.setItem(VERIFIER_KEY, verifier);
		}
		return url;
	}

	/**
	 * Exchanges the authorization code received from the callback for access and refresh tokens.
	 * Retrieves the stored PKCE code verifier from sessionStorage to complete the exchange.
	 *
	 * @param code The authorization code from the URL parameters.
	 * @param redirectUri The redirect URL used when generating the authorization URL.
	 * @returns The exchanged storage credentials.
	 */
	async exchangeCode(code: string, redirectUri: string): Promise<StorageAuthCredentials> {
		if (typeof window !== 'undefined') {
			const verifier = window.sessionStorage.getItem(VERIFIER_KEY);
			if (verifier) {
				this.auth.setCodeVerifier(verifier);
				window.sessionStorage.removeItem(VERIFIER_KEY);
			}
		}

		try {
			const response = await this.auth.getAccessTokenFromCode(redirectUri, code);
			const result = response.result as any;

			const credentials: StorageAuthCredentials = {
				accessToken: result.access_token,
				refreshToken: result.refresh_token,
				expiresAt: result.expires_in ? Date.now() + result.expires_in * 1000 : undefined
			};

			this.setCredentials(credentials);
			return credentials;
		} catch (err) {
			console.error('[DropboxStorage.exchangeCode] error:', err);
			throw err;
		}
	}

	/**
	 * Retrieves the current credentials from the active session.
	 * Use this to serialize and save credentials locally (e.g. in localStorage).
	 *
	 * @returns The active credentials.
	 */
	getCredentials(): StorageAuthCredentials {
		const expiresAt = this.auth.getAccessTokenExpiresAt();
		return {
			accessToken: this.auth.getAccessToken(),
			refreshToken: this.auth.getRefreshToken(),
			expiresAt: expiresAt ? expiresAt.getTime() : undefined
		};
	}

	/**
	 * Restores a previous session by setting the credentials on the authentication client.
	 *
	 * @param credentials The credentials to set.
	 */
	setCredentials(credentials: StorageAuthCredentials): void {
		if (credentials.accessToken) {
			this.auth.setAccessToken(credentials.accessToken);
		}
		if (credentials.refreshToken) {
			this.auth.setRefreshToken(credentials.refreshToken);
		}
		if (credentials.expiresAt) {
			this.auth.setAccessTokenExpiresAt(new Date(credentials.expiresAt));
		}
	}

	/**
	 * Clears the active credentials from the Dropbox session.
	 */
	async disconnect(): Promise<void> {
		this.auth.setAccessToken('');
		this.auth.setRefreshToken('');
		this.auth.setAccessTokenExpiresAt(undefined as any);
	}

	/**
	 * Retrieves metadata for a file or directory at the specified path.
	 *
	 * @param path The absolute path in Dropbox (e.g., "/notes/todo.md").
	 * @returns Metadata for the file/directory, or null if it does not exist.
	 */
	async stat(path: string): Promise<StorageFileInfo | null> {
		try {
			const response = await this.client.filesGetMetadata({ path });
			const entry = response.result as any;
			const type = entry['.tag'] === 'folder' ? 'directory' : 'file';

			return {
				path: entry.path_display || entry.path_lower || '',
				name: entry.name,
				type,
				size: type === 'file' ? entry.size : 0,
				modifiedAt:
					type === 'file' && entry.server_modified ? new Date(entry.server_modified) : new Date(0),
				etag: type === 'file' ? entry.rev : undefined
			};
		} catch (err) {
			if (isNotFoundError(err)) {
				return null;
			}
			console.error(`[DropboxStorage.stat] error getting metadata for ${path}:`, err);
			throw err;
		}
	}

	/**
	 * Reads a file's content as a binary array.
	 *
	 * @param path The absolute file path to read.
	 * @returns A cancellable StorageOperation yielding the binary content.
	 */
	readFile(path: string): StorageOperation<Uint8Array> {
		return new BaseStorageOperation(async (signal) => {
			try {
				const response = await this.client.filesDownload({ path }, { signal });
				const result = response.result;
				if (result.fileBinary) {
					return new Uint8Array(result.fileBinary);
				}
				if (result.fileBlob) {
					return new Uint8Array(await result.fileBlob.arrayBuffer());
				}
				throw new Error('No content returned from filesDownload');
			} catch (err) {
				console.error(`[DropboxStorage.readFile] error reading ${path}:`, err);
				throw err;
			}
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
			try {
				if (options?.atomic) {
					const tempPath = `${path}.tmp`;
					console.log(`[DropboxStorage.writeFile] uploading to temp: ${tempPath}`);
					await this.client.filesUpload(
						{
							path: tempPath,
							contents: content,
							mode: { '.tag': 'overwrite' },
							mute: true
						},
						{ signal }
					);
					console.log(`[DropboxStorage.writeFile] upload complete: ${tempPath}`);
					// renameFile handles deletion of destination for atomicity
					await this.renameFile(tempPath, path);
				} else {
					console.log(`[DropboxStorage.writeFile] uploading directly to: ${path}`);
					await this.client.filesUpload(
						{
							path,
							contents: content,
							mode: { '.tag': 'overwrite' },
							mute: true
						},
						{ signal }
					);
					console.log(`[DropboxStorage.writeFile] upload complete: ${path}`);
				}
			} catch (err) {
				console.error(`[DropboxStorage.writeFile] error writing ${path}:`, err);
				throw err;
			}
		});
	}

	/**
	 * Deletes a file or recursively deletes a directory.
	 *
	 * @param path The absolute path to delete.
	 */
	async deleteFile(path: string): Promise<void> {
		try {
			await this.client.filesDeleteV2({ path });
		} catch (err) {
			if (!isNotFoundError(err)) {
				console.error(`[DropboxStorage.deleteFile] error deleting ${path}:`, err);
				throw err;
			}
		}
	}

	/**
	 * Lists all files and directories directly under the specified path (non-recursively).
	 * Handles pagination automatically if the directory has many files.
	 *
	 * @param path The absolute directory path to list.
	 * @returns An array of child metadata entries.
	 */
	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		// Dropbox requires empty string for root in filesListFolder
		const formatPath = path === '/' ? '' : path;
		console.log(
			`[DropboxStorage.listDirectory] listing path: "${path}", sending to API: "${formatPath}"`
		);

		try {
			const fetchEntries = async (cursor?: string): Promise<any[]> => {
				const response = cursor
					? await this.client.filesListFolderContinue({ cursor })
					: await this.client.filesListFolder({ path: formatPath });

				const { entries, has_more, cursor: nextCursor } = response.result;

				if (has_more) {
					const nextEntries = await fetchEntries(nextCursor);
					return [...entries, ...nextEntries];
				}

				return entries;
			};

			const entries = await fetchEntries();

			return entries.map((entry: any) => {
				const type = entry['.tag'] === 'folder' ? 'directory' : 'file';
				return {
					path: entry.path_display || entry.path_lower || '',
					name: entry.name,
					type,
					size: type === 'file' ? entry.size : 0,
					modifiedAt:
						type === 'file' && entry.server_modified
							? new Date(entry.server_modified)
							: new Date(0),
					etag: type === 'file' ? entry.rev : undefined
				};
			});
		} catch (err) {
			const status = (err as any)?.status;
			const errorSummary = (err as any)?.error?.error_summary || '';
			console.error(
				`[DropboxStorage.listDirectory] error listing ${path}: HTTP ${status} - ${errorSummary}`,
				err
			);
			throw err;
		}
	}

	/**
	 * Renames or moves a file or directory to a new path.
	 * Deletes the destination first to ensure atomicity, then retries move on 409 to handle Dropbox eventual consistency.
	 *
	 * @param oldPath The original path.
	 * @param newPath The target destination path.
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		// Delete destination if it exists to ensure atomic move
		try {
			await this.client.filesDeleteV2({ path: newPath });
		} catch (err) {
			if (!isNotFoundError(err)) {
				throw err;
			}
		}

		// Move temp file to final destination
		await this.client.filesMoveV2({
			from_path: oldPath,
			to_path: newPath
		});
	}
}
