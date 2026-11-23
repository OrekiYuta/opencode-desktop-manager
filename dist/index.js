// src/index.ts
import { Plugin as Plugin2 } from "@opencode/plugin";

// src/github-copilot-fusion/index.ts
import { Model, Plugin } from "@opencode/plugin";

// src/github-copilot-fusion/creds.ts
var COPILOT_INTEGRATION_ID = "github-copilot";
var DEFAULT_BASE_URL = "https://api.githubcopilot.com";
var HOSTNAME_RE = /^[a-z0-9.-]+$/i;
function parseHostname(raw) {
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:") return void 0;
  if (url.username || url.password) return void 0;
  if (!HOSTNAME_RE.test(url.hostname)) return void 0;
  if (url.port && !/^\d{2,5}$/.test(url.port)) return void 0;
  return url.host;
}
function parseOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:") return void 0;
  if (url.username || url.password) return void 0;
  if (!HOSTNAME_RE.test(url.hostname)) return void 0;
  if (url.port && !/^\d{2,5}$/.test(url.port)) return void 0;
  return `${url.protocol}//${url.host}`;
}
function copilotBaseURLFromMetadata(metadata) {
  if (typeof metadata === "object" && metadata !== null) {
    const record2 = metadata;
    const endpoint = record2.apiEndpoint;
    if (typeof endpoint === "string" && endpoint.trim()) {
      return parseOrigin(endpoint.trim()) ?? DEFAULT_BASE_URL;
    }
    const enterprise = record2.enterpriseUrl;
    if (typeof enterprise === "string" && enterprise.trim()) {
      const host = parseHostname(enterprise.trim());
      if (!host) return DEFAULT_BASE_URL;
      return parseOrigin(`https://copilot-api.${host}`) ?? DEFAULT_BASE_URL;
    }
  }
  return DEFAULT_BASE_URL;
}
function copilotCredentialsFromCredential(credential) {
  if (!credential || credential.type !== "oauth") return void 0;
  const token = typeof credential.refresh === "string" && credential.refresh ? credential.refresh : typeof credential.access === "string" ? credential.access : void 0;
  if (!token) return void 0;
  return { token, baseURL: copilotBaseURLFromMetadata(credential.metadata) };
}
async function resolveCopilotCredentials(integration) {
  try {
    const connection = await integration.connection.active(COPILOT_INTEGRATION_ID);
    if (!connection) return void 0;
    const credential = await integration.connection.resolve(connection);
    return copilotCredentialsFromCredential(credential);
  } catch {
    return void 0;
  }
}

// src/github-copilot-fusion/router.ts
import { createHash } from "node:crypto";

// src/github-copilot-fusion/cache.ts
var LruMap = class extends Map {
  constructor(maxSize = 256) {
    super();
    this.maxSize = maxSize;
  }
  maxSize;
  get(key) {
    const value = super.get(key);
    if (value !== void 0) {
      this.delete(key);
      super.set(key, value);
    }
    return value;
  }
  set(key, value) {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    while (this.size > this.maxSize) {
      const oldest = this.keys().next().value;
      if (oldest === void 0) break;
      this.delete(oldest);
    }
    return this;
  }
};

// src/github-copilot-fusion/tiers.ts
var FUSION_TIERS = [
  { variant: "standard", wire: "balance", effort: "low", label: "Fusion Standard" },
  { variant: "high", wire: "hydrafusion", fallbackWire: "intelligence", effort: "high", label: "Fusion High" },
  { variant: "max", wire: "hydrafusion-max", effort: "xhigh", label: "Fusion Max" }
];
function isFusionVariant(value) {
  return value === "standard" || value === "high" || value === "max";
}
function normalizeVariant(value) {
  return isFusionVariant(value) ? value : void 0;
}
function resolveWireTier(variant, byId) {
  const spec = FUSION_TIERS.find((t) => t.variant === variant);
  if (!byId) return { wire: spec.wire, degraded: false };
  const enabled = (id) => byId[id];
  if (enabled(spec.wire)) return { wire: spec.wire, degraded: false };
  if (variant === "high" && spec.fallbackWire && enabled(spec.fallbackWire) === true) {
    return { wire: spec.fallbackWire, degraded: true };
  }
  if (enabled(spec.wire) === false) return null;
  return { wire: spec.wire, degraded: false };
}
function parseFusionMeta(payload) {
  if (typeof payload !== "object" || payload === null) return void 0;
  const tiers = payload.auto?.tiers;
  if (!Array.isArray(tiers)) return void 0;
  const byId = {};
  let fusionOffered = false;
  for (const raw of tiers) {
    if (typeof raw !== "object" || raw === null) continue;
    const tier = raw;
    if (typeof tier.id !== "string") continue;
    if (typeof tier.status?.enabled === "boolean") {
      byId[tier.id] = tier.status.enabled;
      if (tier.type === "fusion" && tier.status.enabled) fusionOffered = true;
    }
  }
  return { byId, fusionOffered };
}
var COPILOT_API_VERSION = "2026-08-01";

