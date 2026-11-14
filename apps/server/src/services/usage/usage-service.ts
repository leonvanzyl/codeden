import {
  type BillingMode,
  type BudgetStatus,
  type BudgetsResponse,
  type InboxItem,
  type ProjectSpend,
  type RateLimitsResponse,
  type RateLimitWindow,
  type SessionUsage,
  type UsageQuery,
  type UsageReport,
  UsageSettings,
  type UsageSettingsInit,
  type UsageSettingsResponse,
} from "@codeden/contracts";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../../db/client";
import { automations, githubPrs, inboxItems, projects, sessions } from "../../db/schema";
import { rateLimitWindows, usageLedger } from "../../db/schema-usage";
import type { EventStore } from "../../events/store";
import { writeJsonFile } from "../../json-file";
import { loadUserJsonFile } from "../../user-json-file";
import { badRequest } from "../errors";
import { FILE_RESET_NOTICES, reportFileReset } from "../file-reset-notice";
import {
  addDays,
  dayKey,
  type LedgerRow,
  type PricedRow,
  priceRows,
  totalsOf,
  utcWindow,
} from "./aggregate";
import {
  type AlertSpec,
  budgetAlerts,
  budgetStatus,
  periodStart,
  rateLimitAlerts,
  toWindow,
} from "./alerts";
import { backfillUsageLedger } from "./backfill";
import { BUNDLED_PRICES } from "./prices";
import { buildReport, type ReportNames, toCsv } from "./report";
import { subagentCosts } from "./subagents";

export interface UsageServiceOptions {
  db: Db;
  store: EventStore;
  /** `usage-settings.json` in the data directory. */
  settingsFile: string;
  /** How each provider is paid for (from login detection). */
  billing?: () => Promise<Record<string, BillingMode>>;
  /** Delay before checking budgets and limits after usage arrives (default 1.5 s). */
  alertDelayMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** Usage and cost reports, budgets and rate-limit alerts (§12.6), over the usage ledger. */
export class UsageService {
  private alertTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private cachedSettings: UsageSettings | undefined;

  constructor(private readonly opts: UsageServiceOptions) {}

  /** Backfill turns from before the ledger, then watch usage for budgets and limits. */
  start(): void {
    const added = backfillUsageLedger(this.opts.db);
    if (added > 0) this.opts.log?.(`usage: backfilled ${added} turns into the ledger`);
    this.unsubscribe = this.opts.store.subscribe((batch) => {
      if (batch.some((e) => e.type === "agent.usage.updated")) this.scheduleAlerts();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.alertTimer) clearTimeout(this.alertTimer);
  }

  // ---------------------------------------------------------------- settings

  settings(): UsageSettings {
    if (!this.cachedSettings) {
      // A broken file is kept as a copy before the next save can overwrite the user's budgets.
      const { value, reset } = loadUserJsonFile(this.opts.settingsFile, UsageSettings);
      const { store, log } = this.opts;
      if (reset) reportFileReset(reset, FILE_RESET_NOTICES.usageSettings, { store, log });
      this.cachedSettings = value;
    }
    return this.cachedSettings;
  }

  settingsResponse(): UsageSettingsResponse {
    return { settings: this.settings(), bundledPrices: BUNDLED_PRICES };
  }

  saveSettings(input: UsageSettingsInit): UsageSettingsResponse {
    const parsed = UsageSettings.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid settings");
    const ids = parsed.data.budgets.map((b) => b.id);
    if (new Set(ids).size !== ids.length) throw badRequest("Budget ids must be unique");
    this.settings(); // Load first: a broken file on disk is kept as a copy before this write.
    writeJsonFile(this.opts.settingsFile, parsed.data);
    this.cachedSettings = parsed.data;
    this.scheduleAlerts();
    return this.settingsResponse();
  }

  timezone(): string {
    return this.settings().timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  today(): string {
    return dayKey(this.now(), this.timezone());
  }

  // ---------------------------------------------------------------- reports

  async report(q: UsageQuery): Promise<UsageReport> {
    if (q.from > q.to) throw badRequest("`from` must not be after `to`");
    const length = Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000) + 1;
    const rows = this.rows(addDays(q.from, -length), q.to);
    return buildReport(rows, q, this.timezone(), this.names(rows), await this.billing());
  }

  csv(q: UsageQuery): string {
    const rows = this.rows(q.from, q.to);
    return toCsv(rows, q, this.names(rows));
  }

  async sessionUsage(sessionId: string): Promise<SessionUsage> {
    const raw = this.opts.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.sessionId, sessionId))
      .all();
    const prices = this.settings().prices;
    const rows = priceRows(raw.map(toLedgerRow), prices, this.timezone());
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    const session = this.opts.db
      .select({ provider: sessions.provider, model: sessions.model })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    const provider = rows[0]?.provider ?? session?.provider;
    const billing = provider ? ((await this.billing())[provider] ?? "unknown") : "unknown";
    return {
      sessionId,
      totals: totalsOf(rows),
      billing,
      turns: rows.map((r) => ({
        turnId: r.turnId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        reasoningTokens: r.reasoningTokens,
        costUsd: r.costUsd,
        costSource: r.costSource,
      })),
      // Display only: what each subagent cost, for its card (§7.3); never part of the totals.
      subagents: session ? subagentCosts(this.opts.db, sessionId, session, prices) : [],
    };
  }

