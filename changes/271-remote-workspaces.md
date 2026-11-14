---
section: added
---

- **Workspaces for runners in a sandbox.** A runner that doesn't share the server's disk now clones the project into a folder it chooses, instead of being handed paths on the server's machine. Its files reach the server through the runner itself: the files panel, diffs, `share_to_chat`, `attach_evidence`, `generate_image` and browser screenshots never read its folder from the server's disk. Clones, fetches and pushes on such a runner get your GitHub token for that one git operation. The token is never stored in the sandbox, its git config, the runner's journal or any log. A session whose folder is gone now says so (`cwd_missing`) instead of failing with `spawn ENOENT`. With only the local runner, sessions work as before. This is the third step towards running agents in Docker containers and Upstash Boxes.