// src/github-copilot-fusion/wire.ts
function wirePath(wire) {
  switch (wire) {
    case "responses":
      return "/responses";
    case "chat":
      return "/chat/completions";
    case "messages":
      return "/v1/messages";
  }
}
function wireOfAnchor(anchor) {
  const pkg = typeof anchor.package === "string" ? anchor.package : "";
  if (pkg.includes("providers/anthropic") || pkg.includes("@ai-sdk/anthropic")) return "messages";
  const endpoint = anchor.settings?.endpoint;
  if (endpoint === "responses" || endpoint === "chat" || endpoint === "messages") {
    return endpoint;
  }
  const id = typeof anchor.modelID === "string" ? anchor.modelID : "";
  if (/^(mai-|grok-)/.test(id)) return "responses";
  const gpt = /^gpt-(\d+)/.exec(id);
  if (gpt && Number(gpt[1]) >= 5 && !id.startsWith("gpt-5-mini")) return "responses";
  return "chat";
}

// src/github-copilot-fusion/auto.ts
var ONE_HOUR_MS = 60 * 6e4;
var META_TTL_MS = 6e4;
var MAX_EXPIRY_MS = 25 * 60 * 6e4;
function endpointsInclude(endpoints, wire) {
  if (!Array.isArray(endpoints)) return null;
  const list = endpoints.filter((e) => typeof e === "string");
  if (list.length === 0) return null;
  const path = wirePath(wire);
  if (list.includes(path)) return true;
  if (wire === "messages" && list.some((e) => e.endsWith("/messages"))) return true;
  return false;
}
function parseAutoResponse(data, now) {
  if (typeof data !== "object" || data === null) return void 0;
  const record2 = data;
  const sessionToken = typeof record2.session_token === "string" ? record2.session_token.trim() : "";
  const selected = record2.selected_model ?? {};
  const modelId = typeof selected.id === "string" ? selected.id.trim() : "";
  if (!sessionToken || !modelId) return void 0;
  const rawSec = typeof record2.expires_at === "number" && Number.isFinite(record2.expires_at) ? record2.expires_at : null;
  const expiresAtMs = rawSec === null ? now + 24 * 3600 * 1e3 : Math.min(rawSec * 1e3, now + MAX_EXPIRY_MS);
  const input = selected.capabilities?.input;
  const vision = Array.isArray(input) ? input.includes("image") || input.includes("image_url") : null;
  return {
    modelId,
    sessionToken,
    expiresAtMs,
    endpoints: selected.supported_endpoints,
    vision,
    hydraScores: record2.hydra_scores,
    discountedCosts: record2.discounted_costs
  };
}
var CopilotClient = class {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  get fetchImpl() {
    return this.options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }
  get now() {
    return this.options.now?.() ?? Date.now();
  }
  get timeoutMs() {
    return this.options.timeoutMs ?? 5e3;
  }
  /**
   * Retry transient connect/TLS failures. Some networks (and Bun's fetch)
   * regularly drop the first connection to the Copilot API; one retry usually
   * succeeds where the first attempt times out.
   */
  async requestWithRetry(url, init, attempts = 3) {
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        last = error;
        if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1e3 * (attempt + 1)));
      }
    }
    throw last;
  }
  async postJson(url, token, body) {
    let response;
    try {
      response = await this.requestWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": COPILOT_API_VERSION
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      return { ok: false, reason: `network error: ${describeError(error)}`, code: "network" };
    }
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}`, code: `http_${response.status}` };
    }
    try {
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, reason: "response was not JSON", code: "bad_json" };
    }
  }
  async getJson(url, token) {
    try {
      const response = await this.requestWithRetry(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": COPILOT_API_VERSION
        }
      });
      if (!response.ok) return void 0;
      return await response.json();
    } catch {
      return void 0;
    }
  }
  /** Route a prompt via /auto. Never throws. */
  async selectModel(input) {
    const payload = {
      prompt: input.prompt.trim() === "" ? "Continue." : input.prompt,
      tier: input.tier,
      multi_turn: { routing_intent: "anchor", turns_since_anchor: input.turnsSinceAnchor }
    };
    if (input.hasImage) payload.has_image = true;
    const result = await this.postJson(`${input.baseURL}/auto`, input.token, payload);
    if (!result.ok) return result;
    const parsed = parseAutoResponse(result.data, this.now);
    if (!parsed) return { ok: false, reason: "response missing session_token or selected_model.id", code: "bad_shape" };
    return { ok: true, auto: parsed };
  }
  metaCache;
  catalogCache;
  /** GET /meta (cached briefly, keyed by host). Undefined on failure. */
  async getMeta(baseURL, token) {
    if (this.metaCache && this.now - this.metaCache.at < META_TTL_MS && this.metaCache.baseURL === baseURL) {
      return this.metaCache.value;
    }
    const value = await this.getJson(`${baseURL}/meta`, token).then(parseFusionMeta);
    this.metaCache = { value, at: this.now, baseURL };
    return value;
  }
  /** GET /models (cached an hour, keyed by host). Empty map on failure. */
  async getCatalog(baseURL, token) {
    if (this.catalogCache && this.now - this.catalogCache.at < ONE_HOUR_MS && this.catalogCache.baseURL === baseURL) {
      return this.catalogCache.value;
    }
    const value = /* @__PURE__ */ new Map();
    const payload = await this.getJson(`${baseURL}/models`, token);
    if (Array.isArray(payload?.data)) {
      for (const raw of payload.data) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw;
        if (typeof item.id !== "string") continue;
        const endpoints = Array.isArray(item.supported_endpoints) ? item.supported_endpoints.filter((e) => typeof e === "string") : null;
        value.set(item.id, endpoints);
      }
    }
    this.catalogCache = { value, at: this.now, baseURL };
    return value;
  }
  /** true / false / null when unknown. */
  async supportsWire(baseURL, token, modelId, wire, endpointsFromAuto) {
    const direct = endpointsInclude(endpointsFromAuto, wire);
    if (direct !== null) return direct;
    const catalog = await this.getCatalog(baseURL, token);
    return endpointsInclude(catalog.get(modelId) ?? null, wire);
  }
};
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// src/github-copilot-fusion/router.ts
var FIVE_MINUTES_MS = 5 * 6e4;
function hashPrompt(text) {
  try {
    return createHash("sha256").update(text).digest("hex");
  } catch {
    return void 0;
  }
}
function credsKey(token, baseURL) {
  return createHash("sha256").update(`${token} ${baseURL}`).digest("hex").slice(0, 16);
}
var FusionRouter = class _FusionRouter {
  constructor(options = {}) {
    this.options = options;
    this.client = new CopilotClient({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, now: options.now });
  }
  options;
  cache = new LruMap(256);
  inflight = /* @__PURE__ */ new Map();
  client;
  get now() {
    return this.options.now?.() ?? Date.now();
  }
  get skewMs() {
    return this.options.skewMs ?? FIVE_MINUTES_MS;
  }
  log(...args) {
    this.options.log?.(...args);
  }
  /** Access to /meta for setup-time variant gating. */
  getMeta(baseURL, token) {
    return this.client.getMeta(baseURL, token);
  }
  static SEP = "\0";
  static key(credsKey2, sessionID, variant, route, text) {
    const SEP = _FusionRouter.SEP;
    if (route === "prompt") {
      const hash = hashPrompt(text);
      return hash ? [credsKey2, sessionID, variant, hash].join(SEP) : void 0;
    }
    return [credsKey2, sessionID, variant].join(SEP);
  }
  /** Drop every cached route for a session (used after compaction). */
  invalidateSession(sessionID, creds) {
    const SEP = _FusionRouter.SEP;
    if (creds) {
      const prefix = [creds, sessionID].join(SEP) + SEP;
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
      return;
    }
    const needle = `${SEP}${sessionID}${SEP}`;
    for (const key of [...this.cache.keys()]) {
      if (key.includes(needle)) this.cache.delete(key);
    }
  }
  static isFresh(entry, now, skewMs) {
    return entry.expiresAtMs - now > skewMs;
  }
  /**
   * Route a prompt. Non-throwing: failures are reported as
   * `{ ok: false, reason }` so callers degrade to the anchor. Concurrent
   * turns for the same key share one /auto call.
   */
  async route(request) {
    const { credsKey: k, sessionID, variant, text, route } = request;
    const key = _FusionRouter.key(k, sessionID, variant, route, text);
    if (key === void 0) {
      return this.routeFresh(request, void 0);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.routePinned(request, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  async routePinned(request, key) {
    const cached = this.cache.get(key);
    if (cached && _FusionRouter.isFresh(cached, this.now, this.skewMs)) {
      if (!request.image || cached.vision !== false) {
        cached.turns += 1;
        return { ok: true, entry: cached };
      }
      this.log(`fusion: re-routing ${key} - image prompt vs pinned model without vision support`);
      this.cache.delete(key);
      const result = await this.routeFresh(request, void 0);
      return result;
    }
    return this.routeFresh(request, cached);
  }
  async routeFresh(request, cached) {
    const { baseURL, token, sessionID, variant, tier, text, image, route } = request;
    const previousTurns = cached?.turns ?? 0;
    const result = await this.client.selectModel({
      baseURL,
      token,
      prompt: text,
      hasImage: image,
      tier,
      turnsSinceAnchor: previousTurns
    });
    if (!result.ok) return this.previousOrFail(cached, result.reason, result.code);
    const auto = result.auto;
    if (image && auto.vision === false) {
      this.log(`fusion: picked ${auto.modelId} but prompt carries an image; falling back to anchor`);
      return { ok: false, reason: `fusion picked ${auto.modelId} without vision support`, code: "no_vision" };
    }
    const allowed = await this.client.supportsWire(baseURL, token, auto.modelId, request.wire, auto.endpoints);
    if (allowed === false) {
      return this.previousOrFail(cached, `selected model ${auto.modelId} does not serve ${request.wire} wire`, "wrong_wire");
    }
    if (this.options.log) {
      this.log(
        `fusion /auto picked ${auto.modelId}${auto.hydraScores ? `; hydra_scores=${JSON.stringify(auto.hydraScores)}` : ""}${auto.discountedCosts ? `; discounted_costs=${JSON.stringify(auto.discountedCosts)}` : ""}`
      );
    }
    const entry = {
      modelId: auto.modelId,
      sessionToken: auto.sessionToken,
      expiresAtMs: auto.expiresAtMs,
      vision: auto.vision,
      turns: previousTurns + 1
    };
    const key = _FusionRouter.key(request.credsKey, sessionID, variant, route, text);
    if (key !== void 0) this.cache.set(key, entry);
    return { ok: true, entry };
  }
  /** Reuse the previous route while it is still valid; otherwise fail. */
  previousOrFail(cached, reason, code) {
    if (cached && _FusionRouter.isFresh(cached, this.now, this.skewMs)) {
      this.log(`fusion: /auto unavailable (${reason}); reusing previous route to ${cached.modelId}`);
      return { ok: true, entry: cached };
    }
    this.log(`fusion: route unavailable (${reason})`);
    return code ? { ok: false, reason, code } : { ok: false, reason };
  }
};

// src/github-copilot-fusion/prompt.ts
var IMAGE_PART_TYPES = /* @__PURE__ */ new Set(["input_image", "image_url", "image"]);
function textFromContentPart(part) {
  if (typeof part !== "object" || part === null) return "";
  const p = part;
  if (typeof p.text === "string") return p.text;
  if (typeof p.text?.value === "string") {
    return p.text.value;
  }
  if (typeof p.input_text === "string") return p.input_text;
  if (typeof p.value === "string") return p.value;
  return "";
}
function contentHasImage(part) {
  if (typeof part !== "object" || part === null) return void 0;
  const type = part.type;
  return typeof type === "string" && IMAGE_PART_TYPES.has(type) ? true : void 0;
}
function readContent(content) {
  if (typeof content === "string") return { text: content, image: false };
  if (!Array.isArray(content)) return { text: "", image: false };
  let text = "";
  let image = false;
  for (const part of content) {
    const imageFlag = contentHasImage(part);
    if (imageFlag) {
      image = true;
      continue;
    }
    const t = textFromContentPart(part);
    if (t) text += (text ? " " : "") + t;
  }
  return { text: text.trim(), image };
}
function fromResponsesInput(input) {
  if (typeof input === "string") return { text: input, image: false };
  if (!Array.isArray(input)) return void 0;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (typeof item !== "object" || item === null) continue;
    const role = item.role;
    if (role !== "user") continue;
    return readContent(item.content);
  }
  return void 0;
}
function fromChatMessages(messages) {
  if (!Array.isArray(messages)) return void 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role !== "user") continue;
    return readContent(msg.content);
  }
  return void 0;
}
function extractPromptFromBody(body) {
  if (typeof body !== "object" || body === null) return null;
  const record2 = body;
  const fromInput = fromResponsesInput(record2.input);
  if (fromInput) return fromInput;
  const fromMessages = fromChatMessages(record2.messages);
  if (fromMessages) return fromMessages;
  return null;
}

// src/github-copilot-fusion/rewrite.ts
async function rewriteRequest(original, options) {
  let parsed = options.body;
  if (parsed === void 0) {
    try {
      parsed = await original.clone().json();
    } catch {
      return { ok: false, reason: "request body was not JSON" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "request body was not a JSON object" };
  }
  const next = { ...parsed, model: options.modelId };
  if (options.stripTemperature !== false) delete next.temperature;
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  try {
    headers.set("Copilot-Session-Token", options.sessionToken);
  } catch {
    return { ok: false, reason: "session token contains invalid header characters" };
  }
  return {
    ok: true,
    modelId: options.modelId,
    request: new Request(original, { headers, body: JSON.stringify(next), signal: original.signal })
  };
}

// src/github-copilot-fusion/options.ts
var DEFAULTS = {
  route: "conversation",
  stripTemperature: true,
  timeoutMs: 5e3,
  skewMs: 5 * 6e4,
  debug: false
};
var DEFAULT_FUSION_OPTIONS = { anchorModel: void 0, ...DEFAULTS };
function pickString(record2, key) {
  const value = record2[key];
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function pickBoolean(record2, key, fallback) {
  const value = record2[key];
  return typeof value === "boolean" ? value : fallback;
}
function pickNumber(record2, key, fallback, min, max) {
  const value = record2[key];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}
function parseFusionOptions(raw) {
  const record2 = typeof raw === "object" && raw !== null ? raw : {};
  return {
    anchorModel: pickString(record2, "anchorModel"),
    route: pickString(record2, "route") === "prompt" ? "prompt" : "conversation",
    stripTemperature: pickBoolean(record2, "stripTemperature", DEFAULTS.stripTemperature),
    timeoutMs: pickNumber(record2, "timeoutMs", DEFAULTS.timeoutMs, 500, 6e4),
    skewMs: pickNumber(record2, "skewMs", DEFAULTS.skewMs, 0, 24 * 60 * 6e4),
    debug: pickBoolean(record2, "debug", DEFAULTS.debug) || process.env.FUSION_DEBUG === "1"
  };
}

// src/github-copilot-fusion/sanitize.ts
import { createHash as createHash2 } from "node:crypto";
function sanitizeCallIds(body) {
  let changed = false;
  const idMap = /* @__PURE__ */ new Map();
  function getShortId(id) {
    let shortId = idMap.get(id);
    if (!shortId) {
      const hash = createHash2("sha256").update(id).digest("hex").slice(0, 40);
      shortId = `call_${hash}`;
      idMap.set(id, shortId);
    }
    return shortId;
  }
  function cleanString(val) {
    if (val.length > 64) {
      changed = true;
      return getShortId(val);
    }
    return val;
  }
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    const record2 = node;
    for (const [key, val] of Object.entries(record2)) {
      if (typeof val === "string") {
        if (key === "call_id" || key === "tool_call_id") {
          record2[key] = cleanString(val);
        } else if (key === "id" && val.length > 64 && (val.startsWith("call_") || record2.type === "function_call" || record2.type === "tool_call" || record2.type === "function")) {
          record2[key] = cleanString(val);
        }
      } else if (typeof val === "object" && val !== null) {
        walk(val);
      }
    }
  }
  walk(body);
  return changed;
}

// src/github-copilot-fusion/index.ts
var PROVIDER_ID = "github-copilot";
var MODEL_ID = "fusion";
var PREFERRED_ANCHORS = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-5.4", "gpt-5.3-codex"];
var github_copilot_fusion_default = Plugin.define({
  id: "opencode-desktop-manager",
  async setup(ctx) {
    const options = parseFusionOptions(ctx.options);
    const debug = (...args) => {
      if (options.debug) console.error("[copilot-fusion]", ...args);
    };
    const warn = (...args) => console.error("[copilot-fusion] warn:", ...args);
    const once = /* @__PURE__ */ new Set();
    const warnOnce = (key, ...args) => {
      if (once.has(key)) return;
      once.add(key);
      warn(...args);
    };
    const router = new FusionRouter({ timeoutMs: options.timeoutMs, skewMs: options.skewMs, log: debug });
    const state = {};
    const getCreds = async () => {
      const cached = state.creds;
      if (cached) {
        const ttl = cached.value ? 3e4 : 5e3;
        if (Date.now() - cached.at < ttl) return cached.value;
      }
      const value = await resolveCopilotCredentials(ctx.integration);
      state.creds = {
        value,
        at: Date.now(),
        key: value ? credsKey(value.token, value.baseURL) : void 0
      };
      return value;
    };
    const getMetaById = async () => {
      if (state.metaById) return state.metaById;
      const creds = await getCreds();
      if (!creds) return void 0;
      const meta = await router.getMeta(creds.baseURL, creds.token);
      state.metaById = meta?.byId;
      return state.metaById;
    };
    const credsAtSetup = await getCreds();
    if (credsAtSetup) {
      const meta = await router.getMeta(credsAtSetup.baseURL, credsAtSetup.token);
      state.metaById = meta?.byId;
      if (meta && !meta.fusionOffered) {
        warn(
          "no enabled Fusion (type:fusion) tiers reported by /meta \u2014 this account or organization may not have Fusion enabled (check your plan and org policy). Standard uses classic Auto `balance`; High can fall back to classic Auto `intelligence`."
        );
      }
      if (!meta) {
        warnOnce("meta-unreachable", "could not verify Fusion availability from /meta \u2014 registering all variants optimistically");
      }
    } else {
      debug("github-copilot is not connected yet; connect it (/connect) to enable Fusion routing");
    }
    const metaById = state.metaById;
    const fusionUnknown = !metaById;
    const tierEnabled = (id) => metaById?.[id] === true;
    const variantSpecs = FUSION_TIERS.filter((spec) => {
      if (spec.variant === "standard") return true;
      if (spec.variant === "max") return fusionUnknown || tierEnabled("hydrafusion-max");
      if (fusionUnknown) return true;
      if (tierEnabled("hydrafusion")) return true;
      if (tierEnabled("intelligence")) {
        warn("Fusion High (hydrafusion) not offered \u2014 variant 'high' will route via classic Auto tier 'intelligence' (no Fusion discount).");
        return true;
      }
      return false;
    });
    await ctx.model.transform((editor) => {
      const provider = PROVIDER_ID;
      let anchor = options.anchorModel ? editor.get(provider, options.anchorModel) : void 0;
      if (options.anchorModel && anchor && anchor.enabled === false) {
        warn(`anchorModel '${options.anchorModel}' is disabled in provider '${provider}' \u2014 falling back to defaults`);
        anchor = void 0;
      }
      if (options.anchorModel && !anchor) {
        warn(`anchorModel '${options.anchorModel}' not found in provider '${provider}' \u2014 falling back to defaults`);
      }
      if (!anchor) {
        for (const candidate of PREFERRED_ANCHORS) {
          const found = editor.get(provider, candidate);
          if (found && found.enabled !== false) {
            anchor = found;
            break;
          }
        }
      }
      if (!anchor) {
        const list = editor.list(provider).filter((model) => model.enabled !== false);
        anchor = list.find((model) => /^gpt-/.test(model.id)) ?? list[0];
      }
      if (!anchor) {
        warn("no enabled models found in provider 'github-copilot' \u2014 is Copilot connected? skipping fusion registration");
        return;
      }
      state.anchorWire = wireOfAnchor(anchor);
      debug(`fusion anchor: ${anchor.id} (modelID=${anchor.modelID}, package=${anchor.package}, wire=${state.anchorWire})`);
      const effortSetting = (effort) => state.anchorWire === "responses" ? { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } : { reasoningEffort: effort };
      editor.update(provider, MODEL_ID, (model) => {
        const cloned = structuredClone(anchor);
        Object.assign(model, cloned, {
          id: MODEL_ID,
          providerID: provider,
          modelID: anchor.modelID,
          // unmodified requests stay valid anchor calls
          name: "Copilot Fusion",
          family: "github-copilot-fusion",
          enabled: true,
          variants: variantSpecs.map((spec) => ({
            id: Model.VariantID.make(spec.variant),
            settings: effortSetting(spec.effort)
          }))
        });
      });
    });
    await ctx.session.hook(
      "compaction",
      (event) => {
        router.invalidateSession(event.sessionID, state.creds?.key ?? "");
        debug(`compaction: invalidated fusion routes for session ${event.sessionID}`);
      },
      { providerID: PROVIDER_ID }
    );
    if (options.debug) {
      await ctx.session.hook(
        "http.response",
        (event) => {
          if (event.model.id !== MODEL_ID || event.model.providerID !== PROVIDER_ID) return;
          event.response.headers.forEach((_value, name) => {
            if (/copilot|fusion|hydra|^x-github|model/i.test(name)) {
              debug(`fusion response header ${name}`);
            }
          });
        },
        { providerID: PROVIDER_ID }
      );
    }
    await ctx.session.hook(
      "http.request",
      async (event) => {
        try {
          if (event.model.providerID !== PROVIDER_ID) return;
          const cloned = await event.request.clone().json().catch(() => void 0);
          if (typeof cloned !== "object" || cloned === null) {
            debug("copilot: request body was not JSON \u2014 leaving request unchanged");
            return;
          }
          const callIdsSanitized = sanitizeCallIds(cloned);
          if (callIdsSanitized) {
            debug("copilot: sanitized call_ids (>64 chars) from previous session turns");
          }
          const applySanitizedFallback = () => {
            if (callIdsSanitized) {
              const headers = new Headers(event.request.headers);
              headers.delete("content-length");
              event.request = new Request(event.request, {
                headers,
                body: JSON.stringify(cloned),
                signal: event.request.signal
              });
            }
          };
          if (event.model.id !== MODEL_ID) {
            applySanitizedFallback();
            return;
          }
          if (event.kind === "title" || event.kind === "generate" || event.kind === "compaction") {
            applySanitizedFallback();
            return;
          }
          const creds = await getCreds();
          if (!creds) {
            warnOnce(
              "creds-missing",
              "github-copilot is not connected \u2014 fusion routing disabled; requests use the anchor model. Connect it and restart."
            );
            applySanitizedFallback();
            return;
          }
          const credsK = state.creds?.key ?? credsKey(creds.token, creds.baseURL);
          if (!state.anchorWire) {
            debug("fusion: anchor wire unresolved \u2014 leaving request unchanged");
            applySanitizedFallback();
            return;
          }
          const prompt = extractPromptFromBody(cloned);
          if (!prompt || !prompt.text.trim() && !prompt.image) {
            debug("fusion: no user prompt found in request body \u2014 leaving request unchanged");
            applySanitizedFallback();
            return;
          }
          const variant = normalizeVariant(event.model.variant);
          if (variant === void 0) {
            warnOnce("variant-unknown", `unrecognized variant '${String(event.model.variant)}' \u2014 using 'standard'`);
          }
          const normalized = variant ?? "standard";
          const metaByIdLazy = state.metaById ?? await getMetaById();
          const resolved = resolveWireTier(normalized, metaByIdLazy);
          if (!resolved) {
            warnOnce(
              `variant-disabled-${normalized}`,
              `Copilot Fusion tier '${normalized}' is not enabled for this account \u2014 using the anchor model for this turn.`
            );
            applySanitizedFallback();
            return;
          }
          const result = await router.route({
            baseURL: creds.baseURL,
            token: creds.token,
            credsKey: credsK,
            sessionID: event.sessionID,
            variant: normalized,
            wire: state.anchorWire,
            tier: resolved.wire,
            text: prompt.text,
            image: prompt.image,
            route: options.route
          });
          if (!result.ok) {
            if (result.code === "http_401" || result.code === "http_403") {
              state.creds = void 0;
            }
            warnOnce(`route-fallback-${result.code ?? "unknown"}`, `fusion route unavailable (${result.reason}) \u2014 using the anchor model for this turn`);
            applySanitizedFallback();
            return;
          }
          const entry = result.entry;
          const rewritten = await rewriteRequest(event.request, {
            modelId: entry.modelId,
            sessionToken: entry.sessionToken,
            stripTemperature: options.stripTemperature,
            body: cloned
          });
          if (!rewritten.ok) {
            warnOnce("rewrite-failed", `fusion: could not rewrite request (${rewritten.reason}) \u2014 using the anchor model for this turn`);
            applySanitizedFallback();
            return;
          }
          event.request = rewritten.request;
          debug(`fusion: ${normalized} -> ${entry.modelId}${resolved.degraded ? " (degraded: classic Auto tier)" : ""}`);
        } catch (error) {
          warnOnce(
            "unexpected-fusion-error",
            `unexpected error in fusion routing \u2014 using the anchor model for this turn: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      { providerID: PROVIDER_ID }
    );
  }
});

