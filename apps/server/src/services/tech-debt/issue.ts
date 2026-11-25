import { createHash } from "node:crypto";
import { type TechDebtFinding, TechDebtFindingInput } from "@codeden/contracts";
import { badRequest, conflict } from "../errors";
import type { GithubClient } from "../github/client";

export interface TechDebtIssuePort {
  read(issue: string): Promise<{ body: string; date: string }>;
  write(issue: string, body: string): Promise<void>;
}

function issueParams(issue: string) {
  const [slug = "", number] = issue.split("#");
  const [owner = "", repo = ""] = slug.split("/");
  return { owner, repo, issue_number: Number(number) };
}

export function techDebtIssuePort(client: GithubClient): TechDebtIssuePort {
  return {
    read: (issue) =>
      client.run(async (octokit) => {
        const { data } = await octokit.rest.issues.get(issueParams(issue));
        if (data.pull_request) throw badRequest("The tech debt reference must be an issue");
        return { body: data.body ?? "", date: data.created_at };
      }),
    write: (issue, body) =>
      client.run(async (octokit) => {
        await octokit.rest.issues.update({ ...issueParams(issue), body });
      }),
  };
}

export function debtId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const tick = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)/;
const localMarker = / <!-- codeden:tech-debt ([a-f0-9]{64}) -->$/;
const low = /^(?:\*\*LOW\*\*|\[LOW\]|LOW)\s*[:–—-]?\s*`?([^\s`]+:\d+)`?\s*[:–—-]?\s+(.+)$/i;

function parseLine(line: string, issue: string, date: string): TechDebtFinding | undefined {
  const checkbox = tick.exec(line);
  if (!checkbox) return;
  const content = line.slice(checkbox[0].length).trim();
  const marker = localMarker.exec(content);
  const match = low.exec(content.replace(localMarker, ""));
  if (!match) return;
  const [text, ...fields] = (match[2] ?? "").split(/\s+\|\s+(?=(?:receipt|date|pr):)/i);
  const metadata = new Map(
    fields.map((field) => {
      const colon = field.indexOf(":");
      return [field.slice(0, colon).toLowerCase(), field.slice(colon + 1).trim()];
    }),
  );
  const givenDate = metadata.get("date") ?? date;
  const parsed = TechDebtFindingInput.safeParse({
    location: match[1],
    text,
    receipt: metadata.get("receipt") || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(givenDate) ? `${givenDate}T00:00:00.000Z` : givenDate,
    pr: metadata.get("pr") || null,
  });
  if (!parsed.success) return;
  return {
    ...parsed.data,
    id: marker?.[1] ?? debtId(`${issue.toLowerCase()}\n${content}`),
    source: issue,
    status: checkbox[2] === " " ? "open" : "fixed",
    reason: null,
    sessionId: null,
  };
}

export function issueFindings(issue: string, body: string, date: string): TechDebtFinding[] {
  return body.split(/\r?\n/).flatMap((line) => parseLine(line, issue, date) ?? []);
}

/** Update the selected checkbox on the fresh issue body, retaining other lines and line endings. */
export async function syncDebtTick(
  port: TechDebtIssuePort,
  issue: string,
  finding: TechDebtFinding,
) {
  const { body, date } = await port.read(issue);
  const writeIfUnchanged = async (next: string) => {
    if ((await port.read(issue)).body !== body) {
      throw conflict("The tracking issue changed during synchronization");
    }
    await port.write(issue, next);
  };
  let found = false;
  const next = body
    .split(/(\r?\n)/)
    .map((line) => {
      const id = finding.source ? parseLine(line, issue, date)?.id : localMarker.exec(line)?.[1];
      if (id !== finding.id || !tick.test(line)) return line;
      found = true;
      return line.replace(tick, "$1x$3");
    })
    .join("");
  if (found) {
    if (next !== body) await writeIfUnchanged(next);
    return;
  }
  if (finding.source) throw conflict("The tracking issue entry changed or was removed");
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const prefix = body ? `${body}${body.endsWith(newline) ? "" : newline}${newline}` : "";
  const line = [
    `- [x] LOW \`${inline(finding.location)}\` — ${inline(finding.text)}`,
    ...(finding.receipt ? [` | Receipt: ${inline(finding.receipt)}`] : []),
    ` | Date: ${finding.date}`,
    ...(finding.pr ? [` | PR: ${inline(finding.pr)}`] : []),
    ` <!-- codeden:tech-debt ${finding.id} -->`,
  ].join("");
  await writeIfUnchanged(`${prefix}${line}${newline}`);
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[&<>`@|]/g, (char) => `&#${char.charCodeAt(0)};`);
}
