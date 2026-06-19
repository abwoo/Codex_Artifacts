# Claude Code Artifacts Parity

Codex Artifacts is a clean-room, local-first recreation of the public Claude Code Artifacts workflow for Codex. It is not the official Claude Artifacts product, not a claude.ai hosted service, and not a copy of Anthropic branding, prompts, private code, or hosted infrastructure.

## Parity Matrix

| Claude feature | Current Codex status | Evidence | Gap | Next action |
| --- | --- | --- | --- | --- |
| Publish a Code session artifact as a private page | Strong local parity | `publish` and `publish-session` create authenticated artifact pages | No native Codex app hook | Add deeper Codex app session ingestion later |
| Stable share URL that updates in place | Strong local parity | Updates create new versions while share URL stays stable | None for local mode | Keep covered by verification |
| Latest-version and pinned-version sharing | Strong local parity | Share settings support latest or a selected version | None for local mode | Keep covered by verification |
| Organization-only private sharing | Behavioral approximation | Seeded local org/users and authenticated share routes | No real Team/Enterprise identity | Add hosted auth/SSO only after deploy target exists |
| Gallery with metadata | Strong local parity | Mine, shared, recent, deleted groups plus author/time/share metadata | UI is local and intentionally not Anthropic-branded | Polish UX without copying Claude pixels |
| Single-page artifact with strict sandboxing | Strong local parity | Rendered HTML is served in a sandboxed iframe with CSP | Browser-specific hardening can always improve | Keep security regression tests broad |
| No external requests from artifact content | Strong local parity | External `src`, `href`, CSS imports, fetch/XHR/WebSocket/EventSource are blocked | Static validation is conservative, not a browser policy engine | Add browser-based network assertions later |
| `.html`, `.htm`, `.md` input and 16 MiB rendered cap | Strong local parity | Renderer accepts only supported sources and enforces size | None for local mode | Keep covered by verification |
| Admin disable and role-scoped creation | Strong local parity | Config/env/admin controls can block publishing | No enterprise policy sync | Map to hosted org settings later |
| Retention and audit trail | Strong local parity | Admin cleanup and audit event records exist | No managed export pipeline | Add export format when cloud mode exists |
| Compliance list, version retrieval, delete | Behavioral approximation | `/v1/compliance/code/artifacts` endpoints exist with pagination/status filtering | Response shape is compatible in spirit, not a guaranteed Anthropic clone | Keep response additive and documented |
| Public sharing and remix | Experimental/non-Claude Code | Optional public audience and `remix` create copied artifacts | Claude Code Team/Enterprise parity does not require this | Keep disabled-by-default in positioning |
| Hosted private HTTPS links | Missing hosted enterprise layer | Hosted base URL can be configured for generated links | No deployment, storage, auth, or HTTPS service included | Choose Vercel/Render/Fly/Railway/VPS before implementing |
| SSO, SCIM, enterprise identity, policy sync | Missing hosted enterprise layer | Local users only | Requires real identity provider integration | Defer until hosted mode |

## Status Legend

- `Strong local parity`: behavior is implemented and verified for localhost/private local use.
- `Behavioral approximation`: the same workflow exists with local accounts or local storage rather than Claude organization infrastructure.
- `Experimental/non-Claude Code`: useful artifact behavior inspired by broader artifact products, but not required for Claude Code Team/Enterprise parity.
- `Missing hosted enterprise layer`: requires hosted infrastructure, real identity, managed storage, or enterprise integrations.

## Current Read

The project is strong local functional parity for Claude Code Artifacts. The remaining gap is not artifact mechanics; it is production hosting and enterprise identity. Public/remix behavior is deliberately marked as an optional extension so the primary clean-room target stays Claude Code Artifacts rather than Claude.ai marketplace behavior.

## Test-Learned Fixes

- Fixed shell/user DOM ID collision by prefixing artifact shell controls with `codexArtifact`.
- Fixed full HTML input handling so artifact content does not nest a complete HTML document inside another shell.
- Fixed summary extraction so CSS and JavaScript are ignored in favor of readable title, heading, or paragraph text.
- Added the Codex plugin template to the repository instead of keeping it only in the local personal plugin folder.

Not affiliated with Anthropic.
