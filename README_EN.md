<p align="center">
  <a href="./README.md">中文</a> · <a href="./README_EN.md">English</a>
</p>

# DSH Desktop

A turnkey desktop shell wrapping [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) (**Windows / Linux**): **all dependencies bundled, isolated from the system, ships its own Chromium kernel, and a built-in terminal that can update dependencies.**

It reuses the official Web UI (no reinventing the interface); the desktop layer only covers the host capabilities the original lacked: process lifecycle, port & auth, data persistence, terminal, packaging & distribution.

## Overview

| | |
|---|---|
| What | Desktop shell for DeepSeek Harness: bundled deps, system-isolated, built-in terminal |
| Current version | **0.1.2** |
| Artifacts | Windows: `DSH-Desktop-Setup-0.1.2.exe` (NSIS installer), `DSH-Desktop-0.1.2-portable.exe` (portable); Linux: `npm run dist:linux` produces AppImage + deb |
| Build | `npm install` → `npm run dist:win` or `npm run dist:linux` (**Node 24 required**, see section 2; **no cross-compiling**) |
| Where data lives | Windows `%APPDATA%\dsh-desktop\`, Linux `~/.config/dsh-desktop\`, independent of install dir, **survives uninstall** |
| Source layout | `src/main` (main process), `src/preload`, `src/renderer` (loading / terminal / kernel panels) |

> The installer is ~112 MB, exceeding GitHub's 100 MB per-file hard limit, so it is **not in git** and is distributed as a Release attachment.

---

## 0. Current Status

> Snapshot updated after take-over on 2026-09-15. This section says where things stand and what's left; read it first if you're taking over.

### Verification status

| Check | Result | Notes |
|---|---|---|
| Phase-1 unit tests | **41 / 41** | path layout, config, atomic write, concurrency lock |
| `smoke:kernel` | **PASS** | real launch + token probe |
| `smoke:phase2` | **13 / 13** | remote metadata, dual-channel throttling, plugin manifest, rollback candidate, concurrency lock |
| `smoke:ui` | **PASS** | zero console errors |
| `smoke:switch` | **PASS** | 7 groups: success path + failure path (config not corrupted, old kernel self-heals) + concurrent re-entry rejected (`KERNEL_BUSY`) + progress events emitted during switch |
| `smoke:install` | **PASS** | real download of ~500 deps → native build → smoke → atomic promote, full chain; environment restored |
| `smoke:migrate` | **18 / 18** (new) | legacy kernel adoption, snapshots not overwritten, data rescue, idempotency, malformed candidate doesn't throw, app self-update gating |
| `smoke:paths` | **40 / 40** | path normalization, DSH_HOME vs kernel dir mutual-nesting exclusion, system-dir rejection |
| `smoke:lock` | **34 / 34** | lock contention, only release own lock, stale lock takeover, malformed lock file, zombie lock cleanup (never delete a live one) |

### TODO

| # | Item | Status |
|---|---|---|
| 1 | Old users' "bundled dsh" → `core/snapshots` migration | **Done** (`src/main/migrate.js`, see section 2.6) |
| 2 | `electron-updater` auto-update UI | **Done**: main-process chain (section 5) + kernel panel section 7 "App Update" (current/latest version, check, download progress bar, restart & install, update source + "auto-check on startup" toggle). The native "Help → Check for App Updates…" dialog is kept as a fallback when the kernel won't start. **Still not end-to-end verified on real hardware**: no real update source configured yet (see section 7 known limitations) |
| 3 | Real-hardware Windows NSIS packaging (custom path / Geek detection / clean uninstall) | **Done**: `npm run dist:win` runs on Windows + **portable Node 24.21** (first verified at 0.1.0, **re-verified at 0.1.2**), producing `DSH-Desktop-Setup-0.1.2.exe` (NSIS) + `DSH-Desktop-0.1.2-portable.exe`, with `node-pty` in the packed `app.asar.unpacked` actually able to spawn a PTY (see section 2.6 note). System Node 22 is insufficient; the build machine must bring its own Node 24 (see section 2) |
| 4 | Startup fault tolerance: three defects that cause "double-click and no window at all" | **Done**: module-level `applyPathOverrides()` and `boot()` lacked try/catch (any throw crashes the main process at `require` time or before `createMainWindow()`); window `show:false` with no `did-fail-load` fallback (on load failure `ready-to-show` never fires). All three are **pure fallbacks** — the normal path executes none of them |
| 5 | Single-instance lock broken across "portable / installed" | **Done**: Electron's own lock is keyed by userData, so portable (exe-sibling `dsh-desktop-data`) and installed (`%APPDATA%\dsh-desktop`) each hold one and can run simultaneously, fighting over the port. Added `src/main/instance-lock.js` placing the lock at a fixed location independent of userData: `%APPDATA%\dsh-desktop-shell\instance.lock`, shared by both; on failure shows a native dialog and exits. `clearStaleLock()` in the same file also clears kernel-side zombie locks at startup (below) |
| 6 | Kernel-side zombie lock causing "double-click won't open" | **Done**: task-board records its pid in `dsh-home/task-board/ledger-v2.lock`; if the process is force-killed the lock stays and next launch the kernel reports `ledger is already owned by process <pid>` and exits. `boot()` now calls `clearStaleLock()` before launching the kernel: delete if pid is dead, never touch if alive |
| 7 | Kernel switch "very easy to hang then crash" | **Done**: three root causes stacked — ① killing the process tree used `execSync('taskkill')`, **blocking the main event loop synchronously**, freezing UI/IPC/heartbeat during switch; ② `switchTo()` had no re-entry guard, so concurrent calls stepped on each other's `stop`/`start` and corrupted `config.json`; ③ no progress feedback, user could only click repeatedly. Changed to async `killTreeAsync()` + `#exclusive` re-entry lock (busy → throw `KERNEL_BUSY`) + `switch-progress` broadcast. See section 2.9 |
| 8 | One-click restart and reconnect kernel | **Done**: `Ctrl + K` panel "Actions" button **"Restart and Reconnect Kernel"** (`btnRestart`). Chain `ipcMain.handle('dsh:restart')` → `launcher.restart()` → `mainWindow.loadURL(url)`. The port is randomized each time, **without reconnect it stays on the old address**, so this step can't be skipped |
| 9 | Linux cross-platform compatibility | **Done (0.1.2 packaged and run on real Linux x64 hardware)**: on POSIX, spawn always uses `detached: true`; killing the tree uses process-group `process.kill(-pgid, 'SIGTERM')` → timeout `SIGKILL` (a bare `child.kill()` only kills the direct child, leaving dsh's plugin grandchildren orphaned and holding the port); `package.json` gained a `linux` target (AppImage + deb) and `npm run dist:linux`. Linux packages **can only be built on a Linux host**, see section 2 |
| 10 | Optional version download of kernel | **Done**: added `kernel:remoteVersions` (remote version list) + version dropdown on the loading page / kernel panel; selecting one goes through the same "stage → verify → smoke → atomic promote" pipeline. See section 2.5.1 |
| 11 | Kernel auto-check update and pull-install | **Done**: `kernel-auto-update.js`, 30s after startup + every 6 hours + manual trigger, semver-compares against dist-tag `latest`, reuses the same install pipeline, backs off on failure while keeping the current kernel; 25/25 rules (`npm run smoke:autoupdate`), see section 2.5.2 |

### Take-over must-read: six invariants

Confirm none of these is violated before changing any of the related code:

| # | Constraint | Why |
|---|---|---|
| 1 | Kernel lives in `%APPDATA%\dsh-desktop\core\snapshots\<version>\`, **not in the installer** | The installer was slimmed; `@deepseek-ai/dsh` was removed from `dependencies` |
| 2 | **Only replace the current kernel after the new one passes smoke**; on failure the current kernel is unchanged + `core/staging` cleared | `kernel-package-manager.install()`'s "verify → stage → smoke → atomic promote" chain |
| 3 | **Never modify the deepseekharness kernel itself**, only interface with it | The kernel dir may only be written with `snapshot.json` metadata |
| 4 | `DSH_HOME` defaults to `userData/dsh-home`, **configurable** (see section 2.7), but **must never nest with the kernel dir** | Putting it inside the kernel tree would get deleted by "clean old snapshots"; the reverse would make dsh treat it as its own data dir |
| 5 | Platform differences converge in `isWindows` at the top of each file: Windows has MAX_PATH 260, no symlink, process tree via `taskkill /T`; POSIX uses `detached` process groups + `process.kill(-pgid)`. **Killing the process tree must be async** | Snapshot promotion uses `rename` not symlink; hoisted flat node_modules shorten paths; `execSync` is forbidden (see section 2.9) |
| 6 | `config.json` / `plugin-manifest.json` must be **atomic-written** (temp file + rename) | An interrupted update must not leave the app unbootable |

---

## 1. Design Highlights

### 1. Dependencies bundled, isolated from the system

| Capability | Need to install on system? | Notes |
|---|---|---|
| Node.js | ❌ No | Uses Electron's built-in Node 24 directly |
| pnpm | ❌ No | Packed into `node_modules/pnpm` |
| dsh + 522 deps | ❌ No | **Not in the installer**, downloaded on demand to `%APPDATA%\dsh-desktop\core` |
| Chromium | ❌ No | Bundled with Electron |
| Will system Node/npm/pnpm interfere | ❌ No | Child-process PATH prioritizes built-in dirs |

**dsh runs as a subprocess**, using `ELECTRON_RUN_AS_NODE=1` to make the Electron binary act as plain Node — avoiding packing another ~50 MB Node runtime.

> This requires Electron ≥ 44 (built-in Node 24.18+), because dsh's `bin.js` ends with
> `if (import.meta.main) await runCli()`, and `import.meta.main` is a Node 24 property.
> On Node 22 it **silently exits with code 0 and no error** — the hardest bug in this project to diagnose.

### 2. Data lives outside the install directory

```
%APPDATA%\dsh-desktop\          ← on Linux: ~/.config/dsh-desktop/
├── dsh-home\        DSH_HOME: profile, credentials, plugins (survive upgrade)
├── workspace\       default workspace, auto-created on first launch
├── logs\dsh.log     dsh subprocess log
├── bin\             auto-generated dsh / pnpm command shims
├── config.json      kernel version selection, throttling, snapshot retention count
├── plugin-manifest.json  plugin & snapshot manifest, rollback history
└── core\            ← kernel (dsh itself), separate from the app, updatable & rollbackable
    ├── snapshots\<version>\    one complete node_modules per version
    ├── staging\               download/install staging, promoted only on success
    └── update.lock            concurrent-install mutex
```

Reinstalling or upgrading the app does not take away profile, session, or plugins.

### 2.5 Dynamic kernel update (snapshot / switch / rollback)

The dsh core **is no longer packed into the installer**; instead it's treated as an updatable "kernel" under `core/snapshots/<version>/`.
This buys three things: a smaller installer, a kernel that can upgrade independently of the app, and one-click rollback if something breaks.

```
query version → stage install → verify entry → pre-start smoke → promote to snapshot → switch
```

Core invariant: **only after the new kernel actually starts and passes the HTTP readiness probe is the config allowed to be written to replace the current kernel.**
Any step failing deletes the staging dir and leaves the current kernel untouched.

| Capability | Implementation |
|---|---|
| Version switch | Change the pointer in `config.json`, no symlink (Windows needs admin/developer mode to create symlinks) |
| Rollback | Switch back to any `ready` snapshot directly, recording `from → to` history |
| Switch keeps plugins | `DSH_HOME` is fixed at `dsh-home/`; dsh installs plugins into `$DSH_HOME/profiles/*/node_modules`, not the kernel dir |
| Dual-channel throttling | Kernel download and plugin download each get a local CONNECT tunnel proxy, independent |
| Concurrency protection | `update.lock` created with `O_EXCL`, auto-declared dead and cleaned after 10 minutes |
| Failure self-heal | Switch failure writes the pointer back to the original version and tries to restart the original kernel |

UI entry: `Ctrl + K` (or menu "Kernel → Kernel Management"). When the kernel is missing, the loading page offers an "Install Kernel" button directly.

### 2.5.1 Pick a version and download the kernel

dsh ships 20 versions a month; installing only `latest` isn't enough — sometimes you roll back to a verified rc, sometimes you try `next` early. So the UI lets you **pick a version and download it**:

| Location | Interaction |
|---|---|
| Loading page (when kernel missing) | "Kernel version" dropdown lists published versions from the mirror; pick and click "Install / Update Kernel" |
| Kernel panel section 2 | "Remotely downloadable versions" dropdown + "Refresh list" + "Download and install" |

- The list comes from `KernelPackageManager.listRemoteVersions()` (reads the registry packument), sorted descending by version, marking dist-tags `latest` / `next` and "installed / current"; to avoid flooding the dropdown with hundreds of historical versions, **only the most recent 40** are returned, but installed and current versions are always kept.
- The download still goes through the 2.5 pipeline (stage → verify → smoke → atomic promote); selecting an **already-installed** version recognizes the local cache and enables it directly without re-downloading.
- Failure to fetch the list (offline / mirror unreachable) **is not an error**: the loading page degrades to a single `latest` option, the panel only shows the reason in this area, and the installed kernel remains usable.

### 2.5.2 Kernel auto-update (trigger / source / compare / flow / failure / prompt)

dsh ships 20 versions a month; manual clicking isn't realistic. All auto-update lives in `src/main/plugins/backup-roll/kernel-auto-update.js`, with rules pinned by `scripts/smoke-autoupdate.js` (25 cases).

| Question | Conclusion |
|---|---|
| **Trigger** | ① auto-check 30s after startup; ② then every **6 hours**; ③ panel "Check now" manual (ignores clicks within 60s); ④ on failure back off at **5 / 15 / 45 minutes** |
| **Source** | `config.kernel.registry` (default npmmirror) dist-tag `latest`; not GitHub Release — a separate chain from the desktop shell's own `electron-updater` |
| **Compare** | semver (`semver.js`, no third-party dep): `1.0.10 > 1.0.9`, release > same-core rc. Update only if target > current |
| **Pull & update flow** | Reuses the 2.5 pipeline: **stage → download deps → verify entry & version → pre-start smoke → atomic promote to snapshot → switch**; manual "download and install" calls the same function |
| **Replace & rollback** | Only write `config.json` after smoke passes (really started and responded to HTTP); on failure delete staging, **current kernel untouched**, panel can roll back to any `ready` snapshot |
| **Failure handling** | Network (ETIMEDOUT / ENOTFOUND / ECONNRESET / request timeout) → back off and retry; verify fail / smoke fail / insufficient permission → **no auto-retry**, only log & prompt; task in progress → return `busy`, don't queue |
| **User prompt** | Kernel panel section 2: toggle + "last check / result / next check" + "check now"; progress via `kernel:progress` events and stage text |
| **Logging** | Main process `[kernel:auto]` prefix (trigger source, remote version, decision, failure reason); each update writes `history` to `plugin-manifest.json` (`action: auto-update` or `update`, with `from → to`) |
| **Silent or confirm** | **Silent auto-update by default** — because the kernel is only enabled after passing smoke, silent doesn't mean "might break"; turning the toggle off degrades to "only check, only prompt", install left to a human button |

Deliberately **not** auto-done (all become "prompt + wait for human confirmation"):

- Remote `latest` is older than current → no auto-downgrade
- Current is release, target is pre-release → no auto-jump
- Pre-release channel change (`rc` → `alpha`) → no auto-jump
- `mode: pinned` (fixed version) → report only, no switch

### 2.6 Old-version migration (bundled dsh → snapshot)

Older versions packed dsh directly into the installer and launched from there. After slimming the installer, all entries go through `KernelRegistry + core/snapshots`, so **an upgraded old machine prompts "Harness kernel not installed yet" — even though a perfectly good dsh is sitting in the install dir.**

`src/main/migrate.js` adds this step **on every startup, before resolving the kernel**:

```
scan candidates → recognize layout → copy into snapshot → write snapshot.json → rescue DSH_HOME data → record to config.app.migrations
```

| Rule | Approach |
|---|---|
| Read-only worldview | Legacy dir is **copied not moved, not deleted** — it may be read-only (asar), and it's the user's only fallback after upgrade |
| Don't modify kernel | Only drop `snapshot.json`, consistent with invariant #3 |
| Don't overwrite | Skip if a same-named snapshot exists; don't touch existing files by a single byte |
| Idempotent | Result written to `config.app.migrations`, second run is a no-op |
| Rescue data | Residual `profiles/` / `credentials.json` / `sessions` in the kernel tree merged back to `dsh-home/` (existing wins, source kept) |
| Don't grab pointer | Only take over when `currentVersion` is empty or points to a non-existent snapshot; never downgrade a runnable kernel |

Recognizes two historical layouts, both normalizing to `core/snapshots/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js`:

- **Self-contained**: `<container>/node_modules/@deepseek-ai/dsh` (move whole tree, deps not lost)
- **hoisted root**: `<node_modules>/@deepseek-ai/dsh` (deps at same level, move whole `node_modules` into the lower `node_modules/`)

> ⚠️ After copy, the entry file must be verified to exist, otherwise the whole copy is deleted and rolled back — rather fail to migrate than leave an unbootable snapshot.
> ⚠️ Migration failure **must not block startup**: a single bad dir is only logged and continues; overall exceptions are swallowed by `index.js`.

### 2.7 Path settings (DSH_HOME / kernel dir)

Entry: **`Ctrl + K`** panel → section 8 "Path Settings". Browse to select or type manually.

| Config | Default | Notes |
|---|---|---|
| `paths.dshHome` | `%APPDATA%\dsh-desktop\dsh-home` | profile / credentials / plugins / session; **blank = restore default** |
| `paths.kernelDir` | `core\snapshots\<currentVersion>` | current kernel snapshot dir, can only pick a dir inside the snapshot root |

Validation rules live in `src/main/path-config.js` (`npm run smoke:paths`, 40 cases):

- Must be absolute path, not a disk root;
- Must not point to a system dir (Program Files, Windows, ProgramData, etc.);
- The two **must not nest with each other** — the only current form of invariant #4;
- Dir must be writable (if absent, parent must be writable);
- Kernel dir must actually have a kernel installed (`node_modules/@deepseek-ai/dsh/lib/bin.js` exists).

How it takes effect:

- Change **DSH_HOME** → restart the dsh subprocess immediately (it's injected via env var; config change doesn't affect the running process), config also atomically persisted;
- Change **kernel dir** → go through the existing `launcher.switchTo()` chain, identical to `Ctrl + K` version switch;
- Both are **projections of each other** with `config.kernel.currentVersion`: switching version auto-syncs path, and vice versa, so there's never a "two different current kernels" display.

> Values are always validated before writing; illegal values are not adopted; on startup if a saved value is invalid (dir deleted/moved), silently fall back to default and only log — **a bad path config must not make the app unbootable**, or the user loses the chance to fix it.

### 2.8 Plugins and plugin store

- Plugins install only into **`<DSH_HOME>/dsh-plugins/`**: an independent subdir under DSH_HOME, not in the kernel tree (cleaning snapshots won't delete plugins), not in system dirs, not modifying any env var or global config (npm/pnpm prefix, cache, userconfig all point to userData).
- **The store is the npm registry**: dsh plugins are npm packages, and installation goes through `pnpm add <pkg>`, so "searchable" and "installable" share a source — no "clickable in list but 404 on install".
- Meta-info is written to `plugin-manifest.json`, containing: `name`, `version`, `requiresKernel` (the kernel version the plugin **declares** it depends on, taken in order from `dsh.kernelVersion` → `peerDependencies["@deepseek-ai/dsh"]` → `engines.dsh`, null if none), `kernelVersion` (the **kernel it's actually installed on**, a scene snapshot for troubleshooting).

### 2.9 Kernel-switch stability (async tree-kill + operation serialization)

Early "switch kernel = hang then crash" was not one bug but three stacked, all fixed:

| Symptom | Root cause | Fix |
|---|---|---|
| Click once and the whole UI freezes, then the process vanishes after a few seconds | Killing the process tree used `execSync('taskkill …')`, **synchronously blocking the main event loop**, freezing UI/IPC/heartbeat during switch | `killTreeAsync()`: `spawn('taskkill', …)` + timeout wait; POSIX branch uses `process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` on timeout |
| Click "switch" twice, or "switch" collides with "restart", state utterly scrambled | `switchTo()` had no re-entry guard; two `stop()`/`start()` compete, killing the just-launched new process and corrupting `config.json` | `#exclusive` re-entry lock (`#opRunning`): if an op is in progress, **explicitly reject** and throw `KERNEL_BUSY`, no queueing, no stepping on each other |
| Stuck with no idea what's happening, only clicking repeatedly | No feedback throughout the switch | Broadcast `switch-progress` throughout: `switch-stop` → `switch-boot` → `switch-done` / `switch-rollback` / `switch-failed`, forwarded by `index.js` to all windows |

Two hard constraints, read before touching these files:

- **No `execSync` in `stop()` / `killTree()`.** A kernel process's life/death is async; synchronous wait drags the whole desktop shell down.
- **POSIX spawn must be `detached: true`.** Without it the child shares Electron's group, and killing the group would hurt itself; with it you can use `process.kill(-pgid)` to also reap dsh's plugin grandchildren.

The panel "Actions" **"Restart and Reconnect Kernel"** goes through the same chain: `launcher.restart()` gets the new URL, then `index.js` runs `mainWindow.loadURL(url)` — the port is randomized each time, **without reconnect you stay on the old address**.

> Initiating another same-kind op during switch/restart is rejected with `KERNEL_BUSY`, UI shows "please try later". This is deliberate design, not a bug: one switch can take 90 seconds; queueing and hanging are indistinguishable.

### 3. Built-in terminal

Open with `Ctrl + \``. On startup it auto-injects built-in env vars, so you can run directly:

```powershell
dsh --version
dsh plugin --profile web add @scope/plugin
pnpm add <pkg>
```

The terminal **explicitly detects and shows the shell type and version** — shell behavior differences are enough to cause mojibake and command failures, so it doesn't guess, it probes and prints the result. Candidate order differs by platform:

**Windows** (`SHELL_CANDIDATES` `isWindows` branch)

| Shell | Notes |
|---|---|
| `pwsh.exe` (PowerShell 7+) | Preferred, best UTF-8 |
| `powershell.exe` (5.1) | Built-in, compatibility fallback |
| `bash.exe` (Git Bash / WSL) | Used if present; listed explicitly so a "Git Bash only" dev machine doesn't fall to cmd |
| `cmd.exe` | Last fallback, auto `chcp 65001` on startup |

**Linux / macOS** (POSIX branch)

| Shell | Notes |
|---|---|
| `/bin/bash --login` | Preferred |
| `/bin/zsh --login` | Second choice |
| `/bin/sh` | Last fallback |

### 4. Security

- Renderer: `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`
- `--expose-internals` **granted only to the dsh subprocess**, never to any renderer
- Navigation whitelist: main window may only access loopback addresses and local pages; external links **only allow `http(s)`** handed to the system browser (`shell.openExternal` passes the string to the system shell; allowing `file://` equals arbitrary program execution)
- `app:openPath` only allows paths inside `userData`
- Version numbers and plugin package names are whitelisted before being spliced into pnpm args and paths (against arg injection and path traversal)
- Single-instance lock: avoid two instances writing the same profile

### 5. Desktop shell's own update (distinct from kernel update)

Kernel update swaps dsh (panel `Ctrl + K`); app update swaps the desktop shell itself. The two are fully separate:

```
src/main/app-updater.js  —— generic provider + runtime feedURL
  └─ enabled = app.isPackaged && config.app.updateUrl configured
```

- With no `updateUrl` the whole thing is **disabled**; dev builds never self-check (talking update on an unpackaged binary is meaningless)
- After detecting a version, a native dialog drives "download → restart install" (menu: Help → Check for App Updates…); this path doesn't depend on the dsh Web UI and works even when the kernel won't start
- The renderer gets the same state via `dshDesktop.updater.*` (`app:update` event): the kernel panel (`Ctrl + K`) section 7 "App Update" already draws current version / latest version / last check, check & download buttons, download progress bar, plus update-source input and "auto-check on startup" toggle; after download the same button becomes "Restart and Install". Dev builds / unconfigured `updateUrl` show the disable reason directly, not a dead button
- Update source **only allows http(s)** and can only be written to `config.json`; the renderer can't specify its own update source

### 6. File map

| File | Responsibility |
|---|---|
| `src/main/index.js` | IPC + startup + window + navigation whitelist + IPC input validation + migration/update wiring |
| `src/main/migrate.js` | **New** legacy built-in kernel → `core/snapshots` migration, DSH_HOME data rescue |
| `src/main/app-updater.js` | **New** electron-updater wrapper (generic source, disabled if unconfigured) |
| `src/main/dsh-launcher.js` | Subprocess lifecycle: `ELECTRON_RUN_AS_NODE` + `--expose-internals` + random port + token + readiness probe + tree-kill |
| `src/main/paths.js` / `layout.js` / `user-data.js` | Path layout, pin userData to `%APPDATA%\dsh-desktop` |
| `src/main/config-store.js` | `config.json` + update lock + `KERNEL_MIN_NODE_MAJOR=24` + `app` section (migration record / update source) + `paths` section (custom DSH_HOME / kernel dir) |
| `src/main/path-config.js` | **New** user-configurable path validation: absolute path, system dir, mutual nesting, writability, kernel snapshot legality (`smoke:paths`, 40 cases) |
| `src/main/plugins/backup-roll/plugin-store.js` | **New** plugin store: npm registry search + resolve plugin-declared kernel version |
| `src/main/plugins/backup-roll/*` | `kernel-registry`(snapshot registry) / `kernel-package-manager`(download orchestration, **POSIX process-group tree-kill**) / `plugin-manage`(plugins+rollback) / `registry-client` / `throttle-proxy`(throttling) / `validate`(injection guard) |
| `src/main/instance-lock.js` | **New** cross "portable / installed" single-instance lock (hardlink exclusive create, only release own lock) + zombie lock cleanup (`clearStaleLock`) |
| `src/renderer/{loading,kernel,terminal}.html` | loading page / kernel panel ("Actions" has **"Restart and Reconnect Kernel"**, section 7 "App Update", section 8 "Path Settings") / terminal |
| `npmrc.sample` | **New** non-dotfile copy of `.npmrc` (auto-restored on missing `postinstall`, guards against transfer file loss) |
| `scripts/smoke-*.js` | Smoke scripts; `smoke:migrate` is pure node, no Electron needed |
| `build/installer.nsh` | NSIS hooks: custom-path memory, write InstallLocation, taskkill before uninstall, data-keep prompt |

---

## 2. Build (Windows / Linux)

> ⚠️ **No cross-compiling — Windows packages only build on Windows, Linux packages only on Linux.**
> `node-pty` is a native module and `node-gyp` doesn't support cross-compiling native modules from source. Building a Windows package on Linux/macOS fails directly with `node-gyp does not support cross-compiling native modules from source`; and vice versa.
> The reference project dsh-desktop follows the same principle.

### Prerequisites

- **Node.js 24 LTS** (for building; the app runtime needs no Node at all)
- Git
- When `node-pty` builds locally it also needs **Visual Studio Build Tools** (check "C++ Desktop Development" + English language pack)

> The Node lower bound is hard: dsh's `bin.js` ends with `if (import.meta.main)`, which on Node 22 **silently exits with code 0 and no error** (section 5, rule 5).
> `KERNEL_MIN_NODE_MAJOR = 24` is hardcoded in `config-store.js`; don't lower it.

### Windows

```powershell
cd dsh-desktop
npm install            # includes node-pty local build; .npmrc already uses a domestic mirror
npm run seed:core -- 0.1.5-rc.1   # optional: preload kernel to skip first-launch download
npm run dist:win
```

> **Build machine has no Node 24? (already hit this)**
> System Node 22 won't run (`import.meta.main` silent exit). Don't touch system Node;
> just download a **portable Node 24** outside the project dir, e.g. `tools\node24\`:
>
> ```powershell
> # Use portable node's npm for install and packaging, never touching system Node
> $N = 'X:\path\to\tools\node24\node.exe'
> & $N (Join-Path (Split-Path $N) 'node_modules/npm/bin/npm-cli.js') install
> & $N (Join-Path (Split-Path $N) 'node_modules/npm/bin/npm-cli.js') run dist:win
> ```
>
> Two environment-related pitfalls (measured this time):
> 1. **Electron binary download fails** — `@electron/get` doesn't read `.npmrc`'s `electron_mirror`, it hits GitHub directly and times out. Use `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` env var, or manually extract `electron-vXX-win32-x64.zip` into `node_modules/electron/dist` and write `path.txt=electron.exe`.
> 2. **npm 11 `allowScripts` gate** — it blocks `node-pty`'s install-script warning, but `node-pty`'s prebuilt artifacts still land and load fine in `app.asar.unpacked` after packaging (measured `cmd.exe` PTY echo). If bindings are ever missing, manually run `node node_modules/node-pty/scripts/prebuild.js`.

Output in `dist\` (verified): both NSIS installer and portable build generated, `node-pty` actually spawns a terminal in the packed build.

Artifacts in `dist\`:

- `DSH-Desktop-Setup-0.1.2.exe` — NSIS installer (standard install, system-recognizable, uninstallable)
- `DSH-Desktop-0.1.2-portable.exe` — portable green edition (no registry, delete folder = uninstall)

### Linux

```bash
cd dsh-desktop
npm install
npm run dist:linux     # AppImage + deb, output in dist/
```

> Linux packages must be built on a Linux host (same reason, `node-pty` can't cross-compile).

**Real-hardware verification passed** (UOS Desktop 25 / Debian-family, x86_64, Node 24.14). Measured conclusions:

| Item | Result |
|---|---|
| `npm install` + package | AppImage (~129 MB) + deb (~102 MB) both succeed; `node-pty` needs `g++` (built from source via `python3 make g++`) |
| Startup & sandbox | Runs directly, **no `--no-sandbox` needed** (Chromium sandbox works normally under a normal user) |
| Data dir / single-instance lock | `~/.config/dsh-desktop/` created per README section 2 structure; `~/.config/dsh-desktop-shell/instance.lock` works, second launch auto-exits |
| Kernel download & start | `KernelPackageManager` installed `0.1.5-rc.1` (~500 deps) for real, kernel up on a random loopback port with token resolved |
| Terminal | `node-pty` loads fine under Linux Electron 44 (N-API, no `npmRebuild` needed), shell recognized as `/bin/bash` |
| Pure-node smoke | `smoke:migrate` 18/18, `smoke:paths` 40/40, `smoke:lock` 34/34 |

The only build-time warning is `desktopName` unset (doesn't affect running); the deb target requires `homepage` in `package.json`, already added. AppImage needs FUSE (present on the machine, can run `./xxx.AppImage` directly).

---

## 3. Install and Uninstall

> This section is about the **Windows NSIS installer**: registry keys, ARP (Add/Remove Programs), `/D=` silent param belong only to the installed edition.
> The `portable` edition writes no registry; delete the folder to uninstall; Linux uses deb / AppImage, handled by the distro package manager or manual placement.

### Install: path is your choice

Double-click `DSH-Desktop-Setup-<version>.exe`; the wizard shows an **install location** page where you can "Browse" to any directory or type one manually. Default `C:\Program Files\DSH Desktop` (`perMachine`, first time asks for admin).

| Method | Usage | Scenario |
|---|---|---|
| Wizard | "Install location" page → browse / type | Manual install |
| Silent param | `DSH-Desktop-Setup-0.1.2.exe /S /D=D:\Tools\DSH Desktop` | Batch deploy, scripted install |
| Reuse last | No action | Upgrade, or reinstall after uninstall |

`/D=` must be the **last** argument on the command line, and the path **no quotes** (spaces parse correctly).

Overwrite install (upgrade) reuses the last dir, wizard skips the path page; to change location uninstall first then reinstall, or use `/D=`.
After uninstall-reinstall also remember the last location — electron-builder's own `InstallLocation` is deleted with the uninstall entry, so an extra copy is kept at `HKLM\Software\DSH Desktop\InstallPath` (`build/installer.nsh` `customInit` / `customInstall`).

**Changing install location doesn't affect any data.** Profile, plugins, session, workspace, logs are all in `%APPDATA%\dsh-desktop`, independent of where the exe is. Moving the app from C: to D: leaves data intact.

Two suggestions when picking a path:

- Chinese and spaces are supported; subprocess calls are all quoted;
- But Windows `MAX_PATH` (260) still holds, and dsh has 522 deps with very deep dirs, **prefer short paths** (e.g. `D:\dsh`), don't bury it in `D:\我的软件\AI 工具集合\DeepSeek\Harness Desktop\`.

After install it appears in **Settings → Apps → Installed apps**, with icon, version, publisher, and uninstall entry, and shows the real install path (the installer wrote `InstallLocation` to the ARP entry).

### Uninstall: system-recognizable

The uninstaller writes a standard "Add/Remove Programs" registry entry, so all three ways below work:

1. **Windows Settings** → Apps → Installed apps → DSH Desktop → Uninstall
2. **Start Menu** → DSH Desktop → Uninstall DSH Desktop
3. **Control Panel** → Programs and Features → Uninstall a program

Because it's a standard ARP entry (`HKLM\...\Uninstall\...`), tools like Geek Uninstaller, Bulk Crap Uninstaller, Revo Uninstaller also recognize and take over uninstall.

### Cleanup behavior on uninstall

Uninstall first ends the app **and its dsh subprocess** — both use the same exe image name; not ending it first causes file locks and uninstall leftovers (see `build/installer.nsh` `customUnInstall`).

Then it asks whether to also delete user data:

| Choice | Behavior |
|---|---|
| Yes | Clear `%APPDATA%\dsh-desktop`, `%LOCALAPPDATA%\DSH Desktop`, etc., fully clean |
| No (default) | Keep profile, plugins, session, logs; reusable after reinstall |

Silent uninstall (Geek Uninstaller, winget, script `/S`) equals "No" — won't delete data by mistake, won't pop a dialog that jams automation (`MessageBox /SD IDNO`).

Uninstall only deletes what the installer wrote. Anything you put in the install dir yourself is kept.

### Want zero trace? Use the portable edition

The `portable` edition writes no registry, isn't in Program Files; the whole app is one directory, **delete the folder = uninstall**, good for USB carry or machines without admin.

Manual thorough cleanup (installed edition):

```powershell
Remove-Item "$env:APPDATA\dsh-desktop" -Recurse -Force
```

The portable edition needs no such step: its data is in the exe-sibling `dsh-desktop-data\`, gone with the folder.

### Domestic-network acceleration

```powershell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npm run dist:win
```

### About native modules (`node-pty`)

The terminal depends on `node-pty`, a native module, but **you usually don't need to build it locally**:

- The package ships `prebuilds/win32-x64/` prebuilt binaries, and its `.node` uses **N-API** (stable ABI), loadable directly in Electron without recompiling for Electron.
- So `build.npmRebuild` is `false`, **no Visual Studio Build Tools needed at build time**.

If you want to force recompile for Electron, set `build.npmRebuild` to `true` in `package.json` (then you need VS Build Tools and must be able to download the corresponding prebuilt artifacts).

If `node-pty` still fails to load, the app degrades gracefully: the terminal window shows a clear error, **everything else still works**; or remove the dep and repackage, just without a terminal.

---

## 4. Local Development

```powershell
npm install
npm start          # or npm run dev
```

On first launch, if `core/snapshots` is empty, it prompts to download the kernel (~500 deps, 1–2 minutes).

| Command | Verifies what |
|---|---|
| `npm run smoke:terminal` | Built-in terminal and shell detection |
| `npm run smoke:migrate` | **New** legacy migration: adopt / don't overwrite / data rescue / idempotent (pure node, no Electron) |
| `npm run seed:core -- 0.1.5-rc.1` | Install a kernel snapshot with built-in pnpm (verify dep tree runs) |
| `npm run smoke:kernel` | Parse kernel from userData and really start it, get token-bearing URL |
| `npm run smoke:switch` | Kernel switch: success path + failure path (config not corrupted, old kernel self-heals) + **concurrent rejected with `KERNEL_BUSY`** + **progress events** |
| `npm run smoke:phase2` | Remote metadata, dual-channel throttling, plugin manifest, rollback candidate, concurrency lock |
| `npm run smoke:paths` | User-configurable path validation (pure node, 40 cases) |
| `npm run smoke:lock` | Single-instance lock and zombie lock cleanup (pure node, 34 cases) |

Just want to verify the built-in terminal works (without full UI):

```powershell
npm run smoke:terminal
```

It prints the detected shell type and version, and confirms the shell echoes data:

```
[smoke] node-pty available: true
[smoke] shell: PowerShell 7+ (pwsh7) version=7.4.6
[smoke] PASS — shell responded
```

---

## 5. Key Technical Decisions and Pitfall Log

These are all verified on real hardware; read before changing:

**1. `--expose-internals` is required**

dsh's Cordis HMR plugin requires this flag, otherwise:

```
Error: failed to apply loader entry @deepseek-ai/cordis-plugin-hmr:
--expose-internals is required for HMR service
```

It manifests as dsh **crashing immediately after printing the URL**, and Electron loading the URL gets `ERR_CONNECTION_REFUSED`. This flag is added only on the dsh subprocess (`src/main/dsh-launcher.js`).

**2. Under `ELECTRON_RUN_AS_NODE` you can't pass Electron args**

Passing `--no-sandbox` in the subprocess fails directly with `bad option: --no-sandbox`. In this mode the binary parses args as pure Node, only accepting Node flags.

**3. Must wait until the port actually serves**

dsh prints the URL before the HTTP listener is ready; loading directly occasionally fails to connect. `waitUntilServing()` polls until it gets an HTTP response (401/303 also counts as ready).

**4. Web UI has token auth, cookie bound to `host:port`**

```
dsh web: http://127.0.0.1:43779/?token=...
```

The JWT in the cookie is signed bound to `authority: "127.0.0.1:<port>"`, so: **you must parse the token-bearing URL from stdout and then navigate**, not access a fixed address; the port is randomized each time.

**5. Node version**

Must be ≥ 24. If you develop on Node 22, dsh silently exits with code 0; `dsh-launcher.js` therefore added explicit version checks and timeouts. dsh **declares no `engines` field**, so the Node ≥ 24 lower bound is hardcoded in `config-store.js`'s `KERNEL_MIN_NODE_MAJOR` — don't expect it to declare it itself.

**6. pnpm 10 by default doesn't run dependency build scripts**

Since pnpm 10, `install`/`postinstall` of deps are ignored by default; `.npmrc` must set `dangerously-allow-all-builds=true`. Otherwise `node-pty`, `koffi`, `dsh-subprocess-local` will **silently have no native binary**, looking successful but blowing up at runtime. Similarly point `node_pty_binary_host_mirror`, `sharp_*` to domestic mirrors, otherwise scripts pull prebuilt artifacts from GitHub, fail, and fall back to node-gyp, while the user machine has no toolchain.

**7. `node-linker=hoisted`**

dsh has ~522 transitive deps. The default `.pnpm` virtual store adds one more path layer per package, easily hitting the Windows MAX_PATH (260) wall. `hoisted` flattens into a flat `node_modules`, shorter paths.

**8. Start first, then write config**

The kernel-switch order must be `stop → start new snapshot → write config only after success`. The reverse would point `config.json` at a kernel that won't start, **next launch can't run and no kernel is up**. `smoke:switch` verifies this.

**9. Smoke test ≠ production-startable**

At install, a separate `smoke-home` and staging dir do pre-start verification, avoiding polluting the real `DSH_HOME`. This proves "this kernel can come up", but not that it will with a real profile — so a real switch still rolls back on failure.

**10. `.npmrc` lost = "install succeeds but won't run"**

Three switches are indispensable: `node-linker=hoisted` (shorten path), `dangerously-allow-all-builds=true` (pnpm 10 no longer runs dep build scripts by default), binary mirrors (otherwise pull prebuilt from GitHub, fail, fall back to node-gyp). The project-root `.npmrc` and `kernel-package-manager.npmrcFor()` are **two copies of the same config**; change one side must change the other.

> Dotfiles are often lost in packaging transfer (zip upload / some sync tools filter them), so the repo also keeps a **`npmrc.sample`**. `scripts/postinstall.js` auto-copies it if root `.npmrc` is missing at `npm install` — after getting the source, just `npm install`, nothing else.

**11. Kernel process start/stop can't be waited synchronously**

`execSync('taskkill /pid <pid> /T /F')` is simplest to write, but it **synchronously blocks Electron's main event loop**: during switch the window doesn't repaint, IPC doesn't respond, `waitUntilServing()` polling all stalls. The user sees "click once, freeze, then crash" — with nothing in the log, extremely hard to locate. Always switch to `spawn('taskkill', …)` + timeout wait (see `dsh-launcher.js`'s `killTreeAsync`).

**12. Kernel lifecycle ops must be serialized**

Both "switch" and "restart" contain `stop → start`. Concurrently the later `stop()` kills the just-launched process, and `config.json` gets written to nobody's value. Use `#exclusive` re-entry lock: busy → **explicitly throw `KERNEL_BUSY`**, no queueing — one switch can take 90 seconds, queueing and hanging are indistinguishable, while rejection is a clean IPC error the UI can friendly-prompt.

**13. POSIX tree-kill must kill the "process group", not the child**

`child.kill()` only kills the direct child. dsh launches plugin children too, left behind as orphans holding the port and file handles (manifests as "clearly exited, but restart says port in use / file locked"). Spawn with `detached: true` so the child forms its own process group (then `pgid === pid`), then `process.kill(-pgid, 'SIGTERM')`, then `SIGKILL` on timeout. Windows needs no `detached`, uses `taskkill /T`.

---

## 6. Relationship with the community project dsh-desktop

[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) is a mature community project; this project's architecture borrows its core ideas: random loopback port + readiness detection, user-data externalization, renderer hardening, `--expose-internals` granted only to the subprocess.

Differences:

| | This project | dsh-desktop |
|---|---|---|
| Language | JavaScript (quick to start) | TypeScript |
| dsh version | Locked `0.1.5-rc.1` | Locked `0.1.0-rc.6` / `0.1.1-rc.1` |
| Kernel update | **Kernel externalized + snapshot/rollback** | Kernel upgrades with installer |
| Built-in terminal | ✅ | Not seen |
| preset import/export | ❌ | ✅ `.dshpreset` |
| UI patch mechanism | ❌ | ✅ `patch-package` |

---

## 7. Known Limitations

- **Both Windows x64 and Linux x64 are supported and verified on real hardware.**
  Windows: 0.1.2 NSIS installer and portable both run on real hardware (incl. `node-pty` terminal, `asar` code verification).
  Linux: 0.1.2 packaged on a Linux x64 host (AppImage + deb) and verified startup, kernel download, kernel start, and terminal; see the Linux subsection in section 2 for the measured table. **Running as root, and running inside a Docker container, are still unverified**; if it won't start in your environment, you can add `app.commandLine.appendSwitch('no-sandbox')` before `app.whenReady()` (recommended only on Linux and when `process.getuid?.() === 0`; don't blindly disable the sandbox globally).
  Linux packages can only be built on a Linux host (see section 2). The official Harness desktop hasn't listed Linux as a release target either.
- During kernel switch / restart, initiating another same-kind op is rejected with `KERNEL_BUSY` (UI shows "please try later"). This is deliberate design, not a defect — see section 2.9.
- dsh is still a `0.1.x-rc` developer preview, shipping 20 versions a month, **version must be locked** (current `0.1.5-rc.1`). The kernel panel can list and switch installed versions, but **won't auto-jump to an unverified rc**.
- The kernel no longer goes in the installer; installer size drops significantly; the cost is **first launch (or after machine change) needs network to download the kernel**.
- A kernel snapshot is a full dep tree, ~300–400 MB each; `keepSnapshots` keeps 3 by default, clearable in the panel.
- Dev `node_modules` is still ~700 MB (incl. Electron and pnpm binaries).
- Windows MAX_PATH (260) is still a hard constraint: mitigated by `node-linker=hoisted`, but **very deep nested dirs may still trigger it**; keep both install path and user dir shallow.
- **App self-update not yet verified on real hardware**: `package.json`'s `build.publish` isn't configured, so the packaged output has no `app-update.yml`; needs `config.app.updateUrl` (or publish config) in place to verify. When unconfigured the whole chain is disabled, no side effects.
- macOS has no signing/notarization config; macOS build needs extra config.
- Upstream has `apps/desktop` in progress; it may overlap with this project's role in the future.

## 8. License

MIT
