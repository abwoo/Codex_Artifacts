# Claude Code Artifacts Parity

This project is a clean-room, local-first recreation of the public Claude Code Artifacts workflow for Codex.

## Functional Match

| Claude Code Artifacts behavior | Codex Artifacts status |
| --- | --- |
| Publish a session artifact as a private page | Matched locally with `publish` and `publish-session` |
| Keep one stable share URL while updates create new versions | Matched |
| Share latest version or pin a specific version | Matched |
| Organization-scoped private access | Matched with a seeded local organization and users |
| Gallery with author, time, sharing, and version metadata | Mostly matched locally |
| Admin disable controls and role-scoped creation | Matched locally |
| Retention cleanup and audit trail | Matched locally |
| Compliance-style list, version retrieval, delete, and audit endpoints | Mostly matched locally |
| Single-page artifact rendering with strict sandbox/CSP | Matched locally |
| No backend or external network calls from artifact content | Matched by validation and sandboxing |
| `.html`, `.htm`, and `.md` inputs with rendered size cap | Matched |

## Local Equivalents

Private links are localhost links by default. `artifact config hosted-url --set ...` can make generated links use a hosted base URL, but production hosting, SSO, enterprise identity, and cloud storage are intentionally outside the local MVP.

Public/remix mode is optional and disabled by default in spirit: Claude Code Team/Enterprise parity remains the primary target, while remix exists for Claude.ai-style experimentation.

## Remaining Gaps

- Real Claude organization identity, SSO, SCIM, and enterprise policy sync.
- Production-grade hosted deployment with HTTPS, backups, and managed storage.
- Exact Anthropic UI, private prompts, private implementation details, and branding.
- Deep Codex app session hooks beyond CLI-based session capture.

Not affiliated with Anthropic.
