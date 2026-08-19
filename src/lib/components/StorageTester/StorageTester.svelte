<script lang="ts">
	import { onMount } from 'svelte';
	import type { StorageBackend, StorageFileInfo } from '../../types.ts';
	import {
		Panel,
		Padding,
		Divider,
		Field,
		TextInput,
		PasswordInput,
		TextArea,
		Button,
		Icon,
		InfoBox,
		ControlGroup
	} from 'svelte-akui';

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
		// Auto-clear message after 5 seconds
		if (text) {
			setTimeout(() => {
				if (message === text) {
					message = '';
				}
			}, 5000);
		}
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

<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; align-items: start;">
	<!-- Left Side: Configuration & File Creation -->
	<div style="display: flex; flex-direction: column; gap: 1.5rem;">
		<!-- Configuration Panel -->
		<Panel colour="regular" tag="section">
			<Padding size="m">
				<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">1. Configuration</h2>
				{#if !isConfigured}
					<form onsubmit={(e) => { e.preventDefault(); handleSaveConfig(); }} style="display: flex; flex-direction: column; gap: 1rem;">
						{#each configFields as field}
							<Field label={field.label} hint={field.helpText} for={field.key}>
								{#if field.type === 'password'}
									<PasswordInput
										id={field.key}
										bind:value={configValues[field.key]}
										placeholder={field.placeholder}
										required
									/>
								{:else}
									<TextInput
										type="text"
										id={field.key}
										bind:value={configValues[field.key]}
										placeholder={field.placeholder}
										required
									/>
								{/if}
							</Field>
						{/each}

						{#if backend.getAuthUrl && configValues[configFields[0]?.key]?.trim()}
							<div style="margin-top: 0.5rem;">
								<InfoBox variant="info" title="Redirect URI Configuration Required">
									<p style="margin: 0 0 0.5rem 0; font-size: 0.85rem;">Configure your OAuth app settings to redirect to:</p>
									<code style="display: block; background: var(--akui-bg-secondary); border: 1px solid var(--akui-border-input); padding: 0.5rem; border-radius: var(--akui-radius-s); font-family: monospace; font-size: 0.8rem; word-break: break-all; margin-bottom: 0.5rem;">
										{calculatedRedirectUri}
									</code>
									{#if backend.id === 'dropbox'}
										<a
											href="https://www.dropbox.com/developers/apps/info?app_key={configValues[configFields[0].key].trim()}"
											target="_blank"
											rel="noopener noreferrer"
											style="color: var(--akui-bg-accent); font-size: 0.85rem; font-weight: 500;"
										>
											Open App Settings on Dropbox ↗
										</a>
									{:else if backend.id === 'google-drive'}
										<a
											href="https://console.cloud.google.com/apis/credentials"
											target="_blank"
											rel="noopener noreferrer"
											style="color: var(--akui-bg-accent); font-size: 0.85rem; font-weight: 500;"
										>
											Open Credentials on Google Cloud ↗
										</a>
									{/if}
								</InfoBox>
							</div>
						{/if}

						<Padding size="s" y>
							<Button type="submit" variant="accent" style="width: 100%">
								<Icon name={backend.getAuthUrl ? 'box-arrow-in-right' : 'check-circle'} size="16" style="margin-right: 0.5rem" />
								{backend.getAuthUrl ? `Connect with ${title} (OAuth)` : 'Save Configuration'}
							</Button>
						</Padding>
					</form>
				{:else}
					<InfoBox variant="info" title="Connected successfully">
						<p style="margin: 0; font-size: 0.85rem;">Active connection to {title} storage backend is established.</p>
					</InfoBox>
					<Padding size="s" y>
						<Button variant="ghost" onclick={handleDisconnect} style="width: 100%; border-color: var(--akui-fg-danger, #ef4444); color: var(--akui-fg-danger, #ef4444);">
							<Icon name="x-circle" size="16" style="margin-right: 0.5rem" />
							Disconnect Session
						</Button>
					</Padding>
				{/if}
			</Padding>
		</Panel>

		<!-- Write File Panel (if configured) -->
		{#if isConfigured}
			<Panel colour="regular" tag="section">
				<Padding size="m">
					<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">2. Write File</h2>
					<form onsubmit={(e) => { e.preventDefault(); handleCreateFile(); }} style="display: flex; flex-direction: column; gap: 1rem;">
						<Field label="File Path" hint="Must start with '/' (e.g. /notes.txt)" for="filePath">
							<TextInput
								type="text"
								id="filePath"
								bind:value={newFilePath}
								placeholder="/folder/note.txt"
								required
							/>
						</Field>

						<Field label="Content (Text)" for="fileContent">
							<TextArea
								id="fileContent"
								bind:value={newFileContent}
								placeholder="Write file content here..."
								rows="4"
								required
							/>
						</Field>

						<div style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
							<input type="checkbox" id="atomic" bind:checked={writeAtomic} style="cursor: pointer;" />
							<label for="atomic" style="font-size: 0.9rem; color: var(--akui-fg-secondary); cursor: pointer;">
								Use Atomic Write (Write-then-Rename)
							</label>
						</div>

						<Button type="submit" variant="accent">
							<Icon name="upload" size="16" style="margin-right: 0.5rem" />
							Upload File
						</Button>
					</form>
				</Padding>
			</Panel>
		{/if}
	</div>

	<!-- Right Side: Files listing & Viewer -->
	{#if isConfigured}
		<div style="display: flex; flex-direction: column; gap: 1.5rem;">
			<!-- File List Panel -->
			<Panel colour="regular" tag="section">
				<Padding size="m">
					<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
						<h2 style="font-size: 1.25rem; font-weight: 600; margin: 0;">3. Files under Root (/)</h2>
						<Button variant="ghost" size="small" onclick={refreshFiles}>
							<Icon name="arrow-clockwise" size="14" style="margin-right: 0.25rem" />
							Refresh
						</Button>
					</div>

					<div style="margin-bottom: 1rem;">
						<Divider />
					</div>

					{#if files.length === 0}
						<p style="text-align: center; color: var(--akui-fg-secondary); padding: 2rem 0; margin: 0;">
							No files found. Create a file to get started!
						</p>
					{:else}
						<ControlGroup border={true}>
							{#each files as file}
								<li style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
									<button
										type="button"
										onclick={() => file.type === 'file' && handleReadFile(file.path)}
										style="display: flex; align-items: center; gap: 0.75rem; background: none; border: none; padding: 0.75rem 1rem; color: inherit; cursor: pointer; text-align: left; flex-grow: 1;"
									>
										<Icon name={file.type === 'directory' ? 'folder-fill' : 'file-earmark-text'} size="16" style="color: var(--akui-bg-accent);" />
										<span style="font-weight: 500;">{file.name}</span>
										{#if file.type === 'file'}
											<span style="font-size: 0.8rem; color: var(--akui-fg-secondary); margin-left: 0.25rem;">
												({(file.size / 1024).toFixed(2)} KB)
											</span>
										{/if}
									</button>
									<div style="padding-right: 0.75rem;">
										<Button
											variant="ghost"
											size="small"
											onclick={() => handleDeleteFile(file.path)}
											style="color: var(--akui-fg-danger, #ef4444);"
										>
											<Icon name="trash" size="14" />
										</Button>
									</div>
								</li>
							{/each}
						</ControlGroup>
					{/if}
				</Padding>
			</Panel>

			<!-- File Viewer Panel -->
			{#if activeFilePath}
				<Panel colour="regular" tag="section">
					<Padding size="m">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
							<h2 style="font-size: 1.25rem; font-weight: 600; margin: 0;">File Contents: {activeFilePath}</h2>
							<Button variant="ghost" size="small" onclick={() => { activeFilePath = null; activeFileContent = null; }}>
								<Icon name="x" size="14" style="margin-right: 0.25rem;" />
								Close
							</Button>
						</div>
						<div style="margin-bottom: 1rem;">
							<Divider />
						</div>
						<pre style="background: var(--akui-bg-secondary); padding: 1rem; border-radius: var(--akui-radius-m); border: 1px solid var(--akui-border-input); color: var(--akui-fg); font-family: monospace; font-size: 0.95rem; overflow-x: auto; white-space: pre-wrap; margin: 0;">{activeFileContent}</pre>
					</Padding>
				</Panel>
			{/if}
		</div>
	{/if}
</div>

<!-- Floating Notifications Toast area using InfoBox -->
{#if message}
	<div style="position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 1000; max-width: 400px; box-shadow: var(--akui-shadow-shiny); border-radius: var(--akui-radius-m); overflow: hidden;">
		<InfoBox variant={messageType === 'success' ? 'info' : messageType} title={message} />
	</div>
{/if}
