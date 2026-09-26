# Changelog

## 0.2.0

- Set `usableAsTool: true` on node description as required by the n8n community node specification.
- Clean up credential test specification and remove non-standard class properties for strict scanner compatibility.
- Ensure 100% compliance with `@n8n/scan-community-package` rules.

## 0.1.7

- Add `testedBy: 'media2URLApi'` to node credentials declaration for n8n verification compliance.
- Explicit credential test against the Media2URL `/v1/usage` endpoint.
- Link Media2URL documentation, privacy policy, terms, acceptable use, contact support, tools, and pricing.
- Automated GitHub Actions release with npm SLSA provenance.
