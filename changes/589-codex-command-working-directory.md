---
section: fixed
---

- **Codex commands run from a subfolder no longer ask for paths inside the worktree.** A command Codex ran from `<worktree>/frontend` with a relative path such as `> ../proof.log` was judged as if it ran from the worktree root, so the path pointed one level above the worktree and asked at every level, Full included ("Writes CodeDen's own home" when the worktree sits in CodeDen's home). Relative paths in a Codex command now resolve from the folder it runs in, as the shell resolves them. A path that still lands outside the worktree asks as before, and a relative path from a working folder outside the worktree now asks (see Security).
