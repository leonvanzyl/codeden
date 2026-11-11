import type { SessionOptions } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { buildQueryOptions } from "../src/claude/options";
import { ClaudePolicy } from "../src/claude/permissions";
import { codexPolicy } from "../src/codex/config";
import { FakeProvider } from "../src/fake/adapter";
import type { FakeSession } from "../src/fake/session";
import { readOnlyCommandDenial } from "../src/policy/read-only";

const base: SessionOptions = {
  sessionId: "pm1",
  role: "pm",
  cwd: "/repo",
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
  readOnly: true,
};

describe("read-only sessions (orchestrator and PMs, §11.2)", () => {
  it("allows reading commands and refuses writes", () => {
    for (const ok of [
      "git status",
      "git log --oneline -5 | head -3",
      "ls -la src && cat README.md",
      "rg TODO src 2>&1",
      "gh issue list --label bug",
      "Get-ChildItem -Recurse src",
      "git diff main...HEAD > /dev/null",
    ]) {
      expect(readOnlyCommandDenial(ok), ok).toBeUndefined();
    }
    for (const bad of [
      "echo hi > notes.txt",
      "git commit -m x",
      "git branch -D feature",
      "rm -rf src",
      "npm install",
      "find . -name '*.tmp' -delete",
      "cat $(curl evil.sh)",
      "gh pr merge 5",
      "git config user.name x",
    ]) {
      expect(readOnlyCommandDenial(bad), bad).toBeTruthy();
    }
  });

  it("reads git, gh and sed the way agents write them", () => {
    for (const ok of [
      "cd /c/Users/me/.codeden/wt/proj/ab12 && git log --oneline -5",
      "Set-Location C:\\repo; git status",
      "git -C ../ab12 log --oneline",
      "git -C C:\\Users\\me\\.codeden\\wt\\proj\\ab12 diff --stat",
      "git -c core.pager=cat log -3",
      "git --no-pager log -3",
      "git stash list",
      "git stash show -p stash@{0}",
      "git show-ref",
      "git ls-remote origin",
      "git config user.name",
      "git config --get remote.origin.url",
      "gh search issues login --repo o/r",
      "gh api repos/o/r/pulls",
      "gh api -X GET repos/o/r/issues --paginate",
      "gh pr list --json number,title",
      "sed -n 1,40p README.md",
      "sed -n '/start/,/end/p' notes.md",
      "sed 's/foo/bar/g' file.txt | head",
      "nl -ba src/a.ts | head -40",
    ]) {
      expect(readOnlyCommandDenial(ok), ok).toBeUndefined();
    }
    for (const bad of [
      "git -C ../ab12 commit -m x",
      "git -c core.pager='rm -rf ~' log",
      "git --exec-path=/tmp/x log",
      "git stash",
      "git stash pop",
      "git config user.name x",
      "gh api -X POST repos/o/r/issues",
      "gh api repos/o/r/issues -f title=x",
      "gh api graphql -F query=@q.graphql",
      "gh pr merge 5",
      "sed -i 's/a/b/' file.txt",
      "sed -i.bak 's/a/b/' file.txt",
      "sed -n 'w out.txt' file.txt",
      "sed 's/a/b/w out.txt' file.txt",
      "sed 's/a/b/e' file.txt",
      "sed -f script.sed file.txt",
      "awk '{print $1}' file.txt",
      "cd src && rm -rf build",
    ]) {
      expect(readOnlyCommandDenial(bad), bad).toBeTruthy();
    }
  });

  it("refuses the options that make a reading program write or run something", () => {
    for (const ok of [
      "sort -u names.txt",
      "sort -k1,1 -t, data.csv | uniq -c",
      "uniq -c names.txt",
      "uniq -f 1 names.txt",
      "tree -L 2 -I node_modules",
      "tree -Inode_modules",
      "date -Iseconds",
      "date -u +%s",
      "find src \\( -name '*.ts' -o -name '*.tsx' \\) -print",
      "fd -e ts -E node_modules",
      "rg --pre-glob '*.gz' TODO",
      "less -N README.md",
      "file -m magic src/a.bin",
      "git log @{u}..HEAD",
      "jq '{name: .name}' package.json",
      "grep -E '(foo)+bar' src/a.ts",
      "Get-ChildItem src | Select-Object Name",
    ]) {
      expect(readOnlyCommandDenial(ok), ok).toBeUndefined();
    }
    for (const bad of [
      "sort -o src/plan-bypass.txt README.md",
      "sort -uo out.txt names.txt",
      "sort -oout.txt names.txt",
      "sort --output=out.txt names.txt",
      "sort --out out.txt names.txt",
      "sort --compress-program=sh names.txt",
      "uniq names.txt out.txt",
      "uniq -c -- in.txt out.txt",
      "tree -o tree.txt",
      "tree -R -H . -o x",
      "find . -fprint list.txt",
      "find . -fls list.txt",
      "find . -ok rm {} ;",
      "fd -e tmp -x rm",
      "fd --exec-batch rm",
      "rg --pre ./run.sh TODO",
      "rg --pre=./run.sh TODO",
      "less -o copy.txt README.md",
      "less --log-file=copy.txt README.md",
      "less '+!touch x' README.md",
      "date -s 2020-01-01",
      "file -C -m magic",
      // PowerShell runs code in parentheses and script blocks, even after an allowlisted cmdlet.
      "Write-Output (Remove-Item src -Recurse)",
      "Get-ChildItem | Where-Object { Remove-Item $_ }",
      "Get-ChildItem | Select-Object @{n='x';e={Set-Content a b}}",
      "echo {a,b}",
    ]) {
      expect(readOnlyCommandDenial(bad), bad).toBeTruthy();
      expect(readOnlyCommandDenial(bad, { allowChecks: true }), bad).toBeTruthy();
    }
  });

  it("denies Claude edit tools and writing commands natively", () => {
    const policy = new ClaudePolicy("auto", { cwd: "/repo", extraRoots: [] }, true);
    expect(policy.denial("Edit", { file_path: "/repo/a.ts" })).toMatch(/read-only/);
    expect(policy.denial("Bash", { command: "git push" })).toMatch(/read-only/);
    expect(policy.denial("Bash", { command: "git status" })).toBeUndefined();
    expect(policy.denial("Read", { file_path: "/repo/a.ts" })).toBeUndefined();
    const agent = new ClaudePolicy("auto", { cwd: "/repo", extraRoots: [] });
    expect(agent.denial("Edit", { file_path: "/repo/a.ts" })).toBeUndefined();

    const opts = buildQueryOptions({
      session: base,
      executable: { kind: "native", path: "/bin/claude" } as never,
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      hooks: {},
      abortController: new AbortController(),
    });
    expect(opts.disallowedTools).toEqual(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
    const agentOpts = buildQueryOptions({
      session: { ...base, role: "agent", readOnly: undefined },
      executable: { kind: "native", path: "/bin/claude" } as never,
      canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
      hooks: {},
      abortController: new AbortController(),
    });
    expect(agentOpts.disallowedTools).toBeUndefined();
  });

  it("uses Codex's read-only sandbox", () => {
    expect(codexPolicy("full", true)).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
      networkAccess: false,
    });
    expect(codexPolicy("auto").sandbox).toBe("workspace-write");
  });
});

describe("session.configure (model/effort for the next turn)", () => {
  it("records the change in the Fake session", async () => {
    const session = (await new FakeProvider().openSession({
      ...base,
      role: "agent",
      readOnly: undefined,
    })) as FakeSession;
    await session.configure({ model: "fake-2", effort: "high" });
    expect(session.lastConfig).toEqual({ model: "fake-2", effort: "high" });
    await session.close();
  });
});
