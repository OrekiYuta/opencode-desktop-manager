/**
 * opencode-copilot-fusion
 *
 * Registers a `github-copilot/fusion` model that reproduces GitHub Copilot
 * Fusion behaviour as seen in first-party clients (VS Code, Copilot CLI):
 *
 *   1. The request hits Copilot's router first:  POST {baseURL}/auto
 *      with the last user prompt, `has_image`, and the Fusion tier —
 *      Standard -> `balance`, High -> `hydrafusion` (falls back to classic
 *      Auto `intelligence`), Max -> `hydrafusion-max`.
 *   2. /auto replies with a one-off model pick and a 24h `session_token`.
 *      The inference request is rewritten to the picked model and sent with
 *      `Copilot-Session-Token` — this is what bills Fusion, including the
 *      30% launch discount on paid plans (through 2026-11-30), applied
 *      server-side.
 *   3. Routing is sticky per conversation ("route like the CLI"): the first
 *      primary turn anchors the model; re-route happens on compaction,
 *      token nearing expiry (5 min skew), a variant switch, or an image
 *      prompt when the pinned pick has no vision support.
 *
 * Auth reuses opencode's stored GitHub Copilot credential — no extra token.
 * The unmodified request is always a valid call to the anchor model, so any
 * failure path simply degrades to the anchor instead of breaking the turn.
 */
import { Model, Plugin } from "@opencode/plugin"
import { resolveCopilotCredentials, type CopilotCredentials } from "./creds.js"
import { FusionRouter, credsKey } from "./router.js"
import { extractPromptFromBody } from "./prompt.js"
import {
  FUSION_TIERS,
  normalizeVariant,
  resolveWireTier,
  type TierAvailability,
} from "./tiers.js"
import { wireOfAnchor, type Wire } from "./wire.js"
import { rewriteRequest } from "./rewrite.js"
import { parseFusionOptions } from "./options.js"

const PROVIDER_ID = "github-copilot"
const MODEL_ID = "fusion"
const PREFERRED_ANCHORS = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-5.4", "gpt-5.3-codex"]

