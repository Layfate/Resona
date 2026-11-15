# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's *Report a vulnerability* (private security advisory) on this repository. We aim to respond within 7 days.

## Scope and design

* Resona processes audio locally and has no telemetry or accounts.
* Network access is limited to explicit, user-triggered downloads:
  - the `uv` package manager: pinned version, pinned SHA-256;
  - Python packages from PyPI via uv;
  - models: pinned commit URLs, SHA-256 per archive and per file.
* The web view can only read files the user imported. The asset-protocol scope starts empty and is extended at runtime.
* Downloaded model archives are treated as data. Only expected files are extracted, under fixed names.
