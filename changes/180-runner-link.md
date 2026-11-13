---
section: added
---

- **`codeden runner-link`.** A new command that connects its stdin and stdout to the runner in `--home`. The server will start it inside a sandbox, through the sandbox's own command channel (for example `docker exec -i`), to reach a runner there. It needs no network port on either side, and a dropped link costs nothing: the runner keeps working, and the server opens a new link and catches up on everything it missed. Its output carries only protocol messages, with its log on stderr. It exits with code 3 when no runner is running there and 4 when the runner refuses it. With only the local runner nothing changes. This is the second step towards running agents in Docker containers and Upstash Boxes.
