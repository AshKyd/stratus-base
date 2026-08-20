export interface StorageFileInfo {
	path: string; // Absolute path within the storage namespace (e.g., "/notes/todo.md")
	name: string; // File or directory name (e.g., "todo.md")
	type: 'file' | 'directory';
	size: number; // Size in bytes
	modifiedAt: Date; // Last modification time
	etag?: string; // Optional content hash or version identifier for change tracking
}

export interface StorageAuthCredentials {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number; // Epoch timestamp in milliseconds
	[key: string]: any; // Provider-specific metadata
}

export interface StorageOperationEvents {
	progress: (progress: { loaded: number; total: number }) => void;
	retry: (error: Error, attempt: number, delayMs: number) => void;
}

export interface StorageOperation<T> {
	/**
	 * Promise that resolves when the operation completes, or rejects upon failure or cancellation.
	 */
	readonly finished: Promise<T>;

	/**
	 * Aborts the ongoing storage operation.
	 */
	cancel(): void;

	/**
	 * Registers an event listener for progress updates or internal retry notifications.
	 */
	on<E extends keyof StorageOperationEvents>(event: E, callback: StorageOperationEvents[E]): this;
}

export interface WriteOptions {
	/**
	 * Try to perform a write-then-rename if supported by the backend (atomic write).
	 */
	atomic?: boolean;
}

export interface StorageBackend {
	/**
	 * The unique identifier for this backend type (e.g., 'google-drive', 's3')
	 */
	readonly id: string;

	// --- Authentication & Configuration ---

	/**
	 * Checks if the backend has enough credentials/configuration to perform operations.
	 */
	isConfigured(): Promise<boolean>;

	/**
	 * (OAuth only) Returns the URL to redirect the user to start the authentication flow.
	 * Throws if the backend does not support OAuth.
	 */
	getAuthUrl?(redirectUri: string, state?: string): Promise<string>;

	/**
	 * (OAuth only) Exchanges an authorization code for credentials/tokens.
	 * Throws if the backend does not support OAuth.
	 */
	exchangeCode?(code: string, redirectUri: string): Promise<StorageAuthCredentials>;

	/**
	 * Returns current credentials. Useful for serializing and storing them locally.
	 */
	getCredentials?(): StorageAuthCredentials;

	/**
	 * Sets credentials, allowing the application to restore a previous session.
	 */
	setCredentials?(credentials: StorageAuthCredentials): void;

	/**
	 * Clears credentials and configuration, disconnecting the session.
	 */
	disconnect?(): Promise<void>;

	// --- File Operations ---

	/**
	 * Retrieves metadata for a file or directory. Returns null if not found.
	 */
	stat(path: string): Promise<StorageFileInfo | null>;

	/**
	 * Reads a file's content as a binary array.
	 */
	readFile(path: string): StorageOperation<Uint8Array>;

	/**
	 * Writes content to a file.
	 */
	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void>;

	/**
	 * Deletes a file or recursively deletes a directory.
	 */
	deleteFile(path: string): Promise<void>;

	/**
	 * Lists all files and directories directly under the specified path (non-recursive).
	 */
	listDirectory(path: string): Promise<StorageFileInfo[]>;

	/**
	 * Renames/moves a file or directory. Required for atomic operations and general file system actions.
	 */
	renameFile(oldPath: string, newPath: string): Promise<void>;
}
