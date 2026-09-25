import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class Media2URLApi implements ICredentialType {
	name = 'media2URLApi';
	displayName = 'Media2URL API';
	icon = 'fa:cloud' as const;
	documentationUrl = 'https://media2url.com/docs/api/v1';
	properties: INodeProperties[] = [];
}
