# Media2URL for n8n

Media2URL lets an n8n workflow publish a file and pass a direct file URL or a share page to the next step. This is a pre-release community-node project: it is not yet published to npm or submitted to n8n, so there is no installation command to run yet.

The [public source repository](https://github.com/TheSourabhaSahu/n8n-nodes-media2url) contains the node implementation and release checks. Use its [issue tracker](https://github.com/TheSourabhaSahu/n8n-nodes-media2url/issues) to report a problem or request a change.

Use the [Media2URL homepage](https://media2url.com/) to learn what the service hosts, browse the [Media tools](https://media2url.com/tools) for supported file workflows, or read the [API v1 documentation](https://media2url.com/docs/api/v1) when you need the exact request and response fields.

## What the node does

The node uses a Media2URL API key stored in n8n credentials. It can publish binary data from an earlier node, ask Media2URL to import a supported public URL, and read or manage assets that belong to the credential's account. After a successful create, `directUrl` points to the file and `shareUrl` opens its Media2URL page.

| Resource | Operation | Result |
| --- | --- | --- |
| Account | Get Usage | Safe account capabilities and usage information |
| Asset | Upload Binary File | Upload the selected binary property and return asset links |
| Asset | Import From URL | Let Media2URL fetch a supported public URL and return the completed asset |
| Asset | Get / Get Many | Retrieve an owned asset or list assets using cursor pagination |
| Asset | Delete | Delete an owned asset and return `{ "deleted": true }` |
| Asset | Replace | Create a new version while retaining the asset's managed URL; requires a paid plan |
| Version | Get Many | Read an asset's version history |

## Account and link behavior

Free trial uploads and URL imports create temporary assets that expire after 48 hours; check `temporary` and `expires_at` in the result before sharing one downstream. Persistent publishing and same-URL replacement require an eligible paid plan. The node checks account capabilities for replacement, while the Media2URL API remains authoritative for ownership, workspace permissions, file rules, quotas, and plan access. Review [Media2URL plans and pricing](https://media2url.com/pricing) before designing a workflow that depends on persistent hosting.

The node never sends uploaded bytes to the Media2URL API request itself. It asks the API for a short-lived storage upload URL, transfers the selected binary directly to that URL without forwarding the API key, then finalizes the upload through the API. URL imports are fetched by Media2URL rather than by the n8n node.

## Set up credentials

Create an n8n credential named **Media2URL API** and paste a Media2URL API key into its password field. The credential test performs a read-only usage request. Keep the key in n8n's credential store; don't put it in workflow JSON, node parameters, sticky notes, or execution data. The credential uses the usage endpoint to check access without creating an asset or consuming a trial credit.

## Binary uploads and replacement

For **Upload Binary File**, connect a node that provides a binary property, then enter that property's name in **Binary Property**. The default is `data`. The node reads the bytes through n8n's binary helper; it does not include those bytes in its output. The optional **File Name** overrides the source filename.

For **Replace**, provide the existing asset ID and incoming binary property. Replacement uploads new contents as a version at the current managed URL; it does not create a separate asset or provide a rollback operation. Confirm that the asset is the one you intend to change before enabling a production workflow. The latest content will be served from that same URL.

## Examples

The GitHub repository's [workflow examples](https://github.com/TheSourabhaSahu/n8n-nodes-media2url/tree/main/examples) include four credential-free templates. They use blank service settings and have not been run against connected user accounts. Add your own credentials after importing, then inspect the selected binary property and any service-specific IDs before enabling a workflow.

- `drive-to-media2url-to-sheets.json` downloads a Drive file, publishes it, then appends its result to a Sheet.
- `webhook-binary-to-media2url-share-response.json` receives a binary upload and returns the resulting links in a webhook response.
- `generated-image-to-media2url-wordpress.json` passes an OpenAI-generated image through Media2URL before a WordPress media request.
- `replace-existing-media2url-asset.json` replaces the binary version for an existing asset without changing its managed URL.

## Security and service policies

The package uses a password-only credential and does not include API keys in examples. Read the [Privacy policy](https://media2url.com/privacy) to understand how Media2URL handles data, and the [Security practices](https://media2url.com/security) page for its published security information. Workflows must follow the [Terms of service](https://media2url.com/terms) and [Acceptable use policy](https://media2url.com/acceptable-use); don't use file hosting to distribute content you aren't allowed to share.

To ask a setup question, [contact Media2URL support](https://media2url.com/contact). Use [Report abuse](https://media2url.com/report-abuse) for suspected misuse, the [DMCA requests page](https://media2url.com/dmca) for copyright notices, and the [Service providers and subprocessors list](https://media2url.com/subprocessors) to review service providers. Security issues can be reported through the contact route described in [SECURITY.md](SECURITY.md).

## Compatibility and status

The package is under local development and has not yet completed a clean n8n editor installation check, public release, or n8n review. The source branch has local build, unit-test, and node-linter checks; those checks do not establish compatibility with every n8n version or approval by n8n. Check the package's published status before planning deployment.

## License

This community-node package is distributed under the [MIT License](LICENSE). That license covers this package only; it does not change the license or terms for the Media2URL website and hosted service.
