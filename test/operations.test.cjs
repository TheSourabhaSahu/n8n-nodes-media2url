const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeOperationError } = require('n8n-workflow');
const { executeOperation } = require('../dist/nodes/Media2URL/operations.js');
const { Media2URL } = require('../dist/nodes/Media2URL/Media2Url.node.js');

function makeContext(parameters, request) {
	const calls = [];
	const context = {
		node: { name: 'Media2URL', type: 'n8n-nodes-media2url.media2Url', typeVersion: 1, position: [0, 0], parameters: {} },
		getNode() { return this.node; },
		getNodeParameter(name, itemIndex, fallback) {
			const value = parameters[name];
			return value === undefined ? fallback : typeof value === 'function' ? value(itemIndex) : value;
		},
		helpers: {
			httpRequestWithAuthentication: async function (credentialType, options) {
				calls.push({ receiver: this, credentialType, options });
				return request(options);
			},
		},
	};
	return { context, calls };
}

const inputItems = [{ json: { source: 'one' } }];

test('Account:Get Usage returns usage, including exhausted-trial capability state', async () => {
	const usage = { requests: { used: 4, limit: 100 }, account: { trial: { remaining: 0 }, capabilities: { temporary_publish: false } } };
	const { context, calls } = makeContext({}, async () => ({ body: usage, statusCode: 200 }));
	const output = await executeOperation(context, 'account', 'getUsage', inputItems);
	assert.deepEqual(output, [{ json: usage, pairedItem: { item: 0 } }]);
	assert.equal(calls[0].options.url, '/v1/usage');
});

test('read, list, version, and delete operations remain available when the Free trial is exhausted', async () => {
	const responses = new Map([
		['/v1/assets/asset_1', { body: { id: 'asset_1' }, statusCode: 200 }],
		['/v1/assets', { body: { data: [{ id: 'asset_1' }], pagination: { has_more: false, next_cursor: null } }, statusCode: 200 }],
		['/v1/assets/asset_1/versions', { body: { data: [{ version: 1 }] }, statusCode: 200 }],
	]);
	for (const [resource, operation, parameters] of [
		['asset', 'get', { assetId: 'asset_1' }],
		['asset', 'getMany', { returnAll: false, limit: 1 }],
		['version', 'getMany', { assetId: 'asset_1' }],
		['asset', 'delete', { assetId: 'asset_1' }],
	]) {
		const { context } = makeContext(parameters, async (options) =>
			options.method === 'DELETE'
				? { body: undefined, statusCode: 204 }
				: responses.get(options.url),
		);
		const output = await executeOperation(context, resource, operation, inputItems);
		assert.ok(output.length > 0, `${resource}:${operation} should succeed independently of trial credits`);
	}
});

test('node execution preserves input pairing across items', async () => {
	const context = {
		node: { name: 'Media2URL', type: 'n8n-nodes-media2url.media2Url', typeVersion: 1, position: [0, 0], parameters: {} },
		getNode() { return this.node; },
		getInputData() { return [{ json: { source: 1 } }, { json: { source: 2 } }]; },
		getNodeParameter(name) { return name === 'resource' ? 'account' : 'getUsage'; },
		continueOnFail() { return false; },
		helpers: { httpRequestWithAuthentication: async () => ({ body: { requests: { used: 0 } }, statusCode: 200 }) },
	};
	const output = await new Media2URL().execute.call(context);
	assert.deepEqual(output[0].map(({ pairedItem }) => pairedItem), [{ item: 0 }, { item: 1 }]);
});

test('Asset:Get requires an ID and returns the owned asset', async () => {
	const asset = { id: 'asset_123', filename: 'photo.png' };
	const { context, calls } = makeContext({ assetId: 'asset_123' }, async () => ({ body: asset, statusCode: 200 }));
	const output = await executeOperation(context, 'asset', 'get', inputItems);
	assert.deepEqual(output, [{ json: asset, pairedItem: { item: 0 } }]);
	assert.equal(calls[0].options.url, '/v1/assets/asset_123');
	const missing = makeContext({}, async () => assert.fail('must not call API'));
	await assert.rejects(executeOperation(missing.context, 'asset', 'get', inputItems), NodeOperationError);
});

