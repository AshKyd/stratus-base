<script lang="ts">
	import { S3Storage } from '$lib/backends/S3Storage.js';
	import StorageTester from '$lib/components/StorageTester/StorageTester.svelte';
	import { Padding, Panel, Field, TextInput, PasswordInput, Button } from 'svelte-akui';

	let backend = $state<S3Storage | null>(null);

	const configFields = [
		{
			key: 'accessKeyId',
			label: 'Access Key ID',
			type: 'text' as const,
			placeholder: 'Enter your AWS Access Key ID'
		},
		{
			key: 'secretAccessKey',
			label: 'Secret Access Key',
			type: 'password' as const,
			placeholder: 'Enter your AWS Secret Access Key'
		},
		{
			key: 'region',
			label: 'Region',
			type: 'text' as const,
			placeholder: 'e.g. us-east-1'
		},
		{
			key: 'bucket',
			label: 'Bucket Name',
			type: 'text' as const,
			placeholder: 'Enter your bucket name'
		},
		{
			key: 'endpoint',
			label: 'Endpoint URL (Optional)',
			type: 'text' as const,
			placeholder: 'e.g. https://<account-id>.r2.cloudflarestorage.com',
			helpText: 'Leave empty for official Amazon AWS S3.'
		},
		{
			key: 'forcePathStyle',
			label: 'Force Path Style (Optional)',
			type: 'text' as const,
			placeholder: 'true or false',
			helpText: 'Set to "true" for local test environments (like MinIO or s3rver), or leave empty.'
		}
	];

	async function handleConfigure(configValues: Record<string, string>) {
		backend = new S3Storage({
			accessKeyId: configValues.accessKeyId.trim(),
			secretAccessKey: configValues.secretAccessKey.trim(),
			region: configValues.region.trim(),
			bucket: configValues.bucket.trim(),
			endpoint: configValues.endpoint?.trim() || undefined,
			forcePathStyle: configValues.forcePathStyle?.trim() === 'true'
		});
	}

	// Initialize backend if saved config is complete in localStorage
	if (typeof window !== 'undefined') {
		const savedAccessKeyId = localStorage.getItem('tester_config_s3_accessKeyId');
		const savedSecretAccessKey = localStorage.getItem('tester_config_s3_secretAccessKey');
		const savedRegion = localStorage.getItem('tester_config_s3_region');
		const savedBucket = localStorage.getItem('tester_config_s3_bucket');
		const savedEndpoint = localStorage.getItem('tester_config_s3_endpoint');
		const savedForcePathStyle = localStorage.getItem('tester_config_s3_forcePathStyle');

		if (savedAccessKeyId && savedSecretAccessKey && savedRegion && savedBucket) {
			backend = new S3Storage({
				accessKeyId: savedAccessKeyId.trim(),
				secretAccessKey: savedSecretAccessKey.trim(),
				region: savedRegion.trim(),
				bucket: savedBucket.trim(),
				endpoint: savedEndpoint?.trim() || undefined,
				forcePathStyle: savedForcePathStyle?.trim() === 'true'
			});
		}
	}
</script>

<svelte:head>
	<title>S3 Backend Tester</title>
</svelte:head>

<div style="max-width: 1100px; margin: 0 auto; padding: 0 1rem;">
	<Padding size="m" y>
		<header style="text-align: center; margin-bottom: 2rem;">
			<h1 style="font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem;">
				S3 Storage Backend Tester
			</h1>
			<p style="color: var(--akui-fg-secondary); font-size: 1.1rem; font-weight: 300; margin: 0;">
				Securely verify your client-side S3 authentication and file CRUD operations
			</p>
		</header>

		{#if backend}
			<StorageTester {backend} title="S3" {configFields} onConfigure={handleConfigure} />
		{:else}
			<div style="max-width: 500px; margin: 0 auto;">
				<Panel colour="regular">
					<Padding size="m">
						<h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1.25rem;">S3 Configuration</h2>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								const fd = new FormData(e.currentTarget);
								const config = {
									accessKeyId: fd.get('accessKeyId') as string,
									secretAccessKey: fd.get('secretAccessKey') as string,
									region: fd.get('region') as string,
									bucket: fd.get('bucket') as string,
									endpoint: fd.get('endpoint') as string,
									forcePathStyle: fd.get('forcePathStyle') as string
								};
								// Save them so Svelte component can read
								Object.entries(config).forEach(([key, value]) => {
									localStorage.setItem(`tester_config_s3_${key}`, value || '');
								});
								handleConfigure(config);
							}}
							style="display: flex; flex-direction: column; gap: 1.25rem;"
						>
							<Field label="Access Key ID" for="accessKeyId">
								<TextInput type="text" id="accessKeyId" name="accessKeyId" placeholder="Enter AWS Access Key ID" required />
							</Field>

							<Field label="Secret Access Key" for="secretAccessKey">
								<PasswordInput id="secretAccessKey" name="secretAccessKey" placeholder="Enter AWS Secret Access Key" required />
							</Field>

							<Field label="Region" for="region">
								<TextInput type="text" id="region" name="region" placeholder="e.g. us-east-1" required />
							</Field>

							<Field label="Bucket Name" for="bucket">
								<TextInput type="text" id="bucket" name="bucket" placeholder="Enter bucket name" required />
							</Field>

							<Field label="Endpoint URL (Optional)" hint="Leave empty for official Amazon AWS S3." for="endpoint">
								<TextInput type="text" id="endpoint" name="endpoint" placeholder="e.g. https://<account-id>.r2.cloudflarestorage.com" />
							</Field>

							<Field label="Force Path Style (Optional)" hint="Set to 'true' for local test environments (like MinIO or s3rver), or leave empty." for="forcePathStyle">
								<TextInput type="text" id="forcePathStyle" name="forcePathStyle" placeholder="true or false" />
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
