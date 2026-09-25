const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { executeReplaceAsset } = require('../dist/nodes/Media2URL/replacement.js');
const { executeOperation } = require('../dist/nodes/Media2URL/operations.js');
const { Media2URL } = require('../dist/nodes/Media2URL/Media2Url.node.js');

function makeContext({ parameters = {}, usage, apiFailure, executionId = 'exec_replace_1' } = {}) {
	const calls = [];
	const buffers = new Map();
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
			getBinaryDataBuffer: async (index, name) => buffers.get(`${index}:${name}`),
			httpRequestWithAuthentication: async function (credentialType, options) {
				calls.push({ kind: 'api', credentialType, options });
				if (options.url === '/v1/usage') return { body: usage, statusCode: 200 };
				if (apiFailure) {
					const error = new Error('private replacement response detail');
					error.httpCode = String(apiFailure);
					error.response = { statusCode: apiFailure, headers: {}, body: { detail: 'private replacement response detail' } };
					throw error;
				}
				if (options.url.endsWith('/replace/presign')) {
					return { body: { upload_id: 'upload_replace_1', upload_url: 'https://storage.example/signed?sig=secret', required_headers: { 'Content-Type': options.body.content_type } }, statusCode: 201 };
				}
				if (options.url.endsWith('/replace/finalize')) {
					return { body: { id: options.url.split('/')[3], direct_url: 'https://media2url.com/existing-managed-url', share_url: 'https://media2url.com/m/existing', current_version: 2 }, statusCode: 200 };
				}
				throw new Error('unexpected request');
			},
			httpRequest: async (options) => { calls.push({ kind: 'upload', options }); return { statusCode: 200 }; },
		},
	};
	return {
		context,
		calls,
		item(index, { propertyName = 'data', filename = 'updated.png', mimeType = 'image/png', bytes = 'replacement bytes' } = {}) {
			const buffer = Buffer.from(bytes);
			buffers.set(`${index}:${propertyName}`, buffer);
			return { json: {}, binary: { [propertyName]: { fileName: filename, mimeType, bytes: buffer.length } } };
		},
	};
}

const paidUsage = { account: { capabilities: { replace: true, persistent_publish: true } } };
const freeUsage = { account: { capabilities: { replace: false, persistent_publish: false } } };

test('Replace Existing Asset requires an asset ID and binary input', async () => {
	const missingId = makeContext({ usage: paidUsage });
	await assert.rejects(executeReplaceAsset(missingId.context, [{ json: {} }]), NodeOperationError);
	assert.equal(missingId.calls.some(({ options }) => options.url.includes('/replace/presign')), false);

	const missingBinary = makeContext({ usage: paidUsage, parameters: { assetId: 'asset_123' } });
	await assert.rejects(executeReplaceAsset(missingBinary.context, [{ json: {} }]), NodeOperationError);
	assert.equal(missingBinary.calls.some(({ options }) => options.url.includes('/replace/presign')), false);
});

test('Free accounts receive a clear paid-plan response before replacement presign', async () => {
	const mock = makeContext({ usage: freeUsage, parameters: { assetId: 'asset_123' } });
	const item = mock.item(0);
	await assert.rejects(executeReplaceAsset(mock.context, [item]), /active Media2URL paid plan/i);
	assert.deepEqual(mock.calls.map(({ options }) => options.url), ['/v1/usage']);
});

test('replacement preserves the existing managed URL and returns new version metadata', async () => {
	const mock = makeContext({ usage: paidUsage, parameters: { assetId: 'asset_abc', binaryPropertyName: 'filedata', filename: 'release-v2.png' } });
	const item = mock.item(0, { propertyName: 'filedata', filename: 'old.png' });
	const output = await executeReplaceAsset(mock.context, [item]);
	assert.equal(output[0].json.id, 'asset_abc');
	assert.equal(output[0].json.direct_url, 'https://media2url.com/existing-managed-url');
	assert.equal(output[0].json.directUrl, 'https://media2url.com/existing-managed-url');
	assert.equal(output[0].json.current_version, 2);
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	const presign = mock.calls.find(({ options }) => options.url.endsWith('/replace/presign'));
	assert.equal(presign.options.url, '/v1/assets/asset_abc/replace/presign');
	assert.equal(presign.options.body.filename, 'release-v2.png');
	assert.equal(presign.options.body.checksum_sha256.length, 64);
	assert.equal(mock.calls.find(({ kind }) => kind === 'upload').options.headers.Authorization, undefined);
	const finalize = mock.calls.find(({ options }) => options.url.endsWith('/replace/finalize'));
	assert.equal(finalize.options.url, '/v1/assets/asset_abc/replace/finalize');
	assert.equal(finalize.options.body.upload_id, 'upload_replace_1');
	assert.match(finalize.options.headers['Idempotency-Key'], /^m2u-n8n-[a-f0-9]{40}$/);
});

test('Asset:Replace is selectable in the editor and explains its URL and binary behavior', () => {
	const properties = new Media2URL().description.properties;
	assert.equal(Object.hasOwn(new Media2URL().description, 'usableAsTool'), false);
	const assetOperations = properties.find(({ name, displayOptions }) => name === 'operation' && displayOptions?.show?.resource?.includes('asset'));
	const replaceOption = assetOperations.options.find(({ value }) => value === 'replace');
	assert.deepEqual(replaceOption, {
		name: 'Replace',
		value: 'replace',
		action: 'Replace asset content',
		description: 'Upload new contents as a version while keeping the current managed URL',
	});
	const assetId = properties.find(({ name, displayOptions }) => name === 'assetId' && displayOptions?.show?.operation?.includes('replace'));
	assert.equal(assetId.required, true);
	assert.match(assetId.description, /managed Media2URL asset/i);
	const binary = properties.find(({ name, displayOptions }) => name === 'binaryPropertyName' && displayOptions?.show?.operation?.includes('replace'));
	assert.equal(binary.default, 'data');
	assert.match(binary.description, /incoming binary/i);
	assert.match(binary.placeholder, /^e\.g\./);
	const replacementFields = properties.filter(({ displayOptions }) => displayOptions?.show?.resource?.includes('asset') && displayOptions?.show?.operation?.includes('replace'));
	assert.equal(replacementFields.some(({ name }) => name === 'privacy'), false);
	assert.ok(replacementFields.every(({ displayName, description }) => displayName && description));
});

test('Asset:Replace dispatches through the node operation flow', async () => {
	const mock = makeContext({ usage: paidUsage, parameters: { assetId: 'asset_dispatch' } });
	const input = mock.item(0);
	const output = await executeOperation(mock.context, 'asset', 'replace', [input]);
	assert.equal(output[0].json.direct_url, 'https://media2url.com/existing-managed-url');
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	assert.ok(mock.calls.some(({ options }) => options.url.endsWith('/replace/finalize')));
});

test('wrong-owner and plan-denied API failures stay safe and retain item indexes', async () => {
	for (const status of [403, 404]) {
		const mock = makeContext({ usage: paidUsage, apiFailure: status, parameters: { assetId: 'asset_other_user' } });
		const item = mock.item(8);
		await assert.rejects(executeReplaceAsset(mock.context, [item], 8), (error) => {
			assert.ok(error instanceof NodeApiError);
			assert.equal(error.message.includes('private replacement response detail'), false);
			assert.equal(error.message.includes('secret'), false);
			assert.equal(error.context.itemIndex, 8);
			return true;
		});
		assert.equal(mock.calls.filter(({ options }) => options.url.endsWith('/replace/presign')).length, 1);
	}
});
