<script lang="ts">
	import { GoogleDriveStorage } from '$lib/backends/GoogleDriveStorage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';
	import { Padding, Panel, Field, TextInput, InfoBox, Button } from 'svelte-akui';

	let backend = $state<GoogleDriveStorage | null>(null);

	const configFields = [
		{
			key: 'clientId',
			label: 'Google OAuth Client ID',
			type: 'text' as const,
			placeholder: 'Enter your Google client ID',
			helpText: 'Obtained from the credentials page of your project in the Google Cloud Console.'
		},
		{
			key: 'folderName',
			label: 'Google Drive Folder Name',
			type: 'text' as const,
			placeholder: 'Enter root folder name (optional)',
			helpText: 'Scopes all files and folders inside this user-visible directory.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new GoogleDriveStorage({
			clientId: configValues.clientId.trim(),
			folderName: configValues.folderName?.trim() || undefined
		});
	}

	// Initialize backend if last config is saved in localStorage
	if (typeof window !== 'undefined') {
		const savedClientId = localStorage.getItem('tester_config_google-drive_clientId');
		const savedFolder = localStorage.getItem('tester_config_google-drive_folderName');
		if (savedClientId) {
			backend = new GoogleDriveStorage({
				clientId: savedClientId.trim(),
				folderName: savedFolder?.trim() || undefined
			});
		}
	}
</script>

<svelte:head>
	<title>Google Drive Backend Tester</title>
</svelte:head>

<div style="max-width: 1100px; margin: 0 auto; padding: 0 1rem;">
	<Padding size="m" y>
		<header style="text-align: center; margin-bottom: 2rem;">
			<h1 style="font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem;">
				Google Drive Storage Backend Tester
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.1rem; font-weight: 300; margin: 0;">
				Securely verify your client-side Google Drive authentication and file CRUD operations
			</p>
		</header>

		{#if backend}
			<StorageTester {backend} title="Google Drive" {configFields} onConfigure={handleConfigure} />
		{:else}
			<div style="max-width: 500px; margin: 0 auto;">
				<Panel colour="regular">
					<Padding size="m">
						<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1.25rem;">Google Drive Configuration</h2>
						
						<Padding size="s" y>
							<InfoBox variant="info" title="Implicit Auth Flow">
								<p style="font-size: 0.85rem; line-height: 1.45; margin: 0;">
									This client-side library uses Google's standard OAuth Implicit Flow. Create a <strong>"Web application"</strong> client ID in your Google Cloud project and register this page's URL as an authorized redirect URI. No client secret is required.
								</p>
							</InfoBox>
						</Padding>

						<form
							onsubmit={(e) => {
								e.preventDefault();
								const fd = new FormData(e.currentTarget);
								const clientId = fd.get('clientId') as string;
								const folderName = fd.get('folderName') as string;
								localStorage.setItem('tester_config_google-drive_clientId', clientId || '');
								localStorage.setItem('tester_config_google-drive_folderName', folderName || '');
								handleConfigure({ clientId, folderName });
							}}
							style="display: flex; flex-direction: column; gap: 1.25rem;"
						>
							<Field
								label="Google OAuth Client ID"
								hint="Obtained from the credentials page of your project in the Google Cloud Console."
								for="clientId"
							>
								<TextInput
									type="text"
									id="clientId"
									name="clientId"
									placeholder="Enter your Google client ID"
									required
								/>
							</Field>

							<Field
								label="Google Drive Folder Name"
								hint="All files will be stored inside this folder (e.g. StratusBase)."
								for="folderName"
							>
								<TextInput
									type="text"
									id="folderName"
									name="folderName"
									placeholder="Enter folder name (optional, defaults to root)"
								/>
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
