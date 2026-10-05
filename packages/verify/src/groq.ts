/**
 * Groq client for agent simulation.
 *
 * Groq's free tier is generous enough to replay every query in a benchmark, so
 * we use the biggest model available (`llama-3.3-70b-versatile`) and fall back
 * to the 8B when the 70B is rate limited — a slightly worse answer is far
 * more useful than no answer at all.
 */

import { config, errorMessage, hasApiKey, withRetry, isRetryableStatus } from '@agentready/shared';

export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqResponse {
  text: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  finishReason?: string;
}

export interface GroqOptions {
  apiKey?: string;
  model?: string;
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export class GroqNotConfiguredError extends Error {
  constructor() {
    super('GROQ_API_KEY is not set.');
    this.name = 'GroqNotConfiguredError';
  }
}

/** Is Groq usable in this environment? */
export function isGroqConfigured(apiKey?: string): boolean {
  return hasApiKey(apiKey ?? config().groq.apiKey);
}

/**
 * Chat completion via Groq's OpenAI-compatible endpoint.
 *
 * @throws {GroqNotConfiguredError} when no API key is present.
 */
export async function groqChat(messages: GroqMessage[], options: GroqOptions = {}): Promise<GroqResponse> {
  const cfg = config();
  const apiKey = options.apiKey ?? cfg.groq.apiKey;
  if (!hasApiKey(apiKey)) throw new GroqNotConfiguredError();

  const fetchImpl = options.fetchImpl ?? fetch;
  const primary = options.model ?? cfg.groq.model;
  const fallback = options.fallbackModel ?? cfg.groq.fallbackModel;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const call = async (model: string): Promise<GroqResponse> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetchImpl(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 1200,
          stream: false,
        }),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        const err = new Error(`Groq HTTP ${res.status}: ${text.slice(0, 300)}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }

      const body = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        model?: string;
        usage?: { total_tokens?: number };
      };

      const choice = body.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        model: body.model ?? model,
        tokensUsed: body.usage?.total_tokens ?? 0,
        latencyMs: Date.now() - started,
        ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  // Retry the primary model, then try the fallback once. Rate limits (429) and
  // 5xx are worth retrying; a 400 means the request is malformed.
  try {
    return await withRetry(() => call(primary), {
      attempts: 3,
      baseDelayMs: 800,
      maxDelayMs: 8_000,
      shouldRetry: (err) => {
        const status = (err as { status?: number })?.status;
        return typeof status === 'number' ? isRetryableStatus(status) : true;
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (primaryErr) {
    if (fallback && fallback !== primary) {
      try {
        return await withRetry(() => call(fallback), {
          attempts: 2,
          baseDelayMs: 800,
          shouldRetry: (err) => {
            const status = (err as { status?: number })?.status;
            return typeof status === 'number' ? isRetryableStatus(status) : true;
          },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch {
        // Fall through and report the original failure — it is more useful.
      }
    }
    throw primaryErr instanceof Error ? primaryErr : new Error(errorMessage(primaryErr));
  }
}