---
section: fixed
---

- **Codex sessions no longer refuse MCP tools behind your back.** Codex asks before it runs one of your MCP tools that isn't marked read-only, and CodeDen used to decline every such request without showing it. Now it is decided like any other tool call: approved under **Auto** and **Full** (recorded in the transcript), shown as an approval card naming the server, the tool and its arguments under **Supervised**, and refused under **Read-only**.
  - When an MCP server asks you to fill in a form, you get a question card built from the form's fields, and your answers go back to the server. Optional fields can be left empty, and **Dismiss** sends the server nothing. In sessions nobody is watching (started by an automation, a PM or the factory), an unanswered form is withdrawn on the same terms as an approval is denied, so the run never waits forever.
  - When a server asks you to open a link (to sign in, say), the card shows the link for you to open. CodeDen never opens it for you.
  - Approval cards for tools now show the tool's arguments, for Claude sessions too.
