import type {
	StorageBackend,
	StorageFileInfo
} from './types.ts';
import type {
	StratusMiddleware,
	StratusSyncContext,
	SyncConflict,
	SyncResult
} from './StratusBase.ts';
import { SyncConflictError } from './StratusBase.ts';

export interface MiddlewareIndividualFileOptions {
	atomic?: boolean;
}

export class MiddlewareIndividualFile implements StratusMiddleware {
	private options: MiddlewareIndividualFileOptions;

	constructor(options: MiddlewareIndividualFileOptions = {}) {
		this.options = options;
	}

	private async listRemoteFilesRecursive(
		backend: StorageBackend,
		path: string
	): Promise<StorageFileInfo[]> {
		const results: StorageFileInfo[] = [];
		const walk = async (dirPath: string) => {
			const items = await backend.listDirectory(dirPath);
			for (const item of items) {
				if (item.type === 'directory') {
					await walk(item.path);
				} else {
					results.push(item);
				}
			}
		};
		await walk(path);
		return results;
	}

	private appendUpdatesSuffix(filePath: string): string {
		const lastDot = filePath.lastIndexOf('.');
		const lastSlash = filePath.lastIndexOf('/');
		if (lastDot > lastSlash && lastDot !== -1) {
			return filePath.slice(0, lastDot) + '_updates' + filePath.slice(lastDot);
		}
		return filePath + '_updates';
	}

	async sync(context: StratusSyncContext): Promise<SyncResult> {
		const remoteFiles = await this.listRemoteFilesRecursive(context.backend, '/');
		const remoteMap = new Map<string, StorageFileInfo>();
		for (const rf of remoteFiles) {
			remoteMap.set(rf.path, rf);
		}

		const metadata = await context.getLocalMetadata();
		const localFiles = metadata.files;
		const allPaths = new Set([...remoteMap.keys(), ...Object.keys(localFiles)]);

		const conflicts: SyncConflict[] = [];
		const created: string[] = [];
		const updated: string[] = [];
		const deleted: string[] = [];

		for (const path of allPaths) {
			const remoteFile = remoteMap.get(path);
			const localFile = localFiles[path];

			if (remoteFile && !localFile) {
				// Case A: Remote only (new file on remote)
				if (context.sparse) {
					localFiles[path] = {
						path,
						type: 'file',
						size: remoteFile.size,
						localModifiedAt: remoteFile.modifiedAt.getTime(),
						remoteModifiedAt: remoteFile.modifiedAt.getTime(),
						etag: remoteFile.etag,
						status: 'clean'
					};
					created.push(path);
				} else {
					const op = context.backend.readFile(path);
					const content = await op.finished;
					await context.writeLocalFile(path, content);
					localFiles[path] = {
						path,
						type: 'file',
						size: remoteFile.size,
						localModifiedAt: remoteFile.modifiedAt.getTime(),
						remoteModifiedAt: remoteFile.modifiedAt.getTime(),
						etag: remoteFile.etag,
						status: 'clean'
					};
					created.push(path);
				}
			} else if (!remoteFile && localFile) {
				// Local entry exists but not on remote
				if (localFile.status === 'deleted') {
					// Local only, already deleted, remove from metadata
					delete localFiles[path];
				} else if (localFile.status === 'dirty') {
					// Case B: Local only (created locally, not yet on remote)
					const content = await context.readLocalFile(path);
					const op = context.backend.writeFile(path, content, { atomic: this.options.atomic });
					await op.finished;

					const stat = await context.backend.stat(path);
					const modifiedAt = stat?.modifiedAt ?? new Date();
					const etag = stat?.etag;

					localFiles[path] = {
						...localFile,
						status: 'clean',
						remoteModifiedAt: modifiedAt.getTime(),
						etag
					};
					created.push(path);
				} else if (localFile.status === 'clean') {
					// Remote deleted it, and we didn't touch it locally
					await context.deleteLocalFile(path);
					delete localFiles[path];
					deleted.push(path);
				} else if (localFile.status === 'conflict') {
					// Keep conflict status
					conflicts.push({
						path,
						localModifiedAt: new Date(localFile.localModifiedAt),
						remoteModifiedAt: new Date(0),
						type: 'conflict'
					});
				}
			} else if (remoteFile && localFile) {
				// Case C: Exists in both remote and local
				const remoteChanged =
					remoteFile.modifiedAt.getTime() > localFile.remoteModifiedAt ||
					(localFile.etag && remoteFile.etag && remoteFile.etag !== localFile.etag);

				const localModified = localFile.status === 'dirty' || localFile.status === 'deleted';

				if (remoteChanged && localModified) {
					// Subcase C1: Remote Changed AND Local Modified (Conflict)
					const op = context.backend.readFile(path);
					const remoteContent = await op.finished;
					const updatesPath = this.appendUpdatesSuffix(path);
					await context.writeLocalFile(updatesPath, remoteContent);

					localFiles[path] = {
						...localFile,
						status: 'conflict',
						remoteModifiedAt: remoteFile.modifiedAt.getTime(),
						etag: remoteFile.etag
					};

					localFiles[updatesPath] = {
						path: updatesPath,
						type: 'file',
						size: remoteContent.length,
						localModifiedAt: Date.now(),
						remoteModifiedAt: 0,
						status: 'clean'
					};

					conflicts.push({
						path,
						localModifiedAt: new Date(localFile.localModifiedAt),
						remoteModifiedAt: remoteFile.modifiedAt,
						type: 'conflict'
					});
				} else if (remoteChanged && !localModified) {
					// Subcase C2: Remote Changed AND Local NOT Modified
					if (context.sparse) {
						localFiles[path] = {
							path,
							type: 'file',
							size: remoteFile.size,
							localModifiedAt: remoteFile.modifiedAt.getTime(),
							remoteModifiedAt: remoteFile.modifiedAt.getTime(),
							etag: remoteFile.etag,
							status: 'clean'
						};
						// Delete local cache if it existed to enforce sparse read later
						await context.deleteLocalFile(path);
						updated.push(path);
					} else {
						const op = context.backend.readFile(path);
						const content = await op.finished;
						await context.writeLocalFile(path, content);
						localFiles[path] = {
							path,
							type: 'file',
							size: remoteFile.size,
							localModifiedAt: remoteFile.modifiedAt.getTime(),
							remoteModifiedAt: remoteFile.modifiedAt.getTime(),
							etag: remoteFile.etag,
							status: 'clean'
						};
						updated.push(path);
					}
				} else if (!remoteChanged && localModified) {
					// Subcase C3: Remote NOT Changed AND Local Modified (Dirty)
					if (localFile.status === 'deleted') {
						await context.backend.deleteFile(path);
						delete localFiles[path];
						deleted.push(path);
					} else if (localFile.status === 'dirty') {
						const content = await context.readLocalFile(path);
						const op = context.backend.writeFile(path, content, { atomic: this.options.atomic });
						await op.finished;

						const stat = await context.backend.stat(path);
						const modifiedAt = stat?.modifiedAt ?? new Date();
						const etag = stat?.etag;

						localFiles[path] = {
							...localFile,
							status: 'clean',
							remoteModifiedAt: modifiedAt.getTime(),
							etag
						};
						updated.push(path);
					}
				}
				// Subcase C4: Remote NOT Changed AND Local NOT Modified - do nothing
			}
		}

		await context.saveLocalMetadata(metadata);

		if (conflicts.length > 0) {
			throw new SyncConflictError(conflicts);
		}

		return { created, updated, deleted };
	}
}
