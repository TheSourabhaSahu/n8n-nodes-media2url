const test = require('node:test');
const assert = require('node:assert/strict');
const { Media2URLApi } = require('../dist/credentials/Media2URLApi.credentials.js');

test('Media2URL credential uses password-only bearer auth and a read-only usage test', () => {
	const credential = new Media2URLApi();
	assert.equal(credential.name, 'media2URLApi');
	assert.equal(credential.documentationUrl, 'https://media2url.com/docs/api/v1');
	assert.deepEqual(credential.properties.map(({ name, type }) => ({ name, type })), [
		{ name: 'apiKey', type: 'string' },
	]);
	assert.equal(credential.properties[0].typeOptions.password, true);
	assert.deepEqual(credential.authenticate, {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials?.apiKey}}',
			},
		},
	});
	assert.equal(credential.test.request.method, 'GET');
	assert.deepEqual(credential.test.request, {
		baseURL: 'https://api.media2url.com',
		url: '/v1/usage',
		method: 'GET',
	});
});
