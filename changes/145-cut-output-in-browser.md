---
section: fixed
---

- **Long command output no longer slows the open tab, and cut output says so.** While a command streams, the transcript in your browser keeps only its most recent 16,000 characters, the same tail a reload shows. Before, the tab kept every chunk and redrew all of it, using more memory and CPU the longer a build or test run went on.
  - When a tool's output was cut, its details now say how much is shown ("Showing 15.6 KB of 1.9 MB"), and **Show full output** loads what CodeDen stored for it. If only part of it was stored, it says how much was kept.
