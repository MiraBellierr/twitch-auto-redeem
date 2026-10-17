// Twitch Auto Redeem — on-page panel UI (draggable pill + expandable card).
//
// Everything renders inside a shadow root so Twitch's styles can never leak
// in or out. The panel is a dumb view: content.js owns all state and calls
// TarPanel.render(view) after every change.

(() => {
  "use strict";

  const STYLE = `
    :host { all: initial; }
    .tar-wrap { font: 400 12px/1.45 "Inter", "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif; }

    /* ---- pill ---- */
    .tar-pill {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 6px 11px; border-radius: 999px;
      background: rgba(24, 24, 27, .94); color: #efeff1;
      border: 1px solid #3a3a3d; box-shadow: 0 2px 10px rgba(0, 0, 0, .45);
      font-weight: 600; cursor: grab; user-select: none; pointer-events: auto;
      max-width: 230px;
    }
    .tar-pill:active { cursor: grabbing; }
    .tar-pill:focus-visible { outline: 2px solid #9147ff; outline-offset: 2px; }
    .tar-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .tar-dot { width: 9px; height: 9px; border-radius: 50%; background: #7a7a85; flex: none; }
    .tar-dot.s-armed { background: #00c853; }
    .tar-dot.s-ready { background: #00c853; animation: tar-pulse 1.2s ease-in-out infinite; }
    .tar-dot.s-wait  { background: #ffb300; }
    .tar-dot.s-err   { background: #e91916; }
    .tar-dot.s-busy  { background: #9147ff; animation: tar-pulse 1s ease-in-out infinite; }
    @keyframes tar-pulse { 50% { opacity: .3; } }

    /* ---- card ---- */
    .tar-card {
      margin-top: 8px; width: 324px;
      background: #18181b; color: #efeff1;
      border: 1px solid #2f2f35; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .55);
      overflow: hidden;
    }
    .tar-card[hidden] { display: none; }

    .tar-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 9px 12px; border-bottom: 1px solid #2f2f35;
      font-weight: 700; font-size: 12px;
    }
    .tar-x {
      border: 0; background: none; color: #adadb8; cursor: pointer;
      padding: 2px 7px; border-radius: 6px; font-size: 14px; line-height: 1;
    }
    .tar-x:hover { background: #2f2f35; color: #fff; }

    .tar-sub { padding: 9px 12px 3px; color: #adadb8; }
    .tar-bal { color: #ffd37a; font-weight: 600; }

    .tar-list { max-height: 176px; overflow-y: auto; padding: 6px 6px 8px; }
    .tar-list::-webkit-scrollbar { width: 8px; }
    .tar-list::-webkit-scrollbar-thumb { background: #3a3a3d; border-radius: 4px; }

    .tar-row {
      display: flex; width: 100%; gap: 7px; align-items: center;
      padding: 7px 8px; border-radius: 7px;
      background: none; border: 0; color: inherit; text-align: left;
      cursor: pointer; font: inherit;
    }
    .tar-row:hover { background: #26262c; }
    .tar-row.sel { background: #2c2c33; box-shadow: inset 0 0 0 1px #9147ff; }
    .tar-row.dis { opacity: .55; }
    .tar-rtitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tar-cost { flex: none; color: #ffd37a; font-weight: 600; }

    .tar-tag {
      flex: none; font-size: 10px; font-weight: 700; letter-spacing: .03em;
      padding: 2px 6px; border-radius: 999px; background: #2f2f35; color: #adadb8;
    }
    .tar-tag.warn { background: #4a3712; color: #ffca5f; }
    .tar-tag.bad  { background: #4a1a17; color: #ff8a80; }

    .tar-empty { padding: 8px 12px; color: #adadb8; }
    .tar-note  { padding: 2px 12px 10px; color: #7f7f8a; font-size: 11px; }

    .tar-ctrls {
      display: flex; gap: 8px; align-items: center;
      padding: 9px 12px; border-top: 1px solid #2f2f35;
    }
    .tar-switch { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; flex: 1; font-weight: 600; }
    .tar-switch input { accent-color: #9147ff; width: 14px; height: 14px; margin: 0; cursor: pointer; }
    .tar-switch.off { opacity: .5; cursor: default; }

    .tar-btn {
      border: 0; border-radius: 7px; padding: 7px 11px;
      font: 600 12px "Inter", "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif;
      background: #9147ff; color: #fff; cursor: pointer; flex: none;
    }
    .tar-btn:hover:not(:disabled) { background: #772ce8; }
    .tar-btn:disabled { opacity: .45; cursor: default; }
    .tar-btn.ghost { background: #2f2f35; }
    .tar-btn.ghost:hover:not(:disabled) { background: #3a3a3d; }

    .tar-status {
      display: flex; gap: 7px; align-items: flex-start;
      padding: 9px 12px; border-top: 1px solid #2f2f35; color: #d3d3d9;
    }
    .tar-status .tar-dot { margin-top: 3px; }
    .tar-status.err { color: #ff8a80; }
    .tar-status.wait { color: #ffca5f; }

    .tar-log { border-top: 1px solid #2f2f35; max-height: 116px; overflow-y: auto; padding: 6px 12px 8px; }
    .tar-logrow { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; color: #adadb8; }
    .tar-logrow .tar-ltime { flex: none; color: #7f7f8a; }
    .tar-logrow .tar-lwhat { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tar-logrow .tar-lok { flex: none; font-weight: 700; }
    .tar-logrow .tar-lok.ok { color: #00c853; }
    .tar-logrow .tar-lok.bad { color: #ff8a80; }

    .tar-foot { padding: 0 12px 10px; color: #7f7f8a; font-size: 11px; }
  `;

  let host = null;
  let shadow = null;
  let pillEl = null;
  let dotEl = null;
  let pillLabelEl = null;
  let cardEl = null;
  let listEl = null;
  let channelEl = null;
  let balanceEl = null;
  let toggleEl = null;
  let toggleWrapEl = null;
  let redeemBtnEl = null;
  let statusEl = null;
  let statusDotEl = null;
  let statusTextEl = null;
  let logEl = null;

  let handlers = { onPick() {}, onToggleArm() {}, onRedeemNow() {}, onPillMove() {} };
  let view = null;
  let expanded = false;
  let pos = null;
  let drag = null;
  let lastSigs = {};

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const sig = (o) => { try { return JSON.stringify(o); } catch { return String(Math.random()); } };
  const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  };

  function applyPos() {
    if (!host) return;
    if (pos) {
      host.style.left = pos.x + "px";
      host.style.top = pos.y + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    } else {
      host.style.left = "auto";
      host.style.top = "auto";
      host.style.right = "16px";
      host.style.bottom = "110px";
    }
  }

  function clampPos(x, y) {
    const w = host.offsetWidth || 120;
    const h = host.offsetHeight || 34;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    };
  }

  function wirePill() {
    pillEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = host.getBoundingClientRect();
      drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, rectX: rect.left, rectY: rect.top, moved: false };
      pillEl.setPointerCapture(e.pointerId);
    });
    pillEl.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      const p = clampPos(drag.rectX + dx, drag.rectY + dy);
      host.style.left = p.x + "px";
      host.style.top = p.y + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    pillEl.addEventListener("pointerup", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasDrag = drag.moved;
      const rect = host.getBoundingClientRect();
      drag = null;
      if (wasDrag) {
        pos = clampPos(rect.left, rect.top);
        applyPos();
        handlers.onPillMove(pos);
      } else {
        setExpanded(!expanded);
      }
    });
    pillEl.addEventListener("pointercancel", () => { drag = null; });
    pillEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setExpanded(!expanded);
      }
    });
  }

  function setExpanded(next) {
    expanded = next;
    cardEl.hidden = !next;
    pillEl.setAttribute("aria-expanded", String(next));
    if (next && view) render(view, true);
  }

  function build() {
    host = document.createElement("div");
    host.id = "tar-panel-host";
    host.style.cssText = "position:fixed; z-index:2147483646; right:16px; bottom:110px;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(el("style", null, STYLE));

    const wrap = el("div", "tar-wrap");

    pillEl = el("div", "tar-pill");
    pillEl.setAttribute("role", "button");
    pillEl.setAttribute("tabindex", "0");
    pillEl.setAttribute("aria-expanded", "false");
    pillEl.title = "Twitch Auto Redeem — drag to move, click for settings";
    dotEl = el("span", "tar-dot");
    pillLabelEl = el("span", "tar-pill-label", "Auto Redeem");
    pillEl.append(dotEl, pillLabelEl);

    cardEl = el("div", "tar-card");
    cardEl.hidden = true;

    const head = el("div", "tar-head");
    head.appendChild(el("span", null, "Auto Redeem"));
    const xBtn = el("button", "tar-x", "\u2715");
    xBtn.type = "button";
    xBtn.title = "Collapse";
    xBtn.addEventListener("click", () => setExpanded(false));
    head.appendChild(xBtn);

    const sub = el("div", "tar-sub");
    channelEl = el("span", null, "…");
    const sep = el("span", null, " \u00b7 ");
    balanceEl = el("span", "tar-bal", "…");
    sub.append(channelEl, sep, balanceEl);

    listEl = el("div", "tar-list");

    const ctrls = el("div", "tar-ctrls");
    toggleWrapEl = el("label", "tar-switch");
    toggleEl = document.createElement("input");
    toggleEl.type = "checkbox";
    toggleEl.addEventListener("change", () => handlers.onToggleArm(toggleEl.checked));
    toggleWrapEl.append(toggleEl, el("span", null, "Auto-redeem loop"));
    redeemBtnEl = el("button", "tar-btn ghost", "Redeem now");
    redeemBtnEl.type = "button";
    redeemBtnEl.addEventListener("click", () => handlers.onRedeemNow());
    ctrls.append(toggleWrapEl, redeemBtnEl);

    statusEl = el("div", "tar-status");
    statusDotEl = el("span", "tar-dot");
    statusTextEl = el("span", null, "");
    statusEl.append(statusDotEl, statusTextEl);

    logEl = el("div", "tar-log");

    cardEl.append(head, sub, listEl, ctrls, statusEl, logEl);
    wrap.append(pillEl, cardEl);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    wirePill();
  }

  const DOT_CLASS = {
    disarmed: "",
    "no-selection": "",
    "not-logged-in": "",
    armed: "s-armed",
    "armed-ready": "s-ready",
    inflight: "s-busy",
    "waiting-cooldown": "s-armed",
    "waiting-points": "s-wait",
    "waiting-unavailable": "s-wait",
    "paused-left": "s-wait",
    "one-shot-done": "s-armed",
    error: "s-err",
  };

  function render(next, force) {
    view = next;
    if (!host) return;

    // Pill
    const dotCls = "tar-dot " + (DOT_CLASS[next.statusKind] || "");
    if (dotEl.className !== dotCls.trim()) dotEl.className = dotCls.trim();
    if (pillLabelEl.textContent !== next.pillText) pillLabelEl.textContent = next.pillText;

    if (!expanded && !force) return;

    // Channel + balance
    channelEl.textContent = next.login ? "#" + next.login : "";
    balanceEl.textContent = next.loggedIn ? fmtNum(next.balance) + " pts" : "not logged in";

    // Reward list
    const rows = next.rewards || null;
    const listSig = sig({
      rows: rows ? rows.map((r) => [r.id, r.title, r.cost, r.affordable, r.unavailable, r.reason, r.cooldownMsLeft > 0 ? fmtClock(r.cooldownMsLeft) : 0]) : null,
      sel: next.selectedId,
    });
    if (force || listSig !== lastSigs.list) {
      lastSigs.list = listSig;
      listEl.textContent = "";
      if (!next.loggedIn) {
        listEl.appendChild(el("div", "tar-empty", "Log in to Twitch to load rewards."));
      } else if (!rows) {
        listEl.appendChild(el("div", "tar-empty", "Loading rewards…"));
      } else if (!rows.length) {
        listEl.appendChild(el("div", "tar-empty", "No channel points rewards found on this channel."));
      } else {
        for (const r of rows) {
          const row = el("button", "tar-row" + (r.id === next.selectedId ? " sel" : "") + (r.affordable ? "" : " dis"));
          row.type = "button";
          row.setAttribute("aria-pressed", String(r.id === next.selectedId));
          row.appendChild(el("span", "tar-rtitle", r.title));
          if (r.unavailable) row.appendChild(el("span", "tar-tag bad", r.reason || "unavailable"));
          else if (r.cooldownMsLeft > 0) row.appendChild(el("span", "tar-tag warn", fmtClock(r.cooldownMsLeft)));
          row.appendChild(el("span", "tar-cost", fmtNum(r.cost)));
          row.addEventListener("click", () => handlers.onPick(r.id));
          listEl.appendChild(row);
        }
      }
    }

    // Controls
    toggleEl.checked = !!next.armed;
    toggleEl.disabled = !next.selectedId || !next.loggedIn;
    toggleWrapEl.classList.toggle("off", toggleEl.disabled);
    redeemBtnEl.disabled = !next.canRedeemNow;

    // Status
    statusTextEl.textContent = next.statusText;
    statusEl.className = "tar-status" + (next.statusKind === "error" ? " err" : "");
    if (DOT_CLASS[next.statusKind] === "s-wait") statusEl.classList.add("wait");
    statusDotEl.className = (("tar-dot " + (DOT_CLASS[next.statusKind] || "")).trim());

    // Log
    const logSig = sig(next.log);
    if (force || logSig !== lastSigs.log) {
      lastSigs.log = logSig;
      logEl.textContent = "";
      if (!next.log || !next.log.length) {
        logEl.appendChild(el("div", "tar-logrow", "No redeems yet."));
      } else {
        for (const e of next.log) {
          const row = el("div", "tar-logrow");
          const d = new Date(e.t);
          const time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
          row.appendChild(el("span", "tar-ltime", time));
          row.appendChild(el("span", "tar-lwhat", e.title + (e.note ? " — " + e.note : "")));
          const ok = el("span", "tar-lok " + (e.ok ? "ok" : "bad"), e.ok ? "\u2713" : "\u2715");
          row.appendChild(ok);
          if (typeof e.cost === "number") row.appendChild(el("span", "tar-cost", fmtNum(e.cost)));
          logEl.appendChild(row);
        }
      }
    }
  }

  window.TarPanel = {
    mount(opts) {
      handlers = Object.assign(handlers, opts || {});
      if (!host) build();
    },
    setVisible(visible) {
      if (host) host.style.display = visible ? "" : "none";
    },
    setPillPos(p) {
      pos = p || null;
      applyPos();
    },
    render,
  };
})();
