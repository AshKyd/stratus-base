import type {
	StorageBackend,
	StorageFileInfo,
	StorageAuthCredentials,
	StorageOperation,
	WriteOptions
} from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';
import { clearCredentials } from '../utils/CredentialManager.ts';

/**
 * Authentication lifecycle events emitted by {@link GoogleDriveStorage}.
 *
 * - `token-expiring` — the access token is approaching expiry. Renew it from a user
 *   gesture while it is still valid.
 * - `token-renewed` — a new access token was obtained. Persist the supplied credentials.
 * - `reauth-required` — silent renewal is not possible and the full interactive flow
 *   must be run.
 */
export type GoogleAuthEvent = 'token-expiring' | 'token-renewed' | 'reauth-required';

/**
 * Why silent renewal could not complete. `popup-blocked` means the browser suppressed
 * the renewal window, which happens when renewal is not triggered by a user gesture.
 */
export type GoogleReauthReason =
	| 'popup-blocked'
	| 'popup-closed'
	| 'timeout'
	| 'unauthorised'
	| 'login_required'
	| 'consent_required'
	| 'interaction_required';

export interface GoogleAuthEventPayloads {
	'token-expiring': { expiresAt: number };
	'token-renewed': StorageAuthCredentials;
	'reauth-required': { reason: GoogleReauthReason };
}

/**
 * Outcome of handling an OAuth redirect, returned by
 * {@link GoogleDriveStorage.handleAuthCallback}.
 *
 * `popup` means the result was handed back to the opening window and this window is
 * closing itself — the callback route should render nothing further.
 */
export type GoogleAuthCallbackResult =
	| { mode: 'popup' }
	| { mode: 'redirect'; credentials: StorageAuthCredentials; state?: string }
	| { mode: 'error'; error: string; state?: string };

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
	/**
	 * Default OAuth callback URL, used by `getAuthUrl()` and `renewAccessToken()` when no
	 * URI is passed explicitly. Must exactly match an authorised redirect URI in the
	 * Google Cloud Console.
	 */
	redirectUri?: string;
	/**
	 * How long before expiry to emit `token-expiring`, in milliseconds. Defaults to 10
	 * minutes, which gives an active user several opportunities to renew on a gesture
	 * before the token actually lapses.
	 */
	expiryWarningMs?: number;
}

/** Marks the `state` of a renewal request so the callback can route it to the opener. */
const RENEWAL_STATE_PREFIX = 'stratus-renew:';

/** Identifies postMessage payloads sent by the callback handler. */
const MESSAGE_SOURCE = 'stratus-base';

const DEFAULT_EXPIRY_WARNING_MS = 10 * 60 * 1000;

/**
 * StorageBackend implementation for Google Drive, running exclusively on the client side.
 * Supports OAuth 2.0 with PKCE authorization and files CRUD.
 */
export class GoogleDriveStorage extends EventTarget implements StorageBackend {
	readonly id = 'google-drive';
	private clientId: string;
	private accessToken?: string;
	private refreshToken?: string;
	private expiresAt?: number;
	private folderName?: string;
	private rootFolderId?: string;
	private redirectUri?: string;
	private expiryWarningMs: number;

	// Local cache mapping paths to Google Drive file IDs
	private pathIdCache = new Map<string, string>();

	private expiryTimer?: ReturnType<typeof setTimeout>;

	// Coalesces concurrent renewal attempts into a single popup.
	private renewalPromise?: Promise<StorageAuthCredentials>;

	constructor(options: GoogleDriveStorageOptions) {
		super();
		this.clientId = options.clientId;
		this.folderName = options.folderName;
		this.redirectUri = options.redirectUri;
		this.expiryWarningMs = options.expiryWarningMs ?? DEFAULT_EXPIRY_WARNING_MS;
		if (options.credentials) {
			this.setCredentials(options.credentials);
		}
	}

	/**
	 * Returns the configuration hash identifier for Google Drive credential storage.
	 */
	getConfigHash(): string {
		return `google-drive:${this.clientId}`;
	}

	/**
	 * Helper to dispatch both kebab-case and normalised native CustomEvents.
	 */
	private emit<E extends GoogleAuthEvent>(event: E, payload: GoogleAuthEventPayloads[E]): void {
		const normalized = event.replace(/-/g, '');
		this.dispatchEvent(new CustomEvent(normalized, { detail: payload }));
		if (normalized !== event) {
			this.dispatchEvent(new CustomEvent(event, { detail: payload }));
		}
	}

