# Security policy

## Report a vulnerability

Do not open a public issue for a security problem. Report it in private with
GitHub security advisories:
https://github.com/pooriaarab/agentic-documents/security/advisories/new

Include the version (`npm ls agentic-documents`), the steps to reproduce, and the
impact you expect. We aim to reply within 7 days.

## Supported versions

Only the latest published version gets fixes.

## Scope

In scope: the package code (the SDK, CLI, MCP server, and Worker API) and the
export formats it writes.

Out of scope: a deployment that sets its own tokens or region without following
the README, and a self-declared `--as` label on the CLI. The README says that
label is not proof of identity.
