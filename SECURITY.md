# Security policy

## Reporting a vulnerability

Please report a suspected vulnerability privately through the [Media2URL contact page](https://media2url.com/contact). Include the affected component, a clear description of the impact, and steps to reproduce it when those steps are safe to share. Do not include API keys, passwords, private files, or personal data in a report.

Please avoid posting details publicly while a report is being reviewed. Media2URL will assess the report and coordinate any disclosure directly with the reporter. This file describes the reporting route for this community-node package; it is not a promise of a particular response time or service-level agreement.

## Credential handling

The node stores the API key through n8n's password credential field and sends it only to the fixed Media2URL API host for authenticated API requests. Presigned storage uploads do not receive the bearer credential. Workflow examples contain no account credentials. If a key is exposed, revoke it in Media2URL and create a replacement rather than reusing it.