// src/github-copilot-usage/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var nullableNumber = { type: ["number", "null"] };
var nullableBoolean = { type: ["boolean", "null"] };
var nullableString = { type: ["string", "null"] };
var quota = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        entitlement: nullableNumber,
        remaining: nullableNumber,
        percentRemaining: nullableNumber,
        unlimited: nullableBoolean,
        overageCount: nullableNumber,
        overagePermitted: nullableBoolean,
        creditsUsed: nullableNumber,
        timestampUtc: nullableString,
        tokenBasedBilling: nullableBoolean,
        hasQuota: nullableBoolean
      },
      required: ["entitlement", "remaining", "percentRemaining", "unlimited", "overageCount", "overagePermitted", "creditsUsed", "timestampUtc", "tokenBasedBilling", "hasQuota"],
      additionalProperties: false
    }
  ]
};
var UsageRpc = Rpc.define({
  id: "copilot-usage",
  events: {},
  methods: {
    get: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        required: ["refresh"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "not_authenticated", "unauthorized", "forbidden", "network_error", "invalid_response", "rate_limited"] },
          data: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  login: nullableString,
                  loginStatus: { type: "string", enum: ["ok", "unauthorized", "forbidden", "rate_limited", "network_error", "invalid_response"] },
                  plan: nullableString,
                  resetDate: nullableString,
                  tokenBasedBilling: nullableBoolean,
                  quotas: {
                    type: "object",
                    properties: { chat: quota, completions: quota, premiumInteractions: quota },
                    required: ["chat", "completions", "premiumInteractions"],
                    additionalProperties: false
                  }
                },
                required: ["login", "loginStatus", "plan", "resetDate", "tokenBasedBilling", "quotas"],
                additionalProperties: false
              }
            ]
          },
          stale: { type: "boolean" },
          fetchedAt: nullableNumber,
          retryAfter: nullableNumber
        },
        required: ["status", "data", "stale", "fetchedAt", "retryAfter"],
        additionalProperties: false
      }
    }
  }
});

