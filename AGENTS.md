# Worknote public repository guide

This repository contains the public, cross-platform edition of Worknote.

## Scope

- Keep the application local-first: task data, backups, and exports stay in the operating system's application data directory.
- Never commit real task databases, exports, credentials, signing certificates, logs, or user-specific paths.
- Preserve the application identifier unless a migration plan is included.
- Keep macOS- and Windows-specific configuration in their platform configuration files.

## Development

- Frontend: static HTML, CSS, and JavaScript in `ui/`.
- Desktop backend: Tauri v2, Rust, and SQLite in `src-tauri/`.
- No Node.js package manager or frontend bundler is required.
- The visible heading and native window title are `Worknote`. The interface supports an instant, persisted `中 / EN` language switch below the window-mode control.
- Keep the main top workspace stationary from the first scroll movement; the expanded quick-entry composer remains below the sticky area.

Run checks from `src-tauri/`:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo tauri build
```

## Git

- Keep commits focused.
- Do not commit build outputs from `src-tauri/target/`.
- Do not force-push the default branch.
- A release tag must match the version in `Cargo.toml` and `tauri.conf.json`.

## Release sync

- Treat `docs/RELEASE_SYNC_CHECKLIST.md` as the canonical checklist for release preparation, privacy and secret review, macOS and Windows packages, release notes, artifact checks, and remote publication.
- “上传发布” or “发布同步” means the full checklist. “同步私有” and “同步公开” affect only the named repository. A bare “同步” prepares and checks both private and public editions but does not authorize a remote write.
- The checklist never replaces explicit authorization in the current turn for staging, committing, pushing, tagging, or creating a Release.
- Stop on sensitive information, build failures, version drift, unknown dirty changes, or unclear signing/notarization status. Never report a release as complete without evidence.
