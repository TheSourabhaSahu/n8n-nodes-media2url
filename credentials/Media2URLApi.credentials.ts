import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class Media2URLApi implements ICredentialType {
	name = 'media2URLApi';
	displayName = 'Media2URL API';
	icon = { light: 'file:example.svg', dark: 'file:example.dark.svg' } as const;
	documentationUrl = 'https://media2url.com/docs/api/v1';
	testedBy = 'media2Url';

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.media2url.com',
			url: '/v1/usage',
			method: 'GET',
		},
	};
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'A Media2URL API key. It is sent as a bearer token and stored by n8n credentials.',
		},
	];
}
