# Project Structure

This repository keeps the Node service as the primary implementation and the older PowerShell prototype as legacy reference material.

| Area | Purpose |
| --- | --- |
| Root files | Project metadata, license, TypeScript config, and the Windows CLI shim |
| `src/bin` | Thin executable entrypoints for the CLI and web service |
| `src/cli` | Command parsing and CLI workflow orchestration |
| `src/server` | HTTP routes, Web UI, auth checks, sharing, admin, retention, and compliance APIs |
| `src/artifacts` | Markdown/HTML rendering, templates integration, size limits, and artifact safety validation |
| `src/core` | Shared types, SQLite/sql.js setup, seeded org/users, config paths, and audit helpers |
| `src/testing` | End-to-end parity verification script |
| `src/types` | Local TypeScript declarations |
| `templates` | Built-in artifact page shell and starter content types |
| `docs` | Public documentation for parity and repository layout |
| `examples` | Small input files for manual artifact updates |
| `plugins` | Reusable Codex plugin template for installing this tool into Codex |
| `scripts` | Legacy PowerShell MVP compatibility scripts |

Generated local state stays out of git: databases, rendered artifacts, build output, local config, local sessions, and dependencies.
