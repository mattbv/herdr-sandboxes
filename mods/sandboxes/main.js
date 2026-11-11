// Sandboxes: every Docker Sandbox (sbx) on this machine, as a Herdr panel.
// Status, CPU / memory / disk, and the network requests the sandbox policy blocked.
//
// Runs `sbx daemon status`, `sbx ls --json`, `sbx policy log --json` and, in running
// sandboxes, a short `sbx exec` that reads /proc and df (sbx counts that as use: the
// sandbox's last_used_at moves). It never starts the sbx daemon and never creates,
// stops, removes or changes a sandbox or its policy. Formats checked against sbx 0.47.0.
import { View, div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, home, props, settings } from "herdr";

const EVERY = 10 * 1000;          // ms between sbx ls / policy log
const HEALTH_EVERY = 20 * 1000;   // ms between health probes per running sandbox (every 2nd poll)
const TIMEOUT = 8000;             // ms per sbx call
const RETAIN = 6 * 3600 * 1000;   // ms of usage history kept per sandbox
const RANGES = [[15 * 60 * 1000, "15m"], [3600 * 1000, "1h"], [6 * 3600 * 1000, "6h"]];
const SLICES = 60;                // hover columns across a chart
const PLOT_H = 76;                // px, chart height
const BUCKETS = 120;              // most points drawn per line
// Chart series: blue, orange, aqua (validated for color-vision deficiency on light
// and dark surfaces; values and labels are always shown as text too).
const SERIES = [
  { key: 1, label: "CPU", light: "#2a78d6", dark: "#3987e5" },
  { key: 2, label: "Mem", light: "#eb6834", dark: "#d95926" },
  { key: 3, label: "Disk", light: "#1baf7a", dark: "#199e70" },
];
const PROBE = "cat /proc/stat | head -1; cat /proc/meminfo | head -3; df -P -k /home/agent | tail -1";

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
    else {
      const f = line.split(/\s+/);
      if (f.length >= 6 && f[4].endsWith("%")) s.disk = Number(f[4].slice(0, -1));
    }
  }
  return s;
}

// A 15% tint of a theme color, when it is a plain #rrggbb.
const tint = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? `${c}26` : fallback);

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

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: keep in memory */ }
}

