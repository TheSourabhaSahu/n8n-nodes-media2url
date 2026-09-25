const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeOperationError } = require('n8n-workflow');
const { executeImportFromUrl } = require('../dist/nodes/Media2URL/imports.js');

function makeContext({ parameters = {}, usage, importResponse, jobResponses = [], executionId = 'exec_import_1' } = {}) {
	const calls = [];
	const context = {
		node: { name: 'Media2URL', type: 'n8n-nodes-media2url.media2Url', typeVersion: 1, position: [0, 0], parameters: {} },
		getNode() { return this.node; },
		getExecutionId() { return executionId; },
		getNodeParameter(name, itemIndex, fallback) {
			const value = parameters[name];
			return value === undefined ? fallback : typeof value === 'function' ? value(itemIndex) : value;
		},
		continueOnFail() { return false; },
		helpers: {
			httpRequestWithAuthentication: async function (credentialType, options) {
				calls.push({ kind: 'api', credentialType, options });
				if (options.url === '/v1/usage') return { body: usage, statusCode: 200 };
				if (options.url === '/v1/imports') return { body: importResponse, statusCode: 202 };
				if (options.url.startsWith('/v1/jobs/')) {
					const response = jobResponses.shift();
					if (response instanceof Error) throw response;
					return { body: response, statusCode: 200 };
				}
				throw new Error('unexpected request');
			},
			httpRequest: async () => { throw new Error('remote source must never be fetched by n8n'); },
		},
	};
	return { context, calls };
}

const freeUsage = (remaining) => ({ account: { capabilities: { persistent_publish: false }, trial: { remaining } } });
const paidUsage = { account: { capabilities: { persistent_publish: true }, trial: { remaining: 0 } } };
const asset = { id: 'asset_imported', direct_url: 'https://media2url.com/direct', share_url: 'https://media2url.com/share', temporary: false };

test('Import From URL sends the source only to the Media2URL API and returns a completed asset', async () => {
	const source = 'https://files.example.test/image.png?token=private';
	const mock = makeContext({
		parameters: { url: source, filename: 'image.png' },
		usage: paidUsage,
		importResponse: { job_id: 'job_safe_123', status: 'completed', asset },
	});
	const output = await executeImportFromUrl(mock.context, [{ json: { source: 'input' } }]);
	assert.equal(output[0].json.id, 'asset_imported');
	assert.equal(output[0].json.directUrl, asset.direct_url);
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	assert.deepEqual(mock.calls.map(({ options }) => options.url), ['/v1/usage', '/v1/imports']);
	assert.equal(mock.calls.at(-1).options.body.url, source);
	assert.equal(mock.calls.at(-1).options.headers['Idempotency-Key'].startsWith('m2u-n8n-'), true);
});

test('missing and unsupported URLs fail before creating imports', async () => {
	const missing = makeContext({ usage: paidUsage, parameters: {} });
	await assert.rejects(executeImportFromUrl(missing.context, [{ json: {} }]), NodeOperationError);
	assert.equal(missing.calls.length, 0);
	const unsupported = makeContext({ usage: paidUsage, parameters: { url: 'file:///etc/passwd' } });
	await assert.rejects(executeImportFromUrl(unsupported.context, [{ json: {} }]), NodeOperationError);
	assert.equal(unsupported.calls.length, 0);
});

test('Free imports preflight item count and eligible filename across the whole batch', async () => {
	const over = makeContext({ usage: freeUsage(1), parameters: { url: () => 'https://files.example.test/image.png' } });
	await assert.rejects(executeImportFromUrl(over.context, [{ json: {} }, { json: {} }]), /2 files.*1 hosted trial publication/s);
	assert.deepEqual(over.calls.map(({ options }) => options.url), ['/v1/usage']);

	const unsupportedFile = makeContext({ usage: freeUsage(3), parameters: { url: 'https://files.example.test/private.pdf' } });
	await assert.rejects(executeImportFromUrl(unsupportedFile.context, [{ json: {} }]), NodeOperationError);
	assert.deepEqual(unsupportedFile.calls.map(({ options }) => options.url), ['/v1/usage']);
});

test('processing jobs are polled only by returned job ID and honor retry-after', async () => {
	const mock = makeContext({
		parameters: { url: 'https://files.example.test/photo.png' },
		usage: paidUsage,
		importResponse: { job_id: 'job_safe_456', status: 'processing' },
		jobResponses: [{ status: 'processing', retry_after: 2 }, { status: 'completed', asset }],
	});
	let now = 0;
	const waits = [];
	const output = await executeImportFromUrl(mock.context, [{ json: {} }], 0, {
		now: () => now,
		wait: async (ms) => { waits.push(ms); now += ms; },
	});
	assert.deepEqual(waits, [2000]);
	assert.equal(output[0].json.id, 'asset_imported');
	assert.deepEqual(mock.calls.map(({ options }) => options.url), [
		'/v1/usage', '/v1/imports', '/v1/jobs/job_safe_456', '/v1/jobs/job_safe_456',
	]);
	assert.equal(mock.calls.some(({ options }) => options.url.includes('files.example.test')), false);
});

test('polling respects a 429 Retry-After header without retrying the import write', async () => {
	const throttled = new Error('private throttle detail');
	throttled.httpCode = '429';
	throttled.response = { statusCode: 429, headers: { 'Retry-After': '3' }, body: { detail: 'private throttle detail' } };
	const mock = makeContext({
		parameters: { url: 'https://files.example.test/image.png' },
		usage: paidUsage,
		importResponse: { job_id: 'job_safe_789', status: 'processing' },
		jobResponses: [throttled, { status: 'completed', asset }],
	});
	let now = 0;
	const waits = [];
	await executeImportFromUrl(mock.context, [{ json: {} }], 0, {
		now: () => now,
		wait: async (ms) => { waits.push(ms); now += ms; },
	});
	assert.deepEqual(waits, [3000]);
	assert.equal(mock.calls.filter(({ options }) => options.url === '/v1/imports').length, 1);
});

test('failed jobs and poll timeouts expose safe job context and never repeat POST', async () => {
	const failed = makeContext({
		parameters: { url: 'https://files.example.test/private.png?sig=secret' },
		usage: paidUsage,
		importResponse: { job_id: 'job_safe_999', status: 'processing' },
		jobResponses: [{ status: 'failed', error: { code: 'invalid_file', detail: 'secret source details' } }],
	});
	await assert.rejects(executeImportFromUrl(failed.context, [{ json: {} }]), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.message.includes('secret'), false);
		assert.equal(error.message.includes('files.example.test'), false);
		assert.match(error.message, /job_safe_999/);
		return true;
	});

	const timeout = makeContext({
		parameters: { url: 'https://files.example.test/image.png' },
		usage: paidUsage,
		importResponse: { job_id: 'job_safe_timeout', status: 'processing' },
		jobResponses: Array(8).fill({ status: 'processing' }),
	});
	let now = 0;
	await assert.rejects(executeImportFromUrl(timeout.context, [{ json: {} }], 0, {
		now: () => now,
		wait: async (ms) => { now += ms; },
	}), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /job_safe_timeout/);
		return true;
	});
	assert.equal(timeout.calls.filter(({ options }) => options.url === '/v1/imports').length, 1);
	assert.equal(timeout.calls.filter(({ options }) => options.url.startsWith('/v1/jobs/')).length, 8);
});
