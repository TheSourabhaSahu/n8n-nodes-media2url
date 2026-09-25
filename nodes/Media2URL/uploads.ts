import { createHash } from 'node:crypto';
import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { requestMedia2Url, uploadToPresignedUrl } from './transport';

interface UsageResponse {
	account?: {
		capabilities?: { persistent_publish?: boolean };
		trial?: { remaining?: number };
	};
}

interface PresignResponse {
	upload_id: string;
	upload_url: string;
	required_headers: Record<string, unknown>;
}

interface BinaryMetadata {
	itemIndex: number;
	propertyName: string;
	filename: string;
	contentType: string;
	declaredBytes?: number;
}

const FREE_MAX_BYTES = 2 * 1024 * 1024;

function nodeError(context: IExecuteFunctions, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
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
	return new NodeOperationError(context.getNode(), 'Media2URL upload failed. Check the binary input and try again.', { itemIndex });
}

function parseDeclaredBytes(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
	if (typeof value === 'string' && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return undefined;
}

function collectBinaryMetadata(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset: number,
): BinaryMetadata[] {
	return inputItems.map((item, offset) => {
		const itemIndex = itemIndexOffset + offset;
		const propertyName = String(context.getNodeParameter('binaryPropertyName', itemIndex, 'data')).trim();
		if (!propertyName || !item.binary?.[propertyName]) {
			throw new NodeOperationError(
				context.getNode(),
				`No binary data was found in property "${propertyName || 'data'}" for input item ${itemIndex + 1}.`,
				{ itemIndex },
			);
		}
		const binary = item.binary[propertyName];
		const filenameOverride = context.getNodeParameter('filename', itemIndex, '') as string;
		const filename = typeof filenameOverride === 'string' && filenameOverride.trim()
			? filenameOverride.trim()
			: typeof binary.fileName === 'string'
				? binary.fileName.trim()
				: '';
		if (!filename) throw new NodeOperationError(context.getNode(), `A filename is required for input item ${itemIndex + 1}.`, { itemIndex });
		const contentType = typeof binary.mimeType === 'string' ? binary.mimeType.trim().toLowerCase() : '';
		if (!contentType) throw new NodeOperationError(context.getNode(), `A MIME type is required for input item ${itemIndex + 1}.`, { itemIndex });
		return {
			itemIndex,
			propertyName,
			filename,
			contentType,
			declaredBytes: parseDeclaredBytes(binary.bytes) ?? parseDeclaredBytes(binary.fileSize),
		};
	});
}

function assertFreeFormat(context: IExecuteFunctions, file: BinaryMetadata): void {
	const extension = file.filename.toLowerCase().split('.').pop() ?? '';
	const eligible = (extension === 'png' && file.contentType === 'image/png') ||
		((extension === 'jpg' || extension === 'jpeg') && file.contentType === 'image/jpeg');
	if (!eligible) {
		throw new NodeOperationError(
			context.getNode(),
			'Free hosted trial uploads support PNG and JPG/JPEG files only. Use an eligible paid plan for other formats.',
			{ itemIndex: file.itemIndex },
		);
	}
}

function assertFreeFileEligible(context: IExecuteFunctions, file: BinaryMetadata, size: number): void {
	assertFreeFormat(context, file);
	if (size <= 0 || size > FREE_MAX_BYTES) {
		throw new NodeOperationError(
			context.getNode(),
			'Free hosted trial uploads are limited to files up to 2 MiB.',
			{ itemIndex: file.itemIndex },
		);
	}
}

async function readBuffer(context: IExecuteFunctions, file: BinaryMetadata): Promise<Buffer> {
	let buffer: Buffer;
	try {
		buffer = await context.helpers.getBinaryDataBuffer(file.itemIndex, file.propertyName);
	} catch {
		throw new NodeOperationError(context.getNode(), `Binary data for input item ${file.itemIndex + 1} could not be read.`, { itemIndex: file.itemIndex });
	}
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		throw new NodeOperationError(context.getNode(), `Binary data for input item ${file.itemIndex + 1} is empty.`, { itemIndex: file.itemIndex });
	}
	return buffer;
}

function idempotencyKey(context: IExecuteFunctions, itemIndex: number): string {
	const executionId = context.getExecutionId();
	if (typeof executionId !== 'string' || !executionId) {
		throw new NodeOperationError(context.getNode(), 'The n8n execution ID is unavailable; upload was not started.', { itemIndex });
	}
	const digest = createHash('sha256').update(`media2url:n8n:asset-upload:${executionId}:${itemIndex}`).digest('hex').slice(0, 40);
	return `m2u-n8n-${digest}`;
}