	/**
	 * Subscribes to an authentication lifecycle event.
	 *
	 * @returns An unsubscribe function.
	 */
	on<E extends GoogleAuthEvent>(
		event: E,
		callback: (payload: GoogleAuthEventPayloads[E]) => void
	): () => void {
		const handler = (e: Event) => callback((e as CustomEvent).detail);
		this.addEventListener(event, handler);
		return () => {
			this.removeEventListener(event, handler);
		};
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
	 * @param redirectUri The callback URL registered in the Google Cloud Console. Falls back
	 *   to the `redirectUri` given to the constructor.
	 * @param state Optional state parameter, returned unchanged on the callback. Use it to
	 *   record where the user should land once authorisation completes.
	 * @param options.prompt Passed through to Google. `none` suppresses all UI and instead
	 *   returns an error when the request cannot be satisfied silently.
	 * @returns The Google OAuth URL.
	 */
	async getAuthUrl(
		redirectUri?: string,
		state?: string,
		options?: { prompt?: 'none' | 'consent' | 'select_account' }
	): Promise<string> {
		const callbackUri = redirectUri ?? this.redirectUri;
		if (!callbackUri) {
			throw new Error(
				'No redirect URI available. Pass one to getAuthUrl(), or set redirectUri when constructing GoogleDriveStorage.'
			);
		}

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: callbackUri,
			response_type: 'token',
			scope: 'https://www.googleapis.com/auth/drive.file'
		});

		if (state) {
			params.set('state', state);
		}

		if (options?.prompt) {
			params.set('prompt', options.prompt);
		}

		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	/**
	 * Attempts to obtain a fresh access token without showing the consent screen, by opening
	 * a short-lived popup against Google with `prompt=none`.
	 *
	 * Browsers only permit popups opened during a user gesture, so this must be called from
	 * a click/keypress handler. The practical pattern is to listen for `token-expiring` and
	 * renew on the user's next interaction, well before the token actually lapses.
	 *
	 * Concurrent calls share a single popup.
	 *
	 * @throws If the popup is blocked, dismissed, times out, or Google declines to authorise
	 *   silently. `reauth-required` is emitted in each of those cases.
	 */
	async renewAccessToken(
		options: { redirectUri?: string; timeoutMs?: number } = {}
	): Promise<StorageAuthCredentials> {
		if (this.renewalPromise) {
			return this.renewalPromise;
		}

		this.renewalPromise = this.runSilentRenewal(
			options.redirectUri ?? this.redirectUri,
			options.timeoutMs ?? 30_000
		).finally(() => {
			this.renewalPromise = undefined;
		});

		return this.renewalPromise;
	}

	private async runSilentRenewal(
		redirectUri: string | undefined,
		timeoutMs: number
	): Promise<StorageAuthCredentials> {
		if (typeof window === 'undefined') {
			throw new Error('renewAccessToken() is only available in the browser.');
		}

		const state = `${RENEWAL_STATE_PREFIX}${crypto.randomUUID()}`;
		const authUrl = await this.getAuthUrl(redirectUri, state, { prompt: 'none' });

		const popup = window.open(
			authUrl,
			'stratus-auth-renewal',
			'width=500,height=600,menubar=no,toolbar=no'
		);

		if (!popup) {
			this.emit('reauth-required', { reason: 'popup-blocked' });
			throw new Error(
				'The renewal popup was blocked. Call renewAccessToken() from a user gesture, such as a click handler.'
			);
		}

		return new Promise<StorageAuthCredentials>((resolve, reject) => {
			let settled = false;

			const cleanup = () => {
				settled = true;
				window.removeEventListener('message', onMessage);
				clearInterval(closedPoll);
				clearTimeout(timer);
				if (!popup.closed) popup.close();
			};

			const fail = (reason: GoogleReauthReason, message: string) => {
				if (settled) return;
				cleanup();
				this.emit('reauth-required', { reason });
				reject(new Error(message));
			};

			const onMessage = (event: MessageEvent) => {
				if (settled || event.origin !== window.location.origin) return;

				const data = event.data;
				if (data?.source !== MESSAGE_SOURCE || data.state !== state) return;

				if (data.error) {
					fail(data.error as GoogleReauthReason, `Silent renewal declined by Google: ${data.error}`);
					return;
				}

				cleanup();
				this.setCredentials(data.credentials);
				const credentials = this.getCredentials();
				this.emit('token-renewed', credentials);
				resolve(credentials);
			};

			window.addEventListener('message', onMessage);

			// The popup closes itself once it has posted its result; if it closes without one,
			// the user dismissed it.
			const closedPoll = setInterval(() => {
				if (popup.closed) fail('popup-closed', 'The renewal popup was closed before it completed.');
			}, 300);

			const timer = setTimeout(() => fail('timeout', 'Silent renewal timed out.'), timeoutMs);
		});
	}

