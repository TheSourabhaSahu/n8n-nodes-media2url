import { createHash } from 'node:crypto';
import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { requestMedia2Url } from './transport';

interface UsageResponse {
	account?: {
		capabilities?: { persistent_publish?: boolean };
		trial?: { remaining?: number };
	};
}

interface ImportJobResponse {
	job_id?: string;
	status?: string;
	asset?: JsonObject | null;
	error?: { code?: string } | null;
	retry_after?: number;
}

interface ImportInput {
	itemIndex: number;
	url: string;
	filename?: string;
}

export interface ImportPollingOptions {
	now?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
}

const MAX_POLL_ATTEMPTS = 8;
const MAX_POLL_DURATION_MS = 30_000;
const MAX_POLL_DELAY_MS = 5_000;
const MAX_SOURCE_URL_LENGTH = 8_192;

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
	return new NodeOperationError(context.getNode(), 'Media2URL import failed. Check the source URL and try again.', { itemIndex });
}

function collectImports(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset: number,
): ImportInput[] {
	return inputItems.map((_, offset) => {
		const itemIndex = itemIndexOffset + offset;
		const value = context.getNodeParameter('url', itemIndex, '') as unknown;
		if (typeof value !== 'string' || !value.trim() || value.length > MAX_SOURCE_URL_LENGTH) {
			throw new NodeOperationError(context.getNode(), `A valid source URL is required for input item ${itemIndex + 1}.`, { itemIndex });
		}
		const url = value.trim();
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new NodeOperationError(context.getNode(), `A valid source URL is required for input item ${itemIndex + 1}.`, { itemIndex });
		}
		if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
			throw new NodeOperationError(context.getNode(), 'Source URLs must use HTTP or HTTPS without embedded credentials.', { itemIndex });
		}
		const requestedFilename = context.getNodeParameter('filename', itemIndex, '') as unknown;
		const filename = typeof requestedFilename === 'string' && requestedFilename.trim()
			? requestedFilename.trim()
			: parsed.pathname.split('/').pop() || undefined;
		return { itemIndex, url, ...(filename ? { filename } : {}) };
	});
}

function assertFreeFilename(context: IExecuteFunctions, item: ImportInput): void {
	const extension = item.filename?.toLowerCase().split('.').pop();
	if (extension !== 'png' && extension !== 'jpg' && extension !== 'jpeg') {
		throw new NodeOperationError(
			context.getNode(),
			'Free hosted trial imports support PNG and JPG/JPEG files only. Use an eligible paid plan for other formats.',
			{ itemIndex: item.itemIndex },
		);
	}
}

function createImportIdempotencyKey(context: IExecuteFunctions, itemIndex: number): string {
	const executionId = context.getExecutionId();
	if (typeof executionId !== 'string' || !executionId) {
		throw new NodeOperationError(context.getNode(), 'The n8n execution ID is unavailable; import was not started.', { itemIndex });
	}
	const digest = createHash('sha256').update(`media2url:n8n:asset-import:${executionId}:${itemIndex}`).digest('hex').slice(0, 40);
	return `m2u-n8n-${digest}`;
}

function safeJobIdentifier(jobId: string): string {
	return /^job_[a-zA-Z0-9_-]{1,128}$/.test(jobId) ? jobId : 'job_unknown';
}

function failedJobError(context: IExecuteFunctions, jobId: string, code: unknown, itemIndex: number): NodeOperationError {
	const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? ` (${code})` : '';
	return new NodeOperationError(context.getNode(), `Media2URL import ${safeJobIdentifier(jobId)} failed${safeCode}. Check the source and account eligibility.`, { itemIndex });
}

function timeoutError(context: IExecuteFunctions, jobId: string, itemIndex: number): NodeOperationError {
	return new NodeOperationError(context.getNode(), `Media2URL import ${safeJobIdentifier(jobId)} did not complete within the polling limit.`, { itemIndex });
}

function retryAfterSeconds(job: ImportJobResponse | undefined): number | undefined {
	const value = job?.retry_after;
	return Number.isSafeInteger(value) && (value ?? -1) >= 0 && (value ?? 0) <= 604_800 ? value : undefined;
}

async function defaultWait(milliseconds: number): Promise<void> {
	await sleep(milliseconds);
}