function normalizeAsset(asset: JsonObject): JsonObject {
	const output: JsonObject = { ...asset };
	if (typeof asset.direct_url === 'string') output.directUrl = asset.direct_url;
	if (typeof asset.share_url === 'string') output.shareUrl = asset.share_url;
	if (asset.temporary === true) output.temporary = true;
	if (typeof asset.expires_at === 'string') output.expiresAt = asset.expires_at;
	if (typeof asset.trial_remaining === 'number') output.trialRemaining = asset.trial_remaining;
	return output;
}

async function uploadOne(
	context: IExecuteFunctions,
	file: BinaryMetadata,
	buffer: Buffer,
): Promise<JsonObject> {
	const checksum = createHash('sha256').update(buffer).digest('hex');
	const privacy = context.getNodeParameter('privacy', file.itemIndex, 'public') as string;
	const presign = await requestMedia2Url<PresignResponse>(context, '/v1/uploads/presign', {
		method: 'POST',
		itemIndex: file.itemIndex,
		body: {
			filename: file.filename,
			content_type: file.contentType,
			size: buffer.length,
			checksum_sha256: checksum,
			privacy,
		},
	});
	if (!presign || typeof presign.upload_id !== 'string' || typeof presign.upload_url !== 'string' || !presign.required_headers) {
		throw new NodeOperationError(context.getNode(), 'Media2URL returned incomplete upload instructions.', { itemIndex: file.itemIndex });
	}
	await uploadToPresignedUrl(context, presign.upload_url, presign.required_headers, buffer, file.itemIndex);
	const asset = await requestMedia2Url<JsonObject>(context, '/v1/uploads/finalize', {
		method: 'POST',
		itemIndex: file.itemIndex,
		headers: { 'Idempotency-Key': idempotencyKey(context, file.itemIndex) },
		body: { upload_id: presign.upload_id },
	});
	return normalizeAsset(asset);
}

export async function executeUploadBinary(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset = 0,
): Promise<INodeExecutionData[]> {
	const files = collectBinaryMetadata(context, inputItems, itemIndexOffset);
	if (!files.length) return [];
	const usage = await requestMedia2Url<UsageResponse>(context, '/v1/usage', { method: 'GET', itemIndex: itemIndexOffset });
	const capabilities = usage?.account?.capabilities;
	const trial = usage?.account?.trial;
	if (typeof capabilities?.persistent_publish !== 'boolean') {
		throw new NodeOperationError(context.getNode(), 'Media2URL account capabilities are unavailable; upload was not started.', { itemIndex: itemIndexOffset });
	}
	const isFree = !capabilities.persistent_publish;
	const prepared = new Map<number, Buffer>();
	if (isFree) {
		if (!Number.isSafeInteger(trial?.remaining) || (trial?.remaining ?? 0) < 0) {
			throw new NodeOperationError(context.getNode(), 'Media2URL trial availability is unavailable; upload was not started.', { itemIndex: itemIndexOffset });
		}
		for (const file of files) {
			assertFreeFormat(context, file);
			if (file.declaredBytes !== undefined && file.declaredBytes > FREE_MAX_BYTES) {
				assertFreeFileEligible(context, file, file.declaredBytes);
			}
			const buffer = await readBuffer(context, file);
			assertFreeFileEligible(context, file, buffer.length);
			prepared.set(file.itemIndex, buffer);
		}
		if (files.length > (trial?.remaining ?? 0)) {
			const countWord = files.length === 1 ? 'file' : 'files';
			const creditWord = trial?.remaining === 1 ? 'hosted trial publication' : 'hosted trial publications';
			throw new NodeOperationError(
				context.getNode(),
				`This execution contains ${files.length} ${countWord}, but this Media2URL account has ${trial?.remaining} ${creditWord} remaining. Reduce the number of items or use an eligible paid plan.`,
				{ itemIndex: itemIndexOffset },
			);
		}
	}

	const output: INodeExecutionData[] = [];
	for (const file of files) {
		try {
			const buffer = prepared.get(file.itemIndex) ?? await readBuffer(context, file);
			if (isFree) assertFreeFileEligible(context, file, buffer.length);
			const asset = await uploadOne(context, file, buffer);
			output.push({ json: asset, pairedItem: { item: file.itemIndex } });
		} catch (error) {
			const normalizedError = nodeError(context, error, file.itemIndex);
			if (!isFree && context.continueOnFail()) {
				output.push({ json: { error: normalizedError.message }, pairedItem: { item: file.itemIndex } });
				continue;
			}
			if (isFree && context.continueOnFail()) {
				output.push({ json: { error: normalizedError.message }, pairedItem: { item: file.itemIndex } });
				break;
			}
			throw normalizedError;
		}
	}
	return output;
}
