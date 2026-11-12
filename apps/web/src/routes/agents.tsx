import { providersWith } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { HooksList } from "@/components/agents/hooks-list";
import { McpServers } from "@/components/agents/mcp-servers";
import { MemoryEditor, SkillsView, SubagentsView } from "@/components/agents/memory-editor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

const GLOBAL = "global";

export type AgentTab = "memory" | "skills" | "subagents" | "mcp" | "hooks";
/** The tabs on offer; Hooks only when some provider's native config has hooks. */
export const AGENT_TABS: { id: AgentTab; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "subagents", label: "Subagents" },
  { id: "mcp", label: "MCP servers" },
  ...(providersWith("hooks").length > 0 ? [{ id: "hooks" as const, label: "Hooks" }] : []),
];

/** Agent configuration (§12.4): each provider's native files, edited in place. */
export function AgentsPage({ tab, projectId }: { tab: AgentTab; projectId: string | null }) {
  const navigate = useNavigate();
  const projects = useSnapshotData((s) => s.projects, []);
  // `?project=global` keeps "Global only" selected; no param means the first project.
  const scope =
    projectId === GLOBAL
      ? null
      : (projects.find((p) => p.id === projectId)?.id ?? projects[0]?.id ?? null);
  const go = (next: { tab?: AgentTab; project?: string | null }) =>
    void navigate({
      to: "/agents",
      search: {
        tab: next.tab ?? tab,
        project: next.project === undefined ? (scope ?? GLOBAL) : (next.project ?? GLOBAL),
      },
      replace: true,
    });

  return (
    <>
      <PageHeader
        icon={<SlidersHorizontal />}
        title="Agent configuration"
        meta="Native files are the source of truth — edits show up in the CLI too"
        actions={
          <Select
            value={scope ?? "global"}
            onValueChange={(v) => go({ project: v === "global" ? null : v })}
          >
            <SelectTrigger size="sm" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Global only</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-6">
        <div className="mb-4 flex items-center gap-1 border-b border-border">
          {AGENT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go({ tab: t.id })}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
                tab === t.id ? "border-primary text-foreground" : "border-transparent",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "memory" && <MemoryEditor projectId={scope} />}
        {tab === "skills" && <SkillsView projectId={scope} />}
        {tab === "subagents" && <SubagentsView projectId={scope} />}
        {tab === "mcp" && (
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <div className="mx-auto max-w-4xl">
              <McpServers projectId={scope} />
            </div>
          </div>
        )}
        {tab === "hooks" && (
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            <div className="mx-auto max-w-4xl">
              <HooksList projectId={scope} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
