# Changelog

## 0.2.4

- Disable TypeScript `.d.ts` declaration file emission so n8n automated vetting scanner does not treat declaration stubs as missing credential tests.

## 0.2.3

- Add explicit `headers` with `Authorization` Bearer token into `test.request` in `Media2URLApi.credentials.ts` for automated vetting environments that do not inherit from generic auth.

## 0.2.2

- Match `Media2Url.node.json` codex file casing precisely to `Media2Url.node.ts` for Linux case-sensitive filesystems and n8n vetting registry.

## 0.2.1

- Remove redundant `testedBy` string from node `credentials` array so n8n runtime directly evaluates the credential's `test: ICredentialTestRequest`.

- Set `usableAsTool: true` on node description as required by the n8n community node specification.
- Clean up credential test specification and remove non-standard class properties for strict scanner compatibility.
- Ensure 100% compliance with `@n8n/scan-community-package` rules.

## 0.1.7

- Add `testedBy: 'media2URLApi'` to node credentials declaration for n8n verification compliance.
- Explicit credential test against the Media2URL `/v1/usage` endpoint.
- Link Media2URL documentation, privacy policy, terms, acceptable use, contact support, tools, and pricing.
- Automated GitHub Actions release with npm SLSA provenance.