	/**
	 * Reads an OAuth result from the current URL fragment. Call this from the callback route
	 * registered as your redirect URI — it serves both the interactive flow and silent
	 * renewal.
	 *
	 * When the window was opened by {@link renewAccessToken}, the result is posted back to
	 * the opener and this window closes itself. Otherwise the parsed credentials are returned
	 * along with the `state` passed to {@link getAuthUrl}, so the caller can route onward.
	 *
	 * @returns `null` when the URL carries no OAuth response.
	 */
	static handleAuthCallback(): GoogleAuthCallbackResult | null {
		if (typeof window === 'undefined') return null;

		const fragment = window.location.hash.replace(/^#/, '');
		if (!fragment) return null;

		const params = new URLSearchParams(fragment);
		const accessToken = params.get('access_token');
		const error = params.get('error');
		if (!accessToken && !error) return null;

		const state = params.get('state') ?? undefined;
		const credentials: StorageAuthCredentials | undefined = accessToken
			? {
					accessToken,
					expiresAt: Date.now() + Number(params.get('expires_in') || 3600) * 1000
				}
			: undefined;

		if (window.opener && state?.startsWith(RENEWAL_STATE_PREFIX)) {
			window.opener.postMessage(
				{ source: MESSAGE_SOURCE, state, credentials, error: error ?? undefined },
				window.location.origin
			);
			// Give the message a moment to land before tearing the window down.
			setTimeout(() => window.close(), 100);
			return { mode: 'popup' };
		}

		// Keep the access token out of the address bar and out of history.
		window.history.replaceState({}, '', window.location.pathname + window.location.search);

		if (error) return { mode: 'error', error, state };
		return { mode: 'redirect', credentials: credentials!, state };
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
		this.scheduleExpiryWarning();
		if (this.accessToken) {
			this.emit('token-renewed', this.getCredentials());
		}
	}

	/**
	 * Clears credentials and cached metadata, disconnecting Google Drive.
	 */
	async disconnect(): Promise<void> {
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.expiresAt = undefined;
		this.rootFolderId = undefined;
		this.pathIdCache.clear();
		clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
		clearCredentials();
	}

	/**
	 * Arms the `token-expiring` warning so consumers can renew while the token is still
	 * valid. Fires immediately when the token is already inside the warning window.
	 */
	private scheduleExpiryWarning(): void {
		clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;

		if (typeof window === 'undefined' || !this.expiresAt) return;

		const expiresAt = this.expiresAt;
		const delay = Math.max(0, expiresAt - this.expiryWarningMs - Date.now());
		this.expiryTimer = setTimeout(() => this.emit('token-expiring', { expiresAt }), delay);
	}

	/**
	 * Issues an authenticated request, flagging the session as dead when Google rejects the
	 * token. Callers still receive the response so existing error handling applies.
	 */
	private async fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(url, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` }
		});

		if (response.status === 401) {
			this.emit('reauth-required', { reason: 'unauthorised' });
		}

		return response;
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
		const res = await this.fetchWithAuth(url);

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

		const createRes = await this.fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
			method: 'POST',
			headers: {
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
			const res = await this.fetchWithAuth(url);

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
					const createRes = await this.fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
						method: 'POST',
						headers: {
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

			const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,md5Checksum,headRevisionId`;
			const res = await this.fetchWithAuth(url);

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
				// Must match the etag field `listDirectory` reports, or freshness checks that compare a
				// stat against a listing would see a change on every sync.
				etag: file.md5Checksum ?? file.headRevisionId
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

			const response = await this.fetchWithAuth(
				`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
				{ signal }
			);

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
					const res = await this.fetchWithAuth(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
						method: 'PATCH',
						headers: {
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
					const metadataRes = await this.fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
						method: 'POST',
						headers: {
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
					const res = await this.fetchWithAuth(`https://www.googleapis.com/upload/drive/v3/files/${metadata.id}?uploadType=media`, {
						method: 'PATCH',
						headers: {
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

		const res = await this.fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
			method: 'DELETE'
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
				fields:
					'nextPageToken, files(id, name, mimeType, size, modifiedTime, md5Checksum, headRevisionId)'
			});
			if (pageToken) {
				params.set('pageToken', pageToken);
			}

			const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
			const res = await this.fetchWithAuth(url);

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
				// The Drive file id is stable across edits, so it can never signal a content change.
				// md5Checksum changes with every upload; headRevisionId covers files Drive won't hash.
				etag: file.md5Checksum ?? file.headRevisionId
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

		const res = await this.fetchWithAuth(`${url}?${queryParams.toString()}`, {
			method: 'PATCH',
			headers: {
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