// Stored history must be { name: [[ms, cpu, mem, disk], ...] }; anything else is dropped.
function validHistory(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) out[k] = v.filter((p) => Array.isArray(p) && p.length === 4 && Number.isFinite(p[0]));
  }
  return out;
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
    this.open = new Set(load("open", []));  // expanded rows, kept across restarts
    this.busy = false;
    this.recording = load("record", true);
    this.hist = validHistory(load("history", {}));   // vm name → [[ms, cpu, mem, disk], ...]
    this.dirty = false;                 // history changed since it was last saved
    this.range = load("range", RANGES[1][0]);
    this.hover = null;                  // { name, k } while the pointer is on a chart
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
    } catch (e) {
      const msg = String(e?.message ?? e);
      // Only "can't start the program" means sbx is missing; a timeout is an error.
      this.state = /not found|no such file|enoent|cannot (start|find)|failed to (start|spawn)/i.test(msg) ? "missing" : "error";
      this.message = this.state === "error" ? `sbx daemon status: ${msg}` : "";
      this.boxes = [];
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
    const names = new Set(this.boxes.map((b) => b.name));
    if ([...this.open].some((n) => !names.has(n))) {
      this.open = new Set([...this.open].filter((n) => names.has(n)));
      save("open", [...this.open]);
    }

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
      if (h && now - h.at < HEALTH_EVERY - 2000) return;
      if (typeof b.name !== "string" || b.name.startsWith("-")) return;
      try {
        const r = await exec("sbx", ["exec", b.name, "sh", "-c", PROBE], { timeout: TIMEOUT });
        if (r.code !== 0) return;
        const s = parseProbe(r.stdout);
        const prev = h?.prev;
        let cpu = null; // only a real delta between two samples counts
        if (prev?.cpuTotal != null && s.cpuTotal != null && s.cpuTotal > prev.cpuTotal) {
          cpu = 100 * (1 - (s.cpuIdle - prev.cpuIdle) / (s.cpuTotal - prev.cpuTotal));
        }
        const mem = s.memTotal ? 100 * (1 - s.memAvail / s.memTotal) : null;
        this.health[b.name] = { prev: s.cpuTotal != null ? s : prev, cpu, mem, disk: s.disk ?? null, at: now };
        if (this.recording) this.record(b.name, now, cpu, mem, s.disk ?? null);
      } catch {
        // a slow or stopped sandbox: keep the last reading
      }
    }));
    for (const name of Object.keys(this.health)) {
      if (!running.some((b) => b.name === name)) delete this.health[name];
    }
    if (this.dirty) { save("history", this.hist); this.dirty = false; }
  }

  record(name, now, cpu, mem, disk) {
    const r = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
    const list = (this.hist[name] ??= []);
    list.push([now, r(cpu), r(mem), r(disk)]);
    this.dirty = true;
    const cut = now - RETAIN;
    while (list.length && list[0][0] < cut) list.shift();
    for (const k of Object.keys(this.hist)) {
      const l = this.hist[k];
      if (!l.length || l[l.length - 1][0] < cut) delete this.hist[k];
    }
  }

  // Usage over time: CPU, Mem and Disk on one 0-100% axis.
  chart(name, t, dark) {
    const now = Date.now(), range = this.range, start = now - range;
    const raw = (this.hist[name] ?? []).filter((p) => p[0] >= start);
    const btn = (id, label, on, click) => div().id(id).px(5).py(1).rounded(4).cursor_pointer()
      .text_size(10.5).text_color(on ? t.foreground : t.dim).when(on, (e) => e.bg(t.raised))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { click(); cx.notify(); }).child(label);
    const controls = h_flex().gap(2).items_center()
      .children(RANGES.map(([ms, label]) => btn(`sb-r-${name}-${label}`, label, ms === range, () => { this.range = ms; save("range", ms); })))
      .child(div().w(6))
      .child(btn(`sb-clear-${name}`, "Clear", false, () => { delete this.hist[name]; save("history", this.hist); }));

    if (raw.length < 2) {
      if (this.hover?.name === name) this.hover = null;
      return v_flex().gap(4).pt(4)
        .child(div().text_size(11).text_color(t.dim).child(this.recording
          ? "Collecting usage… the chart starts after two readings in this range."
          : "Recording is off. Turn it on in the panel header."))
        .when(raw.length > 0 || (this.hist[name] ?? []).length > 0, (e) => e.child(controls));
    }

    // Average into time buckets so a long range stays light.
    const width = range / BUCKETS;
    const pts = [];
    let cur = null;
    for (const p of raw) {
      const bi = Math.floor(p[0] / width);
      if (!cur || cur.bi !== bi) { cur = { bi, t: 0, n: [0, 0, 0, 0], s: [0, 0, 0, 0] }; pts.push(cur); }
      cur.t = p[0];
      for (const i of [1, 2, 3]) if (p[i] != null) { cur.s[i] += p[i]; cur.n[i]++; }
    }
    const points = pts.map((b) => [b.t, ...[1, 2, 3].map((i) => (b.n[i] ? b.s[i] / b.n[i] : null))]);
    const gap = Math.max(3 * HEALTH_EVERY, 2.5 * width); // a longer silence breaks the line
    const x = (ms) => `${Math.min(100, Math.max(0, ((ms - start) / range) * 100)).toFixed(2)}%`;
    // Heights in px: the chart has a fixed height, and percentages only follow the width.
    const y = (v) => Math.round((1 - Math.min(100, Math.max(0, v)) / 100) * (PLOT_H - 2) * 10) / 10 + 1;
    const paint = (path, color) => window.paint_path(path, color).absolute().top(0).left(0).size_full();

    // Hovered slice → the nearest reading; else the latest.
    const hov = this.hover?.name === name ? this.hover.k : null;
    let shown = points[points.length - 1];
    if (hov != null) {
      const at = start + ((hov + 0.5) / SLICES) * range;
      shown = points.reduce((a, b) => (Math.abs(b[0] - at) < Math.abs(a[0] - at) ? b : a));
    }

    let grid = PathBuilder.stroke(1);
    for (const v of [0, 50, 100]) grid = grid.move_to("0%", y(v)).line_to("100%", y(v));
    const lines = SERIES.map((s) => {
      let pb = PathBuilder.stroke(2);
      let drawn = 0, last = null;
      for (const p of points) {
        const v = p[s.key];
        if (v == null) continue;
        if (last == null || p[0] - last > gap) pb = pb.move_to(x(p[0]), y(v));
        else { pb = pb.line_to(x(p[0]), y(v)); drawn++; }
        last = p[0];
      }
      return drawn ? paint(pb.build(), dark ? s.dark : s.light) : null;
    }).filter(Boolean);

    const legend = h_flex().gap(10).items_center().text_size(11)
      .children(SERIES.map((s) => h_flex().gap(4).items_center()
        .child(div().w(10).h(2).rounded(1).bg(dark ? s.dark : s.light))
        .child(div().text_color(t.muted).child(s.label))
        .child(div().text_color(t.foreground).child(pct(hov != null ? shown[s.key]
          : [...points].reverse().find((p) => p[s.key] != null)?.[s.key])))))
      .child(div().flex_1())
      .child(div().text_color(t.dim).child(hov == null ? "now" : `${ago(new Date(shown[0]).toISOString())} ago`.replace("now ago", "now")));

    const plot = div().relative().w_full().h(PLOT_H)
      .child(paint(grid.build(), t.border))
      .children(lines)
      .when(hov != null, (e) => e.child(paint(PathBuilder.stroke(1).move_to(x(shown[0]), 0).line_to(x(shown[0]), PLOT_H).build(), t.muted)))
      .child(div().absolute().top(3).right(2).text_size(9).text_color(t.dim).child("100%"))
      .child(h_flex().absolute().top(0).left(0).size_full()
        .children(Array.from({ length: SLICES }, (_, k) => div().id(`sb-h-${name}-${k}`).flex_1().h_full()
          .on_hover((on, cx) => {
            if (on) this.hover = { name, k };
            else if (this.hover?.name === name && this.hover.k === k) this.hover = null;
            cx.notify();
          }))));

    const label = RANGES.find(([ms]) => ms === range)?.[1] ?? "";
    return v_flex().gap(4).pt(4)
      .child(legend)
      .child(div().py(3).child(plot))
      .child(h_flex().text_size(10).text_color(t.dim)
        .child(div().child(`−${label}`)).child(div().flex_1()).child(controls).child(div().flex_1()).child(div().child("now")));
  }

  row(b, t, dark) {
    const color = b.status === "running" ? (t.ansi2 ?? t.working) : b.status === "stopped" ? t.dim : (t.ansi3 ?? t.done);
    const blocked = this.blocked[b.name] ?? [];
    const hits = blocked.reduce((n, x) => n + x.count, 0);
    const h = this.health[b.name];
    const open = this.open.has(b.name);
    const folder = (b.workspaces ?? [])[0];
    return v_flex().flex_none()
      .child(h_flex().id(`sb-${b.name}`).px(8).h(30).flex_none().rounded(8).items_center().gap(9)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          open ? this.open.delete(b.name) : this.open.add(b.name);
          if (this.hover?.name === b.name) this.hover = null;
          save("open", [...this.open]);
          cx.notify();
        })
        .child(div().size(7).flex_none().rounded(4).bg(color))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).truncate().text_color(b.status === "running" ? t.foreground : t.muted).child(b.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(b.agent ?? "")))
        .when(hits > 0, (e) => e.child(div().id(`sb-hits-${b.name}`).flex_none().px(5).h(17).rounded(5).bg(tint(t.blocked, t.raised))
          .text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center()
          .tooltip(`${blocked.length} blocked host${blocked.length === 1 ? "" : "s"}, ${hits} request${hits === 1 ? "" : "s"}`)
          .child(`${hits} blocked`))))
      .when(b.status === "running" && h != null && !open, (e) => e.child(
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
        .when(blocked.length > 8, (e) => e.child(div().child(`+${blocked.length - 8} more`)))
        .child(this.chart(b.name, t, dark))));
  }

  recButton(t) {
    const on = this.recording;
    return h_flex().id("sb-rec").gap(4).items_center().cursor_pointer().text_size(10.5)
      .text_color(on ? t.muted : t.dim).hover((s) => s.text_color(t.foreground))
      .tooltip(on ? "Recording usage for charts (keeps 6 h). Click to pause." : "Usage recording is paused. Click to record.")
      .on_click((_e, cx) => { this.recording = !this.recording; save("record", this.recording); cx.notify(); })
      .child(div().size(6).rounded(3).bg(on ? t.blocked : t.dim))
      .child(on ? "Rec" : "Paused");
  }

  render(cx) {
    const t = theme();
    const dark = settings()?.dark ?? true;
    const running = this.boxes.filter((b) => b.status === "running").length;
    const note = {
      loading: "Reading sandboxes…",
      off: "The sbx daemon is off. Sandboxes show up here while it runs.",
      missing: "sbx is not installed.",
      error: this.message,
      ok: this.boxes.length === 0 ? "No sandboxes. Start one with sbx run claude." : null,
    }[this.state];
    const noteEl = (pad) => div().px(pad).text_size(12).text_color(this.state === "error" ? t.blocked : t.dim).child(note);
    const list = (pad) => v_flex().id("sb-list").flex_1().min_h(0).p(pad).overflow_y_scrollbar()
      .children(this.boxes.map((b) => this.row(b, t, dark)));

    // In the sidebar (props: { "sidebar": true }): a section like the Agents list.
    if (props()?.sidebar) {
      return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
        .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Sandboxes"))
            .child(this.recButton(t)))
          .when(this.boxes.length > 0, (e) => e.child(div().text_size(11).text_color(t.dim)
            .child(`${running}/${this.boxes.length} running`))))
        .when(note != null, (e) => e.child(noteEl(16)))
        .child(list(0).px(8));
    }

    // Default: a side panel card like Files and Changes.
    return v_flex().id("sandboxes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Sandboxes"))
        .child(div().flex_1())
        .child(this.recButton(t))
        .when(this.boxes.length > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border)
          .text_size(10).text_color(t.muted).child(`${running}/${this.boxes.length} running`))))
      .when(note != null, (e) => e.child(noteEl(14).pt(10)))
      .child(list(6));
  }
}
