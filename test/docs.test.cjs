const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredLinks = new Map([
	['https://media2url.com/', /Media2URL homepage/i],
	['https://media2url.com/tools', /Media tools/i],
	['https://media2url.com/docs/api/v1', /API v1 documentation/i],
	['https://media2url.com/pricing', /Media2URL plans and pricing/i],
	['https://media2url.com/privacy', /Privacy policy/i],
	['https://media2url.com/security', /Security practices/i],
	['https://media2url.com/terms', /Terms of service/i],
	['https://media2url.com/acceptable-use', /Acceptable use policy/i],
	['https://media2url.com/contact', /Contact Media2URL support/i],
	['https://media2url.com/report-abuse', /Report abuse/i],
	['https://media2url.com/dmca', /DMCA requests/i],
	['https://media2url.com/subprocessors', /Service providers and subprocessors/i],
]);
const requiredRepositoryLinks = new Map([
	['https://github.com/TheSourabhaSahu/n8n-nodes-media2url', /source repository/i],
	['https://github.com/TheSourabhaSahu/n8n-nodes-media2url/issues', /issue tracker/i],
]);

function documentationFiles() {
	const files = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'RELEASE.md'];
	for (const name of fs.readdirSync(path.join(root, 'examples')).filter((file) => file.endsWith('.json'))) {
		files.push(path.join('examples', name));
	}
	return files.map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]);
}

test('public README has contextual Media2URL backlinks and stays truthful before publication', () => {
	const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
	const links = [...readme.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)];
	for (const [url, anchorPattern] of requiredLinks) {
		const matches = links.filter(([, , target]) => target === url);
		assert.equal(matches.length, 1, `README should link to ${url} exactly once`);
		assert.match(matches[0][1], anchorPattern, `link to ${url} should have a descriptive anchor`);
	}
	for (const [url, anchorPattern] of requiredRepositoryLinks) {
		const matches = links.filter(([, , target]) => target === url);
		assert.equal(matches.length, 1, `README should link to ${url} exactly once`);
		assert.match(matches[0][1], anchorPattern, `link to ${url} should have a descriptive anchor`);
	}
	for (const [anchor] of links) assert.doesNotMatch(anchor, /^(here|click here|learn more|this page)$/i);
	assert.match(readme, /not yet published/i);
	assert.doesNotMatch(readme, /npm\s+install\s+n8n-nodes-media2url/i);
	assert.match(readme, /\[workflow examples\]\(https:\/\/github\.com\/TheSourabhaSahu\/n8n-nodes-media2url\/tree\/main\/examples\)/i);
});

test('public documentation contains no private paths, secret-shaped values, or private-host URLs', () => {
	for (const [name, content] of documentationFiles()) {
		assert.doesNotMatch(content, /\/(?:Users|home)\/[A-Za-z0-9._/-]+/, `${name} must not contain absolute local paths`);
		assert.doesNotMatch(content, /(?:m2u_live_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i, `${name} must not contain credential-shaped values`);
		assert.doesNotMatch(content, /https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[^\s/]*\.(?:internal|local|lan))(?:[/:)]|$)/i, `${name} must not link to a private host`);
	}
});

test('exactly four importable, credential-free workflow examples include safety notes', () => {
	const examplesDir = path.join(root, 'examples');
	const files = fs.readdirSync(examplesDir).filter((name) => name.endsWith('.json')).sort();
	assert.deepEqual(files, [
		'drive-to-media2url-to-sheets.json',
		'generated-image-to-media2url-wordpress.json',
		'replace-existing-media2url-asset.json',
		'webhook-binary-to-media2url-share-response.json',
	]);
	for (const filename of files) {
		const workflow = JSON.parse(fs.readFileSync(path.join(examplesDir, filename), 'utf8'));
		assert.equal(typeof workflow.name, 'string');
		assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length >= 3);
		assert.equal(typeof workflow.connections, 'object');
		assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-media2url.media2Url'), true, `${filename} must use Media2URL`);
		assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.stickyNote'), true, `${filename} must include a setup and safety note`);
		assert.equal(workflow.nodes.some(({ credentials }) => credentials !== undefined), false, `${filename} must not contain credentials`);
		const noteText = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.stickyNote').map(({ parameters }) => parameters.content).join(' ');
		assert.match(noteText, /credential/i);
		assert.match(noteText, /binary property/i);
		assert.match(noteText, /temporary/i);
		assert.match(noteText, /48 hours/i);
		assert.match(noteText, /paid/i);
	}
	const workflowTypes = (filename) => JSON.parse(fs.readFileSync(path.join(examplesDir, filename), 'utf8')).nodes.map(({ type }) => type);
	assert.ok(workflowTypes('drive-to-media2url-to-sheets.json').includes('n8n-nodes-base.googleDrive'));
	assert.ok(workflowTypes('drive-to-media2url-to-sheets.json').includes('n8n-nodes-base.googleSheets'));
	assert.ok(workflowTypes('webhook-binary-to-media2url-share-response.json').includes('n8n-nodes-base.webhook'));
	assert.ok(workflowTypes('webhook-binary-to-media2url-share-response.json').includes('n8n-nodes-base.respondToWebhook'));
	assert.ok(workflowTypes('generated-image-to-media2url-wordpress.json').includes('@n8n/n8n-nodes-langchain.openAi'));
	assert.ok(workflowTypes('generated-image-to-media2url-wordpress.json').includes('n8n-nodes-base.httpRequest'));
	assert.ok(JSON.parse(fs.readFileSync(path.join(examplesDir, 'replace-existing-media2url-asset.json'), 'utf8')).nodes.some(({ parameters }) => parameters.operation === 'replace'));
});

test('MIT terms, security contact route, and Media2URL-owned node icons are present', () => {
	assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
	assert.match(fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8'), /https:\/\/media2url\.com\/contact/);
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	assert.equal(packageJson.license, 'MIT');
	assert.ok(packageJson.files.includes('SECURITY.md'));
	assert.ok(packageJson.files.includes('README.md'));
	assert.equal(packageJson.homepage, 'https://media2url.com/integrations/n8n');
	for (const filename of ['example.svg', 'example.dark.svg']) {
		const icon = fs.readFileSync(path.join(root, 'nodes/Media2URL', filename), 'utf8');
		assert.match(icon, /<svg[\s\S]*viewBox="0 0 24 24"/);
		assert.doesNotMatch(icon, /n8n/i);
		assert.doesNotMatch(icon, /feather|lucide/i);
	}
});

test('release notes distinguish the public repository from unverified release settings', () => {
	const release = fs.readFileSync(path.join(root, 'RELEASE.md'), 'utf8');
	assert.match(release, /public source repository is already created/i);
	assert.match(release, /branch\/tag protections.*trusted publisher/i);
	assert.doesNotMatch(release, /current repository checkout is local-only/i);
});