export default Plugin.define({
  id: "opencode-desktop-manager",
  async setup(ctx) {
    const options = parseFusionOptions(ctx.options)
    const debug = (...args: unknown[]) => {
      if (options.debug) console.error("[copilot-fusion]", ...args)
    }
    const warn = (...args: unknown[]) => console.error("[copilot-fusion] warn:", ...args)
    const once = new Set<string>()
    const warnOnce = (key: string, ...args: unknown[]) => {
      if (once.has(key)) return
      once.add(key)
      warn(...args)
    }

    const router = new FusionRouter({ timeoutMs: options.timeoutMs, skewMs: options.skewMs, log: debug })
    const state: {
      anchorWire?: Wire
      metaById?: TierAvailability["byId"]
      creds?: { value: CopilotCredentials | undefined; at: number; key: string | undefined }
      warnedMissingCreds?: boolean
    } = {}

    const getCreds = async (): Promise<CopilotCredentials | undefined> => {
      const cached = state.creds
      if (cached) {
        // Positive results are cheap to trust for 30s; negatives re-check sooner.
        const ttl = cached.value ? 30_000 : 5_000
        if (Date.now() - cached.at < ttl) return cached.value
      }
      const value = await resolveCopilotCredentials(ctx.integration)
      state.creds = {
        value,
        at: Date.now(),
        key: value ? credsKey(value.token, value.baseURL) : undefined,
      }
      return value
    }

    /** Lazy /meta resolution (setup-time fetch may not have run yet). */
    const getMetaById = async (): Promise<TierAvailability["byId"]> => {
      if (state.metaById) return state.metaById
      const creds = await getCreds()
      if (!creds) return undefined
      const meta = await router.getMeta(creds.baseURL, creds.token)
      state.metaById = meta?.byId
      return state.metaById
    }

    // ---- 1) Discover fusion tier availability (never fatal) ----
    const credsAtSetup = await getCreds()
    if (credsAtSetup) {
      const meta = await router.getMeta(credsAtSetup.baseURL, credsAtSetup.token)
      state.metaById = meta?.byId
      if (meta && !meta.fusionOffered) {
        warn(
          "no enabled Fusion (type:fusion) tiers reported by /meta — this account or organization may not have" +
            " Fusion enabled (check your plan and org policy). Standard uses classic Auto `balance`;" +
            " High can fall back to classic Auto `intelligence`.",
        )
      }
      if (!meta) {
        warnOnce("meta-unreachable", "could not verify Fusion availability from /meta — registering all variants optimistically")
      }
    } else {
      debug("github-copilot is not connected yet; connect it (/connect) to enable Fusion routing")
    }

    // Which variants to expose — mirrors the CLI's managed fusionTier mapping:
    // high falls back to classic Auto `intelligence`; max has no fallback.
    const metaById = state.metaById
    const fusionUnknown = !metaById
    const tierEnabled = (id: string) => metaById?.[id] === true
    const variantSpecs = FUSION_TIERS.filter((spec) => {
      if (spec.variant === "standard") return true
      if (spec.variant === "max") return fusionUnknown || tierEnabled("hydrafusion-max")
      // high
      if (fusionUnknown) return true
      if (tierEnabled("hydrafusion")) return true
      if (tierEnabled("intelligence")) {
        warn("Fusion High (hydrafusion) not offered — variant 'high' will route via classic Auto tier 'intelligence' (no Fusion discount).")
        return true
      }
      return false
    })

    // ---- 2) Register github-copilot/fusion (inherits anchor metadata) ----
    await ctx.model.transform((editor) => {
      const provider = PROVIDER_ID
      // Resolve anchor: explicit option, then preferred GPT anchors, then any enabled GPT, then anything.
      let anchor = options.anchorModel ? editor.get(provider, options.anchorModel) : undefined
      if (options.anchorModel && anchor && anchor.enabled === false) {
        warn(`anchorModel '${options.anchorModel}' is disabled in provider '${provider}' — falling back to defaults`)
        anchor = undefined
      }
      if (options.anchorModel && !anchor) {
        warn(`anchorModel '${options.anchorModel}' not found in provider '${provider}' — falling back to defaults`)
      }
      if (!anchor) {
        for (const candidate of PREFERRED_ANCHORS) {
          const found = editor.get(provider, candidate)
          if (found && found.enabled !== false) {
            anchor = found
            break
          }
        }
      }
      if (!anchor) {
        const list = editor.list(provider).filter((model) => model.enabled !== false)
        anchor = list.find((model) => /^gpt-/.test(model.id)) ?? list[0]
      }
      if (!anchor) {
        warn("no enabled models found in provider 'github-copilot' — is Copilot connected? skipping fusion registration")
        return
      }
      state.anchorWire = wireOfAnchor(anchor)
      debug(`fusion anchor: ${anchor.id} (modelID=${anchor.modelID}, package=${anchor.package}, wire=${state.anchorWire})`)

      // Variant settings are wire-aware: Responses accepts the full effort
      // block; other wires get reasoningEffort only.
      const effortSetting = (effort: "low" | "high" | "xhigh") =>
        state.anchorWire === "responses"
          ? { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
          : { reasoningEffort: effort }

      editor.update(provider, MODEL_ID, (model) => {
        const cloned = structuredClone(anchor)
        Object.assign(model, cloned, {
          id: MODEL_ID,
          providerID: provider,
          modelID: anchor.modelID, // unmodified requests stay valid anchor calls
          name: "Copilot Fusion",
          family: "github-copilot-fusion",
          enabled: true,
          variants: variantSpecs.map((spec) => ({
            id: Model.VariantID.make(spec.variant),
            settings: effortSetting(spec.effort),
          })),
        })
      })
    })

    // ---- 3) Drop cached routes after compaction (CLI re-anchors too) ----
    await ctx.session.hook(
      "compaction",
      (event) => {
        router.invalidateSession(event.sessionID, state.creds?.key ?? "")
        debug(`compaction: invalidated fusion routes for session ${event.sessionID}`)
      },
      { providerID: PROVIDER_ID },
    )

    // ---- 4) Surface any server headers that reveal fusion orchestration (debug only) ----
    if (options.debug) {
      await ctx.session.hook(
        "http.response",
        (event) => {
          if (event.model.id !== MODEL_ID || event.model.providerID !== PROVIDER_ID) return
          event.response.headers.forEach((_value, name) => {
            if (/copilot|fusion|hydra|^x-github|model/i.test(name)) {
              // Log names only: header values may contain session tokens.
              debug(`fusion response header ${name}`)
            }
          })
        },
        { providerID: PROVIDER_ID },
      )
    }

    // ---- 5) Route + rewrite on the wire ----
    await ctx.session.hook(
      "http.request",
      async (event) => {
        try {
        if (event.model.id !== MODEL_ID || event.model.providerID !== PROVIDER_ID) return
        // Auxiliary calls stay deterministic and cheap — never route them.
        if (event.kind === "title" || event.kind === "generate" || event.kind === "compaction") return

        const creds = await getCreds()
        if (!creds) {
          warnOnce(
            "creds-missing",
            "github-copilot is not connected — fusion routing disabled; requests use the anchor model. Connect it and restart.",
          )
          return
        }
        const credsK = state.creds?.key ?? credsKey(creds.token, creds.baseURL)
        if (!state.anchorWire) {
          debug("fusion: anchor wire unresolved — leaving request unchanged")
          return
        }

        const cloned = await event.request.clone().json().catch(() => undefined)
        if (typeof cloned !== "object" || cloned === null) {
          debug("fusion: request body was not JSON — leaving request unchanged")
          return
        }
        const prompt = extractPromptFromBody(cloned)
        if (!prompt || (!prompt.text.trim() && !prompt.image)) {
          debug("fusion: no user prompt found in request body — leaving request unchanged")
          return
        }
        const variant = normalizeVariant(event.model.variant)
        if (variant === undefined) {
          warnOnce("variant-unknown", `unrecognized variant '${String(event.model.variant)}' — using 'standard'`)
        }
        const normalized = variant ?? "standard"

        const metaByIdLazy = state.metaById ?? (await getMetaById())
        const resolved = resolveWireTier(normalized, metaByIdLazy)
        if (!resolved) {
          warnOnce(
            `variant-disabled-${normalized}`,
            `Copilot Fusion tier '${normalized}' is not enabled for this account — using the anchor model for this turn.`,
          )
          return
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
          route: options.route,
        })
        if (!result.ok) {
          if (result.code === "http_401" || result.code === "http_403") {
            state.creds = undefined
          }
          warnOnce(`route-fallback-${result.code ?? "unknown"}`, `fusion route unavailable (${result.reason}) — using the anchor model for this turn`)
          return
        }
        const entry = result.entry
        const rewritten = await rewriteRequest(event.request, {
          modelId: entry.modelId,
          sessionToken: entry.sessionToken,
          stripTemperature: options.stripTemperature,
          body: cloned as Record<string, unknown>,
        })
        if (!rewritten.ok) {
          warnOnce("rewrite-failed", `fusion: could not rewrite request (${rewritten.reason}) — using the anchor model for this turn`)
          return
        }
        event.request = rewritten.request
        debug(`fusion: ${normalized} -> ${entry.modelId}${resolved.degraded ? " (degraded: classic Auto tier)" : ""}`)
        } catch (error) {
          // Last-resort: never abort the turn in the plugin's name.
          warnOnce(
            "unexpected-fusion-error",
            `unexpected error in fusion routing — using the anchor model for this turn: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      },
      { providerID: PROVIDER_ID },
    )
  },
})
