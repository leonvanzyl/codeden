---
section: fixed
---

- **OpenCode custom models fail with a reason you can act on, and a bare model id no longer runs the wrong model.** A model id without its provider (`Worker` instead of `9router/Worker`) silently ran OpenCode's default model; the session now says the id needs the `<providerID>/<modelID>` form that `opencode run -m` takes. "Model unavailable" no longer counts as a passing failure that CodeDen retries, and it now explains the usual cause: OpenCode lists models per folder and each session runs in its own worktree, so a provider defined in a project `opencode.json` that git doesn't track isn't there. Set it in your global OpenCode config or commit the file. A custom model OpenCode doesn't list is also sent without an effort level, because OpenCode fails the turn on a level the model doesn't offer.
