import {
	S3Client,
	HeadObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	ListObjectsV2Command,
	CopyObjectCommand,
	NoSuchKey
} from '@aws-sdk/client-s3';
import type { StorageBackend, StorageFileInfo, StorageOperation, WriteOptions } from '../types.ts';
import { BaseStorageOperation } from '../utils/BaseStorageOperation.ts';

/**
 * Configuration options for initializing the S3 storage backend.
 */
export interface S3StorageOptions {
	/**
	 * AWS access key ID.
	 */
	accessKeyId: string;
	/**
	 * AWS secret access key.
	 */
	secretAccessKey: string;
	/**
	 * Optional AWS session token for temporary credentials.
	 */
	sessionToken?: string;
	/**
	 * The AWS region where the bucket is located.
	 */
	region: string;
	/**
	 * The name of the S3 bucket.
	 */
	bucket: string;
	/**
	 * Optional custom endpoint URL (e.g., for MinIO or LocalStack).
	 */
	endpoint?: string;
	/**
	 * Whether to force path-style URLs (bucket in path instead of subdomain).
	 */
	forcePathStyle?: boolean;
}

/**
 * StorageBackend implementation for AWS S3 and S3-compatible APIs.
 * Supports standard CRUD operations and custom endpoints.
 */
export class S3Storage implements StorageBackend {
	readonly id = 's3';
	private options: S3StorageOptions;
	private client: S3Client;

	/**
	 * Initialises the S3 storage client with the provided options.
	 *
	 * @param options The configuration options for S3 storage.
	 */
	constructor(options: S3StorageOptions) {
		this.options = options;
		this.client = new S3Client({
			region: options.region,
			endpoint: options.endpoint,
			forcePathStyle: options.forcePathStyle ?? false,
			credentials: {
				accessKeyId: options.accessKeyId,
				secretAccessKey: options.secretAccessKey,
				sessionToken: options.sessionToken
			}
		});
	}

	/**
	 * Checks if the backend has valid configuration to perform storage operations.
	 *
	 * @returns A promise resolving to true if configured, or false otherwise.
	 */
	async isConfigured(): Promise<boolean> {
		return !!(this.options.accessKeyId && this.options.secretAccessKey && this.options.bucket);
	}

	/**
	 * Normalises a file path to a standard S3 key.
	 * Strips the leading slash for standard S3 conventions.
	 *
	 * @param path The path to normalise.
	 * @returns The normalised S3 key.
	 */
	private normalizeKey(path: string): string {
		// S3 keys should not start with a leading slash unless desired, but usually they are relative to bucket root.
		// Let's strip the leading slash for standard S3 conventions.
		return path.startsWith('/') ? path.slice(1) : path;
	}

	/**
	 * Denormalises an S3 key back to a standard file path starting with a slash.
	 *
	 * @param key The S3 key to denormalise.
	 * @returns The denormalised path.
	 */
	private denormalizeKey(key: string): string {
		return key.startsWith('/') ? key : '/' + key;
	}

