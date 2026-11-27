# Security Policy

## Scope

**Skill Library** interacts with sensitive local and remote boundaries on the user's machine:

- Managing and symlinking local directories under `$HOME` (such as `~/.skill-library/skills` and AI tool directories like `~/.claude/skills`, `~/.codex/skills`, etc.)
- Atomic symlink transaction journals and original-folder backup retention/restoration
- Fetching skills from remote Git repositories and package command inputs
- Checking, verifying (minisign), and installing desktop app updates from GitHub Releases

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report vulnerabilities privately through GitHub Security Advisories:

- https://github.com/sunyifeng11111/skill-library/security/advisories/new

Please include as much detail as possible to reproduce the issue (macOS version, app version, affected files/commands, and proof-of-concept steps). We will acknowledge receipt and work on a fix before any public disclosure.
