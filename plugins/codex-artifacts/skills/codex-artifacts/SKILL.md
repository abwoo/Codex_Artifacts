---
name: codex-artifacts
description: Publish, update, open, and share local Codex Artifacts from Codex. Use when the user asks to create an artifact, publish a session artifact, update an artifact page, or open/share an artifact link.
---

# Codex Artifacts

Use this skill when the user asks Codex to create, publish, update, open, or share a local artifact page.

Codex Artifacts is a local-first, clean-room recreation of Claude Code Artifacts for Codex. It uses the local project at `D:\Codex_Artifacts` and the CLI shim `D:\Codex_Artifacts\artifact.cmd`. It is not affiliated with Anthropic.

## Workflow

1. Work from `D:\Codex_Artifacts`.
2. Build the service when needed with `npm run build`.
3. Ensure the service is available at `http://127.0.0.1:4177/health`; if it is not running, start it with `D:\Codex_Artifacts\artifact.cmd serve` or `npm run serve`.
4. Set the CLI user with `D:\Codex_Artifacts\artifact.cmd login --user creator` unless the user requests another seeded user.
5. Publish local HTML or Markdown with `D:\Codex_Artifacts\artifact.cmd publish --title "..." --type dashboard|pr|compare|tune --from <file> --yes`.
6. Use `share`, `open`, `versions`, `update`, `update-url`, and `reopen` for follow-up artifact operations.

## Artifact Requirements

- Prefer self-contained `.html`, `.htm`, or `.md` files.
- Keep CSS and JS inline.
- Do not load external scripts, fonts, images, or network resources.
- Avoid backend calls from artifact content.
- For interactive demos, prefer the `tune` type.

## Safety

Do not copy Anthropic UI, private prompts, private code, or branding. Match public workflow behavior only.
