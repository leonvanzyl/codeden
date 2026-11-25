---
section: fixed
---

- **Cloning into a folder that already holds the repository adds it.** After a reinstall, a reset of CodeDen's data or with a second profile, **Clone from GitHub** used to fail with "already exists and is not empty" when the project folder was still there from before. When that folder is already a clone of the same repository (its https or ssh address, in any letter case, with or without `.git`), CodeDen now adds it as the project without cloning again, just as **Local folder** would. A folder that holds another repository or other files is still left alone, and the message now says which repository is there and suggests choosing another folder or adding it as a local folder.
