# Claude Code Artifacts Parity

Codex Artifacts is a clean-room, local-first recreation of the public Claude Code Artifacts workflow for Codex. It targets functional parity, not Anthropic branding, prompts, private code, or hosted infrastructure.

## Parity Matrix

| Claude feature | Current Codex status | Evidence | Gap | Next action |
| --- | --- | --- | --- | --- |
| Publish a Code session artifact as a private page | Matched locally | `publish` and `publish-session` create authenticated artifact pages | No native Codex app hook | Add deeper Codex app session ingestion later |
| Stable share URL that updates in place | Matched locally | Updates create new versions while share URL stays stable | None for local mode | Keep covered by verification |
| Latest-version and pinned-version sharing | Matched locally | Share settings support latest or a selected version | None for local mode | Keep covered by verification |
| Organization-only private sharing | Local equivalent | Seeded local org/users and authenticated share routes | No real Team/Enterprise identity | Add hosted auth/SSO only after deploy target exists |
| Gallery with metadata | Matched locally | Mine, shared, recent, deleted groups plus author/time/share metadata | UI is local and intentionally not Anthropic-branded | Polish UX without copying Claude pixels |
| Single-page artifact with strict sandboxing | Matched locally | Rendered HTML is served in a sandboxed iframe with CSP | Browser-specific hardening can always improve | Keep security regression tests broad |
| No external requests from artifact content | Matched locally | External `src`, `href`, CSS imports, fetch/XHR/WebSocket/EventSource are blocked | Static validation is conservative, not a browser policy engine | Add browser-based network assertions later |
| `.html`, `.htm`, `.md` input and 16 MiB rendered cap | Matched locally | Renderer accepts only supported sources and enforces size | None for local mode | Keep covered by verification |
| Admin disable and role-scoped creation | Matched locally | Config/env/admin controls can block publishing | No enterprise policy sync | Map to hosted org settings later |
| Retention and audit trail | Matched locally | Admin cleanup and audit event records exist | No managed export pipeline | Add export format when cloud mode exists |
| Compliance list, version retrieval, delete | Mostly matched locally | `/v1/compliance/code/artifacts` endpoints exist with pagination/status filtering | Response shape is compatible in spirit, not a guaranteed Anthropic clone | Keep response additive and documented |
| Public sharing and remix | Experimental/non-Claude Code | Optional public audience and `remix` create copied artifacts | Claude Code Team/Enterprise parity does not require this | Keep disabled-by-default in positioning |
| Hosted private HTTPS links | Missing cloud/enterprise | Hosted base URL can be configured for generated links | No deployment, storage, auth, or HTTPS service included | Choose Vercel/Render/Fly/Railway/VPS before implementing |
| SSO, SCIM, enterprise identity, policy sync | Missing cloud/enterprise | Local users only | Requires real identity provider integration | Defer until hosted mode |

## Status Legend

- `Matched locally`: behavior is implemented and verified for localhost/private local use.
- `Local equivalent`: the same workflow exists with local accounts or local storage rather than Claude organization infrastructure.
- `Experimental/non-Claude Code`: useful artifact behavior inspired by broader artifact products, but not required for Claude Code Team/Enterprise parity.
- `Missing cloud/enterprise`: requires hosted infrastructure, real identity, managed storage, or enterprise integrations.

## Current Read

The project is strong local functional parity for Claude Code Artifacts. The remaining gap is not artifact mechanics; it is production hosting and enterprise identity. Public/remix behavior is deliberately marked as an optional extension so the primary clean-room target stays Claude Code Artifacts rather than Claude.ai marketplace behavior.

Not affiliated with Anthropic.
