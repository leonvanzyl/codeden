---
section: security
---

- **Read-only commands are checked more strictly.** Sessions at Read-only, the orchestrator, PMs and agents in plan mode may no longer use the options that make a reading program write or run something (`sort -o`, Windows `sort /O` and `/T`, `uniq` with an output file, `find -fprint`/`-ok`, also after `--`, `fd -x`, `rg --pre`, `less -o`, `tree -o`, `date -s`, `file -C`, `git diff --output`, `git grep -O`), git's writing forms (`git branch <name>`, `git tag <name>`, `git remote remove`, `git worktree remove`, `git reflog expire`, abbreviated `git config` writes), `gh` verbs that aren't reads or `gh` extensions, background jobs (`&`), nor unquoted parentheses and braces, in which PowerShell runs code even after an allowed cmdlet. Options are read the way the shell passes them (`-'o'` is `-o`), and variables, `$'…'` quoting and unquoted patterns that could become an option are refused.
