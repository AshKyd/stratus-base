<script lang="ts">
	import { DropboxStorage } from '$lib/backends/DropboxStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';

	let backend = $state<DropboxStorage | null>(null);

	const configFields = [
		{
			key: 'clientId',
			label: 'Dropbox App Key (Client ID)',
			type: 'text' as const,
			placeholder: 'Enter your Dropbox app client ID',
			helpText: 'Obtained from the settings page of your app in the Dropbox Developer Console.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new DropboxStorage({
			clientId: configValues.clientId.trim()
		});
	}

	// Initialize backend if last app key is saved in localStorage
	if (typeof window !== 'undefined') {
		const savedClientId = localStorage.getItem('tester_config_dropbox_clientId');
		if (savedClientId) {
			backend = new DropboxStorage({
				clientId: savedClientId.trim()
			});
		}
	}
</script>

<svelte:head>
	<title>Dropbox Backend Tester</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>Dropbox Storage Backend Tester</h1>
		<p class="subtitle">Securely verify your client-side Dropbox authentication and file CRUD operations</p>
	</header>

	{#if backend}
		<StorageTester {backend} title="Dropbox" {configFields} onConfigure={handleConfigure} />
	{:else}
		<section class="card">
			<h2>Dropbox Configuration</h2>
			<form onsubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); handleConfigure({ clientId: fd.get('clientId') as string }); }} class="vertical-form">
				<div class="form-group">
					<label for="clientId">Dropbox App Key (Client ID)</label>
					<input
						type="text"
						id="clientId"
						name="clientId"
						placeholder="Enter your Dropbox app client ID"
						required
					/>
					<p class="help-text">Obtained from the settings page of your app in the Dropbox Developer Console.</p>
				</div>
				<button type="submit" class="btn btn-primary">Save and Continue</button>
			</form>
		</section>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		background: #0f1115;
		color: #e2e8f0;
		font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		-webkit-font-smoothing: antialiased;
	}

	.container {
		max-width: 1100px;
		margin: 0 auto;
		padding: 40px 20px;
	}

	.header {
		text-align: center;
		margin-bottom: 40px;
	}

	h1 {
		font-size: 2.5rem;
		font-weight: 700;
		background: linear-gradient(135deg, #60a5fa, #3b82f6);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		margin-bottom: 10px;
	}

	.subtitle {
		color: #94a3b8;
		font-size: 1.1rem;
		font-weight: 300;
	}

	.card {
		background: rgba(30, 41, 59, 0.4);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 16px;
		padding: 24px;
		box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
		max-width: 500px;
		margin: 0 auto;
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

	input[type='text'] {
		background: rgba(15, 23, 42, 0.6);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		padding: 12px;
		color: #f8fafc;
		font-size: 0.95rem;
		transition: border-color 0.2s;
	}

	input[type='text']:focus {
		outline: none;
		border-color: #3b82f6;
	}

	.help-text {
		font-size: 0.8rem;
		color: #64748b;
		margin: 0;
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

	.btn-primary {
		background: #2563eb;
		color: white;
		width: 100%;
	}

	.vertical-form {
		display: flex;
		flex-direction: column;
	}
</style>
