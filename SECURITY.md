# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in a public issue. Use the
repository's private vulnerability reporting feature when it is available. If
that feature is not enabled, contact the maintainers through a private channel
listed in the repository profile and include:

- the affected revision and component;
- a concise description of the security impact;
- reproduction steps that do not include real credentials or personal data;
- any proposed mitigation.

Allow reasonable time for triage and remediation before public disclosure. Do
not include API keys, OAuth tokens, private project files, terminal transcripts,
or other sensitive material in an issue, pull request, log, or test fixture.

## Security boundaries

Traflix Space is a local Windows desktop application. Terminal processes run
with the current user's permissions, and the application can access project
files selected by that user. Treat the application, its dependencies, agent
CLIs, and remote providers as separate trust boundaries.

Never commit `.env` files, provider credentials, generated sidecars, local
agent checkouts, or diagnostic logs. Use `.env.example` for documentation-only
placeholders.

## Before public release

Removing a file from the working tree does not remove it from existing Git
history or hosted objects. Before making a previously private repository public,
review its full history and release artifacts. If a credential was ever
committed, revoke and rotate it before publication; rewrite history separately
when necessary.