	/**
	 * Retrieves metadata for a file or directory at the specified path.
	 *
	 * @param path The path to query.
	 * @returns A promise resolving to the file info, or null if it does not exist.
	 */
	async stat(path: string): Promise<StorageFileInfo | null> {
		const key = this.normalizeKey(path);

		// Special case for root directory
		if (key === '') {
			return {
				path: '/',
				name: '',
				type: 'directory',
				size: 0,
				modifiedAt: new Date(0)
			};
		}

		try {
			const res = await this.client.send(
				new HeadObjectCommand({
					Bucket: this.options.bucket,
					Key: key
				})
			);

			const name = key.split('/').pop() || '';
			return {
				path: this.denormalizeKey(key),
				name,
				type: 'file',
				size: res.ContentLength ?? 0,
				modifiedAt: res.LastModified ?? new Date(0),
				etag: res.ETag
			};
		} catch (err: any) {
			// Check if it's a directory by listing the parent directory and checking for its presence
			try {
				const segments = key.split('/').filter(Boolean);
				if (segments.length > 0) {
					const name = segments[segments.length - 1];
					const parentPath = '/' + segments.slice(0, -1).join('/');
					const parentListing = await this.listDirectory(parentPath);
					const match = parentListing.find(
						(item) => item.name === name && item.type === 'directory'
					);
					if (match) {
						return match;
					}
				}
			} catch {
				// Ignore listing failures
			}

			const isNotFound =
				err instanceof NoSuchKey ||
				err.name === 'NoSuchKey' ||
				err.name === 'NotFound' ||
				err.code === 'NoSuchKey' ||
				err.code === 'NotFound' ||
				err.$metadata?.httpStatusCode === 404;

			if (isNotFound) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Reads file contents from the S3 bucket.
	 * Supports progress callbacks and client-side cancellation.
	 *
	 * @param path The path of the file to read.
	 * @returns A storage operation containing the file data as a Uint8Array.
	 */
	readFile(path: string): StorageOperation<Uint8Array> {
		const key = this.normalizeKey(path);
		return new BaseStorageOperation(async (signal, onProgress) => {
			const res = await this.client.send(
				new GetObjectCommand({
					Bucket: this.options.bucket,
					Key: key
				}),
				{ abortSignal: signal }
			);

			if (!res.Body) {
				throw new Error('S3 response body is empty');
			}

			const total = res.ContentLength ?? 0;
			const reader = (res.Body as any).getReader ? (res.Body as any).getReader() : null;

			if (reader) {
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
			} else {
				// Node or alternative stream
				const bytes = await res.Body.transformToByteArray();
				onProgress(bytes.length, bytes.length);
				return bytes;
			}
		});
	}

	/**
	 * Writes content to a file in the S3 bucket.
	 * Supports atomic writes via a temporary file when requested.
	 *
	 * @param path The path to write to.
	 * @param content The byte contents of the file.
	 * @param options Optional configuration like atomic write flag.
	 * @returns A storage operation that resolves when the write completes.
	 */
	writeFile(path: string, content: Uint8Array, options?: WriteOptions): StorageOperation<void> {
		const key = this.normalizeKey(path);
		return new BaseStorageOperation(async (signal) => {
			const upload = async (targetKey: string) => {
				await this.client.send(
					new PutObjectCommand({
						Bucket: this.options.bucket,
						Key: targetKey,
						Body: content
					}),
					{ abortSignal: signal }
				);
			};

			if (options?.atomic) {
				const tempKey = `${key}.tmp`;
				await upload(tempKey);

				try {
					await this.client.send(
						new DeleteObjectCommand({
							Bucket: this.options.bucket,
							Key: key
						})
					);
				} catch {
					// Ignore error if target file doesn't exist
				}

				await this.client.send(
					new CopyObjectCommand({
						Bucket: this.options.bucket,
						CopySource: `${this.options.bucket}/${tempKey}`,
						Key: key
					})
				);

				await this.client.send(
					new DeleteObjectCommand({
						Bucket: this.options.bucket,
						Key: tempKey
					})
				);
			} else {
				await upload(key);
			}
		});
	}

	/**
	 * Deletes a file or recursively deletes a directory at the specified path.
	 *
	 * @param path The path to delete.
	 * @returns A promise resolving when deletion is complete.
	 */
	async deleteFile(path: string): Promise<void> {
		const key = this.normalizeKey(path);

		// Check if it's a directory
		const info = await this.stat(path);
		if (!info) return;

		if (info.type === 'directory') {
			const prefix = key.endsWith('/') ? key : key + '/';
			let continuationToken: string | undefined;

			do {
				const listRes = await this.client.send(
					new ListObjectsV2Command({
						Bucket: this.options.bucket,
						Prefix: prefix,
						ContinuationToken: continuationToken
					})
				);

				if (listRes.Contents) {
					await Promise.all(
						listRes.Contents.map((obj) => {
							if (!obj.Key) return Promise.resolve();
							return this.client.send(
								new DeleteObjectCommand({
									Bucket: this.options.bucket,
									Key: obj.Key
								})
							);
						})
					);
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);
		} else {
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.options.bucket,
					Key: key
				})
			);
		}
	}

	/**
	 * Lists all files and subdirectories directly inside the specified directory path.
	 *
	 * @param path The directory path to list.
	 * @returns A promise resolving to an array of file and directory metadata.
	 */
	async listDirectory(path: string): Promise<StorageFileInfo[]> {
		const rawKey = this.normalizeKey(path);
		const prefix = rawKey === '' ? '' : rawKey.endsWith('/') ? rawKey : rawKey + '/';

		const files: StorageFileInfo[] = [];
		let continuationToken: string | undefined;

		do {
			const res = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.options.bucket,
					Prefix: prefix,
					Delimiter: '/',
					ContinuationToken: continuationToken
				})
			);

			if (res.CommonPrefixes) {
				for (const p of res.CommonPrefixes) {
					if (!p.Prefix) continue;
					const name = p.Prefix.slice(prefix.length).replace(/\/$/, '');
					if (!name) continue;
					files.push({
						path: this.denormalizeKey(p.Prefix.replace(/\/$/, '')),
						name,
						type: 'directory',
						size: 0,
						modifiedAt: new Date(0)
					});
				}
			}

			if (res.Contents) {
				for (const obj of res.Contents) {
					if (!obj.Key || obj.Key === prefix) continue;
					const name = obj.Key.slice(prefix.length);
					if (!name) continue;
					files.push({
						path: this.denormalizeKey(obj.Key),
						name,
						type: 'file',
						size: obj.Size ?? 0,
						modifiedAt: obj.LastModified ?? new Date(0),
						etag: obj.ETag
					});
				}
			}

			continuationToken = res.NextContinuationToken;
		} while (continuationToken);

		return files;
	}

	/**
	 * Renames (moves) a file within the S3 bucket by copying to the new path and deleting the old.
	 *
	 * @param oldPath The current path of the file.
	 * @param newPath The destination path.
	 * @returns A promise resolving when the rename completes.
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const oldKey = this.normalizeKey(oldPath);
		const newKey = this.normalizeKey(newPath);

		await this.client.send(
			new CopyObjectCommand({
				Bucket: this.options.bucket,
				CopySource: `${this.options.bucket}/${oldKey}`,
				Key: newKey
			})
		);

		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.options.bucket,
				Key: oldKey
			})
		);
	}
}
