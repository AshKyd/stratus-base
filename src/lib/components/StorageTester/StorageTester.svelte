<script lang="ts">
	import { onMount } from 'svelte';
	import type { StorageBackend, StorageFileInfo } from '../../types.ts';

	interface ConfigField {
		key: string;
		label: string;
		type: 'text' | 'password';
		placeholder?: string;
		helpText?: string;
	}

	interface Props {
		backend: StorageBackend;
		title: string;
		configFields: ConfigField[];
		onConfigure?: (config: Record<string, string>) => Promise<void>;
	}

	let { backend, title, configFields, onConfigure }: Props = $props();

	let configValues = $state<Record<string, string>>({});
	let isConfigured = $state(false);
	let files = $state<StorageFileInfo[]>([]);
	let message = $state('');
	let messageType = $state<'info' | 'error' | 'success'>('info');

	// File creation form state
	let newFilePath = $state('');
	let newFileContent = $state('');
	let writeAtomic = $state(false);

	// File reading state
	let activeFileContent = $state<string | null>(null);
	let activeFilePath = $state<string | null>(null);

	let calculatedRedirectUri = $state('');

	function getRedirectUri() {
		return window.location.origin + window.location.pathname;
	}

	function showMsg(text: string, type: 'info' | 'error' | 'success' = 'info') {
		message = text;
		messageType = type;
	}

	onMount(async () => {
		calculatedRedirectUri = getRedirectUri();

		// Load stored config values from localStorage
		configFields.forEach((field) => {
			const saved = localStorage.getItem(`tester_config_${backend.id}_${field.key}`);
			if (saved) {
				configValues[field.key] = saved;
			}
		});

		// Check if credentials are saved
		const savedCreds = localStorage.getItem(`tester_creds_${backend.id}`);
		if (savedCreds && backend.setCredentials) {
			backend.setCredentials(JSON.parse(savedCreds));
		}

		isConfigured = await backend.isConfigured();

		// Handle OAuth callback if present in URL
		const params = new URLSearchParams(window.location.search);
		const code = params.get('code');
		const hashParams = new URLSearchParams(window.location.hash.substring(1));
		const accessToken = hashParams.get('access_token');

		if (code && backend.exchangeCode) {
			try {
				showMsg('Exchanging authorization code...', 'info');
				const credentials = await backend.exchangeCode(code, calculatedRedirectUri);
				localStorage.setItem(`tester_creds_${backend.id}`, JSON.stringify(credentials));
				isConfigured = true;
				showMsg('Authenticated successfully!', 'success');
				window.history.replaceState({}, '', window.location.pathname);
			} catch (err: any) {
				showMsg(`Authentication failed: ${err.message || err}`, 'error');
			}
		} else if (accessToken) {
			try {
				const expiresSeconds = Number(hashParams.get('expires_in') || 3600);
				const credentials = {
					accessToken,
					expiresAt: Date.now() + expiresSeconds * 1000
				};
				localStorage.setItem(`tester_creds_${backend.id}`, JSON.stringify(credentials));
				if (backend.setCredentials) {
					backend.setCredentials(credentials);
				}
				isConfigured = true;
				showMsg('Authenticated successfully!', 'success');
				window.history.replaceState({}, '', window.location.pathname);
			} catch (err: any) {
				showMsg(`Authentication failed: ${err.message || err}`, 'error');
			}
		}

		if (isConfigured) {
			await refreshFiles();
		}
	});

	async function handleSaveConfig() {
		// Save values to localStorage
		Object.entries(configValues).forEach(([key, value]) => {
			localStorage.setItem(`tester_config_${backend.id}_${key}`, value);
		});

		if (onConfigure) {
			try {
				await onConfigure(configValues);
			} catch (err: any) {
				showMsg(`Configuration error: ${err.message || err}`, 'error');
				return;
			}
		}

		if (backend.getAuthUrl) {
			// Trigger OAuth redirect
			try {
				const authUrl = await backend.getAuthUrl(calculatedRedirectUri);
				window.location.href = authUrl;
			} catch (err: any) {
				showMsg(`Failed to get authorization URL: ${err.message || err}`, 'error');
			}
		} else {
			// Non-interactive backend (e.g. S3) is configured immediately
			isConfigured = await backend.isConfigured();
			if (isConfigured) {
				showMsg('Configuration saved successfully!', 'success');
				await refreshFiles();
			} else {
				showMsg('Failed to configure backend with provided values.', 'error');
			}
		}
	}

	async function handleDisconnect() {
		localStorage.removeItem(`tester_creds_${backend.id}`);
		configFields.forEach((field) => {
			localStorage.removeItem(`tester_config_${backend.id}_${field.key}`);
			configValues[field.key] = '';
		});
		isConfigured = false;
		files = [];
		activeFileContent = null;
		activeFilePath = null;
		showMsg('Session disconnected.', 'success');
	}

	async function refreshFiles() {
		try {
			showMsg('Loading file list...', 'info');
			files = await backend.listDirectory('/');
			showMsg('Loaded directory listing.', 'success');
		} catch (err: any) {
			showMsg(`Failed to list files: ${err.message || err}`, 'error');
		}
	}

	async function handleCreateFile() {
		if (!newFilePath.startsWith('/')) {
			showMsg('File path must start with "/" (e.g., /notes.txt)', 'error');
			return;
		}
		try {
			showMsg(`Writing file ${newFilePath}...`, 'info');
			const contentBytes = new TextEncoder().encode(newFileContent);
			const op = backend.writeFile(newFilePath, contentBytes, { atomic: writeAtomic });

			await op.finished;
			showMsg('File written successfully!', 'success');
			newFilePath = '';
			newFileContent = '';
			await refreshFiles();
		} catch (err: any) {
			showMsg(`Failed to write file: ${err.message || err}`, 'error');
		}
	}

	async function handleReadFile(path: string) {
		try {
			showMsg(`Reading file ${path}...`, 'info');
			activeFilePath = path;
			activeFileContent = 'Loading...';
			const op = backend.readFile(path);
			const bytes = await op.finished;
			activeFileContent = new TextDecoder().decode(bytes);
			showMsg(`Read file ${path}`, 'success');
		} catch (err: any) {
			showMsg(`Failed to read file: ${err.message || err}`, 'error');
			activeFileContent = null;
			activeFilePath = null;
		}
	}

	async function handleDeleteFile(path: string) {
		if (!confirm(`Are you sure you want to delete ${path}?`)) return;
		try {
			showMsg(`Deleting file ${path}...`, 'info');
			await backend.deleteFile(path);
			showMsg(`Deleted file ${path}`, 'success');
			if (activeFilePath === path) {
				activeFilePath = null;
				activeFileContent = null;
			}
			await refreshFiles();
		} catch (err: any) {
			showMsg(`Failed to delete file: ${err.message || err}`, 'error');
		}
	}
