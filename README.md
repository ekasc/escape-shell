# Escape shell

Escape's GPUIX UI. The shell owns the desktop experience, while `../engine` owns the AI agent core. The two communicate through the engine's stdio RPC process.

The shell has two client modes:

- Native builds spawn `escape rpc` and stream assistant text, tool events, approval requests, questions, errors, and settlement events.
- Browser builds and tests use a deterministic local client, so the UI remains runnable without a Go binary or provider credentials.

Provider secrets stay in the Go process. The shell never handles them.

## Run it

```bash
bun run dev
```

The desktop app opens at 940 × 660. A save remounts the React tree in the same window.

Set `ESCAPE_BIN` when the engine binary is not on `PATH`:

```bash
ESCAPE_BIN=/path/to/escape bun run dev
```

## Packaging

Escape ships as **one product containing two binaries**. The user installs a single
app; the Go engine is an implementation detail they never install or think about.

### Why the shell is not a single compiled binary

The GPUIX shell cannot be shipped as a `bun build --compile` binary. `@gpuix/native`
is a NAPI addon loaded via a **runtime** `require('@gpuix/native-darwin-arm64')` of a
`.node` file. A compiled Bun binary is hermetic — its module resolution is pinned to a
virtual `/$bunfs/root/` path — so it can never reach a real native addon and crashes
with "Cannot find native binding" at launch.

Instead the app bundles the **Bun runtime** and a JS bundle, with the dependency
closure on disk:

```text
Escape.app/Contents/
  MacOS/escape-shell          launcher: execs the bundled Bun on the UI bundle
  Resources/bin/escape        Go engine (spawned as `escape rpc`)
  Resources/bin/bun           Bun runtime
  Resources/app/shell.js      bundled UI (native binding kept external)
  Resources/app/node_modules/ runtime dependency closure
```

The shell resolves the engine in this order:
1. an explicit `command` argument
2. `$ESCAPE_BIN`
3. a bundled `escape` (next to the app script, or in `../bin` / `../Resources/bin`)
4. `escape` on `$PATH`

### Build a single installable bundle

```bash
bun run bundle   # flat layout for Linux/Windows-style installs
bun run app      # macOS Escape.app
```

Output:

```text
bun run bundle -> shell/build/release/{escape-shell,bin/,app/}
bun run app    -> shell/build/Escape.app/Contents/{MacOS,Resources}
```

Other scripts:

| Script | What it does |
|---|---|
| `bun run build:engine` | Build the Go engine into `build/engine/escape` |
| `bun run build:shell` | Bundle the GPUIX UI into `build/app/shell.js` (native binding external) |
| `bun run bundle` | Build both binaries and assemble a single installable release directory |
| `bun run app` | Assemble a macOS `.app` with the engine in `Contents/Resources/bin` |
| `bun run run` | Build the flat bundle and launch it against the bundled engine |
| `bun run verify` | Prove the bundled engine is resolvable and speaks RPC |
| `bun run install:app` | Build and install `Escape.app` into `~/Applications` |
| `bun run clean` | Remove `build/` |

Assembly lives in `scripts/assemble.ts`; it only lays out files, so `build/`
stays the single output location for both `bundle` and `app`.

### Install into ~/Applications

```bash
bun run install:app
```

This builds `Escape.app`, stops any running copy, copies it to
`~/Applications/Escape.app`, ad-hoc signs it, and refreshes LaunchServices:

```text
==> installed: ~/Applications/Escape.app
    launch with: open ~/Applications/Escape.app
```

To reinstall an existing build without recompiling:

```bash
bash scripts/install.sh --no-build
```

The ad-hoc signature is what lets a locally built bundle launch on macOS
(including Apple Silicon) without a Developer ID. To install on a machine
other than the one you built it on, replace the ad-hoc signature with a real
Developer ID and notarize first (below).

### Signing and notarization (macOS)

`bun run app` produces an unsigned bundle. To distribute it you still need to sign the
engine and shell and notarize the app:

```bash
codesign --force --options runtime \
  --sign "Developer ID Application: <TEAM> (<ID>)" \
  build/Escape.app/Contents/Resources/bin/escape

codesign --force --options runtime \
  --entitlements <(printf '<dict/>') \
  --sign "Developer ID Application: <TEAM> (<ID>)" \
  build/Escape.app/Contents/MacOS/escape-shell

codesign --force --deep --sign "Developer ID Application: <TEAM> (<ID>)" build/Escape.app
xcrun notarytool submit build/Escape.app --keychain-profile <PROFILE> --wait
xcrun stapler staple build/Escape.app
```

