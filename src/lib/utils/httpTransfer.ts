/**
 * HTTP transfer helpers that report progress while bytes move, not just when they finish.
 *
 * Downloads stream `fetch`'s response body. Uploads use `XMLHttpRequest`, because `fetch` has no
 * upload progress; XHR is available in the dedicated worker stratus-base runs in. Where XHR is
 * missing (Node, where the unit tests run) uploads fall back to `fetch` and report once at the end.
 */

export type ProgressCallback = (loaded: number, total: number) => void;

/** An HTTP failure shaped like the provider SDK errors backends already check (`status`, `error`). */
export interface HttpTransferError extends Error {
	status: number;
	/** Parsed JSON error body, or the raw text when it isn't JSON. */
	error: unknown;
}

export interface UploadResult {
	status: number;
	/** Response body as text. */
	text: string;
	/** Reads a response header, or null when absent. */
	getHeader: (name: string) => string | null;
}

interface UploadOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body: Uint8Array;
	signal?: AbortSignal;
	onProgress?: ProgressCallback;
}

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Builds the error thrown for a non-2xx response. */
export function httpError(status: number, text: string, statusText = ''): HttpTransferError {
	const err = new Error(`HTTP ${status} ${statusText}`.trim()) as HttpTransferError;
	err.status = status;
	err.error = parseBody(text);
	return err;
}

/**
 * Reads a response body chunk by chunk, reporting progress as each chunk arrives.
 * `total` comes from `content-length`, then `totalHint`, then whatever has arrived so far.
 */
export async function readBodyWithProgress(
	response: Response,
	onProgress: ProgressCallback,
	totalHint = 0
): Promise<Uint8Array> {
	const total = Number(response.headers.get('content-length')) || totalHint;
	const reader = response.body?.getReader();
	if (!reader) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		onProgress(bytes.length, bytes.length);
		return bytes;
	}

	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		onProgress(loaded, total || loaded);
	}

	const result = new Uint8Array(loaded);
	chunks.reduce((offset, chunk) => {
		result.set(chunk, offset);
		return offset + chunk.length;
	}, 0);
	return result;
}

function uploadWithXhr({
	url,
	method = 'POST',
	headers = {},
	body,
	signal,
	onProgress
}: UploadOptions): Promise<UploadResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException('Operation aborted', 'AbortError'));

		const xhr = new XMLHttpRequest();
		xhr.open(method, url);
		Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));

		xhr.upload.onprogress = (event) => {
			onProgress?.(event.loaded, event.lengthComputable ? event.total : body.length);
		};
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				return reject(httpError(xhr.status, xhr.responseText, xhr.statusText));
			}
			onProgress?.(body.length, body.length);
			resolve({
				status: xhr.status,
				text: xhr.responseText,
				getHeader: (name) => xhr.getResponseHeader(name)
			});
		};
		// status 0 is a network failure; treated as transient so BaseStorageOperation retries it.
		xhr.onerror = () => reject(httpError(503, '', 'Network error'));
		xhr.onabort = () => reject(new DOMException('Operation aborted', 'AbortError'));
		signal?.addEventListener('abort', () => xhr.abort(), { once: true });

		xhr.send(body as unknown as XMLHttpRequestBodyInit);
	});
}

async function uploadWithFetch({
	url,
	method = 'POST',
	headers = {},
	body,
	signal,
	onProgress
}: UploadOptions): Promise<UploadResult> {
	const response = await fetch(url, { method, headers, body: body as BodyInit, signal });
	const text = await response.text();
	if (!response.ok) throw httpError(response.status, text, response.statusText);
	onProgress?.(body.length, body.length);
	return { status: response.status, text, getHeader: (name) => response.headers.get(name) };
}

/** Uploads bytes, reporting progress as they are sent when `XMLHttpRequest` is available. */
export function uploadWithProgress(options: UploadOptions): Promise<UploadResult> {
	return typeof XMLHttpRequest === 'undefined' ? uploadWithFetch(options) : uploadWithXhr(options);
}
