import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

const API_BASE_URL = 'https://api.media2url.com';
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

export interface Media2UrlRequestOptions {
	method?: IHttpRequestOptions['method'];
	qs?: IDataObject;
	body?: IHttpRequestOptions['body'];
	itemIndex?: number;
}

interface SafeErrorMetadata {
	statusCode?: number;
	requestId?: string;
	retryAfter?: number;
	code?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	return value as Record<string, unknown>;
}

function safeStatus(value: unknown): number | undefined {
	const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : undefined;
}

function safeHeader(headers: unknown, name: string): unknown {
	const record = asRecord(headers);
	if (!record) return undefined;
	const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? record[key] : undefined;
}

function readSafeErrorMetadata(error: unknown): SafeErrorMetadata {
	const record = asRecord(error);
	const response = asRecord(record?.response);
	const headers = response?.headers;
	const requestIdValue = safeHeader(headers, 'x-request-id');
	const requestId = typeof requestIdValue === 'string' && REQUEST_ID_PATTERN.test(requestIdValue)
		? requestIdValue
		: undefined;
	const retryAfterValue = safeHeader(headers, 'retry-after');
	const retryAfterNumber = typeof retryAfterValue === 'number'
		? retryAfterValue
		: typeof retryAfterValue === 'string' && /^\d{1,6}$/.test(retryAfterValue)
			? Number(retryAfterValue)
			: NaN;
	const retryAfter = Number.isInteger(retryAfterNumber) && retryAfterNumber >= 0 && retryAfterNumber <= 604_800
		? retryAfterNumber
		: undefined;
	const rawCode = record?.code;
	const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,40}$/i.test(rawCode) ? rawCode : undefined;
	return {
		statusCode: safeStatus(record?.httpCode) ?? safeStatus(record?.statusCode) ?? safeStatus(response?.statusCode),
		requestId,
		retryAfter,
		code,
	};
}

function errorMessage(statusCode?: number): string {
	if (statusCode === 401 || statusCode === 403) return 'Media2URL authentication failed. Check the API key in your n8n credentials.';
	if (statusCode === 429) return 'Media2URL rate limit reached.';
	if (statusCode !== undefined) return `Media2URL API request failed (HTTP ${statusCode}).`;
	return 'Media2URL request could not be completed.';
}

function errorDescription(statusCode?: number, requestId?: string, retryAfter?: number): string | undefined {
	const details: string[] = [];
	if (statusCode === 429 && retryAfter !== undefined) details.push(`Retry after ${retryAfter} seconds.`);
	if (requestId) details.push(`Request ID: ${requestId}.`);
	return details.length ? details.join(' ') : undefined;
}

function attachSafeMetadata(error: NodeApiError | NodeOperationError, metadata: SafeErrorMetadata): void {
	const safeContext: Record<string, number | string> = {};
	if (metadata.requestId) safeContext.requestId = metadata.requestId;
	if (metadata.retryAfter !== undefined) safeContext.retryAfter = metadata.retryAfter;
	if (Object.keys(safeContext).length) {
		Object.assign(error.context, safeContext);
	}
}

function makeApiError(context: IExecuteFunctions, metadata: SafeErrorMetadata, itemIndex?: number): NodeApiError {
	const statusCode = metadata.statusCode;
	// Only sanitized numeric/string metadata enters NodeApiError; never pass the raw response body.
	const safeResponse: JsonObject = {};
	if (statusCode !== undefined) safeResponse.statusCode = statusCode;
	if (metadata.requestId) safeResponse.requestId = metadata.requestId;
	if (metadata.retryAfter !== undefined) safeResponse.retryAfter = metadata.retryAfter;
	const error = new NodeApiError(context.getNode(), safeResponse, {
		message: errorMessage(statusCode),
		description: errorDescription(statusCode, metadata.requestId, metadata.retryAfter),
		httpCode: statusCode === undefined ? undefined : String(statusCode),
		itemIndex,
	});
	attachSafeMetadata(error, metadata);
	return error;
}

function parseResponseBody<T>(body: unknown, context: IExecuteFunctions, itemIndex?: number): T {
	if (typeof body === 'string') {
		try {
			return JSON.parse(body) as T;
		} catch {
			throw new NodeOperationError(context.getNode(), 'Media2URL returned an invalid JSON response.', { itemIndex });
		}
	}
	if (body === undefined || body === null) {
		throw new NodeOperationError(context.getNode(), 'Media2URL returned an empty response.', { itemIndex });
	}
	return body as T;
}

export async function requestMedia2Url<T>(
	context: IExecuteFunctions,
	path: string,
	options: Media2UrlRequestOptions = {},
): Promise<T> {
	if (!/^\/v1\/[a-zA-Z0-9/_-]*(?:\/[a-zA-Z0-9_-]+)?$/.test(path) || path.includes('..')) {
		throw new NodeOperationError(context.getNode(), 'Media2URL API path must be a relative /v1/ endpoint.');
	}
	const { itemIndex, ...requestOptions } = options;
	let response: unknown;
	try {
		response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			'media2URLApi',
			{
				baseURL: API_BASE_URL,
				url: path,
				method: requestOptions.method ?? 'GET',
				qs: requestOptions.qs,
				body: requestOptions.body,
				json: true,
				returnFullResponse: true,
				timeout: REQUEST_TIMEOUT_MS,
				maxRedirects: 0,
				disableFollowRedirect: true,
				sendCredentialsOnCrossOriginRedirect: false,
			},
		);
	} catch (error) {
		const metadata = readSafeErrorMetadata(error);
		if (metadata.statusCode !== undefined) throw makeApiError(context, metadata, itemIndex);
		throw new NodeOperationError(
			context.getNode(),
			metadata.code === 'ETIMEDOUT' || metadata.code === 'ECONNABORTED'
				? 'Media2URL request timed out. Try again later.'
				: 'Media2URL request could not be completed. Check the connection and try again.',
			{ itemIndex },
		);
	}
	const responseRecord = asRecord(response);
	return parseResponseBody<T>(responseRecord && 'body' in responseRecord ? responseRecord.body : response, context, itemIndex);
}
