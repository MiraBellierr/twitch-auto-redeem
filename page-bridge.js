// Twitch Auto Redeem — page bridge.
//
// Runs in the page's MAIN world (document_start) so it can use the logged-in
// Twitch web session. Auth is header-based, exactly like the Twitch website:
// `Authorization: OAuth <auth-token cookie>` + the public web Client-ID
// against https://gql.twitch.tv/gql.
//
// Client-Integrity: Twitch's mutations on the web client are integrity-gated.
// Tokens must be minted from a twitch.tv page context (where Twitch's Kasada
// script lives), so this bridge both passively captures the tokens Twitch's
// own requests carry and mints its own via POST /integrity when needed.
//
// The sandboxed content script talks to this bridge via window.postMessage:
//   Request  (content -> page): { __tar: "req", id, type, payload }
//   Response (page -> content): { __tar: "res", id, ok, data, error }
//   Push     (page -> content): { __tar: "event", type: "context", data }
//
// Twitch changes their internal schema without notice, so every GQL call is
// written as a list of variants: the first the server accepts is cached.

(() => {
  "use strict";

  const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const GQL_URL = "https://gql.twitch.tv/gql";
  const INTEGRITY_URL = "https://gql.twitch.tv/integrity";
  const INTEGRITY_FALLBACK_TTL_MS = 60 * 60 * 1000;

  const dbg = (...a) => { try { console.debug("[tar-bridge]", ...a); } catch {} };

  // ------------------------------------------------------- auth + integrity

  function readAuthToken() {
    const m = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function readDeviceId() {
    const m = document.cookie.match(/(?:^|;\s*)unique_id=([^;]+)/);
    return m ? m[1] : null;
  }

  const integrity = { token: null, exp: 0, deviceId: null, minting: null };

  function cachedIntegrity() {
    return integrity.token && Date.now() < integrity.exp - 60000 ? integrity.token : null;
  }

  function storeIntegrity(token, expiration) {
    if (!token) return;
    integrity.token = token;
    const exp = typeof expiration === "number" && expiration > 0 ? expiration : Date.now() + INTEGRITY_FALLBACK_TTL_MS;
    integrity.exp = Math.min(exp, Date.now() + INTEGRITY_FALLBACK_TTL_MS);
  }

  function invalidateIntegrity() {
    integrity.token = null;
    integrity.exp = 0;
  }

  async function mintIntegrity(force) {
    if (!force && cachedIntegrity()) return cachedIntegrity();
    if (integrity.minting) return integrity.minting;
    integrity.minting = (async () => {
      try {
        const headers = { "Client-ID": CLIENT_ID };
        const token = readAuthToken();
        if (token) headers.Authorization = "OAuth " + token;
        const did = integrity.deviceId || readDeviceId();
        if (did) headers["X-Device-Id"] = did;
        const res = await fetch(INTEGRITY_URL, { method: "POST", headers });
        const j = await res.json();
        if (j && j.token) {
          storeIntegrity(j.token, j.expiration);
          return integrity.token;
        }
        dbg("integrity mint returned no token", res.status);
      } catch (e) {
        dbg("integrity mint failed", e);
      } finally {
        integrity.minting = null;
      }
      return cachedIntegrity();
    })();
    return integrity.minting;
  }

  // ------------------------------------------------------------- gql plumbing

  async function gql(body, opts) {
    const headers = { "Client-ID": CLIENT_ID, "Content-Type": "application/json" };
    const token = readAuthToken();
    if (token) headers.Authorization = "OAuth " + token;
    if (!opts || opts.integrity !== false) {
      const t = cachedIntegrity() || (await mintIntegrity(false));
      if (t) headers["Client-Integrity"] = t;
    }
    const res = await fetch(GQL_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { httpStatus: res.status, json };
  }

  function errorMessage(r) {
    const out = [];
    const json = r && r.json;
    if (json) {
      const errs = json.errors;
      if (Array.isArray(errs)) {
        for (const e of errs) {
          if (!e) continue;
          let s = e.message || "";
          if (e.extensions && e.extensions.code) s += " [" + e.extensions.code + "]";
          if (s) out.push(s);
        }
      }
      if (json.extensions && json.extensions.challenge && json.extensions.challenge.type) {
        out.push("challenge:" + json.extensions.challenge.type);
      }
    }
    if (!out.length && r && r.httpStatus >= 400) out.push("HTTP " + r.httpStatus);
    return out.join("; ");
  }

  const SCHEMA_ERROR = /cannot query field|unknown field|unknown argument|unknown type|is never used|must have a selection|must not have a selection|cannot select field|did you mean|invalid value for|was not provided|expected type/i;
  const isSchemaError = (msg) => SCHEMA_ERROR.test(String(msg || ""));
  const isIntegrityError = (msg) => /integrity/i.test(String(msg || ""));

  // -------------------------------------------------------- context variants

  const CONTEXT_VARIANTS = [
    `query ChannelPointsContext($channelLogin: String!) {
      user(login: $channelLogin) {
        id
        login
        displayName
        channel {
          id
          self { communityPoints { balance availableClaim { id } } }
          communityPointsSettings {
            customRewards {
              id title cost prompt backgroundColor
              isEnabled isPaused isInStock isUserInputRequired
              cooldownExpiresAt
              globalCooldownSetting { isEnabled globalCooldownSeconds }
              defaultImage { url }
            }
          }
        }
      }
    }`,
    `query ChannelPointsContext($channelLogin: String!) {
      user(login: $channelLogin) {
        id
        login
        channel {
          id
          self { communityPoints { balance } }
          communityPointsSettings {
            customRewards {
              id title cost prompt
              isEnabled isPaused isInStock isUserInputRequired
              cooldownExpiresAt
              globalCooldownSetting { isEnabled }
            }
          }
        }
      }
    }`,
    `query ChannelPointsContext($channelLogin: String!) {
      user(login: $channelLogin) {
        id
        login
        channel {
          id
          self { communityPoints { balance } }
          communityPointsSettings {
            customRewards { id title cost isEnabled isPaused isInStock }
          }
        }
      }
    }`,
  ];

  function parseTs(v) {
    if (v == null) return null;
    const t = Date.parse(v);
    if (!isFinite(t) || t <= 1000) return null; // epoch/none/invalid
    return t;
  }

  function normalizeReward(r) {
    const out = { id: r.id, title: r.title, cost: r.cost, prompt: r.prompt == null ? "" : String(r.prompt) };
    if (r && "cooldownExpiresAt" in r) out.cooldownExpiresAtMs = parseTs(r.cooldownExpiresAt);
    if (r && r.globalCooldownSetting) out.noCooldown = r.globalCooldownSetting.isEnabled === false;
    let reason = null;
    if (r.isUserInputRequired === true) reason = "requires a text message";
    else if (r.isEnabled === false) reason = "disabled by streamer";
    else if (r.isPaused === true) reason = "paused by streamer";
    else if (r.isInStock === false) {
      // Twitch restates a running cooldown as isInStock:false — don't surface
      // that as a stock-out.
      const cdTs = "cooldownExpiresAt" in r ? parseTs(r.cooldownExpiresAt) : null;
      const cdConfigured = r.globalCooldownSetting && r.globalCooldownSetting.isEnabled === true;
      if (!(cdConfigured && cdTs != null)) reason = "out of stock / limit reached";
    }
    out.unavailable = !!reason;
    out.reason = reason;
    return out;
  }

  // Breadth-limited deep search; tolerates Twitch nesting channel points data
  // differently than our own inline query.
  function deepFindArray(obj, key, depth) {
    if (!obj || typeof obj !== "object" || depth > 6) return null;
    if (Array.isArray(obj[key])) return obj[key];
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const hit = deepFindArray(v, key, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Accepts both our inline response shape and the app's own persisted-query
  // response shape (which aliases `user` to `community`).
  function normalizeContext(data) {
    const user = data && (data.user || data.community);
    if (!user || !user.channel) return null;
    const channel = user.channel;
    const self = channel.self || null;
    const rewards =
      (channel.communityPointsSettings && channel.communityPointsSettings.customRewards) ||
      deepFindArray(channel, "customRewards", 0) ||
      [];
    return {
      ok: true,
      loggedIn: !!self,
      login: String(user.login || "").toLowerCase(),
      channelId: channel.id || null,
      balance: self && self.communityPoints ? self.communityPoints.balance : null,
      rewards: rewards.map(normalizeReward),
    };
  }

  // --------------------------------------------------------- redeem variants

  // Server-side quirk (verified live 2026-10): the operation was renamed to
  // RedeemCustomReward, but the response FIELD is still
  // `redeemCommunityPointsCustomReward` and the input TYPE is still
  // `RedeemCommunityPointsCustomRewardInput!`.
  const REDEEM_OPS = ["RedeemCustomReward", "RedeemCommunityPointsCustomReward"];
  const REDEEM_FIELD = "redeemCommunityPointsCustomReward";
  const REDEEM_INPUT_TYPE = "RedeemCommunityPointsCustomRewardInput";
  const REDEEM_SELECTIONS = ["{ error { code } __typename }", "{ __typename }", ""];
  const INPUT_VARIANTS = ["full", "txn", "bare"];

  function buildRedeemQuery(op, selection) {
    return selection
      ? `mutation ${op}($input: ${REDEEM_INPUT_TYPE}!) { ${REDEEM_FIELD}(input: $input) ${selection} }`
      : `mutation ${op}($input: ${REDEEM_INPUT_TYPE}!) { ${REDEEM_FIELD}(input: $input) }`;
  }

  function newTransactionId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    } catch {}
    return ("tar" + Date.now() + Math.random().toString(36).slice(2)).slice(0, 32);
  }

  function buildRedeemInput(kind, params) {
    const { channelId, rewardId, cost, title, prompt } = params;
    const input = { channelID: channelId, rewardID: rewardId };
    if (kind !== "bare") input.transactionID = newTransactionId();
    if (kind === "full") {
      input.pricingType = "POINTS";
      if (typeof cost === "number") input.cost = cost;
      if (typeof title === "string") input.title = title;
      input.prompt = typeof prompt === "string" ? prompt : "";
    }
    return input;
  }

  const REDEEM_COMBOS = [];
  for (const op of REDEEM_OPS) {
    for (const sel of REDEEM_SELECTIONS) {
      for (const iv of INPUT_VARIANTS) {
        REDEEM_COMBOS.push({ op, query: buildRedeemQuery(op, sel), inputVariant: iv });
      }
    }
  }

  const schema = { contextIndex: 0, redeemIndex: 0 };

  async function handleGetContext(payload) {
    const login = payload && payload.login;
    if (!login) return { ok: false, error: "missing login" };

    for (let i = schema.contextIndex; i < CONTEXT_VARIANTS.length; i++) {
      const r = await gql(
        {
          operationName: "ChannelPointsContext",
          query: CONTEXT_VARIANTS[i],
          variables: { channelLogin: login },
        },
        { integrity: false }
      );
      const hasData = r.json && "data" in r.json && r.json.data;
      if (hasData) {
        const norm = normalizeContext(r.json.data);
        if (norm) {
          schema.contextIndex = i;
          return { ok: true, data: norm };
        }
        return { ok: false, error: "channel not found", reason: "no-user" };
      }
      const msg = errorMessage(r);
      if (!isSchemaError(msg)) {
        return { ok: false, error: msg || "no data" };
      }
      dbg("context variant", i, "rejected:", msg);
    }
    return { ok: false, error: "context query rejected in all variants" };
  }

  async function handleRedeem(payload) {
    const { channelId, rewardId, cost, title, prompt } = payload || {};
    if (!channelId || !rewardId) return { ok: false, error: "missing channel/reward id" };
    const params = { channelId, rewardId, cost, title, prompt };

    let integrityRetried = false;
    for (let i = schema.redeemIndex; i < REDEEM_COMBOS.length; i++) {
      const combo = REDEEM_COMBOS[i];
      const input = buildRedeemInput(combo.inputVariant, params);
      const r = await gql({
        operationName: combo.op,
        query: combo.query,
        variables: { input },
      });
      const msg = errorMessage(r);

      if (msg && isIntegrityError(msg) && !integrityRetried) {
        integrityRetried = true;
        invalidateIntegrity();
        await mintIntegrity(true);
        i--; // retry the same combo with a fresh token
        continue;
      }
      if (msg && /transaction_already_committed/i.test(msg)) {
        schema.redeemIndex = i;
        return { ok: true, data: { alreadyCommitted: true } };
      }
      if (msg && isSchemaError(msg)) {
        dbg("redeem variant", i, "rejected:", msg);
        continue;
      }
      if (msg) return { ok: false, error: msg };

      // No top-level errors: the payload's `error` field is the verdict.
      const out = r.json && r.json.data ? r.json.data[REDEEM_FIELD] : null;
      if (out === null || out === undefined) {
        return { ok: false, error: "empty redeem response" };
      }
      const code = out.error && out.error.code ? String(out.error.code) : null;
      if (code === "TRANSACTION_ALREADY_COMMITTED") {
        schema.redeemIndex = i;
        return { ok: true, data: { alreadyCommitted: true } };
      }
      if (code) return { ok: false, error: code };
      schema.redeemIndex = i;
      return { ok: true, data: out };
    }
    return { ok: false, error: "redeem rejected in all variants" };
  }

  // ------------------------------------------------------------- own requests

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.__tar !== "req") return;
    const { id, type, payload } = e.data;
    let out = { __tar: "res", id, ok: false, error: "" };
    try {
      if (type === "getContext") out = { ...out, ...(await handleGetContext(payload)) };
      else if (type === "redeem") out = { ...out, ...(await handleRedeem(payload)) };
      else out.error = "unknown request type: " + type;
    } catch (err) {
      out.error = String((err && err.message) || err);
      dbg("request failed", type, err);
    }
    window.postMessage(out, window.location.origin);
  });

  // ------------------------------------------------- passive response sniffer
  // Watches Twitch's own gql traffic: mirrors ChannelPointsContext responses
  // to the content script, and harvests Client-Integrity / X-Device-Id
  // values so we usually never have to mint our own.

  function postEvent(type, data) {
    window.postMessage({ __tar: "event", type, data }, window.location.origin);
  }

  function headerFrom(init, input, name) {
    try {
      if (init && init.headers) {
        const v = new Headers(init.headers).get(name);
        if (v) return v;
      }
      if (input && typeof input !== "string" && input.headers && input.headers.get) {
        const v = input.headers.get(name);
        if (v) return v;
      }
    } catch {}
    return null;
  }

  function installSniffer() {
    const orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function (input, init) {
      const call = orig.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.indexOf("gql.twitch.tv") !== -1) {
          const ci = headerFrom(init, input, "client-integrity");
          if (ci) storeIntegrity(ci, 0);
          const did = headerFrom(init, input, "x-device-id");
          if (did && !integrity.deviceId) integrity.deviceId = did;

          if (url.indexOf("/integrity") !== -1) {
            call
              .then((res) => {
                try {
                  res.clone().json()
                    .then((j) => { if (j && j.token) storeIntegrity(j.token, j.expiration); })
                    .catch(() => {});
                } catch {}
              })
              .catch(() => {});
          } else if (init && typeof init.body === "string") {
            let parsed = null;
            try { parsed = JSON.parse(init.body); } catch {}
            if (parsed && parsed.operationName === "ChannelPointsContext") {
              call
                .then((res) => {
                  try {
                    res.clone().json()
                      .then((json) => {
                        const norm = normalizeContext(json && json.data);
                        if (norm && norm.channelId) postEvent("context", norm);
                      })
                      .catch(() => {});
                  } catch {}
                })
                .catch(() => {});
            }
          }
        }
      } catch {}
      return call;
    };
  }

  installSniffer();
  dbg("bridge installed");
})();
