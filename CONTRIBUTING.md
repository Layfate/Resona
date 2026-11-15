# Contributing to Resona

Thanks for helping. Resona aims to be a trustworthy, local and free audio restoration tool.

## Ground rules

1. **Honesty over hype.** A feature is *working* only when it has tests that check what it claims. New or unvalidated features ship as *experimental* and are labelled that way in the UI and the README. Never claim that lost audio is "recovered".
2. **Audio fidelity.**
   - Never change duration or channel alignment.
   - Never clip.
   - Never change loudness unless the user asked for it.
   - Run the end-to-end tests in `worker/tests/test_pipeline.py`.
3. **Licences.** Only add models or code whose licences allow redistribution, and document their provenance in `docs/MODELS.md`. Downloads must use pinned URLs and SHA-256 checks.
4. **Local first.** No telemetry, accounts or required network access beyond the one-time engine and model downloads.

## Workflow

1. Fork the repository and create a branch: `feat/…`, `fix/…` or `docs/…`.
2. Set up the project ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).
3. Make focused commits with clear messages ([Conventional Commits](https://www.conventionalcommits.org/) are appreciated).
4. Before opening a PR, make sure this passes:
   ```bash
   npm run lint && npx tsc -b && npm test
   cd worker && ruff check . && pytest
   cd ../src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
   ```
5. Open a pull request that describes what changed, how you tested it, and before/after measurements for audio changes.

## Where things live

* UI: `src/` (React components in `src/components`, the state store in `src/store.ts`, themes in `src/lib/themes.ts`)
* Backend: `src-tauri/src/`
* Audio processing: `worker/resona_worker/`

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reporting bugs

Please include:
- Your OS, Resona version and engine variant (*Settings → AI engine*).
- The log file (*Settings → About → Open logs*).
- If you can, a short audio sample that reproduces the problem.

## Code of conduct

Be kind, assume good intent, and keep discussions technical. Harassment of any kind is not tolerated.
