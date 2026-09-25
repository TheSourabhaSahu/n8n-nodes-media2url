import { createHash } from 'node:crypto';
import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { requestMedia2Url, uploadToPresignedUrl } from './transport';

interface UsageResponse {
	account?: { capabilities?: { replace?: boolean } };
}

interface ReplacementInput {
	itemIndex: number;
	assetId: string;
	propertyName: string;
	filename: string;
	contentType: string;
}

interface PresignResponse {
	upload_id: string;
	upload_url: string;
	required_headers: Record<string, unknown>;
}

function safeNodeError(context: IExecuteFunctions, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError) {
		const safeResponse: JsonObject = {};
		if (error.httpCode) safeResponse.statusCode = error.httpCode;
		const wrapped = new NodeApiError(context.getNode(), safeResponse, {
			message: error.message,
			description: error.description ?? undefined,
			httpCode: error.httpCode ?? undefined,
			itemIndex,
		});
		for (const key of ['requestId', 'retryAfter']) {
			const value = error.context[key];
			if ((key === 'requestId' && typeof value === 'string') || (key === 'retryAfter' && typeof value === 'number')) {
				wrapped.context[key] = value;
			}
		}
		return wrapped;
	}
	if (error instanceof NodeOperationError) {
		return new NodeOperationError(context.getNode(), error.message, {
			description: error.description ?? undefined,
			itemIndex,
		});
	}
	return new NodeOperationError(context.getNode(), 'Media2URL replacement failed. Check the asset and binary input.', { itemIndex });
}

function collectReplacementInputs(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset: number,
): ReplacementInput[] {
	return inputItems.map((item, offset) => {
		const itemIndex = itemIndexOffset + offset;
		const assetValue = context.getNodeParameter('assetId', itemIndex, '') as unknown;
		if (typeof assetValue !== 'string' || !assetValue.trim() || !/^[a-zA-Z0-9_-]{1,128}$/.test(assetValue.trim())) {
			throw new NodeOperationError(context.getNode(), 'A valid Media2URL asset ID is required for replacement.', { itemIndex });
		}
		const propertyName = String(context.getNodeParameter('binaryPropertyName', itemIndex, 'data')).trim();
		const binary = item.binary?.[propertyName];
		if (!propertyName || !binary) {
			throw new NodeOperationError(context.getNode(), `No binary data was found in property "${propertyName || 'data'}" for input item ${itemIndex + 1}.`, { itemIndex });
		}
		const filenameOverride = context.getNodeParameter('filename', itemIndex, '') as unknown;
		const filename = typeof filenameOverride === 'string' && filenameOverride.trim()
			? filenameOverride.trim()
			: typeof binary.fileName === 'string'
				? binary.fileName.trim()
				: '';
		if (!filename) throw new NodeOperationError(context.getNode(), `A filename is required for input item ${itemIndex + 1}.`, { itemIndex });
		const contentType = typeof binary.mimeType === 'string' ? binary.mimeType.trim().toLowerCase() : '';
		if (!contentType) throw new NodeOperationError(context.getNode(), `A MIME type is required for input item ${itemIndex + 1}.`, { itemIndex });
		return { itemIndex, assetId: assetValue.trim(), propertyName, filename, contentType };
	});
}

function idempotencyKey(context: IExecuteFunctions, assetId: string, itemIndex: number): string {
	const executionId = context.getExecutionId();
	if (typeof executionId !== 'string' || !executionId) {
		throw new NodeOperationError(context.getNode(), 'The n8n execution ID is unavailable; replacement was not started.', { itemIndex });
	}
	const digest = createHash('sha256').update(`media2url:n8n:asset-replacement:${executionId}:${itemIndex}`).digest('hex').slice(0, 40);
	return `m2u-n8n-${digest}`;
}

async function replaceOne(context: IExecuteFunctions, item: ReplacementInput): Promise<JsonObject> {
	let buffer: Buffer;
	try {
		buffer = await context.helpers.getBinaryDataBuffer(item.itemIndex, item.propertyName);
	} catch {
		throw new NodeOperationError(context.getNode(), `Binary data for input item ${item.itemIndex + 1} could not be read.`, { itemIndex: item.itemIndex });
	}
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		throw new NodeOperationError(context.getNode(), `Binary data for input item ${item.itemIndex + 1} is empty.`, { itemIndex: item.itemIndex });
	}
	const checksum = createHash('sha256').update(buffer).digest('hex');
	const path = `/v1/assets/${encodeURIComponent(item.assetId)}/replace`;
	const presign = await requestMedia2Url<PresignResponse>(context, `${path}/presign`, {
		method: 'POST',
		itemIndex: item.itemIndex,
		body: {
			filename: item.filename,
			content_type: item.contentType,
			size: buffer.length,
			checksum_sha256: checksum,
		},
	});
	if (!presign || typeof presign.upload_id !== 'string' || typeof presign.upload_url !== 'string' || !presign.required_headers) {
		throw new NodeOperationError(context.getNode(), 'Media2URL returned incomplete replacement instructions.', { itemIndex: item.itemIndex });
	}
	await uploadToPresignedUrl(context, presign.upload_url, presign.required_headers, buffer, item.itemIndex);
	const asset = await requestMedia2Url<JsonObject>(context, `${path}/finalize`, {
		method: 'POST',
		itemIndex: item.itemIndex,
		headers: { 'Idempotency-Key': idempotencyKey(context, item.assetId, item.itemIndex) },
		body: { upload_id: presign.upload_id },
	});
	const output: JsonObject = { ...asset };
	if (typeof asset.direct_url === 'string') output.directUrl = asset.direct_url;
	if (typeof asset.share_url === 'string') output.shareUrl = asset.share_url;
	return output;
}

export async function executeReplaceAsset(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset = 0,
): Promise<INodeExecutionData[]> {
	const replacements = collectReplacementInputs(context, inputItems, itemIndexOffset);
	if (!replacements.length) return [];
	const usage = await requestMedia2Url<UsageResponse>(context, '/v1/usage', { method: 'GET', itemIndex: itemIndexOffset });
	if (usage?.account?.capabilities?.replace !== true) {
		throw new NodeOperationError(
			context.getNode(),
			'Replacing an asset while preserving its managed URL requires an active Media2URL paid plan.',
			{ itemIndex: itemIndexOffset },
		);
	}
	const output: INodeExecutionData[] = [];
	for (const item of replacements) {
		try {
			const asset = await replaceOne(context, item);
			output.push({ json: asset, pairedItem: { item: item.itemIndex } });
		} catch (error) {
			const normalized = safeNodeError(context, error, item.itemIndex);
			if (context.continueOnFail()) {
				output.push({ json: { error: normalized.message }, pairedItem: { item: item.itemIndex } });
				continue;
			}
			throw safeNodeError(context, error, item.itemIndex);
		}
	}
	return output;
}
