import { TechDebtAction, type TechDebtFinding } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";

const labels: Record<TechDebtFinding["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  fixed: "Fixed",
  dismissed: "Dismissed",
};

export function TechDebtPanel({ projectId }: { projectId: string }) {
  const { techDebt } = useClient();
  const cache = useQueryClient();
  const queryKey = ["tech-debt", projectId];
  const query = useQuery({ queryKey, queryFn: () => techDebt.list(projectId) });
  const [selected, setSelected] = useState<string[]>([]);
  const [dismiss, setDismiss] = useState<string | null>(null);
  const [error, setError] = useState("");
  const update = useMutation({
    mutationFn: (action: TechDebtAction) => techDebt.act(projectId, action),
    onSuccess: (view, action) => {
      cache.setQueryData(queryKey, view);
      if (action.action === "fix") setSelected([]);
      if (action.action === "dismiss") setDismiss(null);
      if (action.action === "configure" || action.action === "fix") {
        return cache.invalidateQueries({ queryKey });
      }
    },
  });
  const submit = (value: unknown) => {
    const parsed = TechDebtAction.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid tech debt update");
      return;
    }
    setError("");
    update.mutate(parsed.data);
  };
  const view = query.data;
  const ids =
    view?.findings.filter((f) => f.status === "open" && selected.includes(f.id)).map((f) => f.id) ??
    [];

  return (
    <section aria-label="Tech debt" className="space-y-5">
      {query.isPending && <p role="status">Loading tech debt…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {(error || update.error) && <p role="alert">{error || update.error?.message}</p>}
      {update.data?.syncError && <p role="alert">{update.data.syncError}</p>}
      {view && (
        <>
          <form
            key={view.issue ?? ""}
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const issue = String(new FormData(event.currentTarget).get("issue") ?? "").trim();
              submit({ action: "configure", issue: issue || null });
            }}
          >
            <label className="text-sm" htmlFor="tech-debt-issue">
              Tracking issue
              <Input
                id="tech-debt-issue"
                name="issue"
                placeholder="owner/repo#123"
                defaultValue={view.issue ?? ""}
              />
            </label>
            <Button size="sm" type="submit" variant="outline" disabled={update.isPending}>
              Save issue
            </Button>
          </form>
          {view.importError && (
            <div className="flex items-center gap-2">
              <p role="alert">{view.importError}</p>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                Retry import
              </Button>
            </div>
          )}
          <Button
            size="sm"
            disabled={!ids.length || update.isPending}
            onClick={() => submit({ action: "fix", ids })}
          >
            Fix selected{ids.length > 0 && ` (${ids.length})`}
          </Button>
          {view.findings.length === 0 && (
            <p className="text-sm text-muted-foreground">No LOW findings.</p>
          )}
          <ul className="divide-y divide-border rounded-md border border-border empty:hidden">
            {view.findings.map((finding) => (
              <li key={finding.id} className="space-y-2 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {finding.status === "open" && (
                    <input
                      type="checkbox"
                      aria-label={`Select finding at ${finding.location}`}
                      checked={selected.includes(finding.id)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) =>
                          checked
                            ? [...current, finding.id]
                            : current.filter((id) => id !== finding.id),
                        );
                      }}
                    />
                  )}
                  <code className="break-all">{finding.location}</code>
                  <span className="text-muted-foreground">{labels[finding.status]}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{finding.text}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 break-all text-xs text-muted-foreground">
                  <time dateTime={finding.date}>{finding.date.slice(0, 10)}</time>
                  <span>PR {finding.pr ?? "—"}</span>
                  <span>Receipt {finding.receipt ?? "—"}</span>
                  {finding.sessionId && (
                    <Link
                      className="underline"
                      to="/sessions/$sessionId"
                      params={{ sessionId: finding.sessionId }}
                    >
                      Fix session
                    </Link>
                  )}
                </div>
                {finding.reason && <p className="break-words">{finding.reason}</p>}
                {(finding.status === "open" || finding.status === "in_progress") && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={update.isPending}
                      onClick={() => submit({ action: "fixed", id: finding.id })}
                    >
                      Mark fixed
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={update.isPending}
                      onClick={() => setDismiss(finding.id)}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
                {dismiss === finding.id && (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit({
                        action: "dismiss",
                        id: finding.id,
                        reason: new FormData(event.currentTarget).get("reason"),
                      });
                    }}
                  >
                    <label htmlFor="tech-debt-reason">
                      Dismissal reason
                      <Input id="tech-debt-reason" name="reason" required maxLength={1000} />
                    </label>
                    <Button size="sm" type="submit" disabled={update.isPending}>
                      Confirm dismissal
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setDismiss(null)}
                    >
                      Cancel
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer">Record a LOW finding</summary>
            <form
              className="mt-2 flex max-w-xl flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                submit({
                  action: "record",
                  finding: {
                    location: data.get("location"),
                    text: data.get("text"),
                    receipt: String(data.get("receipt") ?? "").trim() || null,
                    date: `${data.get("date")}T00:00:00.000Z`,
                    pr: String(data.get("pr") ?? "").trim() || null,
                  },
                });
              }}
            >
              <label htmlFor="tech-debt-location">
                File and line
                <Input
                  id="tech-debt-location"
                  name="location"
                  placeholder="src/file.ts:12"
                  required
                  maxLength={500}
                />
              </label>
              <label htmlFor="tech-debt-text">
                Finding
                <Textarea id="tech-debt-text" name="text" required maxLength={4000} />
              </label>
              <label htmlFor="tech-debt-receipt">
                Receipt
                <Input id="tech-debt-receipt" name="receipt" maxLength={1000} />
              </label>
              <label htmlFor="tech-debt-date">
                Date
                <Input
                  id="tech-debt-date"
                  name="date"
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  required
                />
              </label>
              <label htmlFor="tech-debt-pr">
                PR
                <Input id="tech-debt-pr" name="pr" maxLength={500} />
              </label>
              <Button size="sm" type="submit" className="self-start" disabled={update.isPending}>
                Record finding
              </Button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
