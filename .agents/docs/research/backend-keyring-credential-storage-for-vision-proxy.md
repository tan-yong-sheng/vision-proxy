---
type: research
title: Keyring credential storage for vision-proxy
description: Research optional OS keyring-backed storage for vision-proxy provider API keys.
area: backend
tags: []
status: active
created: "2026-08-14"
updated: "2026-08-14"
stale_after: "2026-09-13"
related: []
---
# Keyring credential storage for vision-proxy

## Question

How should `vision-proxy` optionally store provider API keys in the OS keyring instead of relying solely on environment variables and `--api-key`?

## Findings

### Current state

- `src/provider.ts` resolves API keys from the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) or an explicit `--api-key` flag.
- The config file intentionally does not store keys.
- Some users would prefer a secure, OS-integrated credential store that survives reboots without polluting their shell profile.

### Option 1: `@napi-rs/keyring`

`@napi-rs/keyring` is a Node.js binding to the Rust `keyring-rs` crate. It supports macOS Keychain, Windows Credential Manager, and Linux Secret Service (D-Bus) with a single API.

- **Pros**:
  - Cross-platform with prebuilt native binaries; zero runtime dependencies beyond the package itself.
  - Simple API: `new Entry('vision-proxy', '<provider>').setPassword(key)` / `.getPassword()` / `.deletePassword()`.
  - Well-maintained and actively used by large projects migrating away from `keytar`.
- **Cons**:
  - Native module; installation can fail on unusual architectures or minimal Linux images without D-Bus/Secret Service.
  - Headless servers and some WSL environments may lack a running secret service.

### Option 2: `keytar`

The older `node-keytar` library was the standard choice for Electron/Node keychain access.

- **Pros**:
  - Familiar API, wide platform support historically.
- **Cons**:
  - The upstream `atom/node-keytar` repository is archived/deprecated.
  - Requires `libsecret` headers on Linux and often breaks in CI/minimal containers.
  - **Not recommended** for new code.

### Option 3: OS-specific CLI fallbacks

Shell out to platform tools: macOS `security`, Windows `cmdkey`, Linux `secret-tool` or `pass`.

- **Pros**:
  - No npm dependency.
- **Cons**:
  - Brittle parsing and escaping.
  - Different tools on each platform; Windows support is especially awkward.
  - Harder to test and to keep secure.

### Option 4: encrypted local file

Store keys in `~/.vision-proxy/credentials.json` encrypted with a password-derived key using Node.js `crypto`.

- **Pros**:
  - No native dependencies, works everywhere.
- **Cons**:
  - The encryption password still needs to be supplied on every run or stored somewhere else, which largely re-creates the original problem.
  - More code and more risk of crypto misuse.

### Option 5: hybrid keyring + explicit opt-in plaintext fallback

Try the OS keyring first. If it is unavailable, allow a plaintext fallback stored in `~/.vision-proxy/credentials.json` only when `VP_ALLOW_PLAINTEXT_CREDENTIALS=1` is set (mirroring the existing `VP_ALLOW_HOME` safety pattern).

- **Pros**:
  - Best availability; users without a keyring are not blocked.
  - Explicit opt-in keeps the default secure.
- **Cons**:
  - More code paths to maintain and test.
  - Plaintext storage is still a liability; should be clearly documented.

### Recommended approach

Adopt **Option 1 with a graceful, non-persisting fallback**:

- Add `@napi-rs/keyring` as an optional dependency (or direct dependency if the project is comfortable with the native binary).
- Add keyring helpers in a new module `src/keyring.ts` with functions `storeKey(provider, key)`, `loadKey(provider)`, `deleteKey(provider)`, and `isAvailable()`.
- Add CLI commands:
  - `vp provider store-key <provider>` (read key from stdin or prompt if TTY; never accept it as a plain positional to avoid shell history leaks).
  - `vp provider delete-key <provider>`.
  - `vp provider list-keys` (shows which providers have stored keys, not the values).
- Modify `resolveModel` in `src/provider.ts` so the key resolution order becomes:
  1. explicit `--api-key`;
  2. environment variable;
  3. keyring entry for the provider;
  4. missing-key error.
- Service name: `vision-proxy`; account name: provider id (`openai`, `anthropic`, `google`).
- Add env overrides:
  - `VP_KEYRING_DISABLE=1` to skip the keyring lookup.
  - `VP_KEYRING_SERVICE` to override the service name.
- If the keyring throws, surface a one-line stderr warning and fall back to env/missing-key behavior; do not crash.

### Security notes

- Never log or echo stored keys.
- Read keys from stdin or a secure prompt (e.g., `node:readline` with muted input) rather than command-line arguments.
- Keep the keyring module isolated so the rest of the CLI can run without it if the dependency is absent.

## Open questions

1. Should `@napi-rs/keyring` be a direct dependency, an optional dependency, or a peer dependency with a helpful error if missing?
2. On Linux without D-Bus/Secret Service, should the CLI silently skip the keyring or print a warning suggesting `VP_KEYRING_DISABLE=1`?
3. Should the config file gain a `useKeyring` boolean, or should keyring lookup remain automatic when keys are absent from env?
4. Should the keyring store arbitrary provider keys (for custom providers added via `vp provider add`), or only known built-in providers?
5. Is there a need to support multiple keys per provider (e.g., work vs. personal) via account suffixes?
