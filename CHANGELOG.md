# Changelog

## 0.2.11

- Update Codex `node` field to fully-qualified identifier format `n8n-nodes-media2url.media2Url` in `Media2Url.node.json`.
- Ensure supported Codex categories (`Development`, `Data & Storage`) and synchronize `main` default branch on GitHub with npm package version.

## 0.2.10

- Update Codex categories in `Media2Url.node.json` to supported n8n categories (`Development`, `Data & Storage`) per community vetting review feedback.

## 0.2.9

- Update Codex categories in `Media2Url.node.json` to supported n8n categories (`Development`, `Data & Storage`) per community vetting review feedback.

## 0.2.8

- Update Codex categories in `Media2Url.node.json` to supported n8n categories (`Development`, `Data & Storage`) per community vetting feedback.

## 0.2.7

- Package configuration and community vetting adjustments.

## 0.2.6

- Provide explicit full URL (`https://api.media2url.com/v1/usage`) and explicit `headers` with Bearer token authentication in credential `test.request` for direct runner evaluation.

## 0.2.5

- Align credential property order, explicit icon typing, and generic bearer authorization expression syntax (`{{$credentials?.apiKey}}`) exactly with official n8n community node starter template.

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
