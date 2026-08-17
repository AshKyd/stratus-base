<script lang="ts">
	import { GithubStorage } from '$lib/backends/GithubStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';

	let backend = $state<GithubStorage | null>(null);

	const configFields = [
		{
			key: 'owner',
			label: 'GitHub Owner/Username',
			type: 'text' as const,
			placeholder: 'e.g. AshKyd',
			helpText: 'The user or organisation owner of the target repository.'
		},
		{
			key: 'repo',
			label: 'GitHub Repository Name',
			type: 'text' as const,
			placeholder: 'e.g. stratus-base',
			helpText: 'The repository name where files will be read and written.'
		},
		{
			key: 'branch',
			label: 'Branch Name',
			type: 'text' as const,
			placeholder: 'e.g. main',
			helpText: 'Defaults to "main" if left blank.'
		},
		{
			key: 'accessToken',
			label: 'GitHub Personal Access Token (PAT)',
			type: 'password' as const,
			placeholder: 'ghp_...',
			helpText: 'Required to read/write contents on the client-side.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new GithubStorage({
			owner: configValues.owner.trim(),
			repo: configValues.repo.trim(),
			branch: configValues.branch ? configValues.branch.trim() : 'main'
		});
		if (backend.setCredentials) {
			backend.setCredentials({
				accessToken: configValues.accessToken.trim()
			});
		}
	}

	// Initialize backend if saved in localStorage
	if (typeof window !== 'undefined') {
		const savedOwner = localStorage.getItem('tester_config_github_owner');
		const savedRepo = localStorage.getItem('tester_config_github_repo');
		const savedBranch = localStorage.getItem('tester_config_github_branch');
		const savedCreds = localStorage.getItem('tester_creds_github');

		if (savedOwner && savedRepo) {
			const instance = new GithubStorage({
				owner: savedOwner.trim(),
				repo: savedRepo.trim(),
				branch: savedBranch ? savedBranch.trim() : 'main'
			});
			if (savedCreds && instance.setCredentials) {
				instance.setCredentials(JSON.parse(savedCreds));
			}
			backend = instance;
		}
	}
</script>

<svelte:head>
	<title>GitHub Backend Tester</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
	<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="container">
	<header class="header">
		<h1>GitHub Storage Backend Tester</h1>
		<p class="subtitle">Securely verify your client-side GitHub file operations using a Personal Access Token</p>
	</header>

	{#if backend}
		<StorageTester {backend} title="GitHub" {configFields} onConfigure={handleConfigure} />
	{:else}
		<section class="card">
			<h2>GitHub Configuration</h2>
			<div class="alert-box">
				<span class="alert-icon">ℹ️</span>
				<div class="alert-content">
					<strong>Client-Side Token Authentication:</strong> To avoid exposing application secrets or running a backend OAuth proxy, this tester allows you to authenticate using a GitHub <strong>Personal Access Token (PAT)</strong>. Tokens are stored purely in your browser's local storage.
				</div>
			</div>

			<form onsubmit={(e) => {
				e.preventDefault();
				const fd = new FormData(e.currentTarget);
				handleConfigure({
					owner: fd.get('owner') as string,
					repo: fd.get('repo') as string,
					branch: fd.get('branch') as string,
					accessToken: fd.get('accessToken') as string
				});
			}} class="vertical-form">
				<div class="form-group">
					<label for="owner">GitHub Owner/Username</label>
					<input type="text" id="owner" name="owner" placeholder="e.g. AshKyd" required />
				</div>
				<div class="form-group">
					<label for="repo">GitHub Repository Name</label>
					<input type="text" id="repo" name="repo" placeholder="e.g. stratus-base" required />
				</div>
				<div class="form-group">
					<label for="branch">Branch Name</label>
					<input type="text" id="branch" name="branch" placeholder="main" />
				</div>
				<div class="form-group">
					<label for="accessToken">GitHub Personal Access Token (PAT)</label>
					<input type="password" id="accessToken" name="accessToken" placeholder="ghp_..." required />
					<p class="help-text">
						Generate a token with <code>repo</code> scope (classic) or Contents read/write permissions (fine-grained) at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="help-link">github.com/settings/tokens</a>.
					</p>
				</div>
				<button type="submit" class="btn btn-primary">Save and Continue</button>
			</form>
		</section>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		background: #0d1117;
		color: #c9d1d9;
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
		background: linear-gradient(135deg, #a371f7, #2188ff);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		margin-bottom: 10px;
	}

	.subtitle {
		color: #8b949e;
		font-size: 1.1rem;
		font-weight: 300;
	}

	.card {
		background: rgba(22, 27, 34, 0.6);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(240, 246, 252, 0.1);
		border-radius: 16px;
		padding: 24px;
		box-shadow: 0 4px 30px rgba(0, 0, 0, 0.4);
		max-width: 500px;
		margin: 0 auto;
	}

	h2 {
		font-size: 1.3rem;
		margin-top: 0;
		margin-bottom: 20px;
		color: #f0f6fc;
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
		color: #8b949e;
		font-weight: 500;
	}

	input[type='text'],
	input[type='password'] {
		background: #0d1117;
		border: 1px solid rgba(240, 246, 252, 0.1);
		border-radius: 8px;
		padding: 12px;
		color: #f0f6fc;
		font-size: 0.95rem;
		transition: border-color 0.2s;
	}

	input[type='text']:focus,
	input[type='password']:focus {
		outline: none;
		border-color: #2188ff;
	}

	.help-text {
		font-size: 0.8rem;
		color: #8b949e;
		margin: 0;
	}

	.help-link {
		color: #58a6ff;
		text-decoration: underline;
	}

	.help-link:hover {
		color: #79c0ff;
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
		background: #238636;
		color: white;
		width: 100%;
	}

	.btn-primary:hover {
		background: #2ea043;
	}

	.vertical-form {
		display: flex;
		flex-direction: column;
	}

	.alert-box {
		background: rgba(56, 139, 253, 0.1);
		border: 1px solid rgba(56, 139, 253, 0.2);
		border-radius: 8px;
		padding: 14px;
		margin-bottom: 20px;
		display: flex;
		gap: 12px;
		font-size: 0.85rem;
		line-height: 1.45;
		color: #58a6ff;
	}

	.alert-icon {
		font-size: 1.2rem;
		flex-shrink: 0;
	}
</style>
