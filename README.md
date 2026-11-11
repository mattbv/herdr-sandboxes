# Sandboxes for Herdr

![Sandboxes](preview.png)

A [Herdr](https://herdr.dev) desktop app mod that shows your [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) beside your agents: which sandboxes run, how much CPU, memory and disk they use, and which network requests the sandbox policy blocked.

It only runs `sbx`. No server, no extra service, nothing to install besides the mod.

## What you see

- **One row per sandbox:** a status dot (green: running, grey: stopped), its name and its agent.
- **Health:** `CPU · Mem · Disk` under each running sandbox.
- **Blocked requests:** a red `N blocked` badge when the policy blocked network requests from that sandbox.
- **Click a row** for its workspace folder, the blocked hosts (how often, how long ago) and a usage chart.
- **Usage over time:** CPU, memory and disk as lines on one 0–100% chart, over the last 15 minutes, hour or 6 hours. Hover for the values at a moment.
- When there is nothing to show, it says why: no sandboxes, the `sbx` daemon is off, or `sbx` is not installed.

## Agents in sandboxes already work in Herdr

Run an agent with `sbx run claude <folder>` in a Herdr tab. Herdr tracks it like any other agent: working, done and blocked status, the agents list, notifications and the conversation title. Claude Code reports its status to its terminal, and `sbx` passes it through. This mod adds what Herdr can't see: the sandbox around the agent.

## Install

Ask the agent in your Herdr window:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/mattbv/herdr-sandboxes
```

It reads [RECIPE.md](RECIPE.md) and the files, tells you what the mod runs, copies `mods/sandboxes/` and adds the Sandboxes button next to Files and Changes. Say "in the sidebar" if you want it under the Agents list instead.

Or by hand. Copy the mod (its `mod.json` keeps Herdr from docking it on its own):

```sh
git clone https://github.com/mattbv/herdr-sandboxes.git
cp -R herdr-sandboxes/mods/sandboxes ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/sandboxes
```

Then put it in a layout of your own (Herdr's shipped layouts are read-only; clone one first with `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`). Pick one of these.

### As a side panel, next to Files and Changes

1. Add a block to the `panel-body` stack in your layout:

   ```json
   { "id": "sandboxes", "type": "block", "content": { "mod": "sandboxes" } }
   ```

2. Herdr's tab bar (the shipped `tabs` mod) draws only the Files and Changes buttons. To get a Sandboxes button, clone it and point your layout's `tabs` block at the clone:

   ```sh
   herdr-app do mod.clone '{"name":"tabs","as":"tabs-panels"}'
   ```

   In `~/.config/herdr-app/mods/tabs-panels/main.js`, make two changes:

   ```js
   // 1. Replace the `enabled` line:
   const extra = find(root, "sandboxes") ? ["sandboxes"] : [];
   const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...extra];

   // 2. After the Changes button:
   .when(enabled.includes("sandboxes"), el => el.child(panelButton("sandboxes", "Sandboxes", "mods/sandboxes/box.svg")))
   ```

   A cloned mod does not get Herdr's updates to the tab bar. Clone it again after an update if you want them.

### In the sidebar, under Agents

Add a block to the `sidebar-lists` column. `"sidebar": true` gives it the look of the Agents list instead of a side panel card:

```json
{ "id": "sandboxes", "type": "block", "content": { "mod": "sandboxes", "props": { "sidebar": true } }, "size": { "weight": 0.6 }, "min": 80 }
```

## Usage history

While **Rec** in the panel header is on (the default), each health reading is kept for 6 hours, also across restarts, in the mod's own storage (`~/.config/herdr-app/data/sandboxes/store.json`). It never leaves your machine. Click **Rec** to pause, and **Clear** under a chart to forget that sandbox's history. Recording continues while the panel is closed, as long as the layout that holds it is shown.

The chart colors (blue, orange, aqua) were checked for color-vision deficiency on light and dark backgrounds, and the legend always shows each value as text.

## What it runs

Every 10 seconds, read-only:

- `sbx daemon status`: if the daemon is off, the mod stops here. It never starts the daemon.
- `sbx ls --json`: the sandboxes.
- `sbx policy log --json`: blocked network requests.
- Every 15 seconds, in each running sandbox: `sbx exec <name> sh -c '…'`, which reads `/proc/stat`, `/proc/meminfo`, `df` and `nproc`.

It never creates, stops, removes or changes a sandbox or its policy, and it makes no network requests of its own. Output formats were checked against `sbx` 0.47.0 on macOS.

## Credits

The box icon is [Lucide](https://lucide.dev)'s `box` (ISC).

## License

[MIT](LICENSE)
