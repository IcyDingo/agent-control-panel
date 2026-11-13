# Glue for Linux: a downloadable app

## Context

Glue runs only on macOS. Each person clones the repo and `./install.sh` compiles a Swift/WKWebView window
(`app/main.swift`) around the local Node server and installs a launchd service. Nothing can be downloaded, there is
no CI, and the Mac app bakes in absolute paths to the clone and to the user's Node.

The server and the page are nearly platform-neutral already. What is Mac-only is the window, the background
service, where data lives, and five things the server asks the Mac to do (Terminal for sign-in and trust, the folder
dialog, notifications, and `script(1)` to hand a message to a running job).

What you decided:

- **Who it is for:** the public. A download, not clone-and-build.
- **How:** an Electron window around the existing Node server. Not a Go or Rust rewrite: the server waits on Claude
  Code and its subprocesses, so a faster language would not show. The shell stays thin, so a later mobile client or a
  hosted relay can reuse the server and the page.
- **Shared machines:** the server gives its token to anything on the machine that asks for the page
  (`GET /`). Ship first, fix after: this work says in the README that Glue is for a machine one person uses, and the
  Linux app attaches only to a server it started. A per-user secret is a follow-up.

Calls made here, not yours:

- The Mac app stays the Swift one. Only Linux is built and released.
- No systemd service. The app keeps the server alive: closing the window hides it, and **Start at login** (off by
  default) writes an autostart entry.
- AppImage and .deb, x64 and arm64. No rpm, Flatpak or Snap.
- Only the AppImage updates itself. A .deb gets a notice with a link.
- CI makes draft releases; a person publishes them.
- New Agent is Ctrl+Shift+T and Reload is Ctrl+Shift+R: plain Ctrl+T, Ctrl+R and Ctrl+W belong to the embedded
  `claude attach` terminal.

## Goals, non-goals, anti-goals

**Goals.** Someone with Claude Code and python3 on a Linux desktop downloads one file, opens it, and gets the panel
with everything the Mac app does that Linux has an equivalent for. A version tag builds, smoke-tests and drafts a
release with no manual steps.

**Non-goals.** Replacing the Mac app; Windows; a systemd service; rpm, Flatpak, Snap; code signing; the per-user
secret; remote or mobile access.

**Anti-goals.** A Linux app that changes how the Mac app or `node server.mjs` behave. Dependencies the server
needs at run time (it stays standard-library only; `node server.mjs` still runs with no `npm install`). A release
that publishes itself.

## The shell (`desktop/main.mjs`)

It does what `app/main.swift` does, on Electron:

- **Server.** Spawns the bundled `server.mjs` on Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), logging to
  `~/.local/state/glue/server-<port>.log`. It restarts one that ran for more than 30 s and then stopped, reports
  `EADDRINUSE`, and on quit sends SIGTERM, waits 3 s, then SIGKILL. The server deletes `ELECTRON_RUN_AS_NODE` from
  its own environment first, so no session it starts inherits it.
- **Own server only.** The pid of the server it started is kept in `~/.config/glue/server-<port>.pid`. If the port
  already answers as Glue, the app attaches only when that pid is alive and its own to signal; otherwise it says the
  port is in use.
- **Environment.** AppImage adds itself to `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR`;
  those entries and `APPDIR`, `APPIMAGE`, `OWD`, `ARGV0`, `ELECTRON_*` and `CHROME_DESKTOP` are removed before
  anything is spawned. `PATH` is then the login shell's (asked once, with a timeout), plus `~/.local/bin` and the
  usual places, since a launcher starts apps with less than a terminal has.
- **Before it starts.** If `python3` or `claude` is missing, a page says what to install.
- **Window.** One instance; a second launch shows the window. Closing hides it and the panel stays connected. The
  first close says so once, since plain GNOME shows no tray. Other sites open in the browser.
- **Count.** "(3) Glue" becomes a launcher badge where the desktop has one, the tray tooltip, and a flash when a
  request arrives while you are elsewhere.
- **Menu** (bar hidden, shortcuts live): New Agent, Reload, zoom, full screen, Start at login, Add to applications
  menu (AppImage), Check for updates / Restart to update, Quit.

## The page bridge

`window.glueApp = { newAgent, focus(), pickFolder(start), setTheme(theme) }`, exposed by a sandboxed preload. The
page's edits are guarded, so a browser and the Mac app see no change: a notification click also asks the app to
come forward; the folder button uses the app's dialog when there is one; the theme goes to the app as the choice
itself (`system` stays `system`, so it keeps following the desktop); and "Match the Mac", "System Settings" and
`brew install gh` get neutral words off a Mac.

## Look

The page is the same one. Three things keep it from looking worse: Geist and Geist Mono ship with the app instead
of loading from Google Fonts (same look offline, no request at launch; the Mac app and browsers gain this too);
scrollbars are thin and in the theme's colours off a Mac, where Chromium otherwise draws wide ones; and the window
has the desktop's own title bar, dark or light with the theme.

## The server on Linux

| What | Mac | Linux |
|---|---|---|
| A message for a running job | `script -q /dev/null claude --resume …` | `pty-bridge.py`, as the embedded terminal uses |
| Sign-in and trust | zsh `.command`, `open -a Terminal` | bash script, the desktop's terminal (`terminal.mjs`) |
| Folder dialog | osascript | the app's dialog; a browser types the path |
| Notification with no page open | osascript | `notify-send`, where installed |
| `gh` when PATH lacks it | Homebrew's folders | `/usr/bin`, `~/.local/bin`, linuxbrew, snap |
| Deleted-version check | lsof (TCC) | none: nothing refuses a session over it |
| Data, logs | `~/Library/…/Glue` | `~/.config/glue`, `~/.local/state/glue` (XDG variables honoured) |
| `daemon` command | launchd | says to use Start at login |

A packaged server (`ACP_PACKAGED=1`) reads the page once, so an upgrade under a running app cannot pair an old
server with a new page.

## Packaging, updates, release

electron-builder makes an AppImage (static runtime, so no libfuse2; one file name per architecture, so an update
replaces it in place) and a .deb (which ships an AppArmor profile, so Chromium's sandbox works on Ubuntu 24.04 and
later; the AppImage starts without the sandbox there). Files are not packed into an archive: python3 reads the
helper scripts as files.

`electron-updater` reads GitHub Releases. An AppImage downloads the new version and offers **Restart to update**.
A .deb is told a new version exists.

`ci.yml` runs the tests on Linux x64, Linux arm64 and macOS. `release.yml` builds on both Linux architectures, runs
the packaged app headless (it must load the page, find `window.glueApp`, save a screenshot and exit 0; the .deb is
installed first), and on a `v*` tag one last job checks the tag against `package.json` and drafts the release.

## What can't be checked without a Linux desktop

Tray, badge, notification clicks, raising the window on Wayland, which terminal opens, and the folder dialog on
real GNOME and KDE; a live session against a signed-in Claude Code; an update between two published releases.