  async projectSpend(projectId: string): Promise<ProjectSpend> {
    const today = this.today();
    const first = addDays(today, -13);
    const monthStart = periodStart("monthly", today);
    const from = [monthStart, first].sort()[0] ?? first;
    const rows = this.rows(from, today).filter((r) => r.projectId === projectId);
    const sumWhere = (pred: (r: PricedRow) => boolean) =>
      round(rows.filter(pred).reduce((a, r) => a + r.costUsd, 0));
    const daily = Array.from({ length: 14 }, (_, i) => addDays(first, i)).map((d) =>
      sumWhere((r) => r.day === d),
    );
    const byModel = new Map<string, number>();
    for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.costUsd);
    const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const billing = await this.billing();
    return {
      projectId,
      todayUsd: sumWhere((r) => r.day === today),
      last7Usd: sumWhere((r) => r.day >= addDays(today, -6)),
      monthUsd: sumWhere((r) => r.day >= monthStart),
      estimated: rows.some((r) => r.costSource !== "reported"),
      dailyUsd: daily,
      topModel,
      budgets: this.budgetStatuses().filter((b) => b.budget.projectId === projectId),
      billing: Object.fromEntries(
        [...new Set(rows.map((r) => r.provider))].map((p) => [p, billing[p] ?? "unknown"]),
      ),
    };
  }

  /**
   * Spend (USD) and tokens since a local day, for a project or everything, optionally only of
   * some sessions (factory limits).
   */
  spendSince(
    day: string,
    projectId?: string,
    sessionIds?: ReadonlySet<string>,
  ): { usd: number; tokens: number } {
    const rows = this.rows(day, this.today()).filter(
      (r) =>
        r.day >= day &&
        (!projectId || r.projectId === projectId) &&
        (!sessionIds || sessionIds.has(r.sessionId)),
    );
    const t = totalsOf(rows);
    return {
      usd: t.costUsd,
      tokens: t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
    };
  }

  /** The latest reading of every provider's rate-limit windows (the factory's availability). */
  rateLimitWindows(): RateLimitWindow[] {
    const now = this.now();
    return this.opts.db
      .select()
      .from(rateLimitWindows)
      .all()
      .map((r) => toWindow(r, now))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.windowId.localeCompare(b.windowId));
  }

  async limits(): Promise<RateLimitsResponse> {
    return {
      windows: this.rateLimitWindows(),
      warnPercent: this.settings().rateLimitWarnPercent,
      billing: await this.billing(),
    };
  }

  budgets(): BudgetsResponse {
    return { budgets: this.budgetStatuses() };
  }

  /** Raise inbox items for budgets and rate-limit windows that crossed their thresholds. */
  async checkAlerts(): Promise<InboxItem[]> {
    const names = new Map(
      this.opts.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .all()
        .map((p) => [p.id, p.name]),
    );
    const specs = [
      ...budgetAlerts(this.budgetStatuses(), (id) => names.get(id) ?? "Project"),
      ...rateLimitAlerts((await this.limits()).windows, this.settings().rateLimitWarnPercent),
    ];
    return this.raise(specs);
  }

  // ---------------------------------------------------------------- internals

  private budgetStatuses(): BudgetStatus[] {
    const today = this.today();
    const budgets = this.settings().budgets;
    if (budgets.length === 0) return [];
    const rows = this.rows(periodStart("monthly", today), today);
    return budgets.map((b) => {
      const start = periodStart(b.period, today);
      const spent = rows
        .filter((r) => r.day >= start && (!b.projectId || r.projectId === b.projectId))
        .reduce((a, r) => a + r.costUsd, 0);
      return budgetStatus(b, spent, start);
    });
  }

  private raise(specs: AlertSpec[]): InboxItem[] {
    if (specs.length === 0) return [];
    const existing = new Set(
      this.opts.db
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(
          inArray(
            inboxItems.id,
            specs.map((s) => s.id),
          ),
        )
        .all()
        .map((r) => r.id),
    );
    const now = new Date(this.now()).toISOString();
    const items: InboxItem[] = specs
      .filter((s) => !existing.has(s.id))
      .map((s) => ({
        id: s.id,
        kind: "message",
        status: "open",
        priority: s.priority,
        // A budget alert: the user decides whether to keep spending.
        notify: "needs_you",
        title: s.title,
        body: s.body,
        projectId: s.projectId,
        sessionId: null,
        threadId: null,
        itemId: null,
        requestId: null,
        issue: null,
        pr: null,
        automationRunId: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolution: null,
      }));
    if (items.length > 0) {
      this.opts.store.append(
        items.map((item) => ({ type: "inbox.created", sessionId: null, payload: { item } })),
      );
    }
    return items;
  }

  private scheduleAlerts(): void {
    if (this.alertTimer) return;
    this.alertTimer = setTimeout(() => {
      this.alertTimer = undefined;
      this.checkAlerts().catch((error: unknown) =>
        this.opts.log?.(`usage: alert check failed: ${String(error)}`),
      );
    }, this.opts.alertDelayMs ?? 1500);
    this.alertTimer.unref?.();
  }

  /** Priced ledger rows whose local day may fall between `from` and `to`. */
  private rows(from: string, to: string): PricedRow[] {
    const { start, end } = utcWindow(from, to);
    const raw = this.opts.db
      .select()
      .from(usageLedger)
      .where(and(gte(usageLedger.ts, start), lt(usageLedger.ts, end)))
      .all();
    return priceRows(raw.map(toLedgerRow), this.settings().prices, this.timezone());
  }

  private names(rows: PricedRow[]): ReportNames {
    const db = this.opts.db;
    const projectNames = new Map(
      db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .all()
        .map((p) => [p.id, p.name]),
    );
    const automationNames = new Map(
      db
        .select({ id: automations.id, name: automations.name })
        .from(automations)
        .all()
        .map((a) => [a.id, a.name]),
    );
    const ids = [...new Set(rows.map((r) => r.sessionId))];
    const sessionRows = ids.length
      ? db.select().from(sessions).where(inArray(sessions.id, ids)).all()
      : [];
    const info = new Map(
      sessionRows.map((s) => [s.id, { title: s.title ?? s.purpose, pr: s.pr ?? null }]),
    );
    const merged = new Set(sessionRows.filter((s) => s.pr?.state === "merged").map((s) => s.id));
    // PR state synced from GitHub wins when the session row has not caught up yet.
    const syncedMerged = ids.length
      ? db
          .select({
            sessionId: githubPrs.sessionId,
            number: githubPrs.number,
            url: githubPrs.url,
            title: githubPrs.title,
          })
          .from(githubPrs)
          .where(and(inArray(githubPrs.sessionId, ids), eq(githubPrs.state, "merged")))
          .all()
      : [];
    for (const r of syncedMerged) {
      if (!r.sessionId) continue;
      merged.add(r.sessionId);
      const known = info.get(r.sessionId);
      // Count the PR by its number even when the session never recorded it.
      if (known && !known.pr) {
        known.pr = { number: r.number, url: r.url, state: "merged", title: r.title };
      }
    }
    return {
      project: (id) => projectNames.get(id) ?? null,
      automation: (id) => automationNames.get(id) ?? null,
      session: (id) => info.get(id) ?? null,
      merged: (id) => merged.has(id),
    };
  }

  private async billing(): Promise<Record<string, BillingMode>> {
    try {
      return (await this.opts.billing?.()) ?? {};
    } catch {
      return {};
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

function toLedgerRow(r: typeof usageLedger.$inferSelect): LedgerRow {
  return {
    sessionId: r.sessionId,
    turnId: r.turnId,
    projectId: r.projectId,
    provider: r.provider,
    model: r.model,
    role: r.role,
    source: r.source,
    automationId: r.automationId,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: r.reasoningTokens,
    reportedCostUsd: r.reportedCostUsd,
    ts: r.ts,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
