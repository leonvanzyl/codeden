---
section: added
---

- **Test an MCP server's connection.** Each server on the **Agents → MCP servers** tab has a **Test** button, and so does the add/edit dialog, which tests the values in the form before you save them. CodeDen connects to the server as your agent would, with its command, arguments, environment and headers (and Claude Code's `${VAR}` placeholders), runs the MCP handshake and lists its tools. It then stops the server again. You see whether it connected, the server's name and version, how many tools it offers with their names, and how long it took. If it fails, you see the error and the end of the server's error output. A wrong command, a missing `npx` package, a bad URL or an expired token now shows up here, not as missing tools in your next session.