test('Asset:Get maps a not-found API response with the input item index', async () => {
	const { context } = makeContext({ assetId: 'asset_missing' }, async () => {
		const error = new Error('untrusted API response details');
		error.httpCode = '404';
		error.response = { statusCode: 404, headers: {}, body: { detail: 'untrusted API response details' } };
		throw error;
	});
	await assert.rejects(executeOperation(context, 'asset', 'get', inputItems, 7), (error) => {
		assert.match(error.message, /HTTP 404/);
		assert.equal(error.message.includes('untrusted'), false);
		assert.equal(error.context.itemIndex, 7);
		return true;
	});
});

test('Asset:Get Many follows cursors in order and obeys Limit', async () => {
	const pages = [
		{ body: { data: [{ id: 'asset_1' }, { id: 'asset_2' }], pagination: { has_more: true, next_cursor: 'cursor_1' } }, statusCode: 200 },
		{ body: { data: [{ id: 'asset_3' }], pagination: { has_more: false, next_cursor: null } }, statusCode: 200 },
	];
	const { context, calls } = makeContext({ returnAll: true }, async () => pages.shift());
	const output = await executeOperation(context, 'asset', 'getMany', inputItems);
	assert.deepEqual(output.map(({ json }) => json.id), ['asset_1', 'asset_2', 'asset_3']);
	assert.deepEqual(output.map(({ pairedItem }) => pairedItem), Array(3).fill({ item: 0 }));
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].options.qs, { limit: 100 });
	assert.deepEqual(calls[1].options.qs, { limit: 100, cursor: 'cursor_1' });

	const limited = makeContext({ returnAll: false, limit: 2 }, async () => ({
		body: { data: [{ id: 'asset_a' }, { id: 'asset_b' }, { id: 'asset_c' }], pagination: { has_more: true, next_cursor: 'unused' } },
		statusCode: 200,
	}));
	const limitedOutput = await executeOperation(limited.context, 'asset', 'getMany', inputItems);
	assert.deepEqual(limitedOutput.map(({ json }) => json.id), ['asset_a', 'asset_b']);
	assert.equal(limited.calls.length, 1);

	const largePages = [
		{ body: { data: Array.from({ length: 100 }, (_, index) => ({ id: `asset_${index}` })), pagination: { has_more: true, next_cursor: 'cursor_100' } }, statusCode: 200 },
		{ body: { data: Array.from({ length: 100 }, (_, index) => ({ id: `asset_${index + 100}` })), pagination: { has_more: true, next_cursor: 'cursor_200' } }, statusCode: 200 },
	];
	const multiPageLimit = makeContext({ returnAll: false, limit: 150 }, async () => largePages.shift());
	const multiPageOutput = await executeOperation(multiPageLimit.context, 'asset', 'getMany', inputItems);
	assert.equal(multiPageOutput.length, 150);
	assert.deepEqual(multiPageLimit.calls.map(({ options }) => options.qs.limit), [100, 50]);
	assert.deepEqual(multiPageLimit.calls[1].options.qs, { limit: 50, cursor: 'cursor_100' });
});

test('Asset:Delete returns a stable result after a 204 response', async () => {
	const { context, calls } = makeContext({ assetId: 'asset_abc' }, async () => ({ body: undefined, statusCode: 204 }));
	const output = await executeOperation(context, 'asset', 'delete', inputItems);
	assert.deepEqual(output, [{ json: { deleted: true }, pairedItem: { item: 0 } }]);
	assert.equal(calls[0].options.method, 'DELETE');
});

test('Version:Get Many returns history and rejects a missing asset ID', async () => {
	const versions = [{ version: 1 }, { version: 2 }];
	const { context, calls } = makeContext({ assetId: 'asset_v1' }, async () => ({ body: { data: versions }, statusCode: 200 }));
	const output = await executeOperation(context, 'version', 'getMany', inputItems);
	assert.deepEqual(output.map(({ json }) => json.version), [1, 2]);
	assert.equal(calls[0].options.url, '/v1/assets/asset_v1/versions');
	assert.deepEqual(output.map(({ pairedItem }) => pairedItem), Array(2).fill({ item: 0 }));
	const missing = makeContext({}, async () => assert.fail('must not call API'));
	await assert.rejects(executeOperation(missing.context, 'version', 'getMany', inputItems), NodeOperationError);
});
