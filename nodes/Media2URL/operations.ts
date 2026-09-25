import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { requestMedia2Url } from './transport';
import { executeImportFromUrl } from './imports';
import { executeUploadBinary } from './uploads';
import { executeReplaceAsset } from './replacement';

interface AssetListResponse {
	data: JsonObject[];
	pagination: {
		has_more: boolean;
		next_cursor: string | null;
	};
}

interface VersionListResponse {
	data: JsonObject[];
}

export type Media2UrlOperation =
	| 'account.getUsage'
	| 'asset.get'
	| 'asset.getMany'
	| 'asset.delete'
	| 'asset.upload'
	| 'asset.importFromUrl'
	| 'asset.replace'
	| 'version.getMany';

const API_PAGE_SIZE = 100;
const MAX_OUTPUT_ITEMS = 10_000;
const MAX_PAGES = 1_000;

function getOperationKey(resource: string, operation: string): Media2UrlOperation | undefined {
	const key = `${resource}.${operation}`;
	if (
		key === 'account.getUsage' ||
		key === 'asset.get' ||
		key === 'asset.getMany' ||
		key === 'asset.delete' ||
		key === 'asset.upload' ||
		key === 'asset.importFromUrl' ||
		key === 'asset.replace' ||
		key === 'version.getMany'
	) {
		return key;
	}
	return undefined;
}

function requiredString(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): string {
	const value = context.getNodeParameter(name, itemIndex, '') as unknown;
	if (typeof value !== 'string' || !value.trim()) {
		throw new NodeOperationError(context.getNode(), `${label} is required.`, { itemIndex });
	}
	return value.trim();
}

function requiredAssetId(context: IExecuteFunctions, itemIndex: number): string {
	const assetId = requiredString(context, 'assetId', itemIndex, 'Asset ID');
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(assetId)) {
		throw new NodeOperationError(context.getNode(), 'Asset ID contains unsupported characters.', { itemIndex });
	}
	return assetId;
}

function readBoolean(context: IExecuteFunctions, name: string, itemIndex: number): boolean {
	return context.getNodeParameter(name, itemIndex, false) === true;
}

function readLimit(context: IExecuteFunctions, itemIndex: number): number {
	const value = context.getNodeParameter('limit', itemIndex, 50);
	const limit = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTPUT_ITEMS) {
		throw new NodeOperationError(
			context.getNode(),
			`Limit must be a whole number between 1 and ${MAX_OUTPUT_ITEMS}.`,
			{ itemIndex },
		);
	}
	return limit;
}

function result(item: JsonObject, itemIndex: number): INodeExecutionData {
	return { json: item, pairedItem: { item: itemIndex } };
}

