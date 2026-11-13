---
section: added
---

- **Turn off `CI=true` for a project's agents.** **Settings → General → Agent environment** has a switch per project, on by default. Turn it off when a project's tools misbehave under CI (Playwright not reusing your running dev server, Yarn refusing to update the lockfile, builds failing on warnings): agent sessions opened after that run without `CI` added. pnpm may then ask again before reinstalling `node_modules`, so set `confirmModulesPurge: false` in that project's `pnpm-workspace.yaml`. The orchestrator can change it too (`update_project`).
