// Sandboxes: every Docker Sandbox (sbx) on this machine, as a Herdr panel.
// Status, CPU / memory / disk, and the network requests the sandbox policy blocked.
//
// Read-only: runs `sbx daemon status`, `sbx ls --json`, `sbx policy log --json` and,
// in running sandboxes, a short `sbx exec` that reads /proc and df. It never starts
// the sbx daemon and never changes a sandbox. Output formats checked against sbx 0.47.0.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, home } from "herdr";

const EVERY = 10 * 1000;          // ms between sbx ls / policy log
const HEALTH_EVERY = 15 * 1000;   // ms between health probes per running sandbox
const TIMEOUT = 8000;             // ms per sbx call
const PROBE = "cat /proc/stat | head -1; cat /proc/meminfo | head -3; df -P -k /home/agent | tail -1; nproc";

// The first JSON object in text: `sbx ls` can print an update box after it.
function firstJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseProbe(stdout) {
  const s = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const num = (rest) => Number(rest.trim().split(/\s+/)[0]);
    if (line.startsWith("cpu ")) {
      const f = line.slice(4).trim().split(/\s+/).slice(0, 8).map(Number);
      if (f.length >= 5 && f.every(Number.isFinite)) {
        s.cpuTotal = f.reduce((a, b) => a + b, 0);
        s.cpuIdle = f[3] + f[4];
      }
    } else if (line.startsWith("MemTotal:")) s.memTotal = num(line.slice(9));
    else if (line.startsWith("MemAvailable:")) s.memAvail = num(line.slice(13));
    else if (/^\d+$/.test(line)) s.cpus = Number(line);
    else {
      const f = line.split(/\s+/);
      if (f.length >= 6 && f[4].endsWith("%")) s.disk = Number(f[4].slice(0, -1));
    }
  }
  return s;
}

const pct = (n) => (n == null || !Number.isFinite(n) ? "–" : `${Math.round(n)}%`);

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortPath(p) {
  const h = home();
  return p && h && p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p ?? "";
}

