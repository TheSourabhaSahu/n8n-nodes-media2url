const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const transport = require('../dist/nodes/Media2URL/transport.js');

function makeContext(helper) {
	return {
		node: { name: 'Media2URL', type: 'n8n-nodes-media2url.media2Url', typeVersion: 1, position: [0, 0], parameters: {} },
		getNode() { return this.node; },
		helpers: { httpRequestWithAuthentication: helper },
	};
}

test('requestMedia2Url uses n8n credential substitution and parses JSON', async () => {
	let called;
	const context = makeContext(async function (credentialType, options) {
		called = { receiver: this, credentialType, options };
		return { body: { id: 'asset_1' }, headers: { 'x-request-id': 'req_123' }, statusCode: 200 };
	});
	const result = await transport.requestMedia2Url(context, '/v1/usage', { method: 'GET', itemIndex: 2 });
	assert.deepEqual(result, { id: 'asset_1' });
	assert.equal(called.receiver, context);
	assert.equal(called.credentialType, 'media2URLApi');
	assert.equal(called.options.baseURL, 'https://api.media2url.com');
	assert.equal(called.options.url, '/v1/usage');
	assert.equal(called.options.returnFullResponse, true);
	assert.equal(called.options.timeout, 30_000);
});

test('request errors expose request id and Retry-After but redact secrets, payloads and signed query data', async () => {
	const secret = 'm2u_live_never_leak_this';
	const binary = Buffer.from('private binary bytes').toString('base64');
	const signedUrl = 'https://storage.example/object?X-Goog-Signature=private-signature&key=private-key';
	const context = makeContext(async () => {
		const error = new Error(`request failed ${secret} ${signedUrl} ${binary}`);
		error.httpCode = '429';
		error.response = {
			statusCode: 429,
			headers: { 'x-request-id': 'req_safe_456', 'retry-after': '42', authorization: `Bearer ${secret}` },
			body: { message: `${secret} ${signedUrl}`, storageKey: 'storage-secret', content: binary },
		};
		throw error;
	});
	await assert.rejects(
		transport.requestMedia2Url(context, '/v1/uploads/finalize', { method: 'POST', body: { content: binary, uploadUrl: signedUrl }, itemIndex: 3 }),
		(error) => {
			assert.ok(error instanceof NodeApiError);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes(binary), false);
			assert.equal(error.message.includes(signedUrl), false);
			assert.equal(error.message.includes('private-signature'), false);
			assert.equal(error.description.includes(secret), false);
			assert.equal(error.description.includes(binary), false);
			assert.equal(error.description.includes(signedUrl), false);
			assert.equal(error.stack.includes(secret), false);
			assert.equal(error.stack.includes(binary), false);
			assert.equal(error.stack.includes(signedUrl), false);
			assert.equal(JSON.stringify(error.context).includes('private-key'), false);
			assert.equal(error.context.itemIndex, 3);
			assert.equal(error.context.requestId, 'req_safe_456');
			assert.equal(error.context.retryAfter, 42);
			return true;
		},
	);
});

test('authentication failures use a generic credential message', async () => {
	const secret = 'do-not-echo-this-token';
	const context = makeContext(async () => {
		const error = new Error(`${secret} rejected`);
		error.httpCode = '401';
		error.response = { statusCode: 401, headers: {}, body: { token: secret } };
		throw error;
	});
	await assert.rejects(transport.requestMedia2Url(context, '/v1/usage', { itemIndex: 6 }), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.match(error.message, /authentication failed/i);
		assert.equal(error.message.includes(secret), false);
		assert.equal(error.stack.includes(secret), false);
		assert.equal(error.context.itemIndex, 6);
		return true;
	});
});

test('timeout errors use a stable generic message and preserve the item index', async () => {
	const secret = 'hidden-timeout-secret';
	const context = makeContext(async () => {
		const error = new Error(`${secret} timed out`);
		error.code = 'ETIMEDOUT';
		throw error;
	});
	await assert.rejects(transport.requestMedia2Url(context, '/v1/usage', { itemIndex: 4 }), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.message.includes(secret), false);
		assert.equal(error.context.itemIndex, 4);
		return true;
	});
});

test('malformed JSON responses fail with a safe configuration error', async () => {
	const privateValue = 'sensitive-malformed-body-value';
	const context = makeContext(async () => ({ body: `not-json ${privateValue}`, statusCode: 200 }));
	await assert.rejects(transport.requestMedia2Url(context, '/v1/usage', { itemIndex: 5 }), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /invalid JSON response/);
		assert.equal(error.message.includes(privateValue), false);
		assert.equal(error.stack.includes(privateValue), false);
		assert.equal(error.context.itemIndex, 5);
		return true;
	});
});

test('invalid paths are rejected without making a request', async () => {
	let called = false;
	const context = makeContext(async () => { called = true; });
	await assert.rejects(transport.requestMedia2Url(context, 'https://evil.example', {}), NodeOperationError);
	assert.equal(called, false);
});
