<script lang="ts">
	import { GithubStorage } from '$lib/backends/GithubStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';
	import { Padding, Panel, Field, TextInput, PasswordInput, InfoBox, Button } from 'svelte-akui';

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
</svelte:head>

<div style="max-width: 1100px; margin: 0 auto; padding: 0 1rem;">
	<Padding size="m" y>
		<header style="text-align: center; margin-bottom: 2rem;">
			<h1 style="font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem;">
				GitHub Storage Backend Tester
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.1rem; font-weight: 300; margin: 0;">
				Securely verify your client-side GitHub file operations using a Personal Access Token
			</p>
		</header>

		{#if backend}
			<StorageTester {backend} title="GitHub" {configFields} onConfigure={handleConfigure} />
		{:else}
			<div style="max-width: 500px; margin: 0 auto;">
				<Panel colour="regular">
					<Padding size="m">
						<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1.25rem;">GitHub Configuration</h2>
						
						<Padding size="s" y>
							<InfoBox variant="info" title="Client-Side Token Authentication">
								<p style="font-size: 0.85rem; line-height: 1.45; margin: 0;">
									This tester allows you to authenticate using a GitHub <strong>Personal Access Token (PAT)</strong>. Tokens are stored purely in your browser's local storage.
								</p>
							</InfoBox>
						</Padding>

						<form
							onsubmit={(e) => {
								e.preventDefault();
								const fd = new FormData(e.currentTarget);
								const owner = fd.get('owner') as string;
								const repo = fd.get('repo') as string;
								const branch = fd.get('branch') as string;
								const accessToken = fd.get('accessToken') as string;

								localStorage.setItem('tester_config_github_owner', owner || '');
								localStorage.setItem('tester_config_github_repo', repo || '');
								localStorage.setItem('tester_config_github_branch', branch || '');
								localStorage.setItem('tester_creds_github', JSON.stringify({ accessToken }) || '');

								handleConfigure({ owner, repo, branch, accessToken });
							}}
							style="display: flex; flex-direction: column; gap: 1.25rem;"
						>
							<Field label="GitHub Owner/Username" for="owner">
								<TextInput type="text" id="owner" name="owner" placeholder="e.g. AshKyd" required />
							</Field>

							<Field label="GitHub Repository Name" for="repo">
								<TextInput type="text" id="repo" name="repo" placeholder="e.g. stratus-base" required />
							</Field>

							<Field label="Branch Name" hint="Defaults to 'main' if left blank." for="branch">
								<TextInput type="text" id="branch" name="branch" placeholder="main" />
							</Field>

							<Field
								label="GitHub Personal Access Token (PAT)"
								hint="Generate a token with repo scope (classic) or Contents read/write permissions (fine-grained) at github.com/settings/tokens."
								for="accessToken"
							>
								<PasswordInput id="accessToken" name="accessToken" placeholder="ghp_..." required />
							</Field>

							<Button type="submit" variant="accent" style="width: 100%">
								Save and Continue
							</Button>
						</form>
					</Padding>
				</Panel>
			</div>
		{/if}
	</Padding>
</div>