</script>

<div class="grid">
	<!-- Authentication/Configuration Card -->
	<section class="card">
		<h2>1. Configuration</h2>
		{#if !isConfigured}
			<form onsubmit={(e) => { e.preventDefault(); handleSaveConfig(); }} class="vertical-form">
				{#each configFields as field}
					<div class="form-group">
						<label for={field.key}>{field.label}</label>
						<input
							type={field.type}
							id={field.key}
							bind:value={configValues[field.key]}
							placeholder={field.placeholder}
							required
						/>
						{#if field.helpText}
							<p class="help-text">{field.helpText}</p>
						{/if}
					</div>
				{/each}

				{#if backend.getAuthUrl && configValues[configFields[0]?.key]?.trim()}
					<div class="redirect-guide">
						<p><strong>Required Action:</strong> You must configure your app redirect URIs to include:</p>
						<code class="uri-display">{calculatedRedirectUri}</code>
						{#if backend.id === 'dropbox'}
							<a
								href="https://www.dropbox.com/developers/apps/info?app_key={configValues[configFields[0].key].trim()}"
								target="_blank"
								rel="noopener noreferrer"
								class="setup-link"
							>
								Open App Settings on Dropbox ↗
							</a>
						{:else if backend.id === 'google-drive'}
							<a
								href="https://console.cloud.google.com/apis/credentials"
								target="_blank"
								rel="noopener noreferrer"
								class="setup-link"
							>
								Open Credentials page on Google Cloud ↗
							</a>
						{/if}
					</div>
				{/if}

				<button type="submit" class="btn btn-primary">
					{backend.getAuthUrl ? `Connect with ${title} (OAuth)` : 'Save Configuration'}
				</button>
			</form>
		{:else}
			<div class="status-box authenticated">
				<div class="status-indicator"></div>
				<div>
					<strong>Connected to {title}</strong>
					<p class="help-text">Backend active and configured</p>
				</div>
			</div>
			<button class="btn btn-danger" onclick={handleDisconnect}>Disconnect Session</button>
		{/if}
	</section>

	<!-- CRUD Operations Card -->
	{#if isConfigured}
		<section class="card">
			<h2>2. Write File</h2>
			<form onsubmit={(e) => { e.preventDefault(); handleCreateFile(); }} class="vertical-form">
				<div class="form-group">
					<label for="filePath">File Path</label>
					<input
						type="text"
						id="filePath"
						bind:value={newFilePath}
						placeholder="/folder/note.txt"
						required
					/>
				</div>
				<div class="form-group">
					<label for="fileContent">Content (Text)</label>
					<textarea
						id="fileContent"
						bind:value={newFileContent}
						placeholder="Write content here..."
						rows="4"
						required
					></textarea>
				</div>
				<div class="checkbox-group">
					<input type="checkbox" id="atomic" bind:checked={writeAtomic} />
					<label for="atomic">Use Atomic Write (Write-then-Rename)</label>
				</div>
				<button type="submit" class="btn btn-success">Upload File</button>
			</form>
		</section>

		<!-- File List Card -->
		<section class="card col-span-2">
			<div class="section-header">
				<h2>3. Files under Root (/)</h2>
				<button class="btn btn-secondary btn-sm" onclick={refreshFiles}>Refresh</button>
			</div>

			{#if files.length === 0}
				<p class="empty-state">No files found. Create a file above to get started!</p>
			{:else}
				<div class="file-list">
					{#each files as file}
						<div class="file-item">
							<button type="button" class="file-info" onclick={() => file.type === 'file' && handleReadFile(file.path)}>
								<span class="icon">{file.type === 'directory' ? '📁' : '📄'}</span>
								<span class="file-name">{file.name}</span>
								{#if file.type === 'file'}
									<span class="file-meta">({(file.size / 1024).toFixed(2)} KB)</span>
								{/if}
							</button>
							<div class="actions">
								<button class="btn btn-danger btn-sm" onclick={() => handleDeleteFile(file.path)}>
									Delete
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- File Viewer -->
		{#if activeFilePath}
			<section class="card col-span-2 viewer-card">
				<div class="section-header">
					<h2>File Contents: {activeFilePath}</h2>
					<button class="btn btn-secondary btn-sm" onclick={() => { activeFilePath = null; activeFileContent = null; }}>Close</button>
				</div>
				<pre class="file-content">{activeFileContent}</pre>
			</section>
		{/if}
	{/if}
</div>

{#if message}
	<div class="toast {messageType}">
		{message}
	</div>
{/if}

<style>
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 24px;
	}

	.col-span-2 {
		grid-column: span 2;
	}

	.card {
		background: rgba(30, 41, 59, 0.4);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 16px;
		padding: 24px;
		box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
	}

	h2 {
		font-size: 1.3rem;
		margin-top: 0;
		margin-bottom: 20px;
		color: #f1f5f9;
		font-weight: 600;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 20px;
	}

	label {
		font-size: 0.9rem;
		color: #94a3b8;
		font-weight: 500;
	}

	input[type='text'],
	input[type='password'],
	textarea {
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		padding: 12px;
		color: #f8fafc;
		font-size: 0.95rem;
		transition: border-color 0.2s;
	}

	input[type='text']:focus,
	input[type='password']:focus,
	textarea:focus {
		outline: none;
		border-color: #3b82f6;
	}

	.help-text {
		font-size: 0.8rem;
		color: #64748b;
		margin: 0;
	}

	.checkbox-group {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 20px;
	}

	.checkbox-group label {
		cursor: pointer;
	}

	.btn {
		cursor: pointer;
		font-weight: 500;
		padding: 10px 18px;
		border-radius: 8px;
		font-size: 0.95rem;
		transition: transform 0.1s, filter 0.2s;
		border: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.btn:hover {
		filter: brightness(1.1);
	}

	.btn:active {
		transform: scale(0.98);
	}

	.btn-primary {
		background: #2563eb;
		color: white;
		width: 100%;
	}

	.btn-success {
		background: #10b981;
		color: white;
	}

	.btn-danger {
		background: #ef4444;
		color: white;
	}

	.btn-secondary {
		background: rgba(255, 255, 255, 0.1);
		color: #e2e8f0;
	}

	.btn-sm {
		padding: 6px 12px;
		font-size: 0.85rem;
	}

	.toast {
		position: fixed;
		bottom: 24px;
		right: 24px;
		padding: 12px 18px;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 500;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		animation: fadeIn 0.3s ease;
		z-index: 1000;
	}

	.info {
		background: rgba(59, 130, 246, 0.95);
		border: 1px solid rgba(59, 130, 246, 0.3);
		color: #ffffff;
	}

	.success {
		background: rgba(16, 185, 129, 0.95);
		border: 1px solid rgba(16, 185, 129, 0.3);
		color: #ffffff;
	}

	.error {
		background: rgba(239, 68, 68, 0.95);
		border: 1px solid rgba(239, 68, 68, 0.3);
		color: #ffffff;
	}

	.status-box {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
		background: rgba(16, 185, 129, 0.08);
		border: 1px solid rgba(16, 185, 129, 0.2);
		border-radius: 8px;
		margin-bottom: 20px;
	}

	.status-indicator {
		width: 10px;
		height: 10px;
		background: #10b981;
		border-radius: 50%;
		box-shadow: 0 0 8px #10b981;
	}

	.vertical-form {
		display: flex;
		flex-direction: column;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
	}

	.section-header h2 {
		margin-bottom: 0;
	}

	.file-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.file-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		background: rgba(15, 23, 42, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 8px;
		transition: background 0.2s;
	}

	.file-item:hover {
		background: rgba(15, 23, 42, 0.6);
	}

	.file-info {
		display: flex;
		align-items: center;
		gap: 12px;
		cursor: pointer;
		flex-grow: 1;
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		font-family: inherit;
		color: inherit;
	}

	.icon {
		font-size: 1.2rem;
	}

	.file-name {
		font-weight: 500;
		color: #f1f5f9;
	}

	.file-meta {
		font-size: 0.8rem;
		color: #64748b;
	}

	.empty-state {
		text-align: center;
		color: #64748b;
		padding: 40px 0;
	}

	.viewer-card {
		border-color: rgba(59, 130, 246, 0.2);
	}

	.file-content {
		background: #090d16;
		padding: 16px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.05);
		color: #cbd5e1;
		font-family: 'Courier New', Courier, monospace;
		font-size: 0.95rem;
		overflow-x: auto;
		white-space: pre-wrap;
	}

	.redirect-guide {
		background: rgba(59, 130, 246, 0.08);
		border: 1px solid rgba(59, 130, 246, 0.15);
		border-radius: 8px;
		padding: 14px;
		margin-bottom: 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.redirect-guide p {
		margin: 0;
		font-size: 0.85rem;
		color: #93c5fd;
		line-height: 1.4;
	}

	.uri-display {
		background: #090d16;
		padding: 6px 10px;
		border-radius: 4px;
		font-family: 'Courier New', Courier, monospace;
		font-size: 0.8rem;
		color: #3b82f6;
		word-break: break-all;
	}

	.setup-link {
		color: #60a5fa;
		font-size: 0.85rem;
		text-decoration: underline;
		font-weight: 500;
		align-self: flex-start;
	}

	.setup-link:hover {
		color: #93c5fd;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
