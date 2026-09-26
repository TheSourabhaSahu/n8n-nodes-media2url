const assert = require('node:assert/strict');
const test = require('node:test');

const nodeModule = require('../dist/nodes/Media2URL/Media2Url.node.js');

test('n8n can construct the node class named by the package entry path', () => {
	const node = new nodeModule.Media2Url();

	assert.equal(node.description.name, 'media2Url');
	assert.equal(node.description.displayName, 'Media2URL');
});
