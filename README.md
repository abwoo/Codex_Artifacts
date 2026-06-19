# Codex Artifacts

A local, clean-room recreation of Claude Code Artifacts for Codex.

```powershell
npm install
npm run build
.\artifact.cmd serve
```

Codex Artifacts gives you private local links, live updates, pinned versions, a gallery, sandboxed rendering, and local organization permissions.

See `docs/PARITY.md` for the Claude Code Artifacts parity checklist and `docs/STRUCTURE.md` for the repository layout.

## Codex plugin

The reusable plugin template lives in `plugins/codex-artifacts`. A personal install can be placed at `C:\Users\13803\plugins\codex-artifacts` with marketplace metadata at `C:\Users\13803\.agents\plugins\marketplace.json`.

Validate it with:

```powershell
python C:\Users\13803\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\codex-artifacts
```

Not affiliated with Anthropic.
