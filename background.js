// Twitch Auto Redeem — background service worker.
//
// Single job: arbitrate which tab may fire a redeem for a channel, so two open
// tabs of the same channel can never double-redeem. Locks live in
// chrome.storage.session (survives service-worker restarts, cleared when the
// browser closes) and are keyed by channel login.
//
// Message protocol (from content scripts):
//   { ns: "tar", type: "lock-acquire", login }                -> { granted }
//   { ns: "tar", type: "lock-hold",    login, holdUntilMs }   -> { ok }  (extend or release)
//   { ns: "tar", type: "lock-release", login }                -> { ok }

const LOCK_PREFIX = "tar-lock:";
const DEFAULT_TTL_MS = 15000; // how long a granted lock blocks other tabs
const MAX_HOLD_MS = 10 * 60 * 1000;

// Serialize lock operations: two messages arriving close together must not
// interleave their read-modify-write over storage.session.
const queue = {
  chain: Promise.resolve(),
  run(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  },
};

async function getLock(login) {
  const key = LOCK_PREFIX + login;
  const out = await chrome.storage.session.get(key);
  return out[key] ?? null;
}

async function setLock(login, lock) {
  const key = LOCK_PREFIX + login;
  if (lock === null) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: lock });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.ns !== "tar") return;

  const tabId = sender.tab?.id ?? -1;

  if (msg.type === "lock-acquire") {
    queue.run(async () => {
      const now = Date.now();
      const existing = await getLock(msg.login);
      if (existing && existing.expiresAt > now && existing.tabId !== tabId) {
        sendResponse({ granted: false });
        return;
      }
      await setLock(msg.login, { tabId, expiresAt: now + DEFAULT_TTL_MS });
      sendResponse({ granted: true });
    });
    return true; // async response
  }

  if (msg.type === "lock-hold") {
    queue.run(async () => {
      const existing = await getLock(msg.login);
      if (!existing || existing.tabId !== tabId) {
        sendResponse({ ok: false });
        return;
      }
      const now = Date.now();
      const holdUntil = Math.min(msg.holdUntilMs ?? 0, now + MAX_HOLD_MS);
      if (holdUntil > now) {
        await setLock(msg.login, { tabId, expiresAt: holdUntil });
      } else {
        await setLock(msg.login, null);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "lock-release") {
    queue.run(async () => {
      const existing = await getLock(msg.login);
      if (!existing || existing.tabId === tabId) await setLock(msg.login, null);
      sendResponse({ ok: true });
    });
    return true;
  }
});
