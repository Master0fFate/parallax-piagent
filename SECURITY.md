# Security Policy

## Supported versions

The latest commit on `main` is the supported development version until formal releases begin.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use the repository's **Security** tab to submit a private report when available. Otherwise, contact [@Master0fFate](https://github.com/Master0fFate) privately through GitHub with:

- affected version or commit;
- reproduction steps;
- impact and affected trust boundary;
- suggested mitigation, if known.

Reports will be acknowledged as soon as practical. Please allow time for validation and remediation before disclosure.

## Security boundaries

Parallax runs with the current user's permissions. Project-defined configuration, checks, delegate context, and Horizon execution must remain behind Pi's project-trust decision. Never include credentials, private source, or unsanitized Horizon artifacts in reports.
