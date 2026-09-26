const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const packageRoot = path.resolve(__dirname, '..');
const builtPackage = path.join(packageRoot, 'dist');

async function scanBuiltPackage() {
	if (!fs.existsSync(path.join(builtPackage, 'package.json'))) {
		throw new Error('Run the package build before scanning its dist directory.');
	}

	const scannerPath = require.resolve('@n8n/scan-community-package/scanner/scanner.mjs', {
		paths: [path.join(packageRoot, 'tools', 'community-scanner')],
	});
	const { analyzePackage } = await import(pathToFileURL(scannerPath).href);
	// Scan shipped code and metadata. The scaffold emits .d.ts files, which are
	// declarations rather than node source and trip the scanner's source-file naming rules.
	const result = await analyzePackage(builtPackage, ['**/*.js', '**/*.json']);

	if (!result.passed) {
		console.error(result.message || 'The n8n community package scan failed.');
		if (result.details) console.error(result.details);
		process.exitCode = 1;
		return;
	}

	console.log('The built Media2URL package passed the pinned n8n community package scan.');
}

scanBuiltPackage().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
