// Twitch Auto Redeem — page controller.
//
// Owns all state, the 1-second tick, cooldown scheduling, cross-tab locking
// and the storage record for every channel. Renders the panel UI via
// TarPanel. Talks to the page-world bridge (page-bridge.js) via postMessage
// to read channel points data and send redeems.
//
// Per-channel record shape (stored under key "tar.prefs.<login>"):
//   {
//     rewardId, rewardTitle, cost,
//     armed,                 // loop toggle
//     noCooldown,            // learned: reward can be redeemed repeatedly
//     consumed,              // one-shot used up for the current arming
//     cooldownEndsAt,        // ms epoch — server-reported cooldown end
//     fireAt,                // ms epoch — when the next auto attempt fires
//     lastRedeemAt, paused, log: [{t, title, cost, ok, note}]
//   }

(() => {
  "use strict";

  const DEBUG = false;
  const dbg = (...a) => { if (DEBUG) console.debug("[tar]", ...a); };

  const TICK_MS = 1000;
  const JITTER_MAX_MS = 3000;
  const CONTEXT_TIMEOUT_MS = 10000;
  const REDEEM_TIMEOUT_MS = 12000;
  const REFRESH_ARMED_MS = 90000;
  const REFRESH_IDLE_MS = 300000;
  const LOG_MAX = 20;

  const RESERVED = new Set([
    "directory", "downloads", "settings", "subscriptions", "wallet", "drops",
    "inventory", "search", "jobs", "turbo", "prime", "following", "friends",
    "whispers", "notifications", "p", "videos", "creatorcamp", "security",
    "legal", "accessibility", "blog", "about", "teams", "store", "products",
    "oauth2", "login", "signup", "logout", "activate", "help", "policy",
    "purple", "broadcast", "admin", "moderator", "u", "s",
  ]);

  // ---------------------------------------------------------------- storage

  const store = { prefs: {}, ui: { pillPos: null } };

  function defaultPrefs() {
    return {
      rewardId: null, rewardTitle: null, cost: null,
      armed: false, noCooldown: false, consumed: false,
      cooldownEndsAt: null, fireAt: null, lastRedeemAt: null,
      paused: false, log: [],
    };
  }

  async function loadStore() {
    const all = await chrome.storage.local.get(null);
    for (const k of Object.keys(all)) {
      if (k.startsWith("tar.prefs.")) store.prefs[k.slice("tar.prefs.".length)] = all[k];
      else if (k === "tar.ui") store.ui = Object.assign({ pillPos: null }, all[k]);
    }
  }

  function persistPrefs(login, prefs) {
    const lg = login || state.login;
    const rec = prefs || state.prefs;
    if (!lg || !rec) return;
    chrome.storage.local.set({ ["tar.prefs." + lg]: rec });
  }

  function persistUi() {
    chrome.storage.local.set({ "tar.ui": store.ui });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (state.login) {
      const inc = changes["tar.prefs." + state.login]?.newValue;
      if (inc && JSON.stringify(state.prefs) !== JSON.stringify(inc)) {
        Object.assign(state.prefs, inc);
        dbg("adopted storage change from another tab", inc);
      }
    }
    const ui = changes["tar.ui"]?.newValue;
    if (ui && JSON.stringify(ui.pillPos) !== JSON.stringify(store.ui.pillPos)) {
      store.ui = ui;
      window.TarPanel.setPillPos(store.ui.pillPos);
    }
  });

  // ------------------------------------------------------------------ state

  const state = {
    login: null,
    prefs: null,
    live: null,
    nextRefreshAt: 0,
  };

  function freshLive() {
    return {
      loggedIn: true,
      channelId: null,
      balance: null,
      rewards: null, // null = not loaded yet
      inflight: false,
      lastError: null, // { text, until }
      status: { kind: "no-selection", text: "" },
    };
  }

  function selectedReward() {
    const l = state.live, p = state.prefs;
    if (!l || !l.rewards || !p.rewardId) return undefined;
    return l.rewards.find((r) => r.id === p.rewardId) || null;
  }

  // ----------------------------------------------------------- bridge (page)

  const pending = new Map();
  let msgSeq = 1;

  function bridgeCall(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = msgSeq++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: "timeout", reason: "timeout" });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      window.postMessage({ __tar: "req", id, type, payload }, window.location.origin);
    });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.__tar === "res" && pending.has(m.id)) {
      const cb = pending.get(m.id);
      pending.delete(m.id);
      cb(m);
    } else if (m.__tar === "event" && m.type === "context" && m.data) {
      onSniffedContext(m.data);
    }
  });

  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ ns: "tar", ...msg }, (r) => {
          void chrome.runtime.lastError;
          resolve(r || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => Math.floor(Math.random() * (JITTER_MAX_MS + 1));
  const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "?");
  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  };

  function channelLoginFromPath() {
    const segs = window.location.pathname.split("/").filter(Boolean);
    if (!segs.length) return null;
    const first = decodeURIComponent(segs[0]).toLowerCase();
    if (RESERVED.has(first)) return null;
    if (!/^[a-z0-9_]{1,60}$/.test(first)) return null;
    return first;
  }

  function pushLog(entry) {
    const log = state.prefs.log;
    log.unshift(entry);
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  }

  function classify(errMsg, res) {
    const m = String(errMsg || "").toLowerCase();
    const has = (...ss) => ss.some((s) => m.includes(s));
    if (has("transaction_in_progress")) return { kind: "inprogress", short: "transaction in progress" };
    if (has("insufficient_points", "not_enough_points", "not enough points", "insufficient"))
      return { kind: "points", short: "not enough points" };
    if (has("properties_mismatch", "reward_cost_mismatch"))
      return { kind: "mismatch", short: "reward details changed" };
    if (has("cooldown", "too recently"))
      return { kind: "cooldown", short: "on cooldown" };
    if (has("stream_not_live", "not live", "offline"))
      return { kind: "offline", short: "stream offline" };
    if (has("max_per_stream", "max_per_user", "max per"))
      return { kind: "unavailable", short: "limit reached (resets next stream)" };
    if (has("not_available", "not available", "duplicate_transaction"))
      return { kind: "unavailable", short: "not available right now" };
    if (has("paused", "disabled", "deleted", "not found", "not_found", "inactive", "out of stock", "forbidden"))
      return { kind: "unavailable", short: m.slice(0, 60) || "unavailable" };
    if (has("rate", "429", "too many"))
      return { kind: "rate", short: "rate limited" };
    if (has("unauthenticated", "unauthorized", "401", "403", "integrity", "token"))
      return { kind: "auth", short: "session/integrity issue" };
    return { kind: "unknown", short: m.slice(0, 60) || String(res?.reason || "no response from page") };
  }

  // ---------------------------------------------------- context + scheduling

  function mergeContext(ctx, source) {
    if (!state.login || !ctx) return;
    if ((ctx.login || "").toLowerCase() !== state.login) return; // stale or other channel

    const l = state.live, p = state.prefs;
    if (ctx.loggedIn === false || ctx.reason === "not-logged-in") {
      l.loggedIn = false;
      l.rewards = null;
      render();
      return;
    }
    if (ctx.ok === false) {
      dbg("context error", ctx);
      return;
    }

    l.loggedIn = true;
    l.channelId = ctx.channelId || l.channelId;
    l.balance = ctx.balance;
    l.rewards = ctx.rewards || [];
    p.paused = false;

    const r = selectedReward();
    if (r) {
      p.rewardTitle = r.title;
      p.cost = r.cost;
      if (typeof r.cooldownExpiresAtMs === "number" && r.cooldownExpiresAtMs > Date.now()) {
        p.cooldownEndsAt = r.cooldownExpiresAtMs;
      }
      if (r.noCooldown === true) p.noCooldown = true;
      else if (r.noCooldown === false) p.noCooldown = false;
    }
    if (source !== "post-redeem") recomputeFireTime();
    updateStatus();
    render();
  }

  function onSniffedContext(data) {
    if (state.login && (data.login || "").toLowerCase() === state.login) {
      dbg("sniffed context", data);
      mergeContext(data, "sniff");
    }
  }

  let refreshing = false;
  let refreshQueued = false;

  async function refreshContext(reason) {
    if (!state.login) return null;
    if (refreshing) {
      refreshQueued = true;
      return null;
    }
    refreshing = true;
    const loginAtStart = state.login;
    const res = await bridgeCall("getContext", { login: loginAtStart }, CONTEXT_TIMEOUT_MS);
    refreshing = false;

    if (state.login !== loginAtStart) return null; // navigated away mid-flight

    let ctx = null;
    if (res.ok && res.data) {
      ctx = res.data;
      mergeContext(ctx, reason);
    } else {
      handleContextError(res);
    }
    state.nextRefreshAt = Date.now() + (state.prefs?.armed ? REFRESH_ARMED_MS : REFRESH_IDLE_MS);
    if (refreshQueued) {
      refreshQueued = false;
      refreshContext(reason + ":queued").catch(() => {});
    }
    return ctx;
  }

  function handleContextError(res) {
    const l = state.live;
    const now = Date.now();
    if (res && (res.reason === "not-logged-in" || res.loggedIn === false)) {
      l.loggedIn = false;
      l.rewards = null;
    } else {
      const msg = res?.error ? String(res.error).slice(0, 120) : "timeout";
      l.lastError = { text: "Could not read channel points — Twitch may have changed their page. (" + msg + ")", until: now + 60000 };
      if (DEBUG) console.warn("[tar] context error:", res);
    }
    updateStatus();
    render();
  }

  function recomputeFireTime() {
    const l = state.live, p = state.prefs;
    if (!p) return;
    const now = Date.now();
    p.fireAt = p.fireAt || null;

    if (!p.armed || !p.rewardId) { p.fireAt = null; return; }
    if (p.noCooldown && p.consumed) { p.fireAt = null; return; }
    if (l.rewards === null || !l.channelId) { p.fireAt = null; return; }

    const r = selectedReward();
    if (r && r.unavailable) { p.fireAt = null; return; }
    if (typeof l.balance === "number" && typeof p.cost === "number" && l.balance < p.cost) {
      p.fireAt = null;
      return;
    }

    const cdFuture = p.cooldownEndsAt && p.cooldownEndsAt > now ? p.cooldownEndsAt : null;
    if (p.fireAt == null || (cdFuture && p.fireAt < cdFuture)) {
      p.fireAt = (cdFuture || now) + jitter();
    }
  }

  function setKeepAlive(on) {
    if (on) {
      if (keepAlive || !(navigator.locks && navigator.locks.request)) return;
      let release;
      const gate = new Promise((r) => { release = r; });
      navigator.locks
        .request("tar-keepalive-" + Math.random().toString(36).slice(2), { mode: "exclusive" }, () => gate)
        .catch(() => {});
      keepAlive = { release };
    } else if (keepAlive) {
      keepAlive.release();
      keepAlive = null;
    }
  }
  let keepAlive = null;

  // -------------------------------------------------------------- lifecycle

  function enterChannel(login) {
    if (!login) return;
    state.login = login;
    state.live = freshLive();
    state.prefs = store.prefs[login] || (store.prefs[login] = defaultPrefs());
    const resuming = state.prefs.armed && state.prefs.paused;
    if (resuming) {
      state.live.status = { kind: "paused-left", text: "Resuming — you were away from this channel." };
    }
    setKeepAlive(state.prefs.armed);
    window.TarPanel.setVisible(true);
    window.TarPanel.setPillPos(store.ui.pillPos);
    state.nextRefreshAt = 0;
    dbg("entered channel", login);
    refreshContext("enter").catch(() => {});
    updateStatus();
    render();
  }

  function leaveChannel() {
    if (!state.login) return;
    if (state.prefs?.armed) {
      state.prefs.paused = true;
      persistPrefs();
    }
    setKeepAlive(false);
    state.login = null;
    state.prefs = null;
    state.live = freshLive();
    window.TarPanel.setVisible(false);
    dbg("left channel");
  }

  // ------------------------------------------------------------------- tick

  function tick() {
    const login = channelLoginFromPath();
    if (login !== state.login) {
      if (state.login) leaveChannel();
      if (login) enterChannel(login);
    }
    if (!state.login) return;

    const now = Date.now();
    const l = state.live, p = state.prefs;

    if (p.armed) setKeepAlive(true);

    if (!l.inflight) {
      recomputeFireTime();
      if (p.armed && p.fireAt != null && now >= p.fireAt) {
        attemptRedeem("auto").catch(() => {});
      }
    }

    if (now >= state.nextRefreshAt) {
      state.nextRefreshAt = now + 5000; // avoid hammering if the call fails fast
      refreshContext("periodic").catch(() => {});
    }

    updateStatus();
    render();
  }

  // ----------------------------------------------------------------- redeem

  async function attemptRedeem(kind) {
    const l = state.live, p = state.prefs;
    if (!state.login || !p || l.inflight || !l.loggedIn) return;
    if (!p.rewardId) return;
    if (kind === "auto" && !(p.armed && p.fireAt != null && Date.now() >= p.fireAt)) return;
    if (l.rewards === null) return;

    const login0 = state.login; // the channel this attempt belongs to

    const r = selectedReward();
    if (r && r.unavailable) return;
    if (typeof l.balance === "number" && typeof p.cost === "number" && l.balance < p.cost) return;

    // Cross-tab lock: only one tab of this channel may fire.
    const granted = await bg({ type: "lock-acquire", login: login0 });
    if (!granted.granted) {
      dbg("lock denied — another tab is redeeming");
      state.nextRefreshAt = Date.now() + 2500;
      return;
    }

    l.inflight = true;
    render();

    const selRow = selectedReward();
    const res = await bridgeCall(
      "redeem",
      {
        channelId: l.channelId,
        rewardId: p.rewardId,
        cost: p.cost,
        title: p.rewardTitle,
        prompt: selRow ? selRow.prompt : undefined,
      },
      REDEEM_TIMEOUT_MS
    );
    l.inflight = false;

    // If the user navigated to another channel while this was in flight,
    // unwind without touching the new channel's record.
    if (state.login !== login0) {
      await bg({ type: "lock-release", login: login0 });
      return;
    }

    const now = Date.now();

    if (res.ok) {
      dbg("redeem ok", res);
      p.lastRedeemAt = now;
      p.paused = false;

      await sleep(1200);
      let ctx = await refreshContext("post-redeem");
      if (!ctx) {
        await sleep(1500);
        if (state.login) ctx = await refreshContext("post-redeem:retry");
      }
      const row = ctx && ctx.rewards ? ctx.rewards.find((x) => x.id === p.rewardId) : null;
      const cd = row && typeof row.cooldownExpiresAtMs === "number" && row.cooldownExpiresAtMs > now ? row.cooldownExpiresAtMs : null;

      let note = "";
      if (cd) {
        p.noCooldown = false;
        p.consumed = false;
        p.cooldownEndsAt = cd;
        p.fireAt = cd + jitter();
      } else if (row && row.noCooldown === true) {
        // Twitch says this reward is configured without a cooldown: one-shot.
        p.noCooldown = true;
        p.consumed = true;
        p.cooldownEndsAt = null;
        p.fireAt = null;
        note = "no cooldown — one-shot";
      } else if (row && "cooldownExpiresAtMs" in row) {
        // A cooldown is configured but hasn't surfaced on this response yet;
        // re-probe at a slow pace (server-gated, so this can't spam).
        p.noCooldown = false;
        p.consumed = false;
        p.cooldownEndsAt = null;
        p.fireAt = now + 60000;
        note = "cooldown not reported yet — re-checking";
      } else {
        // Couldn't learn the cooldown; treat conservatively as one-shot.
        p.noCooldown = true;
        p.consumed = true;
        p.cooldownEndsAt = null;
        p.fireAt = null;
        note = "cooldown unknown — re-arm to repeat";
        if (DEBUG) console.warn("[tar] post-redeem context missing cooldown info", ctx);
      }
      pushLog({ t: now, title: p.rewardTitle, cost: p.cost, ok: true, note });
      l.lastError = null;
      await bg({
        type: "lock-hold",
        login: login0,
        holdUntilMs: p.cooldownEndsAt || now + 15000,
      });
    } else {
      const cls = classify(res.error, res);
      dbg("redeem failed", cls, res);
      pushLog({ t: now, title: p.rewardTitle, cost: p.cost, ok: false, note: cls.short });

      switch (cls.kind) {
        case "points":
          l.lastError = { text: "Not enough points yet — waiting.", until: now + 15000 };
          p.fireAt = null;
          state.nextRefreshAt = now + 5000;
          break;
        case "cooldown":
          // Server-gated, so re-probing can never spam this reward.
          l.lastError = { text: "Twitch says it's on cooldown — re-checking shortly.", until: now + 45000 };
          p.fireAt = now + 60000;
          state.nextRefreshAt = now + 5000;
          break;
        case "unavailable":
          l.lastError = { text: "Reward unavailable — waiting. (" + cls.short + ")", until: now + 60000 };
          p.fireAt = null;
          state.nextRefreshAt = now + 30000;
          break;
        case "offline":
          l.lastError = { text: "Channel is offline — waiting.", until: now + 120000 };
          p.fireAt = null;
          state.nextRefreshAt = now + 60000;
          break;
        case "rate":
          l.lastError = { text: "Twitch rate limit — backing off.", until: now + 60000 };
          p.fireAt = now + 60000;
          break;
        case "auth":
          l.lastError = { text: "Twitch session problem — try reloading or logging in again.", until: now + 120000 };
          p.fireAt = null;
          break;
        case "mismatch":
          // Streamer changed cost/title/prompt since we read them: refresh
          // the context and retry once with the fresh values.
          l.lastError = { text: "Reward details changed on Twitch — refreshing and retrying.", until: now + 20000 };
          p.fireAt = now + 15000;
          state.nextRefreshAt = now + 1500;
          break;
        case "inprogress": {
          l.lastError = { text: "Twitch is still committing the redeem — re-checking.", until: now + 30000 };
          state.nextRefreshAt = now + 6000;
          if (p.noCooldown || (!p.lastRedeemAt && p.cooldownEndsAt == null)) {
            p.consumed = true;
            p.fireAt = null;
          } else {
            p.fireAt = now + 60000;
          }
          break;
        }
        default: {
          // Ambiguous: the redeem may or may not have gone through. Never
          // blind-retry a reward that might have no cooldown.
          if (p.noCooldown || (!p.lastRedeemAt && p.cooldownEndsAt == null)) {
            p.consumed = true;
            p.fireAt = null;
            l.lastError = { text: "Redeem status unknown — re-arm the loop to retry.", until: now + 300000 };
          } else {
            l.lastError = { text: "Temporary error — retrying.", until: now + 60000 };
            p.fireAt = now + 60000;
          }
          break;
        }
      }
      await bg({ type: "lock-release", login: login0 });
    }

    persistPrefs(login0, p);
    updateStatus();
    render();
  }

  // ------------------------------------------------------------------ status

  function updateStatus() {
    const l = state.live, p = state.prefs;
    if (!l || !p) return;
    const now = Date.now();
    let kind = "armed";
    let text = "";

    if (!l.loggedIn) {
      kind = "not-logged-in";
      text = "Log in to Twitch to use auto-redeem on this page.";
    } else if (!p.rewardId) {
      kind = "no-selection";
      text = "Pick a reward to auto-redeem.";
    } else if (l.inflight) {
      kind = "inflight";
      text = `Redeeming "${p.rewardTitle}"…`;
    } else if (l.lastError && now < l.lastError.until) {
      kind = "error";
      text = l.lastError.text;
    } else if (!p.armed) {
      kind = "disarmed";
      text = "Loop off.";
    } else if (p.noCooldown && p.consumed) {
      kind = "one-shot-done";
      text = "Redeemed once — re-arm the loop (or Redeem now) for another.";
    } else if (l.rewards === null) {
      kind = "armed";
      text = "Armed — waiting for channel points data…";
    } else if (selectedReward() === null) {
      kind = "waiting-unavailable";
      text = "Reward no longer exists on this channel — waiting for it to come back.";
    } else if (selectedReward()?.unavailable) {
      kind = "waiting-unavailable";
      text = "Waiting — " + selectedReward().reason + ".";
    } else if (typeof l.balance === "number" && typeof p.cost === "number" && l.balance < p.cost) {
      kind = "waiting-points";
      text = `Waiting — ${fmtNum(p.cost - l.balance)} more points needed.`;
    } else if (p.cooldownEndsAt && p.cooldownEndsAt > now) {
      kind = "waiting-cooldown";
      text = `Cooling down — next redeem in ${clock(p.cooldownEndsAt - now)}.`;
    } else if (p.fireAt != null && p.fireAt > now) {
      kind = "armed-ready";
      text = `Ready — redeeming in ${clock(p.fireAt - now)}.`;
    } else {
      kind = "armed";
      text = "Armed — syncing.";
    }

    l.status = { kind, text };
  }

  function pillText() {
    const l = state.live, p = state.prefs;
    if (!l || !p) return "Auto Redeem";
    const now = Date.now();
    switch (l.status.kind) {
      case "not-logged-in": return "log in";
      case "no-selection": return "pick reward";
      case "inflight": return "sending…";
      case "one-shot-done": return "done ✓";
      case "waiting-points": return "need pts";
      case "waiting-unavailable": return "waiting";
      case "error": return "error";
      case "disarmed": return "off";
      case "waiting-cooldown": return "⏱ " + clock(p.cooldownEndsAt - now);
      case "armed-ready": return "⏱ " + clock(Math.max(0, p.fireAt - now));
      case "paused-left": return "paused";
      default: return "armed";
    }
  }

  // ------------------------------------------------------------------ render

  function render() {
    if (!state.login || !state.prefs || !state.live) return;
    const l = state.live, p = state.prefs, now = Date.now();
    const rewards = l.rewards === null
      ? null
      : l.rewards.map((r) => ({
          id: r.id,
          title: r.title,
          cost: r.cost,
          affordable: !(typeof l.balance === "number" && typeof r.cost === "number" && l.balance < r.cost),
          unavailable: !!r.unavailable,
          reason: r.reason || null,
          cooldownMsLeft: r.id === p.rewardId && p.cooldownEndsAt && p.cooldownEndsAt > now ? p.cooldownEndsAt - now : 0,
        }));

    const cheapEnough = !(typeof l.balance === "number" && typeof p.cost === "number" && l.balance < p.cost);
    const canRedeemNow =
      !!p.rewardId && l.loggedIn && !l.inflight && l.rewards !== null &&
      selectedReward() !== null && !selectedReward()?.unavailable && cheapEnough;

    window.TarPanel.render({
      login: state.login,
      loggedIn: l.loggedIn,
      balance: l.balance,
      rewards,
      selectedId: p.rewardId,
      armed: p.armed,
      canRedeemNow,
      statusKind: l.status.kind,
      statusText: l.status.text,
      pillText: pillText(),
      log: p.log,
    });
  }

  // ---------------------------------------------------------------- actions

  function onPick(rewardId) {
    const p = state.prefs, l = state.live;
    if (!p || !l.rewards) return;
    const r = l.rewards.find((x) => x.id === rewardId);
    if (!r) return;
    p.rewardId = r.id;
    p.rewardTitle = r.title;
    p.cost = r.cost;
    p.noCooldown = false;
    p.consumed = false;
    p.cooldownEndsAt = typeof r.cooldownExpiresAtMs === "number" && r.cooldownExpiresAtMs > Date.now() ? r.cooldownExpiresAtMs : null;
    p.fireAt = null;
    l.lastError = null;
    recomputeFireTime();
    persistPrefs();
    updateStatus();
    render();
  }

  function onToggleArm(checked) {
    const p = state.prefs;
    if (!p || !p.rewardId) return;
    p.armed = !!checked;
    p.paused = false;
    if (p.armed) {
      p.consumed = false; // re-arm
      p.fireAt = null;
      state.live.lastError = null;
      state.nextRefreshAt = 0;
      setKeepAlive(true);
    } else {
      p.fireAt = null;
      state.live.lastError = null;
      setKeepAlive(false);
    }
    recomputeFireTime();
    persistPrefs();
    updateStatus();
    render();
  }

  function onRedeemNow() {
    const l = state.live;
    if (!l) return;
    l.lastError = null;
    attemptRedeem("manual").catch(() => {});
  }

  function onPillMove(pos) {
    store.ui.pillPos = pos;
    persistUi();
  }

  // ------------------------------------------------------------------- boot

  async function init() {
    await loadStore();
    window.TarPanel.mount({ onPick, onToggleArm, onRedeemNow, onPillMove });
    window.TarPanel.setPillPos(store.ui.pillPos);
    window.TarPanel.setVisible(false);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.login) {
        state.nextRefreshAt = 0; // re-sync after being hidden/backgrounded
      }
    });

    dbg("init done");
    tick();
    setInterval(tick, TICK_MS);
  }

  init().catch((e) => console.warn("[tar] init failed", e));
})();
