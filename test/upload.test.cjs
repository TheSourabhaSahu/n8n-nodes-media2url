const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { executeUploadBinary } = require('../dist/nodes/Media2URL/uploads.js');

function makeContext({ parameters = {}, usage, failFinalizeFor, finalizeStatus = 422, continueOnFail = false, executionId = 'exec_safe_1' } = {}) {
	const calls = [];
	const binaryBuffers = new Map();
	let uploadCounter = 0;
	const context = {
		node: { name: 'Media2URL', type: 'n8n-nodes-media2url.media2Url', typeVersion: 1, position: [0, 0], parameters: {} },
		getNode() { return this.node; },
		getExecutionId() { return executionId; },
		getNodeParameter(name, itemIndex, fallback) {
			const value = parameters[name];
			return value === undefined ? fallback : typeof value === 'function' ? value(itemIndex) : value;
		},
		continueOnFail() { return continueOnFail; },
		helpers: {
			getBinaryDataBuffer: async (itemIndex, propertyName) => {
				const buffer = binaryBuffers.get(`${itemIndex}:${propertyName}`);
				if (!buffer) throw new Error('binary missing');
				return buffer;
			},
			httpRequestWithAuthentication: async function (credentialType, options) {
				calls.push({ kind: 'api', credentialType, options });
				if (options.url === '/v1/usage') return { body: usage, statusCode: 200 };
				if (options.url === '/v1/uploads/presign') {
					uploadCounter++;
					return { body: { upload_id: `upload_${uploadCounter}`, upload_url: `https://storage.example/${uploadCounter}?X-Signature=secret`, required_headers: { 'Content-Type': options.body.content_type } }, statusCode: 201 };
				}
			if (options.url === '/v1/uploads/finalize') {
				if (failFinalizeFor && options.body.upload_id === failFinalizeFor) {
					const error = new Error('private response detail');
					error.httpCode = String(finalizeStatus);
					error.response = { statusCode: finalizeStatus, headers: {}, body: { detail: 'private response detail' } };
					throw error;
				}
				return { body: { id: options.body.upload_id, direct_url: 'https://media2url.com/direct', share_url: 'https://media2url.com/share', temporary: !usage.account.capabilities.persistent_publish, expires_at: !usage.account.capabilities.persistent_publish ? '2026-09-27T00:00:00.000Z' : undefined, trial_remaining: !usage.account.capabilities.persistent_publish ? usage.account.trial.remaining - 1 : undefined }, statusCode: 201 };
			}
			throw new Error('unexpected authenticated API request');
		},
			httpRequest: async (options) => {
				calls.push({ kind: 'upload', options });
				return { statusCode: 200 };
			},
		},
	};
	return {
		context,
		calls,
		addBinary(itemIndex, propertyName, filename, mimeType, buffer) {
			binaryBuffers.set(`${itemIndex}:${propertyName}`, buffer);
			return {
				json: { source: itemIndex },
				binary: { [propertyName]: { fileName: filename, mimeType, fileSize: String(buffer.length), data: buffer.toString('base64') } },
			};
		},
	};
}

const freeUsage = (remaining) => ({ account: { capabilities: { persistent_publish: false }, trial: { remaining } } });
const paidUsage = { account: { capabilities: { persistent_publish: true }, trial: { remaining: 0 } } };

test('free PNG upload uses the default binary property and returns authoritative temporary fields', async () => {
	const mock = makeContext({ usage: freeUsage(3) });
	const item = mock.addBinary(0, 'data', 'photo.png', 'image/png', Buffer.from('png bytes'));
	const output = await executeUploadBinary(mock.context, [item]);
	assert.equal(output.length, 1);
	assert.equal(output[0].json.direct_url, 'https://media2url.com/direct');
	assert.equal(output[0].json.share_url, 'https://media2url.com/share');
	assert.equal(output[0].json.temporary, true);
	assert.equal(output[0].binary, undefined);
	assert.equal(output[0].json.expires_at, '2026-09-27T00:00:00.000Z');
	assert.equal(output[0].json.trial_remaining, 2);
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	assert.equal(mock.calls.filter(({ kind }) => kind === 'api').length, 3);
	const upload = mock.calls.find(({ kind }) => kind === 'upload');
	assert.equal(upload.options.url.includes('secret'), true);
	assert.equal(Object.keys(upload.options.headers).includes('Authorization'), false);
	assert.equal(upload.options.body.toString(), 'png bytes');
});

