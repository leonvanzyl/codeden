---
section: fixed
---

- **The orchestrator and PMs tell you times in your own timezone.** Their status digest used to carry only a UTC time, and nothing told them your timezone. So a PM at UTC+2 said "I'll check again at 20:02" when it meant 22:02 your time. The digest now also carries your timezone and local time, and their instructions say to quote times in your local time. Wake-ups they schedule show the local time next to UTC. The timezone is the one usage reports use: the usage settings' timezone, else your computer's.
