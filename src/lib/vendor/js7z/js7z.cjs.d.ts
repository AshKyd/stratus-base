// Vendored single-threaded build of JS7z (7-Zip 25.01, ST+FS+EC variant).
// Source: https://github.com/GMH-Code/JS7z — license in licenses/7-zip-LICENSE.txt.

export interface JS7zFS {
	mkdir(path: string): void;
	createPath(parent: string, path: string, canOwn: boolean, canWrite: boolean): void;
	writeFile(path: string, data: Uint8Array): void;
	readFile(path: string): Uint8Array;
	readdir(path: string): string[];
	stat(path: string): { mode: number };
	isDir(mode: number): boolean;
	unlink(path: string): void;
}

export interface JS7zInstance {
	FS: JS7zFS;
	callMain(args: string[]): unknown;
	onExit?: (code: number) => void;
	onAbort?: (reason?: string) => void;
}

declare function JS7z(moduleArg?: Record<string, unknown>): Promise<JS7zInstance>;

export default JS7z;