Sign the inner binaries before signing the outer bundle, and keep the hardened
runtime enabled for notarization.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` | Start the desktop app with hot reload |
| `bun run build` | Build both binaries into `build/` |
| `bun run bundle` | Build both binaries and assemble a single installable release directory |
| `bun run test` | Drive the app through the GPU test renderer with Vitest |
| `bun run typecheck` | Run `tsc --noEmit` |
| `bun run web:dev` | Bundle for the browser and serve it on port 4173 |
| `bun run screenshot` | Drive the app with the automation client and write a PNG |

The browser renderer ships inside `@gpuix/native`, so `web:dev` does not need Rust. Inside the GPUIX repository, `packages/native/wasm/` is ignored and must be built once with `bun run build:web` in `packages/native`.

## Current UI

The first Escape shell slice includes:

- A collapsible workspace sidebar and new-chat action.
- A welcome state with prompt suggestions.
- User and assistant message bubbles in a native virtual list.
- A native text composer with Enter-to-send behavior.
- A typed RPC boundary in `agent-client.ts`.
- Streamed assistant text, visible tool activity, runtime errors, a working stop action, and structured approval/question cards.
- Recent-session listing, switching, and new-session creation backed by the engine.
- A runtime settings panel for provider, model, reasoning level, and approval mode.
- A command palette populated from the engine's dynamic command list.
- Session diagnostics for messages, tokens, tools, cost, and context usage.
- HTML session export with the generated path shown in settings.
- Manual compact and snap-compact actions with returned summaries.
- Reopened sessions restore visible user and assistant transcript text, including persisted tool-call/result markers.
- Busy-turn steering and queued follow-up actions.
- A conservative fork-latest-user-message action that creates and activates a branch.
- A clone-current-session action that creates and activates a copied session.
- Undo-latest-turn creates and activates a session ending before the latest user turn.
- Settings controls for opening a session by path and persisting a session name.
- A branch-tree view with fork actions on user-message nodes.
- A direct-bash runner with streamed output, exit status, and cancellation.
- A built-in workspace review command in the command palette.
- A built-in session recap command in the command palette.
- A command-palette action that restores the last persisted assistant response.
- Built-in Help and Version command-palette actions.
- OpenCode Go/Zen API-key login form; credentials are saved by the engine with private permissions.
- A bounded workspace diff viewer for staged, unstaged, and untracked changes.
- Settings toggles for automatic compaction and retry.
- Retry lifecycle markers in the transcript, including cancellation through `abort_retry`.
- Queue status in the header for steering and follow-up counts.
- Compaction start/completion status in the header.
- Structured tool activity cards with running, completed, and error states.
- Turn and agent lifecycle status in the header.
- Explicit engine connection test in settings.
- Runtime engine state and session metadata in settings diagnostics.
- Settings controls for steering and follow-up queue policies.
- Optional max-output-token control backed by the engine provider request.
- Local fallback behavior for browser previews and tests.

The MVP intentionally stops at streamed chat, structured tool activity, retry lifecycle visibility and cancellation, queue counts, compaction status, turn/agent status, connection diagnostics, runtime state, stop, runtime errors, approvals, clarification answers, session lifecycle, session path/name controls, transcript restoration, persisted tool history, steering/follow-up, queue policies, max-token control, undo/latest-message branching, branch-tree navigation, session cloning, provider/model/reasoning/approval settings, OpenCode API-key login, automation toggles, command palette, help/version, recap, last response, diagnostics, export, compaction, direct bash, workspace review, and diff viewer controls remain the next slice.

## Files

```text
app.tsx        GPUIX UI, state, local fallback, and screen layout
agent-client.ts Typed RPC event parser and native process client
app.test.tsx   GPU test-renderer behavior checks
index.html     Browser page host
web.ts         Browser bundle and cross-origin isolation headers
screenshot.ts Native automation entry point
assets/icons   SVG icons imported as text
```

## Testing

```bash
bun run typecheck
bun run test
bun run test:integration
bun run build
```
The test suite mounts `ChatApp` through the GPU test renderer and exercises the welcome state, prompt submission, keyboard submission, suggestions, and new-chat behavior. Browser verification uses `agent-browser` because the GPUIX renderer paints to a canvas.

## GPUIX notes

Set `jsxImportSource` in `tsconfig.json`. GPUI does not inherit `color`, so each text element sets its own color. The browser build ships IBM Plex Sans and Lilex only, so the app selects its font based on the target.

The browser renderer uses shared memory. `web.ts` sends the headers a production host needs:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Test fixtures

`bun run fixtures` reports object literals that do not satisfy the type they are
contextually assigned to (`AgentClient`, `SessionSummary`, `SkillSummary`). It
walks the real AST with the TypeScript checker, so it selects by contextual type
rather than by pattern, and it never edits anything without `--write`.

```
bun run fixtures        # report, change nothing
bun run fixtures:fix    # insert placeholders for what is missing
```

Literals that spread something else are skipped: a spread may supply any
property, so filling the rest would add stubs that shadow the real ones. The
report says how many literals it checked and how many it could not check, so its
coverage is never a guess.
