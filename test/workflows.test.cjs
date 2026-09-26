const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const workflowFiles = ['ci.yml', 'publish.yml'];

function readWorkflow(name) {
	return fs.readFileSync(path.join(workflowDir, name), 'utf8');
}

test('all GitHub Actions references are pinned to reviewed full commit SHAs', () => {
	for (const filename of workflowFiles) {
		const workflow = readWorkflow(filename);
		const references = [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)/gm)].map(([, reference]) => reference);
		assert.ok(references.length > 0, `${filename} should declare its Actions dependencies`);
		for (const reference of references) {
			assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/, `${filename} action must use a full commit SHA: ${reference}`);
		}
	}
});

test('CI is read-only, fork-safe, cache-free, and runs the release checks', () => {
	const ci = readWorkflow('ci.yml');
	assert.match(ci, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
	assert.doesNotMatch(ci, /:\s*write\b/);
	assert.match(ci, /pull_request:/);
	assert.doesNotMatch(ci, /pull_request_target/);
	assert.match(ci, /runs-on:\s*ubuntu-24\.04/);
	assert.match(ci, /npm ci --ignore-scripts\s*$/m);
	assert.match(ci, /npm ci --prefix tools\/community-scanner --ignore-scripts/);
	assert.match(ci, /npm audit --omit=dev --audit-level=high/);
	assert.match(ci, /npm audit --prefix tools\/community-scanner --audit-level=high/);
	assert.match(ci, /npm test/);
	assert.match(ci, /npm run lint/);
	assert.match(ci, /npm run build/);
	assert.match(ci, /npm run scan:community/);
	assert.match(ci, /npm pack --dry-run --json/);
	assert.doesNotMatch(ci, /cache:\s*['"]?npm|actions\/cache@/i);
});

test('release staging is tag-bound, stage-only, provenance-enabled, and narrowly privileged', () => {
	const publish = readWorkflow('publish.yml');
	const stageJob = publish.split(/^  stage:\s*$/m)[1];
	assert.ok(stageJob, 'publish workflow should declare its stage job');
	assert.match(publish, /push:\s*\n\s+tags:\s*\n\s+- ['"]v\*['"]/);
	assert.match(publish, /github\.ref_type == 'tag'/);
	assert.match(publish, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
	assert.match(publish, /github\.repository == 'TheSourabhaSahu\/n8n-nodes-media2url'/);
	assert.match(publish, /permissions:\s*\{\}/);
	assert.match(publish, /contents:\s*read/);
	assert.match(publish, /id-token:\s*write/);
	assert.match(publish, /environment:\s*npm-staging/);
	assert.match(publish, /npm stage publish --provenance --access public/);
	assert.doesNotMatch(stageJob, /npm ci|npm install/);
	assert.doesNotMatch(publish, /npm publish(?:\s|$)/m);
	assert.doesNotMatch(publish, /pull_request_target/);
	assert.doesNotMatch(publish, /cache:\s*['"]?npm|actions\/cache@/i);
	assert.match(publish, /npm ci --ignore-scripts/);
	assert.match(publish, /npm ci --prefix tools\/community-scanner --ignore-scripts/);
	assert.doesNotMatch(publish, /name: Install locked CLI tools/);
	assert.match(publish, /npm audit --omit=dev --audit-level=high/);
	assert.match(publish, /npm audit --prefix tools\/community-scanner --audit-level=high/);
	assert.match(publish, /node-version:\s*['"]24\.21\.0['"]/);
	assert.match(publish, /test \"\$\(npm --version\)\" = '11\.19\.0'/);
	assert.match(publish, /npm stage publish --provenance --access public/);
	assert.match(publish, /package-manager-cache:\s*false/);
});

test('the release path contains no long-lived publishing secrets or direct-publication command', () => {
	const publish = readWorkflow('publish.yml');
	assert.doesNotMatch(publish, /secrets\./);
	assert.doesNotMatch(publish, /NODE_AUTH_TOKEN/);
	assert.doesNotMatch(publish, /npm publish(?:\s|$)/m);
});

test('the package declares the exact public GitHub repository', () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	assert.equal(packageJson.repository, 'git+https://github.com/TheSourabhaSahu/n8n-nodes-media2url.git');
});

test('the pinned n8n scanner analyzes the built package locally', () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	assert.equal(packageJson.devDependencies['@n8n/scan-community-package'], undefined);
	assert.equal(packageJson.devDependencies.npm, undefined);
	assert.equal(packageJson.overrides, undefined);
	const scannerPackage = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'community-scanner', 'package.json'), 'utf8'));
	assert.equal(scannerPackage.private, true);
	assert.equal(scannerPackage.devDependencies['@n8n/scan-community-package'], '0.37.0');
	assert.equal(scannerPackage.overrides['@n8n/scan-community-package'].tmp, '0.2.7');
	assert.equal(scannerPackage.overrides['form-data'], '4.0.6');
	assert.equal(scannerPackage.overrides.lodash, '4.18.1');
	assert.equal(scannerPackage.overrides.uuid, '11.1.1');
	assert.equal(scannerPackage.overrides['n8n-workflow'], '2.16.0');
	assert.equal(packageJson.scripts['scan:community'], 'node scripts/scan-community.cjs');
	for (const script of ['prepare', 'prepack', 'prepublishOnly', 'postpack']) {
		assert.equal(packageJson.scripts[script], undefined, `npm staging must not execute a ${script} lifecycle script`);
	}
	const scanner = fs.readFileSync(path.join(root, 'scripts', 'scan-community.cjs'), 'utf8');
	assert.match(scanner, /tools', 'community-scanner/);
	assert.match(scanner, /analyzePackage\(builtPackage,\s*\['\*\*\/\*\.js', '\*\*\/\*\.json'\]\)/);
	assert.doesNotMatch(scanner, /'\*\*\/\*\.ts'/);
	assert.match(scanner, /dist/);
});
