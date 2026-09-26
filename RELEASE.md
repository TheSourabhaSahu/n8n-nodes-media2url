# Release workflow

The workflows in this repository are inert until the exact public GitHub repository exists and its branch, tag, Actions, and `npm-staging` environment protections are configured. They do not publish directly: a protected `v*` tag can only stage a package for human review.

CI runs with read-only repository permissions. Its verification jobs install both lockfile-pinned dependency trees with lifecycle scripts disabled, audit production and isolated scanner dependencies, build and test the source, scan the actual `dist/` package with the pinned n8n community scanner, and print a dry-run npm package inventory. Release validation repeats those checks for the exact tagged commit and refuses a tag/version or repository-identity mismatch. The separate staging job receives only `contents: read` and OIDC `id-token: write`; it installs no project dependencies, uses Node.js 24.21.0 with its bundled npm 11.19.0, has no npm token or other repository secret, and requests npm provenance. No direct `npm publish` command is present.

Before any staging run, the owner must configure an `npm-staging` GitHub environment requiring approval, protect the `main` branch and `v*` tags against force updates/deletion, require CI on pull requests, and configure the exact GitHub Actions trusted publisher on npm with `npm stage publish` allowed and `npm publish` disallowed. These are future manual settings; local workflow files do not prove that the settings exist.

## First-version limitation

Current npm staged-publishing documentation says the package must already exist before `npm stage publish` can be used. Therefore this stage-only OIDC workflow cannot bootstrap the first version of a brand-new package. It intentionally contains no token-based or direct-publication fallback. The first-public-version path needs a separately reviewed, user-approved process that preserves GitHub Actions provenance and npm two-factor protection. Do not add a bootstrap token, run a release tag, or publish until that process is resolved and approved.

The current repository checkout is local-only. No remote, GitHub identity, npm credential, trusted publisher, or protection setting has been configured or inspected by these files.
