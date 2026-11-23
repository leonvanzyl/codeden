---
section: fixed
---

- **An old `claude` or `codex` left on PATH no longer hides the current one.** With an outdated copy in `/usr/local/bin` (a leftover npm global install) and a current one in `~/.local/bin`, CodeDen took the first copy that ran, so setup showed "Could not read the Claude login state" or "Not signed in to Codex" for a CLI that was signed in. It now keeps looking when a copy is older than the provider's minimum version and uses the first supported one, for the setup checks and for sessions alike, from a runner's first session and model list on (Gemini CLI and OpenCode too). When only an old copy exists, setup says so and names the file ("Claude Code 2.0.8 is older than 2.1.250; update it") instead of offering Sign in, and no longer asks that copy for its login state, which an old `claude` answered with a model call (#561).