export default class Sandboxes extends View {
  init(_props, cx) {
    this.state = "loading"; // loading | ok | off | missing | error
    this.message = "";
    this.boxes = [];
    this.blocked = {};      // vm name → [{ host, count, last, reason }]
    this.health = {};       // vm name → { prev, cpu, mem, disk, at }
    this.open = new Set();  // expanded rows
    this.busy = false;
    this.poll(cx);
    cx.timer.every(EVERY, (cx) => this.poll(cx));
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.read();
      } catch (e) {
        this.state = "error";
        this.message = String(e?.message ?? e);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  async read() {
    let daemon;
    try {
      daemon = await exec("sbx", ["daemon", "status"], { timeout: TIMEOUT });
    } catch {
      this.state = "missing";
      return;
    }
    if (daemon.code !== 0 || !/Status:\s*running/i.test(daemon.stdout)) {
      this.state = "off";
      this.boxes = [];
      return;
    }

    const ls = await exec("sbx", ["ls", "--json"], { timeout: TIMEOUT });
    const list = ls.code === 0 ? firstJson(ls.stdout) : null;
    if (!list) {
      this.state = "error";
      this.message = (ls.stderr || ls.stdout || "sbx ls failed").trim().split("\n").slice(0, 2).join(" ");
      return;
    }
    this.boxes = Array.isArray(list.sandboxes) ? list.sandboxes : [];
    this.state = "ok";

    const log = await exec("sbx", ["policy", "log", "--json"], { timeout: TIMEOUT });
    const pol = log.code === 0 ? firstJson(log.stdout) : null;
    if (pol) {
      const by = {};
      for (const b of pol.blocked_hosts ?? []) {
        if (!b?.vm_name || !b?.host) continue;
        (by[b.vm_name] ??= []).push({ host: String(b.host), count: Number(b.count_since) || 1, last: b.last_seen, reason: b.reason ?? "" });
      }
      for (const k of Object.keys(by)) by[k].sort((a, b) => (Date.parse(b.last) || 0) - (Date.parse(a.last) || 0));
      this.blocked = by;
    }

    const now = Date.now();
    const running = this.boxes.filter((b) => b.status === "running");
    await Promise.all(running.map(async (b) => {
      const h = this.health[b.name];
      if (h && now - h.at < HEALTH_EVERY) return;
      try {
        const r = await exec("sbx", ["exec", b.name, "sh", "-c", PROBE], { timeout: TIMEOUT });
        if (r.code !== 0) return;
        const s = parseProbe(r.stdout);
        const prev = h?.prev;
        let cpu = h?.cpu ?? null;
        if (prev?.cpuTotal != null && s.cpuTotal > prev.cpuTotal) {
          cpu = 100 * (1 - (s.cpuIdle - prev.cpuIdle) / (s.cpuTotal - prev.cpuTotal));
        }
        const mem = s.memTotal ? 100 * (1 - s.memAvail / s.memTotal) : null;
        this.health[b.name] = { prev: s, cpu, mem, disk: s.disk ?? null, at: now };
      } catch {
        // a slow or stopped sandbox: keep the last reading
      }
    }));
    for (const name of Object.keys(this.health)) {
      if (!running.some((b) => b.name === name)) delete this.health[name];
    }
  }

  row(b, t) {
    const color = b.status === "running" ? (t.ansi2 ?? t.working) : b.status === "stopped" ? t.dim : (t.ansi3 ?? t.done);
    const blocked = this.blocked[b.name] ?? [];
    const hits = blocked.reduce((n, x) => n + x.count, 0);
    const h = this.health[b.name];
    const open = this.open.has(b.name);
    const folder = (b.workspaces ?? [])[0];
    return v_flex().flex_none()
      .child(h_flex().id(`sb-${b.name}`).px(8).h(30).flex_none().rounded(8).items_center().gap(9)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.open.delete(b.name) : this.open.add(b.name); cx.notify(); })
        .child(div().size(7).flex_none().rounded(4).bg(color))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).truncate().text_color(b.status === "running" ? t.foreground : t.muted).child(b.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(b.agent ?? "")))
        .when(hits > 0, (e) => e.child(div().id(`sb-hits-${b.name}`).flex_none().px(5).h(17).rounded(5).bg(t.blocked + "26")
          .text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center()
          .tooltip(`${blocked.length} blocked host${blocked.length === 1 ? "" : "s"}, ${hits} request${hits === 1 ? "" : "s"}`)
          .child(`${hits} blocked`))))
      .when(b.status === "running" && h != null, (e) => e.child(
        div().pl(24).pr(8).mt(-6).pb(4).text_size(11).text_color(t.dim)
          .child(`CPU ${pct(h.cpu)} · Mem ${pct(h.mem)} · Disk ${pct(h.disk)}`)))
      .when(open, (e) => e.child(v_flex().pl(24).pr(8).pb(6).gap(2).text_size(11).text_color(t.dim)
        .when(Boolean(folder), (e) => e.child(div().truncate().child(shortPath(folder))))
        .child(div().text_color(t.muted).child(b.status))
        .when(blocked.length === 0, (e) => e.child(div().child("No blocked requests")))
        .children(blocked.slice(0, 8).map((x, i) => h_flex().id(`sb-host-${b.name}-${i}`).gap(6).items_center()
          .tooltip(x.reason || x.host)
          .child(div().flex_1().min_w(0).truncate().text_color(t.blocked).child(x.host))
          .child(div().flex_none().child(`×${x.count} · ${ago(x.last)}`))))
        .when(blocked.length > 8, (e) => e.child(div().child(`+${blocked.length - 8} more`)))));
  }

  render(cx) {
    const t = theme();
    const running = this.boxes.filter((b) => b.status === "running").length;
    const note = {
      loading: "Reading sandboxes…",
      off: "The sbx daemon is off. Sandboxes show up here while it runs.",
      missing: "sbx is not installed.",
      error: this.message,
      ok: this.boxes.length === 0 ? "No sandboxes. Start one with sbx run claude." : null,
    }[this.state];
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Sandboxes"))
        .when(this.boxes.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim)
          .child(`${running}/${this.boxes.length} running`))))
      .when(note != null, (e) => e.child(div().px(16).text_size(12).text_color(this.state === "error" ? t.blocked : t.dim).child(note)))
      .child(v_flex().id("sb-list").flex_1().min_h(0).px(8).overflow_y_scrollbar()
        .children(this.boxes.map((b) => this.row(b, t))));
  }
}
