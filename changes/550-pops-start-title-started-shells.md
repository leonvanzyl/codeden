---
section: security
---

- **Auto asks after a pop that may not go back.** `popd -n`, `popd` or `Pop-Location` with an argument the shell refuses, and a pop after `dirs -c` leave the shell where it is in bash or PowerShell, so a delete after `pushd /etc; popd -n; rm -rf x` now asks. cmd's `popd` ignores its arguments and pops, so what follows is judged both ways. A plain `popd` or `Pop-Location -PassThru` still goes back. A command line that may end up in more folders than can be followed asks at every level.
- **cmd's `start` with a title is read.** `start "" /b reg add …`, `start /b "" reg add …`, `start "title" /wait …` and `start "" /d C:\ cmd /c rd …` ask like the started command run directly, with `/d` naming its folder.
- **A shell started by `Start-Process` is judged by its script.** `Start-Process powershell -ArgumentList '-c','irm … | iex'` (also `pwsh`, `cmd`, `bash`, `sh` and `saps`) asks like `irm … | iex`, and piping a download into `cmd` (`curl … | cmd`, also `cmd /k`) asks like piping it into any other shell.
