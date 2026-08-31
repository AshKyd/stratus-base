export * from './types.ts';
export { DropboxStorage } from './backends/DropboxStorage.ts';
export type { DropboxStorageOptions } from './backends/DropboxStorage.ts';
export { GoogleDriveStorage } from './backends/GoogleDriveStorage.ts';
export type {
	GoogleDriveStorageOptions,
	GoogleAuthEvent,
	GoogleAuthEventPayloads,
	GoogleAuthCallbackResult,
	GoogleReauthReason
} from './backends/GoogleDriveStorage.ts';
export { GithubStorage } from './backends/GithubStorage.ts';
export type { GithubStorageOptions } from './backends/GithubStorage.ts';
export { S3Storage } from './backends/S3Storage.ts';
export type { S3StorageOptions } from './backends/S3Storage.ts';

export { StratusBase, SyncConflictError, SyncLockedError } from './StratusBase.ts';
export type {
	FileMetadata,
	StratusMetadata,
	SyncConflict,
	SyncResult,
	StratusSyncContext,
	StratusMiddleware,
	StratusBaseOptions,
	StratusBaseEventMap,
	SyncPhase,
	SyncProgress
} from './StratusBase.ts';

export { MiddlewareIndividualFile } from './middleware/MiddlewareIndividualFile/MiddlewareIndividualFile.ts';
export type { MiddlewareIndividualFileOptions } from './middleware/MiddlewareIndividualFile/MiddlewareIndividualFile.ts';

export { MiddlewareZipChunk } from './middleware/MiddlewareZipChunk/MiddlewareZipChunk.ts';
export type {
	MiddlewareZipChunkOptions,
	SmokeTestStep,
	SmokeTestStepReporter
} from './middleware/MiddlewareZipChunk/MiddlewareZipChunk.ts';
export { getJS7zWasmByteLength } from './utils/codec7z.ts';

export { MemoryStorage } from './backends/MemoryStorage.ts';

export { generateSecurePassword } from './utils/crypto.ts';
export {
	STRATUS_CREDENTIALS_KEY,
	loadCredentials,
	saveCredentials,
	clearCredentials
} from './utils/CredentialManager.ts';
export type { StoredSession } from './utils/CredentialManager.ts';
