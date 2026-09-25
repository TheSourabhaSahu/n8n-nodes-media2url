import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { addItemIndexToNodeError, executeOperation } from './operations';

export class Media2URL implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Media2URL',
		name: 'media2Url',
		icon: { light: 'file:example.svg', dark: 'file:example.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Upload and manage Media2URL assets and account usage.',
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		defaults: {
			name: 'Media2URL',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'media2URLApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Asset', value: 'asset' },
					{ name: 'Version', value: 'version' },
				],
				default: 'asset',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [{ name: 'Get Usage', value: 'getUsage', action: 'Get account usage' }],
				default: 'getUsage',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['asset'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get an asset' },
					{ name: 'Get Many', value: 'getMany', action: 'Get many assets' },
					{ name: 'Delete', value: 'delete', action: 'Delete an asset' },
					{ name: 'Upload Binary File', value: 'upload', action: 'Upload a binary file' },
				],
				default: 'getMany',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['version'] } },
				options: [{ name: 'Get Many', value: 'getMany', action: 'Get many asset versions' }],
				default: 'getMany',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				displayOptions: { show: { resource: ['asset'], operation: ['upload'] } },
				default: 'data',
				placeholder: 'data',
				description: 'Name of the incoming binary property to upload',
			},
			{
				displayName: 'File Name',
				name: 'filename',
				type: 'string',
				displayOptions: { show: { resource: ['asset'], operation: ['upload'] } },
				default: '',
				placeholder: 'Leave empty to use the incoming filename',
				description: 'Optional destination filename to use instead of the incoming binary filename',
			},
			{
				displayName: 'Privacy',
				name: 'privacy',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['asset'], operation: ['upload'] } },
				options: [
					{ name: 'Public', value: 'public' },
					{ name: 'Unlisted', value: 'unlisted' },
					{ name: 'Private', value: 'private' },
				],
				default: 'public',
				description: 'Link visibility for the uploaded asset',
			},
			{
				displayName: 'Asset ID',
				name: 'assetId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['asset'],
						operation: ['get', 'delete'],
					},
				},
				default: '',
				placeholder: 'asset_123',
				description: 'The asset ID returned by Media2URL. Deletion removes the asset from your account.',
			},
			{
				displayName: 'Asset ID',
				name: 'assetId',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['version'],
						operation: ['getMany'],
					},
				},
				default: '',
				placeholder: 'asset_123',
				description: 'The asset whose read-only version history you want to retrieve',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				displayOptions: { show: { resource: ['asset'], operation: ['getMany'] } },
				default: false,
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				displayOptions: {
					show: {
						resource: ['asset'],
						operation: ['getMany'],
						returnAll: [false],
					},
				},
				typeOptions: { minValue: 1, maxValue: 10000 },
				default: 50,
				description: 'Max number of results to return',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const output: INodeExecutionData[] = [];
		if (
			inputItems.length &&
			this.getNodeParameter('resource', 0) === 'asset' &&
			this.getNodeParameter('operation', 0) === 'upload'
		) {
			try {
				return [await executeOperation(this, 'asset', 'upload', inputItems)];
			} catch (error) {
				const errorIndex =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? typeof error.context.itemIndex === 'number'
							? error.context.itemIndex
							: 0
						: 0;
				if (this.continueOnFail()) {
					const safeMessage =
						error instanceof NodeOperationError || error instanceof NodeApiError
							? error.message
							: 'Media2URL operation failed.';
					return [[{ json: { error: safeMessage }, pairedItem: { item: errorIndex } }]];
				}
				throw addItemIndexToNodeError(this, error, errorIndex);
			}
		}
		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const itemOutput = await executeOperation(this, resource, operation, [inputItems[itemIndex]], itemIndex);
				output.push(...itemOutput);
			} catch (error) {
				if (this.continueOnFail()) {
					const safeMessage =
						error instanceof NodeOperationError || error instanceof NodeApiError
							? error.message
							: 'Media2URL operation failed.';
					output.push({ json: { error: safeMessage }, pairedItem: { item: itemIndex } });
					continue;
				}
				throw addItemIndexToNodeError(this, error, itemIndex);
			}
		}
		return [output];
	}
}