test('custom binary property and destination filename override are honored; missing metadata fails safely', async () => {
	const mock = makeContext({ usage: paidUsage, parameters: { binaryPropertyName: 'filedata', filename: 'renamed.png' } });
	const item = mock.addBinary(0, 'filedata', 'source.png', 'image/png', Buffer.from('image'));
	const output = await executeUploadBinary(mock.context, [item]);
	const presign = mock.calls.find(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/presign');
	assert.equal(presign.options.body.filename, 'renamed.png');
	assert.equal(presign.options.body.size, 5);
	assert.equal(output[0].json.temporary, false);

	const missing = makeContext({ usage: paidUsage });
	missing.addBinary(0, 'data', undefined, undefined, Buffer.from('bytes'));
	await assert.rejects(executeUploadBinary(missing.context, [{ json: {}, binary: { data: {} } }]), NodeOperationError);
	assert.equal(missing.calls.some(({ options }) => options.url === '/v1/uploads/presign'), false);
});

test('Free JPG uploads are eligible but PDF and oversize items fail before any presign call', async () => {
	const jpg = makeContext({ usage: freeUsage(3) });
	const jpgItem = jpg.addBinary(0, 'data', 'photo.jpg', 'image/jpeg', Buffer.from('jpeg'));
	await executeUploadBinary(jpg.context, [jpgItem]);
	assert.equal(jpg.calls.some(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/presign'), true);
	const paidPdf = makeContext({ usage: paidUsage });
	const paidPdfItem = paidPdf.addBinary(0, 'data', 'document.pdf', 'application/pdf', Buffer.from('pdf bytes'));
	const paidPdfOutput = await executeUploadBinary(paidPdf.context, [paidPdfItem]);
	assert.equal(paidPdfOutput[0].json.temporary, false);

	for (const [filename, mimeType, buffer] of [
		['document.pdf', 'application/pdf', Buffer.from('pdf')],
		['large.png', 'image/png', Buffer.alloc(2 * 1024 * 1024 + 1)],
	]) {
		const invalid = makeContext({ usage: freeUsage(3) });
		const invalidItem = invalid.addBinary(0, 'data', filename, mimeType, buffer);
		await assert.rejects(executeUploadBinary(invalid.context, [invalidItem]), NodeOperationError);
		assert.equal(invalid.calls.some(({ options }) => options.url === '/v1/uploads/presign'), false);
	}
});

test('a Free trial exhaustion race is surfaced once without silently retrying a write', async () => {
	const mock = makeContext({ usage: freeUsage(1), failFinalizeFor: 'upload_1', finalizeStatus: 403 });
	const item = mock.addBinary(0, 'data', 'race.png', 'image/png', Buffer.from('png'));
	await assert.rejects(executeUploadBinary(mock.context, [item]), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.match(error.message, /did not permit this operation/i);
		assert.equal(error.message.includes('private response detail'), false);
		return true;
	});
	assert.equal(mock.calls.filter(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/presign').length, 1);
	assert.equal(mock.calls.filter(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/finalize').length, 1);
});

test('Free batch preflight rejects insufficient credits or one invalid item before side effects', async () => {
	const overLimit = makeContext({ usage: freeUsage(1) });
	const items = [
		overLimit.addBinary(0, 'data', 'one.png', 'image/png', Buffer.from('one')),
		overLimit.addBinary(1, 'data', 'two.png', 'image/png', Buffer.from('two')),
	];
	await assert.rejects(executeUploadBinary(overLimit.context, items), /2 files.*1 hosted trial publication/s);
	assert.equal(overLimit.calls.some(({ options }) => options.url === '/v1/uploads/presign'), false);

	const oneInvalid = makeContext({ usage: freeUsage(3) });
	const mixed = [
		oneInvalid.addBinary(0, 'data', 'one.png', 'image/png', Buffer.from('one')),
		oneInvalid.addBinary(1, 'data', 'two.pdf', 'application/pdf', Buffer.from('two')),
	];
	await assert.rejects(executeUploadBinary(oneInvalid.context, mixed), NodeOperationError);
	assert.equal(oneInvalid.calls.some(({ options }) => options.url === '/v1/uploads/presign'), false);

	const validBatch = makeContext({ usage: freeUsage(2) });
	const validItems = [
		validBatch.addBinary(0, 'data', 'one.png', 'image/png', Buffer.from('first')),
		validBatch.addBinary(1, 'data', 'two.jpg', 'image/jpeg', Buffer.from('second')),
	];
	const validOutput = await executeUploadBinary(validBatch.context, validItems);
	assert.deepEqual(validOutput.map(({ json }) => json.id), ['upload_1', 'upload_2']);
	assert.deepEqual(validOutput.map(({ pairedItem }) => pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.equal(validBatch.calls.filter(({ kind, options }) => kind === 'api' && options.url === '/v1/usage').length, 1);
	assert.equal(validBatch.calls.findIndex(({ kind, options }) => kind === 'api' && options.url === '/v1/usage') < validBatch.calls.findIndex(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/presign'), true);
});

test('paid uploads continue item-locally and idempotency keys contain neither secrets nor file metadata', async () => {
	const mock = makeContext({ usage: paidUsage, failFinalizeFor: 'upload_1', continueOnFail: true });
	const items = [
		mock.addBinary(0, 'data', 'a.png', 'image/png', Buffer.from('secret-binary-a')),
		mock.addBinary(1, 'data', 'b.png', 'image/png', Buffer.from('secret-binary-b')),
	];
	const output = await executeUploadBinary(mock.context, items);
	const presigns = mock.calls.filter(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/presign');
	const finalizes = mock.calls.filter(({ kind, options }) => kind === 'api' && options.url === '/v1/uploads/finalize');
	assert.equal(presigns.length, 2);
	assert.equal(finalizes.length, 2);
	assert.equal(output.length, 2);
	assert.equal(output.some(({ json }) => json.error), true);
	assert.equal(JSON.stringify(output).includes('secret-binary-a'), false);
	assert.equal(JSON.stringify(output).includes('secret-binary-b'), false);
	for (const call of finalizes) {
		const key = call.options.headers['Idempotency-Key'];
		assert.match(key, /^m2u-n8n-[a-f0-9]{40}$/);
		assert.equal(key.includes('secret'), false);
		assert.equal(key.includes('a.png'), false);
		assert.equal(key.includes('b.png'), false);
	}
	const repeated = makeContext({ usage: paidUsage, executionId: 'exec_safe_1' });
	const repeatItem = repeated.addBinary(0, 'data', 'different.png', 'image/png', Buffer.from('different bytes'));
	await executeUploadBinary(repeated.context, [repeatItem]);
	assert.equal(repeated.calls.find(({ options }) => options.url === '/v1/uploads/finalize').options.headers['Idempotency-Key'], finalizes[0].options.headers['Idempotency-Key']);
});
