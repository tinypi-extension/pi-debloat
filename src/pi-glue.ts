/**
 * pi-API glue: the only place that knows about `ctx.modelRegistry` /
 * `ctx.sessionManager`. Everything here is a thin adapter over the pure modules;
 * no pi value is imported at runtime (type-only imports only).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Context, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";

import type { LlmCall } from "./llm.js";
import type { ModelRef } from "./settings.js";
import { deriveState, type DebloatState, type EntryLike } from "./state.js";

/** A bound one-shot caller plus the human-readable model name for messages. */
export interface DebloatCaller {
  call: LlmCall;
  modelLabel: string;
}

/** pi-ai's thinking levels; anything else (incl. "off") degrades to the default. */
const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return String(error);
}

/** Join the text blocks of an assistant `content` value. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Auth for a direct `provider.streamSimple()` call. `streamSimple` asserts an
 * API key (or an auth header) before dispatching, so `getApiKeyAndHeaders` is
 * preferred (it mirrors `ModelRuntime.prepareRequest`, adding configured headers
 * and any baseUrl override); `getApiKeyForProvider` remains the plain fallback.
 */
interface CallerAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  env?: Record<string, string>;
}

async function resolveAuth(
  ctx: ExtensionCommandContext,
  model: NonNullable<ReturnType<ExtensionCommandContext["modelRegistry"]["find"]>>,
): Promise<CallerAuth> {
  try {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (resolved.ok) {
      return {
        ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
        ...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
        ...(resolved.baseUrl === undefined ? {} : { baseUrl: resolved.baseUrl }),
        ...(resolved.env === undefined ? {} : { env: resolved.env }),
      };
    }
  } catch {
    // fall through to the plain API key lookup
  }
  try {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (apiKey !== undefined) return { apiKey };
  } catch {
    // no auth available; `streamSimple` will surface the error
  }
  return {};
}

/** Session id for providers that support session-scoped caching. */
function sessionId(ctx: ExtensionCommandContext): string | undefined {
  try {
    const id = ctx.sessionManager.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a configured model into an `LlmCall`. Throws a descriptive Error when
 * the model is not in the registry — callers notify instead of propagating.
 *
 * Primary path is the provider's `streamSimple()`: only it reads
 * `options.reasoning`, so it is the only way the configured thinking level has
 * any effect (see pi-ai `api/anthropic-messages.js:655`,
 * `api/openai-completions.js:533`, `api/openai-responses.js:162`,
 * `api/google-generative-ai.js:232`). The registry's `complete()` routes to
 * `provider.stream()` (`core/model-runtime.js:423,458`), which ignores
 * `reasoning`, so it is only the fallback for providers/registries that lack
 * `streamSimple` or for which it fails before dispatch.
 */
export function createCaller(
  ctx: ExtensionCommandContext,
  ref: ModelRef,
  thinkingLevel: string,
): DebloatCaller {
  const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
  if (!model) {
    throw new Error(`model ${ref.provider}/${ref.modelId} is not available`);
  }

  const modelLabel = `${ref.provider}/${ref.modelId}`;
  const reasoning = THINKING_LEVELS.has(thinkingLevel)
    ? (thinkingLevel as ThinkingLevel)
    : undefined;
  const sid = sessionId(ctx);

  const call: LlmCall = async (request) => {
    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: request.userPrompt }],
          timestamp: Date.now(),
        },
      ],
    };

    const options: SimpleStreamOptions = {};
    // Omit unknown/"off"/empty levels so providers degrade to their default
    // rather than erroring on an unsupported reasoning value.
    if (reasoning !== undefined) options.reasoning = reasoning;
    if (request.maxTokens !== undefined) options.maxTokens = request.maxTokens;
    if (request.signal !== undefined) options.signal = request.signal;
    if (sid !== undefined) options.sessionId = sid;

    const viaRegistry = async (): Promise<{ text: string; usage?: unknown }> => {
      const response = await ctx.modelRegistry.complete(model, context, options);
      return {
        text: contentText(response?.content),
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
      };
    };

    // PRIMARY: provider.streamSimple() — the only path that honours `reasoning`.
    const provider = ctx.modelRegistry.getProvider(ref.provider);
    if (provider && typeof provider.streamSimple === "function") {
      // Setup (auth resolution + the synchronous `streamSimple` call) is kept
      // separate from awaiting `result()` on purpose. A throw during setup means
      // no request was ever dispatched, so retrying through `complete()` cannot
      // bill the user twice. Once `streamSimple` has returned, the request has
      // been dispatched and a rejection from `result()` must propagate as-is.
      const started = await (async () => {
        try {
          const auth = await resolveAuth(ctx, model);
          const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
          const stream = provider.streamSimple(effectiveModel, context, {
            ...options,
            ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
            ...(auth.headers === undefined ? {} : { headers: auth.headers }),
            ...(auth.env === undefined ? {} : { env: auth.env }),
          });
          return { ok: true as const, stream };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();

      if (started.ok) {
        // Dispatched: never fall back past this point.
        const message = await started.stream.result();
        return {
          text: contentText(message?.content),
          ...(message?.usage === undefined ? {} : { usage: message.usage }),
        };
      }

      // FALLBACK: registry.complete() only when streamSimple is unavailable or
      // failed before dispatch.
      try {
        return await viaRegistry();
      } catch {
        throw started.error;
      }
    }

    return viaRegistry();
  };

  return { call, modelLabel };
}

/** Derive debloat state from the current branch. Never throws. */
export function readState(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi?: ExtensionAPI,
): DebloatState {
  void pi;
  try {
    const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    return deriveState(branch);
  } catch {
    return deriveState([]);
  }
}

/** The current leaf entry id, or null when the session has no leaf. */
export function currentLeafId(ctx: ExtensionCommandContext | ExtensionContext): string | null {
  try {
    return ctx.sessionManager.getLeafId() ?? null;
  } catch {
    return null;
  }
}

export { errorText };
