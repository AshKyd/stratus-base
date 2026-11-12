/** js7z build used for archives: `single` needs nothing special, `multi` needs cross-origin isolation. */
export type WasmVariant = 'single' | 'multi';

export interface WasmConfig {
	/**
	 * Public folder holding the `single/` and `multi/` js7z builds (each with `js7z.mjs` and
	 * `js7z.wasm`). Absolute (`https://…`) or root-relative (`/wasm`). Default: the jsDelivr copy
	 * of this package's own `wasm/` folder, which only works single-threaded (see `threads`).
	 */
	baseUrl?: string;
	/**
	 * `auto` (default) uses the multi-threaded build only when the page is cross-origin isolated
	 * and `baseUrl` is same-origin; otherwise the single-threaded build. `single` / `multi` force one.
	 */
	threads?: 'auto' | WasmVariant;
}

/** Package version the CDN default points at. Keep in step with `package.json`. */
const PACKAGE_VERSION = '0.0.1';

/** Default wasm location. A CDN is cross-origin, so pthread workers can't start from it. */
export const DEFAULT_WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/stratus-base@${PACKAGE_VERSION}/wasm`;

let currentConfig: Required<WasmConfig> = { baseUrl: DEFAULT_WASM_BASE_URL, threads: 'auto' };

/** Bumped on every change so `codec7z` knows to drop its cached module factory. */
let configRevision = 0;

/**
 * Tells stratus-base where the js7z wasm files are served from. Call once at startup, in every
 * thread that reads or writes archives (the main thread and any worker). Copy the files into a
 * public folder first with `node node_modules/stratus-base/scripts/publish-wasm.mjs <folder>`.
 */
export function configureWasm(config: WasmConfig): void {
	currentConfig = {
		baseUrl: (config.baseUrl ?? currentConfig.baseUrl).replace(/\/+$/, ''),
		threads: config.threads ?? currentConfig.threads
	};
	configRevision += 1;
}

export function getWasmConfig(): Required<WasmConfig> & { revision: number } {
	return { ...currentConfig, revision: configRevision };
}

/** Resolves a possibly root-relative `baseUrl` against the current page/worker location. */
export function resolveBaseUrl(baseUrl: string): URL {
	return new URL(`${baseUrl}/`, globalThis.location?.href);
}

/**
 * Multi-threaded js7z needs `SharedArrayBuffer`, which browsers only expose to cross-origin
 * isolated pages (COOP + COEP). Its pthread workers are also spawned from the glue file's own
 * URL, so the files must be same-origin.
 */
export function chooseWasmVariant({ baseUrl, threads }: Required<WasmConfig>): WasmVariant {
	if (threads !== 'auto') return threads;
	const isIsolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
	const isSameOrigin = resolveBaseUrl(baseUrl).origin === globalThis.location?.origin;
	return isIsolated && isSameOrigin ? 'multi' : 'single';
}