async function pollImportJob(
	context: IExecuteFunctions,
	jobId: string,
	itemIndex: number,
	options: ImportPollingOptions,
): Promise<JsonObject> {
	const now = options.now ?? Date.now;
	const wait = options.wait ?? defaultWait;
	const startedAt = now();
	let delay = 1_000;
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
		if (now() - startedAt >= MAX_POLL_DURATION_MS) throw timeoutError(context, jobId, itemIndex);
		let job: ImportJobResponse | undefined;
		let serverRetryDelay = 0;
		try {
			job = await requestMedia2Url<ImportJobResponse>(
				context,
				`/v1/jobs/${encodeURIComponent(jobId)}`,
				{ method: 'GET', itemIndex },
			);
		} catch (error) {
			const normalized = nodeError(context, error, itemIndex);
			if (!(normalized instanceof NodeApiError) || normalized.httpCode !== '429') {
				throw nodeError(context, error, itemIndex);
			}
			const retryAfter = typeof normalized.context.retryAfter === 'number' ? normalized.context.retryAfter * 1_000 : delay;
			serverRetryDelay = Math.max(delay, retryAfter);
		}
		if (job) {
			if (job.status === 'completed' && job.asset && typeof job.asset === 'object') return job.asset;
			if (job.status === 'failed') throw failedJobError(context, jobId, job.error?.code, itemIndex);
			if (job.status !== 'queued' && job.status !== 'processing') {
				throw new NodeOperationError(context.getNode(), `Media2URL returned an unsupported status for ${safeJobIdentifier(jobId)}.`, { itemIndex });
			}
			const retryAfter = retryAfterSeconds(job);
			if (retryAfter !== undefined) serverRetryDelay = Math.max(delay, retryAfter * 1_000);
		}
		if (attempt === MAX_POLL_ATTEMPTS - 1) throw timeoutError(context, jobId, itemIndex);
		const waitMilliseconds = Math.max(delay, serverRetryDelay);
		if (now() - startedAt + waitMilliseconds > MAX_POLL_DURATION_MS) throw timeoutError(context, jobId, itemIndex);
		await wait(waitMilliseconds);
		delay = Math.min(Math.max(1_000, delay * 2), MAX_POLL_DELAY_MS);
	}
	throw timeoutError(context, jobId, itemIndex);
}

function normalizeImportedAsset(asset: JsonObject): JsonObject {
	const output: JsonObject = { ...asset };
	if (typeof asset.direct_url === 'string') output.directUrl = asset.direct_url;
	if (typeof asset.share_url === 'string') output.shareUrl = asset.share_url;
	if (typeof asset.expires_at === 'string') output.expiresAt = asset.expires_at;
	if (typeof asset.trial_remaining === 'number') output.trialRemaining = asset.trial_remaining;
	return output;
}

export async function executeImportFromUrl(
	context: IExecuteFunctions,
	inputItems: INodeExecutionData[],
	itemIndexOffset = 0,
	options: ImportPollingOptions = {},
): Promise<INodeExecutionData[]> {
	const imports = collectImports(context, inputItems, itemIndexOffset);
	if (!imports.length) return [];
	const usage = await requestMedia2Url<UsageResponse>(context, '/v1/usage', { method: 'GET', itemIndex: itemIndexOffset });
	const persistentPublish = usage?.account?.capabilities?.persistent_publish;
	if (typeof persistentPublish !== 'boolean') {
		throw new NodeOperationError(context.getNode(), 'Media2URL account capabilities are unavailable; import was not started.', { itemIndex: itemIndexOffset });
	}
	const isFree = !persistentPublish;
	if (isFree) {
		const remaining = usage?.account?.trial?.remaining;
		if (!Number.isSafeInteger(remaining) || (remaining ?? -1) < 0) {
			throw new NodeOperationError(context.getNode(), 'Media2URL trial availability is unavailable; import was not started.', { itemIndex: itemIndexOffset });
		}
		for (const item of imports) assertFreeFilename(context, item);
		if (imports.length > (remaining ?? 0)) {
			const fileWord = imports.length === 1 ? 'file' : 'files';
			const creditWord = remaining === 1 ? 'hosted trial publication' : 'hosted trial publications';
			throw new NodeOperationError(
				context.getNode(),
				`This execution contains ${imports.length} ${fileWord}, but this Media2URL account has ${remaining} ${creditWord} remaining. Reduce the number of items or use an eligible paid plan.`,
				{ itemIndex: itemIndexOffset },
			);
		}
	}

	const output: INodeExecutionData[] = [];
	for (const item of imports) {
		try {
			const privacy = context.getNodeParameter('privacy', item.itemIndex, 'public') as string;
			const body = { url: item.url, ...(item.filename ? { filename: item.filename } : {}), privacy };
			const created = await requestMedia2Url<ImportJobResponse>(context, '/v1/imports', {
				method: 'POST',
				itemIndex: item.itemIndex,
				headers: { 'Idempotency-Key': createImportIdempotencyKey(context, item.itemIndex) },
				body,
			});
			if (!created || typeof created.job_id !== 'string' || !/^job_[a-zA-Z0-9_-]{1,128}$/.test(created.job_id)) {
				throw new NodeOperationError(context.getNode(), 'Media2URL returned an invalid import job identifier.', { itemIndex: item.itemIndex });
			}
			let asset: JsonObject;
			if (created.status === 'completed' && created.asset && typeof created.asset === 'object') {
				asset = created.asset;
			} else if (created.status === 'failed') {
				throw failedJobError(context, created.job_id, created.error?.code, item.itemIndex);
			} else if (created.status === 'queued' || created.status === 'processing') {
				asset = await pollImportJob(context, created.job_id, item.itemIndex, options);
			} else {
				throw new NodeOperationError(context.getNode(), `Media2URL returned an unsupported status for ${safeJobIdentifier(created.job_id)}.`, { itemIndex: item.itemIndex });
			}
			output.push({ json: normalizeImportedAsset(asset), pairedItem: { item: item.itemIndex } });
		} catch (error) {
			const normalized = nodeError(context, error, item.itemIndex);
			if (isFree) throw nodeError(context, error, item.itemIndex);
			if (context.continueOnFail()) {
				output.push({ json: { error: normalized.message }, pairedItem: { item: item.itemIndex } });
				continue;
			}
			throw nodeError(context, error, item.itemIndex);
		}
	}
	return output;
}