async function getAssetList(
	context: IExecuteFunctions,
	itemIndex: number,
	returnAll: boolean,
	requestedLimit: number,
): Promise<JsonObject[]> {
	const results: JsonObject[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const pageLimit = returnAll ? API_PAGE_SIZE : Math.min(API_PAGE_SIZE, requestedLimit - results.length);
		if (pageLimit <= 0) return results;
		const response = await requestMedia2Url<AssetListResponse>(context, '/v1/assets', {
			method: 'GET',
			qs: { limit: pageLimit, ...(cursor ? { cursor } : {}) },
			itemIndex,
		});
		if (!response || !Array.isArray(response.data) || !response.pagination) {
			throw new NodeOperationError(context.getNode(), 'Media2URL returned an invalid asset list response.', { itemIndex });
		}
		results.push(...response.data.slice(0, pageLimit));
		if (!returnAll && results.length >= requestedLimit) return results.slice(0, requestedLimit);
		if (response.pagination.has_more !== true) return results;
		const nextCursor = response.pagination.next_cursor;
		if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
			throw new NodeOperationError(context.getNode(), 'Media2URL returned an invalid pagination cursor.', { itemIndex });
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	throw new NodeOperationError(context.getNode(), 'Media2URL pagination exceeded the safety limit.', { itemIndex });
}

export async function executeOperation(
	context: IExecuteFunctions,
	resource: string,
	operation: string,
	inputItems: INodeExecutionData[],
	itemIndexOffset = 0,
): Promise<INodeExecutionData[]> {
	const operationKey = getOperationKey(resource, operation);
	if (!operationKey) {
		throw new NodeOperationError(context.getNode(), 'The selected Media2URL operation is not supported.', {
			itemIndex: itemIndexOffset,
		});
	}
	if (operationKey === 'asset.upload') {
		return executeUploadBinary(context, inputItems, itemIndexOffset);
	}
	if (operationKey === 'asset.importFromUrl') {
		return executeImportFromUrl(context, inputItems, itemIndexOffset);
	}
	if (operationKey === 'asset.replace') {
		return executeReplaceAsset(context, inputItems, itemIndexOffset);
	}
	const output: INodeExecutionData[] = [];
	for (let inputIndex = 0; inputIndex < inputItems.length; inputIndex++) {
		const itemIndex = itemIndexOffset + inputIndex;
		if (operationKey === 'account.getUsage') {
			const usage = await requestMedia2Url<JsonObject>(context, '/v1/usage', { method: 'GET', itemIndex });
			output.push(result(usage, itemIndex));
			continue;
		}

		if (operationKey === 'asset.get') {
			const assetId = requiredAssetId(context, itemIndex);
			const asset = await requestMedia2Url<JsonObject>(
				context,
				`/v1/assets/${encodeURIComponent(assetId)}`,
				{ method: 'GET', itemIndex },
			);
			output.push(result(asset, itemIndex));
			continue;
		}

		if (operationKey === 'asset.getMany') {
			const returnAll = readBoolean(context, 'returnAll', itemIndex);
			const requestedLimit = returnAll ? MAX_OUTPUT_ITEMS : readLimit(context, itemIndex);
			const assets = await getAssetList(context, itemIndex, returnAll, requestedLimit);
			output.push(...assets.map((asset) => result(asset, itemIndex)));
			continue;
		}

		if (operationKey === 'asset.delete') {
			const assetId = requiredAssetId(context, itemIndex);
			await requestMedia2Url(context, `/v1/assets/${encodeURIComponent(assetId)}`, {
				method: 'DELETE',
				itemIndex,
			});
			output.push(result({ deleted: true }, itemIndex));
			continue;
		}

		if (operationKey === 'version.getMany') {
			const assetId = requiredAssetId(context, itemIndex);
			const response = await requestMedia2Url<VersionListResponse>(
				context,
				`/v1/assets/${encodeURIComponent(assetId)}/versions`,
				{ method: 'GET', itemIndex },
			);
			if (!response || !Array.isArray(response.data)) {
				throw new NodeOperationError(context.getNode(), 'Media2URL returned an invalid version list response.', { itemIndex });
			}
			output.push(...response.data.map((version) => result(version, itemIndex)));
			continue;
		}

	}
	return output;
}

export function addItemIndexToNodeError(
	context: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	const errorContext = error instanceof NodeApiError || error instanceof NodeOperationError ? error.context : undefined;
	const actualItemIndex = typeof errorContext?.itemIndex === 'number' ? errorContext.itemIndex : itemIndex;
	if (error instanceof NodeApiError) {
		const safeResponse: JsonObject = {};
		if (error.httpCode) safeResponse.statusCode = error.httpCode;
		const wrapped = new NodeApiError(context.getNode(), safeResponse, {
			message: error.message,
			description: error.description ?? undefined,
			httpCode: error.httpCode ?? undefined,
			itemIndex: actualItemIndex,
		});
		for (const key of ['requestId', 'retryAfter']) {
			const value = error.context[key];
			if (typeof value === 'string' && key === 'requestId') wrapped.context[key] = value;
			if (typeof value === 'number' && key === 'retryAfter') wrapped.context[key] = value;
		}
		return wrapped;
	}
	if (error instanceof NodeOperationError) {
		return new NodeOperationError(context.getNode(), error.message, {
			description: error.description ?? undefined,
			itemIndex: actualItemIndex,
		});
	}
	return new NodeOperationError(context.getNode(), 'Media2URL operation failed. Check the input and try again.', {
		itemIndex: actualItemIndex,
	});
}