// src/github-copilot-usage/service.ts
import { createHash as createHash3 } from "node:crypto";
var CACHE_MS = 6e4;
var REFRESH_INTERVAL_MS = 15e3;
var SNAPSHOT_MAX_AGE_MS = 36e5;
var TIMEOUT_MS = 8e3;
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function number(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function boolean(value) {
  return typeof value === "boolean" ? value : null;
}
function quota2(value) {
  const item = record(value);
  if (!item) return null;
  const percentRemaining = number(item.percent_remaining);
  return {
    entitlement: number(item.entitlement),
    remaining: number(item.quota_remaining),
    percentRemaining: percentRemaining !== null && percentRemaining <= 100 ? percentRemaining : null,
    unlimited: boolean(item.unlimited),
    overageCount: number(item.overage_count),
    overagePermitted: boolean(item.overage_permitted),
    creditsUsed: number(item.credits_used),
    timestampUtc: timestamp(item.timestamp_utc),
    tokenBasedBilling: boolean(item.token_based_billing),
    hasQuota: boolean(item.has_quota)
  };
}
function parseUsage(value) {
  const root = record(value);
  if (!root || !("quota_snapshots" in root || "copilot_plan" in root || "quota_reset_date_utc" in root)) return null;
  if (root.quota_snapshots != null && !record(root.quota_snapshots)) return null;
  const snapshots = record(root.quota_snapshots);
  const plan = typeof root.copilot_plan === "string" && /^[a-z0-9_-]{1,80}$/i.test(root.copilot_plan) ? root.copilot_plan : null;
  const resetDate = timestamp(root.quota_reset_date_utc);
  return {
    plan,
    resetDate,
    tokenBasedBilling: boolean(root.token_based_billing),
    quotas: { chat: quota2(snapshots?.chat), completions: quota2(snapshots?.completions), premiumInteractions: quota2(snapshots?.premium_interactions) }
  };
}
function parseLogin(value) {
  const login = record(value)?.login;
  return typeof login === "string" && login.length <= 39 && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:_[a-z0-9]{3,8})?$/i.test(login) ? login : null;
}
var UsageService = class {
  cache;
  integration;
  fetcher;
  now;
  constructor(integration, fetcher = fetch, now = Date.now) {
    this.integration = integration;
    this.fetcher = fetcher;
    this.now = now;
  }
  async identity() {
    try {
      const connection = await this.integration.connection.active("github-copilot");
      if (!connection) return void 0;
      const credential = await this.integration.connection.resolve(connection);
      if (!credential || credential.type !== "oauth") return void 0;
      const access = typeof credential.access === "string" && credential.access ? credential.access : void 0;
      const refresh = typeof credential.refresh === "string" && credential.refresh ? credential.refresh : void 0;
      const usageToken = refresh ?? access;
      if (!usageToken) return void 0;
      const profileToken = access ?? usageToken;
      const info = record(connection);
      const id = typeof info?.id === "string" ? info.id : "";
      const key = createHash3("sha256").update(JSON.stringify([id, usageToken, profileToken])).digest("hex");
      return { key, usageToken, profileToken };
    } catch {
      return void 0;
    }
  }
  result(cache, status, stale, retryAfter = null) {
    const snapshotTime = cache.data?.quotas.premiumInteractions?.timestampUtc;
    const snapshotStale = snapshotTime != null && this.now() - Date.parse(snapshotTime) > SNAPSHOT_MAX_AGE_MS;
    return { status, data: cache.data, stale: cache.data !== null && (stale || snapshotStale), fetchedAt: cache.fetchedAt, retryAfter };
  }
  async get(input) {
    return this.getCurrent(input, 0);
  }
  async getCurrent(input, changes) {
    const identity = await this.identity();
    if (!identity) {
      this.cache = void 0;
      return { status: "not_authenticated", data: null, stale: false, fetchedAt: null, retryAfter: null };
    }
    if (!this.cache || this.cache.key !== identity.key) {
      this.cache = { key: identity.key, data: null, fetchedAt: null, lastAttempt: null, retryAfter: null, lastStatus: "network_error" };
    }
    const cache = this.cache;
    let result;
    const now = this.now();
    if (cache.inFlight) {
      result = await cache.inFlight;
    } else if (cache.retryAfter !== null && now < cache.retryAfter) {
      result = this.result(cache, input.refresh ? "rate_limited" : cache.lastStatus, cache.lastStatus !== "ok", cache.retryAfter);
    } else if (!input.refresh && cache.data && cache.fetchedAt !== null && now - cache.fetchedAt < CACHE_MS && cache.lastStatus === "ok") {
      result = this.result(cache, "ok", false);
    } else {
      cache.lastAttempt = now;
      cache.retryAfter = now + REFRESH_INTERVAL_MS;
      const pending = this.fetchUsage(cache, identity);
      cache.inFlight = pending;
      try {
        result = await pending;
      } finally {
        if (cache.inFlight === pending) cache.inFlight = void 0;
      }
    }
    const current = await this.identity();
    if (!current || current.key !== identity.key || this.cache !== cache) {
      if (changes < 2) return this.getCurrent({ refresh: false }, changes + 1);
      this.cache = void 0;
      return { status: "not_authenticated", data: null, stale: false, fetchedAt: null, retryAfter: null };
    }
    return result;
  }
  request(path, token) {
    return this.fetcher(`https://api.github.com${path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "opencode-copilot-usage" }
    });
  }
  async fetchLogin(identity) {
    const failure = (loginStatus) => ({ login: null, loginStatus });
    try {
      const response = await this.request("/user", identity.profileToken);
      if (response.status === 401) return failure("unauthorized");
      if (response.status === 429 || response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))) return failure("rate_limited");
      if (response.status === 403) return failure("forbidden");
      if (!response.ok) return failure("network_error");
      const login = parseLogin(await response.json());
      if (!login || login === identity.profileToken || login === identity.usageToken) return failure("invalid_response");
      return { login, loginStatus: "ok" };
    } catch (error) {
      return failure(error instanceof SyntaxError ? "invalid_response" : "network_error");
    }
  }
  async fetchUsage(cache, identity) {
    const login = this.fetchLogin(identity);
    let status = "network_error";
    let data = null;
    try {
      const response = await this.request("/copilot_internal/user", identity.usageToken);
      if (response.status === 401) status = "unauthorized";
      else if (response.status === 403) status = "forbidden";
      else if (response.status === 429) {
        status = "rate_limited";
        const header = response.headers.get("retry-after");
        if (header) {
          const seconds = Number(header);
          const date = Date.parse(header);
          const retry = Number.isFinite(seconds) && seconds >= 0 ? this.now() + seconds * 1e3 : date;
          if (Number.isFinite(retry)) cache.retryAfter = Math.max(cache.retryAfter ?? 0, Math.min(retry, this.now() + 36e5));
        }
      } else if (!response.ok) status = "network_error";
      else {
        try {
          data = parseUsage(await response.json());
        } catch {
          data = null;
        }
        status = data ? "ok" : "invalid_response";
      }
    } catch {
      status = "network_error";
    }
    const profile = await login;
    cache.lastStatus = status;
    if (data && status === "ok") {
      cache.data = { ...profile, ...data };
      cache.fetchedAt = this.now();
    }
    return this.result(cache, status, status !== "ok", status === "ok" ? null : cache.retryAfter);
  }
};

// src/index.ts
var index_default = Plugin2.define({
  id: github_copilot_fusion_default.id,
  async setup(ctx) {
    const usage = new UsageService(ctx.integration);
    await ctx.rpc.register(UsageRpc, {
      get: async (input) => usage.get(input)
    });
    return github_copilot_fusion_default.setup(ctx);
  }
});
export {
  index_default as default
};
