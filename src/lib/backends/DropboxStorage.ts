import { Dropbox, DropboxAuth } from 'dropbox';
import type {
	StorageBackend,
	StorageFileInfo,
	StorageAuthCredentials,
	StorageOperation,
	StorageOperationEvents,
	WriteOptions
} from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';

const VERIFIER_KEY = 'dropbox_code_verifier';

/**
 * Checks if a Dropbox API error indicates that the file or folder was not found.
 *
 * @param err The error returned by the Dropbox SDK.
 * @returns True if the error is a 404 or path not_found error, false otherwise.
 */
function isNotFoundError(err: any): boolean {
	if (!err) return false;
	if (err.status === 404) return true;
	const errorObj = err.error || err;
	const pathError = errorObj.path || errorObj.error?.path;
	if (pathError && pathError['.tag'] === 'not_found') {
		return true;
	}
	if (typeof errorObj === 'object') {
		const tag = errorObj['.tag'] || (errorObj.error && errorObj.error['.tag']);
		if (tag === 'not_found') return true;
	}
	return false;
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

		const response = await this.auth.getAccessTokenFromCode(redirectUri, code);
		const result = response.result as any;

		const credentials: StorageAuthCredentials = {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt: result.expires_in ? Date.now() + result.expires_in * 1000 : undefined
		};

		this.setCredentials(credentials);
		return credentials;
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
			const response = await this.client.filesDownload({ path }, { signal });
			const result = response.result;
			if (result.fileBinary) {
				return new Uint8Array(result.fileBinary);
			}
			if (result.fileBlob) {
				return new Uint8Array(await result.fileBlob.arrayBuffer());
			}
			throw new Error('No content returned from filesDownload');
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
			if (options?.atomic) {
				const tempPath = `${path}.tmp`;
				await this.client.filesUpload(
					{
						path: tempPath,
						contents: content,
						mode: { '.tag': 'overwrite' },
						mute: true
					},
					{ signal }
				);

				try {
					await this.client.filesDeleteV2({ path });
				} catch (err) {
					if (!isNotFoundError(err)) {
						throw err;
					}
				}

				await this.client.filesMoveV2({
					from_path: tempPath,
					to_path: path
				});
			} else {
				await this.client.filesUpload(
					{
						path,
						contents: content,
						mode: { '.tag': 'overwrite' },
						mute: true
					},
					{ signal }
				);
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
		const formatPath = path === '/' ? '' : path;

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
					type === 'file' && entry.server_modified ? new Date(entry.server_modified) : new Date(0),
				etag: type === 'file' ? entry.rev : undefined
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
		await this.client.filesMoveV2({
			from_path: oldPath,
			to_path: newPath
		});
	}
}
