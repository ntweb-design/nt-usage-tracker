# NT Usage Tracker — How to use

**English** · [Português (Brasil)](HOW-TO-USE.pt-BR.md) · [Back to the README](README.md)

Everything about installing, reading and arranging the widget, connecting each provider and server, and where your data lives.

> The app only reads. It never changes your accounts, never refreshes or copies your CLI sign-ins, and sends nothing anywhere except the usage requests each provider already answers for its own CLI.

---

## Contents

- [Install](#install)
- [Reading the widget](#reading-the-widget)
- [AI providers](#ai-providers)
- [This PC](#this-pc)
- [VPS servers](#vps-servers)
- [Arranging the boxes](#arranging-the-boxes)
- [Menus and settings](#menus-and-settings)
- [Usage report and cost](#usage-report-and-cost)
- [Privacy: what is stored where](#privacy-what-is-stored-where)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [Project layout](#project-layout)

---

## Install

1. Download `NT-Usage-Tracker-Setup-<version>.exe` (or [build it yourself](#building-from-source)).
2. Run it. It installs for your Windows user only, without asking for administrator rights.
3. The installer is not code-signed, so Windows SmartScreen warns on the first run: choose **More info › Run anyway**.

The widget appears on the right edge of the screen, with a tray icon next to the clock. To start it with Windows, right-click a box › **Start with Windows**.

Requirements: Windows 10 or 11. The VPS feature uses Windows' built-in OpenSSH client (`C:\Windows\System32\OpenSSH\ssh.exe`), which current Windows versions include.

## Reading the widget

Every icon sits inside two rings:

| | AI boxes | PC and VPS boxes |
|---|---|---|
| **Outer ring** | the long window (weekly or monthly): how much is **left** | the main reading: how much is **in use** |
| **Inner ring** | the 5-hour window: how much is **left** | a second reading (see each box below) |
| **Colour** | green → amber at 30 % left → red at 10 % left | green → amber at 75 % used → red at 90 % used |

- **Hover** an icon for details: every limit with its reset time, today's tokens, or the full resource readings.
- **Click** an AI icon to open the usage report for that provider.
- A **red dot** means the reading needs attention (signed out, or a server offline). An **amber dot** means the numbers are from an older reading.
- A dimmed icon has nothing to show yet.

## AI providers

A provider shows up by itself when its CLI is installed or has left data on this machine. To hide one, right-click › **Providers**.

| Provider | Limits | Usage (tokens) |
|---|---|---|
| **Claude Code** | 5-hour and weekly limits from your account, using the sign-in in `~/.claude/.credentials.json` | transcripts in `~/.claude/projects` |
| **Codex CLI** | 5-hour and weekly limits from your ChatGPT account (`~/.codex/auth.json`); falls back to the last reading in the CLI's logs when offline | `~/.codex/sessions` |
| **Grok CLI** | the last credit check the CLI wrote to `~/.grok/logs/unified.jsonl` (refreshed when the CLI runs) | same log |
| **OpenCode** | OpenCode Go plan (5 hours, weekly, monthly), using your OpenCode Console sign-in (`opencode auth login`) or your Go key | `~/.local/share/opencode/opencode.db` |
| **Gemini (Antigravity)** | Google's quota for your plan (5 hours and weekly, per model group), using the sign-in `agy` keeps in the Windows Credential Manager or in `~/.gemini/…oauth-token` | — |
| **Claude API** | optional monthly budget against this month's spend | the organization's Usage and Cost API (needs a key, see below) |

**Signing in.** Right-click › **Connect account** opens a terminal with the CLI's own sign-in command (`claude auth login`, `codex login`, `grok login`, `opencode auth login`, `agy`). The CLI runs its official browser sign-in and the widget picks it up on the next refresh. The app has no sign-in of its own.

**Gemini note.** Google's access token lasts one hour and only `agy` renews it, so the widget keeps the last reading and shows "Last reading … ago" once the token expires. That is fine in practice: the quota only moves when you use `agy`, which renews the token.

### Claude API

The Claude API (Console) has no CLI sign-in to borrow, so it needs a key. Right-click › **Connect account › Claude API (Admin key)…**, then paste:

- an **Admin key** (`sk-ant-admin…`, created by an organization admin in Console › Settings › Admin keys), or
- the **personal key** (`sk-ant-usr…`) of an account with the admin role that is **not tied to a workspace**.

The key is checked with Anthropic before it is saved:

- **401**: the key is invalid, expired or deleted. Keys have an expiry chosen when they are created.
- **403**: the account is not an admin, or the key is tied to a workspace.

The saved key is encrypted with Windows (DPAPI) and only handed to the collector in memory. Add a **monthly budget** in US$ to get a ring for it. Anthropic processes this data with a delay of about 4 hours (up to 24 h), so today always looks incomplete. The tooltip says how fresh the data is.

## This PC

| Icon | Outer ring | Inner ring |
|---|---|---|
| CPU | total use | busiest core |
| Memory | RAM in use | commit (RAM + swap) |
| GPU | load | VRAM |

CPU and RAM come from Node. GPU, VRAM and commit come from Windows performance counters through a small PowerShell helper, so any GPU vendor works. Turn the box on or off with right-click › **PC monitor**.

## VPS servers

Each server gets its own box:

| Icon | Outer ring | Inner ring |
|---|---|---|
| CPU | total use | busiest core |
| Memory | RAM in use | swap |
| Disk | `/` used | disk busy (I/O) |

The tooltip also shows load average, network in/out, host name, OS and uptime. An offline server is dimmed with a red dot, and the tooltip says why (for example "the VPS did not accept the key" or "host not found"). The app reconnects by itself.

**Adding a server:** right-click › **VPS › Add VPS…**

1. **Name**: the label shown above the box.
2. **Host**: an IP, a Tailscale name, or any `Host` from your `~/.ssh/config`. Port and user are optional.
3. **Key**: pick one of four modes.
   - **SSH default**: whatever Windows' `ssh` would use already (`~/.ssh`, ssh-agent, Tailscale SSH).
   - **Private key file**: any key file without a passphrase (or one loaded into ssh-agent).
   - **Paste a private key**: saved only on this machine, in the app's data folder, readable only by your Windows user.
   - **Generate a new key in the app**: creates an ed25519 pair and shows the public key, with a **Copy command** button. Run that command on the server, from the provider's console or an SSH session that already works; it adds the key to `~/.ssh/authorized_keys`.
4. **Test connection**, then **Save**.

How it works: one SSH session stays open per server and reads `/proc` every 2 seconds with a small shell loop. **Nothing is installed on the server, and it does not need root.** The first connection remembers the server's host key in the app's own `known_hosts`; if that key ever changes, the connection is refused.

Each server's own submenu (right-click › **VPS**) has **Show**, **Edit…**, **Reconnect** and **Remove…**.

## Arranging the boxes

Drag any box with the mouse.

- **Anywhere**: a box stays where you drop it.
- **Screen edges**: near an edge it docks to it. It turns vertical on the left and right edges and horizontal at the top and bottom. Near the end of an edge it goes into the corner; near the middle, it centres on the edge.
- **Screen centre**: dropped near the horizontal or vertical centre line, it lines up on it.
- **Other boxes**: near any side of another box (top, bottom, left or right), it attaches there. Along that side it snaps to the nearer corner, to the centre, or to a grid of icon steps. The grid lets a box hang one or two icons past the other, so you can build steps, podiums or triangles. A box never attaches where it would cover another one.
- Snaps **glide** into place instead of jumping.

Boxes that are attached form a group:

- Dragging the group's main box (the one not attached to anything) moves the whole group.
- Dragging any other box pulls it out, together with the boxes attached to it.

Grid size: right-click › **Snap grid** › 1 icon, half an icon, or corners and centre only.

Each box has a small name above its meters ("AI", "This PC", or the server's name). Change it with right-click › **Rename this box…**, and hide all names with **Show box names**.

## Menus and settings

**Right-click any box:**

| Item | What it does |
|---|---|
| Open report / Refresh now | open the usage report; read everything again right away |
| Providers | show or hide each AI provider |
| Connect account | sign in to a CLI, or enter the Claude API key |
| PC monitor | show or hide the PC box |
| VPS | add, edit, show/hide, reconnect or remove servers |
| Rename this box… / Show box names / Snap grid | box names and snapping |
| Language | English or Português (Brasil) |
| Start with Windows / Open data folder / Quit | |

**Tray icon** (click it): usage report, hide/show the widget, transparency, light mode, language, about, close.

Limits refresh every 90 seconds. Position, transparency, theme, language and grid are remembered.

## Usage report and cost

Click an AI icon, or use **Open report**. You can switch between tokens and cost, between today, 7 days and 30 days, and between all providers or a single one. The breakdown groups usage by model, by day or by provider.

- **Claude API** cost is the real amount Anthropic reports, after discounts.
- **CLI** cost is an **estimate** at API list prices per model family. Subscriptions are not billed per token, so read it as "what this would have cost on the API". Edit the prices in `pricing.json` in the data folder; models with no matching rule show no cost.
- OpenCode reports its own cost per message, and that is used as is.

## Privacy: what is stored where

Nothing personal lives in the program folder or in this repository. Everything the app keeps is in your Windows profile:

| Where | What |
|---|---|
| `%APPDATA%\nt-usage-tracker\state.json` | box positions, settings, the list of servers (name, host, user, port, and the path to a key file; never the key itself) |
| `%APPDATA%\nt-usage-tracker\claude-api-admin.key` | the Claude API key, encrypted with Windows (DPAPI) |
| `%APPDATA%\nt-usage-tracker\ssh\` | keys the app generated or that you pasted (readable only by your user), and the app's `known_hosts` |
| `%APPDATA%\nt-usage-tracker\cache\`, `pricing.json` | parsed usage cache, price table |

The app **reads** these sign-ins and never writes to them: `~/.claude`, `~/.codex`, `~/.grok`, OpenCode's database, `~/.gemini`, the `gemini:antigravity` entry in the Windows Credential Manager, and your `~/.ssh/config`.

Network calls go only to each provider's own usage endpoint (the same ones its CLI uses), to Anthropic for the Claude API, and over SSH to the servers you add.

## Troubleshooting

| Symptom | Try |
|---|---|
| A provider is missing | Its CLI is not on `PATH` and has no data yet. Run the CLI once. |
| "Sign-in expired" | Open that CLI, which renews its own sign-in. The widget never refreshes tokens itself. |
| Gemini shows "Last reading … ago" | Normal once the 1-hour token expires; it updates the next time you use `agy`. |
| OpenCode shows usage only | The account has no OpenCode Go subscription, or you are not signed in to the OpenCode Console. |
| Claude API: 401 | The key expired or was deleted. Create a new one (choose a long expiry). |
| Claude API: 403 | Use an Admin key, or the personal key of an admin that is not tied to a workspace. |
| VPS: "did not accept the key" | The public key is not in `~/.ssh/authorized_keys` of that user. Use **Copy command** in the VPS window. |
| VPS: "host not found" | Check the name or IP, or turn on Tailscale. |
| VPS: "key has a passphrase" | Use a key without a passphrase, or load it into ssh-agent. |
| SmartScreen warning | The installer is not signed: **More info › Run anyway**. |

## Building from source

```bash
npm install
npm start            # run the widget
npm run collect      # print what the collector finds, in the terminal
npm run dist         # build the installer into dist/
```

If `npm install` does not download Electron's binary, run `node node_modules/electron/install.js`.

Developer switches (environment variables):

| Variable | Effect |
|---|---|
| `UT_DATA=<folder>` | use a separate settings folder, so a dev copy runs next to the installed one |
| `UT_SHOT=<folder>` | capture each window to PNG, then quit |
| `UT_DRAGTEST=1` | run the scripted drag-and-snap checks with a simulated cursor |
| `ANTHROPIC_ADMIN_KEY=…` | Claude API key for `npm run collect` |

## Project layout

```
src/
  main.js        windows, drag and snap, tooltip, menus, VPS and settings windows
  i18n.js        interface text (English, with the Brazilian Portuguese table)
  sysmon.js      PC monitor (+ sysmon.ps1 for GPU/VRAM/commit counters)
  vpsmon.js      VPS monitor over SSH, key generation and connection test
  preload.js     the bridge between the windows and the main process
  collect/       one collector per provider, run in a worker thread
    vault.ps1    reads the Antigravity sign-in from the Windows Credential Manager
  ui/            widget boxes, tooltip, report, tray menu and small windows
scripts/         icon generator
build/           app icon
```
