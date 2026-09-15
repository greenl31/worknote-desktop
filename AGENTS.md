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
