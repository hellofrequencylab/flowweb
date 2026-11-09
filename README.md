# FlowWeb Core

A small, safe control plane for agent work. One daemon, one CLI, SQLite, git and pull requests as the artifact bus, vendor CLIs in headless mode, and a plain local web UI.

Start with `START-HERE-CORE.md` (in the plan folder) and `CORE-SPEC.md`. This repository is built by its own ledger: `CORE-BACKLOG.json` is imported with `pnpm fw ledger sync`, and each row is one PR with one probe.

```
pnpm install --frozen-lockfile
pnpm -r test
pnpm probe devex/workspace-layout     # fails until FW-C-001 is done
```

Tier 0 paths (probes, policy, gates, CI, instructions) are changed only by the Owner. See `AGENTS.md`.
