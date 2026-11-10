# Usage and costs

CodeDen keeps a ledger of every turn's usage across every provider, project and kind of work, and turns it into reports you can trust: each figure says where it came from.

Open **Usage** in the sidebar.

![The usage report](images/usage-reports.png)

## The ledger

Every turn records a **usage delta**, computed from the provider's own numbers (Claude reports cumulative session totals, so CodeDen stores the per-turn difference; OpenCode reports every model call with its tokens and cost, so a turn is their sum, subagents included):

- input, output, cache-read and cache-write tokens, and reasoning tokens where reported;
- cost in USD;
- the session, project, provider, model, role (orchestrator, PM or agent), who started it, the automation (if any) and the time.

The ledger lives in your local database, never anywhere else.

## Honest cost labels

| Label | Means |
|---|---|
| **Reported** | The provider returned a USD cost for the turn |
| **Estimated** (shown with ≈) | Tokens multiplied by the price table for that model |
| **API-equivalent** | You're on a subscription login (claude.ai or ChatGPT): this is what the same work would cost on API credits, not what you're billed |

The billing mode comes from how each CLI reports its login: API keys and console accounts are pay-per-token; claude.ai and ChatGPT logins are subscriptions. OpenCode reports how each of its providers is connected (API key, OAuth, environment).

### The price table

CodeDen bundles list prices for current Claude and OpenAI models, taken from the providers' pricing pages. Open **Prices** on the Usage page to see them and to add or override a model's price; your entries win over the bundled table. Turns whose model has no price and no reported cost are counted as **unpriced**, so a missing price never hides spend silently.

OpenCode usually reports each turn's cost itself. When it doesn't (OpenCode's free models, or a provider it has no prices for), OpenCode model ids such as `anthropic/claude-opus-5-5` and `openai/gpt-5.5` are priced from the Claude and OpenAI rows; other vendors' models are unpriced unless you add a price for the full id under provider `opencode`.

## Reports

- **Range:** today, 7, 30 or 90 days, or a custom range, in your timezone.
- **Totals:** cost, tokens, cache hit rate, average cost per session and per merged PR.
- **Daily spend chart**, stacked by **provider**, **model**, **project**, **role** or **started by**, in cost or tokens. **Click a bar** to drill into the sessions behind it.
- **Breakdown table** for the chosen dimension: share of spend, cost, tokens, turns and sessions.
- **Top sessions** by cost.
- **Automation and factory spend**, per automation.
- **Export CSV** of the ledger rows in range.

### In context

- Each **session header** shows its cost and tokens; each **turn footer** shows what that turn took.
- Each **project page** has a spend card (today, 7 days, this month).
- The **factory budget meter** reads from the same ledger, so the factory's limits and your reports always agree.

## Rate limits

CodeDen records each provider's limit status as the provider reports it: Claude's 5-hour and weekly windows, and Codex's rate-limit snapshots. The Usage page shows how much of each window is used and when it resets. When a window reaches **85%** (configurable) you get an inbox item, before you hit the wall.

## Budgets and alerts

Add budgets on the Usage page:

- **Daily** or **monthly**, for **all projects** or one project, in USD.
- A **warning** share (default 80%) and the limit itself. Crossing either raises an inbox item and a notification, once per budget and period.

Budgets are alerts; they don't stop work. To hard-stop autonomous work on spend, use the [factory's daily budget](autonomy-and-dark-factory.md#limits).

## Where it's stored

| | |
|---|---|
| Ledger | `~/.codeden/codeden.db` |
| Prices, budgets, warning level, timezone | `~/.codeden/usage-settings.json` |

## API

The local API (install token as a bearer token) exposes the same data: `GET /api/usage/report?from=YYYY-MM-DD&to=YYYY-MM-DD` (optional `projectId`, `provider`, `model`, `role`), `GET /api/usage/export.csv`, `GET /api/usage/limits`, `GET /api/usage/budgets`, and `GET` / `PUT /api/usage/settings`.
