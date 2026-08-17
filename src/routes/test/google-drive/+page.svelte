<script lang="ts">
	import { GoogleDriveStorage } from '$lib/backends/GoogleDriveStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';

	let backend = $state<GoogleDriveStorage | null>(null);

	const configFields = [
		{
			key: 'clientId',
			label: 'Google OAuth Client ID',
			type: 'text' as const,
			placeholder: 'Enter your Google client ID',
			helpText: 'Obtained from the credentials page of your project in the Google Cloud Console.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new GoogleDriveStorage({
			clientId: configValues.clientId.trim()
		});
	}

	// Initialize backend if last client ID is saved in localStorage
	if (typeof window !== 'undefined') {
		const savedClientId = localStorage.getItem('tester_config_google-drive_clientId');
		if (savedClientId) {
			backend = new GoogleDriveStorage({
				clientId: savedClientId.trim()
			});
		}
	}
</script>

<svelte:head>
	<title>Google Drive Backend Tester</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>Google Drive Storage Backend Tester</h1>
		<p class="subtitle">Securely verify your client-side Google Drive authentication and file CRUD operations</p>
	</header>

	{#if backend}
		<StorageTester {backend} title="Google Drive" {configFields} onConfigure={handleConfigure} />
	{:else}
		<section class="card">
			<h2>Google Drive Configuration</h2>
			<div class="alert-box">
				<span class="alert-icon">ℹ️</span>
				<div class="alert-content">
					<strong>Implicit Auth Flow:</strong> This client-side library uses Google's standard OAuth Implicit Flow. Create a <strong>"Web application"</strong> client ID in your Google Cloud project and register this page's URL as an authorized redirect URI. No client secret is required.
				</div>
			</div>

			<form onsubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); handleConfigure({ clientId: fd.get('clientId') as string }); }} class="vertical-form">
				<div class="form-group">
					<label for="clientId">Google OAuth Client ID</label>
					<input
						type="text"
						id="clientId"
						name="clientId"
						placeholder="Enter your Google client ID"
						required
					/>
					<p class="help-text">Obtained from the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" class="help-link">credentials page</a> of your project in the Google Cloud Console.</p>
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
		background: linear-gradient(135deg, #34a853, #4285f4);
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
		border-color: #4285f4;
	}

	.help-text {
		font-size: 0.8rem;
		color: #64748b;
		margin: 0;
	}

	.help-link {
		color: #4285f4;
		text-decoration: underline;
	}

	.help-link:hover {
		color: #3b82f6;
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
		background: #4285f4;
		color: white;
		width: 100%;
	}

	.vertical-form {
		display: flex;
		flex-direction: column;
	}

	.alert-box {
		background: rgba(59, 130, 246, 0.08);
		border: 1px solid rgba(59, 130, 246, 0.2);
		border-radius: 8px;
		padding: 14px;
		margin-bottom: 20px;
		display: flex;
		gap: 12px;
		font-size: 0.85rem;
		line-height: 1.45;
		color: #60a5fa;
	}

	.alert-icon {
		font-size: 1.2rem;
		flex-shrink: 0;
	}

</style>
