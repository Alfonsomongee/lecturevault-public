/**
 * Gemini API client (with optional DeepSeek fallback) — shared by notes, study tools, embeddings and Q&A.
 *
 * - API keys go in headers (`x-goog-api-key` for Gemini, `Authorization: Bearer` for DeepSeek; never in URLs,
 *   so they can't leak through logs, proxies or error messages).
 * - Retries 429 / 5xx / timeouts / unreadable bodies with exponential backoff; every request has a deadline,
 *   so a hung connection can never freeze the AI queue.
 * - Lives within the free quota (ai/quota.ts): text requests are paced (GEMINI_RPM per minute, default 8),
 *   a per-minute 429 waits what Gemini asks instead of falling to the paid fallback after 10 s, and a
 *   daily-quota 429 gives up at once.
 * - Refuses truncated output (finishReason MAX_TOKENS / length) instead of silently saving it.
 * - Supports JSON-schema constrained output for structured extraction.
 * - When `DEEPSEEK_API_KEY` is configured, text and JSON requests automatically fall back to DeepSeek if
 *   Gemini fails (or run directly on DeepSeek when `GEMINI_API_KEY` is absent). Embeddings stay on Gemini.
 */

import type { Logger } from 'pino';
import { quotaWait, RateGate } from './quota.js';

/** One pacing window per key and process: every client using the same key shares the same quota. */
const GATES = new Map<string, RateGate>();
/** A per-minute 429 that asks for longer than this is treated as a failure (something else is wrong). */
const MAX_QUOTA_WAIT_MS = 90_000;

function defaultRequestsPerMinute(): number {
  const n = Number(process.env['GEMINI_RPM'] ?? '8');
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
/** Current general-purpose DeepSeek model (the old `deepseek-chat` alias was retired on 2026-07-24). */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
/** Retired DeepSeek ids that older `.env` files may still carry: they map to the V4 Flash model. */
const LEGACY_DEEPSEEK_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
/** Output cap asked of DeepSeek by default; if the API refuses it we retry once with the old 8192. */
const DEEPSEEK_MAX_OUTPUT_TOKENS = 16_384;
const DEEPSEEK_SAFE_MAX_OUTPUT_TOKENS = 8192;

/** Map a retired DeepSeek model id to its replacement; anything else is used as given. */
export function resolveDeepseekModel(model?: string): string {
  const id = (model ?? '').trim();
  if (!id || LEGACY_DEEPSEEK_MODELS.has(id)) return DEFAULT_DEEPSEEK_MODEL;
  return id;
}
/** Embedding a batch is quick; waiting longer than this means the connection is stuck */
const EMBED_TIMEOUT_MS = 60_000;

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  /** Optional DeepSeek API key used as automatic fallback when Gemini fails (or when Gemini key is absent) */
  deepseekApiKey?: string;
  /** DeepSeek model for text/JSON generation (default: deepseek-v4-flash; retired `deepseek-chat` is mapped to it) */
  deepseekModel?: string;
  logger?: Logger;
  /** Max attempts per request (default 4) */
  maxAttempts?: number;
  /** Base backoff in ms (default 1500). Tests set this to 0. */
  backoffMs?: number;
  /** Deadline of one request, body included (default 180 s: long notes with thinking are slow) */
  timeoutMs?: number;
  /** Text requests per minute to Gemini (default GEMINI_RPM, else 8; 0 = no pacing) */
  requestsPerMinute?: number;
}

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Gemini responseSchema (OpenAPI subset). Implies application/json output. */
  schema?: Record<string, unknown>;
  /** Try this provider first (JSON calls). DeepSeek is cheaper; Gemini stays as the fallback. */
  prefer?: 'deepseek';
}

export interface ProviderCheck {
  provider: 'gemini' | 'deepseek';
  model: string;
  ok: boolean;
  ms: number;
  /** The start of the answer, or the error */
  detail: string;
}

export class GeminiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GeminiError';
  }
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly deepseekApiKey: string;
  readonly model: string;
  readonly deepseekModel: string;
  readonly embeddingModel: string;
  private _lastModelUsed: string;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly gate: RateGate;

  constructor(options: GeminiClientOptions = {}) {
    this.apiKey = (options.apiKey !== undefined ? options.apiKey : (process.env['GEMINI_API_KEY'] || '')).trim();
    this.deepseekApiKey = (
      options.deepseekApiKey !== undefined
        ? options.deepseekApiKey
        : options.apiKey === undefined
          ? (process.env['DEEPSEEK_API_KEY'] || '')
          : ''
    ).trim();
    this.model = options.model || 'gemini-2.5-flash';
    this.deepseekModel = resolveDeepseekModel(options.deepseekModel);
    this.embeddingModel = options.embeddingModel || 'gemini-embedding-001';
    this._lastModelUsed = this.apiKey ? this.model : this.deepseekApiKey ? this.deepseekModel : this.model;
    this.logger = options.logger?.child({ component: 'gemini' });
    this.maxAttempts = options.maxAttempts ?? 4;
    this.backoffMs = options.backoffMs ?? 1500;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    const rpm = options.requestsPerMinute ?? defaultRequestsPerMinute();
    const gateKey = `${this.apiKey}|${rpm}`;
    if (!GATES.has(gateKey)) GATES.set(gateKey, new RateGate(rpm));
    this.gate = GATES.get(gateKey)!;
  }

  /** True when at least one text provider (Gemini or DeepSeek) is configured. */
  get hasKey(): boolean {
    return this.apiKey.length > 0 || this.deepseekApiKey.length > 0;
  }

  get hasGeminiKey(): boolean {
    return this.apiKey.length > 0;
  }

  get hasDeepseekKey(): boolean {
    return this.deepseekApiKey.length > 0;
  }

  /** Embeddings require Gemini (DeepSeek does not provide an embeddings API). */
  get hasEmbeddingKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** Model that answered the most recent text/JSON call (or the primary configured model). */
  get lastModelUsed(): string {
    return this._lastModelUsed;
  }

  private requireAnyKey(): void {
    if (!this.hasKey) {
      throw new GeminiError(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar las funciones de IA.'
      );
    }
  }

  private requireGeminiKey(): void {
    if (!this.apiKey) {
      throw new GeminiError(
        'GEMINI_API_KEY no está configurada. Añádela en tu archivo .env para usar las funciones de IA.'
      );
    }
  }

  private redact(text: string): string {
    let out = text;
    if (this.apiKey) out = out.split(this.apiKey).join('***');
    if (this.deepseekApiKey) out = out.split(this.deepseekApiKey).join('***');
    return out;
  }

  /**
   * POST to Gemini with a deadline and retry/backoff on 429, 5xx, timeouts and bodies that are not JSON.
   * Never includes the key in thrown messages.
   */
  private async post(url: string, body: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    this.requireGeminiKey();
    let lastError: GeminiError | undefined;

    // Text generation shares the free per-minute quota; embeddings have their own and are not paced here
    const paced = url.includes(':generateContent');
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (paced && this.backoffMs > 0) await this.gate.take();
      // The signal covers the whole exchange, reading the body included
      const signal = AbortSignal.timeout(timeoutMs);
      const timedOut = () => new GeminiError(`Gemini no respondió en ${Math.round(timeoutMs / 1000)} s.`);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        lastError = signal.aborted ? timedOut() : new GeminiError(`No se pudo contactar con Gemini: ${this.redact((err as Error).message)}`);
        this.logger?.warn({ attempt, timedOut: signal.aborted }, 'Gemini request failed, retrying');
        await this.sleep(attempt);
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          // A cut connection or an HTML page served with a 200: worth another try, never a crash
          lastError = signal.aborted ? timedOut() : new GeminiError('Gemini devolvió una respuesta que no es JSON.');
          this.logger?.warn({ attempt, timedOut: signal.aborted }, 'Gemini response unreadable, retrying');
          await this.sleep(attempt);
          continue;
        }
      }

      const errorBody = this.redact(await response.text().catch(() => ''));
      lastError = new GeminiError(
        `Error en la API de Gemini (${response.status} ${response.statusText}): ${errorBody.slice(0, 500)}`,
        response.status
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;

      const quota = quotaWait(response.status, errorBody, response.headers?.get?.('retry-after'));
      if (quota?.kind === 'day') {
        // No wait helps until tomorrow: say so plainly (the caller may fall back or leave the step for later)
        throw new GeminiError('Se ha agotado la cuota diaria gratuita de Gemini; se reintentará mañana.', 429);
      }
      if (quota?.kind === 'minute') {
        if (quota.ms > MAX_QUOTA_WAIT_MS) throw lastError;
        this.logger?.warn({ attempt, waitMs: quota.ms }, 'Gemini per-minute quota reached, waiting what it asks');
        // Every client of this key waits too: the quota is shared
        if (this.backoffMs > 0) this.gate.pause(quota.ms + 500);
        if (!paced && this.backoffMs > 0) await new Promise((r) => setTimeout(r, quota.ms + 500));
        continue;
      }

      this.logger?.warn({ status: response.status, attempt }, 'Gemini request failed, retrying');
      await this.sleep(attempt);
    }

    throw lastError ?? new GeminiError('Gemini request failed');
  }

  /**
   * POST to DeepSeek with the same deadline and retry/backoff guarantees as Gemini.
   * Never includes the key in thrown messages.
   */
  private async postDeepseek(body: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    if (!this.deepseekApiKey) {
      throw new GeminiError('DEEPSEEK_API_KEY no está configurada.');
    }
    let lastError: GeminiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      const timedOut = () => new GeminiError(`DeepSeek no respondió en ${Math.round(timeoutMs / 1000)} s.`);

      let response: Response;
      try {
        response = await fetch(DEEPSEEK_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.deepseekApiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        lastError = signal.aborted ? timedOut() : new GeminiError(`No se pudo contactar con DeepSeek: ${this.redact((err as Error).message)}`);
        this.logger?.warn({ attempt, timedOut: signal.aborted }, 'DeepSeek request failed, retrying');
        await this.sleep(attempt);
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          lastError = signal.aborted ? timedOut() : new GeminiError('DeepSeek devolvió una respuesta que no es JSON.');
          this.logger?.warn({ attempt, timedOut: signal.aborted }, 'DeepSeek response unreadable, retrying');
          await this.sleep(attempt);
          continue;
        }
      }

      const errorBody = this.redact(await response.text().catch(() => ''));
      lastError = new GeminiError(
        `Error en la API de DeepSeek (${response.status} ${response.statusText}): ${errorBody.slice(0, 500)}`,
        response.status
      );

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;

      this.logger?.warn({ status: response.status, attempt }, 'DeepSeek request failed, retrying');
      await this.sleep(attempt);
    }

    throw lastError ?? new GeminiError('DeepSeek request failed');
  }

  private async sleep(attempt: number): Promise<void> {
    if (this.backoffMs <= 0 || attempt >= this.maxAttempts) return;
    await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
  }

  private async generateTextGemini(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxOutputTokens) generationConfig['maxOutputTokens'] = options.maxOutputTokens;
    if (options.schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = options.schema;
    }

    const data = await this.post(`${API_ROOT}/models/${this.model}:generateContent`, {
      ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    });

    const candidate = data?.candidates?.[0];
    // Skip "thought" parts that thinking models may emit before the answer.
    const rawParts: unknown = candidate?.content?.parts;
    const parts: { text?: string; thought?: boolean }[] = Array.isArray(rawParts) ? rawParts : [];
    const text = parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    if (!text) {
      const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? 'desconocido';
      throw new GeminiError(`Gemini no devolvió texto en su respuesta (motivo: ${reason}).`);
    }
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new GeminiError(
        'La respuesta de Gemini se cortó por límite de tokens (MAX_TOKENS); no se guarda un resultado incompleto.'
      );
    }
    return text;
  }

  private async generateTextDeepseek(prompt: string, options: GenerateOptions = {}): Promise<string> {
    // DeepSeek's json_object mode requires "json" in the prompt and does not enforce responseSchema at the
    // API level, so we embed the exact schema in the system instruction for structured calls.
    const schemaInstruction = options.schema
      ? `Devuelve únicamente un objeto JSON válido que cumpla exactamente este esquema (respeta los nombres exactos de las propiedades y sus tipos, sin texto adicional fuera del JSON):\n${JSON.stringify(options.schema)}`
      : undefined;
    const systemText = [options.system, schemaInstruction].filter(Boolean).join('\n\n');

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (systemText) messages.push({ role: 'system', content: systemText });
    messages.push({ role: 'user', content: prompt });

    const buildBody = (cap: number): Record<string, unknown> => ({
      model: this.deepseekModel,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxOutputTokens ? Math.min(options.maxOutputTokens, cap) : cap,
      ...(options.schema ? { response_format: { type: 'json_object' } } : {}),
    });

    let data: any;
    try {
      data = await this.postDeepseek(buildBody(DEEPSEEK_MAX_OUTPUT_TOKENS));
    } catch (err) {
      // A 400 that complains about max_tokens means this model has a lower cap than we asked for
      const e = err as GeminiError;
      if (e.status === 400 && /max_tokens|maximum|out of range|invalid/i.test(e.message)) {
        this.logger?.warn({ cap: DEEPSEEK_SAFE_MAX_OUTPUT_TOKENS }, 'DeepSeek refused the output cap, retrying with the safe one');
        data = await this.postDeepseek(buildBody(DEEPSEEK_SAFE_MAX_OUTPUT_TOKENS));
      } else {
        throw err;
      }
    }
    const choice = data?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';

    if (!text) {
      const reason = choice?.finish_reason ?? 'desconocido';
      throw new GeminiError(`DeepSeek no devolvió texto en su respuesta (motivo: ${reason}).`);
    }
    if (choice?.finish_reason === 'length') {
      throw new GeminiError(
        'La respuesta de DeepSeek se cortó por límite de tokens (length); no se guarda un resultado incompleto.'
      );
    }
    return text;
  }

  private parseJsonObject<T>(text: string, provider: string): T {
    // Defensive: strip a stray markdown fence if the model added one.
    const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    for (const candidate of [text, stripped]) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        // Every schema we send describes an object or an array: `null`, a number or a string is not an answer
        if (parsed !== null && typeof parsed === 'object') return parsed as T;
      } catch { /* try the next form */ }
    }
    throw new GeminiError(`${provider} devolvió JSON no válido.`);
  }

  /**
   * Generate text. Tries Gemini first when configured; if Gemini fails and `DEEPSEEK_API_KEY` is present,
   * automatically falls back to DeepSeek. Throws on empty or truncated output.
   */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    this.requireAnyKey();

    if (this.hasGeminiKey) {
      try {
        const text = await this.generateTextGemini(prompt, options);
        this._lastModelUsed = this.model;
        return text;
      } catch (err) {
        if (!this.hasDeepseekKey) throw err;
        this.logger?.warn(
          { err: (err as Error).message, fallbackModel: this.deepseekModel },
          'Gemini failed, falling back to DeepSeek'
        );
        try {
          const text = await this.generateTextDeepseek(prompt, options);
          this._lastModelUsed = this.deepseekModel;
          return text;
        } catch (dsErr) {
          throw new GeminiError(
            `${(err as Error).message} (Respaldo DeepSeek también falló: ${(dsErr as Error).message})`,
            (err as GeminiError).status
          );
        }
      }
    }

    const text = await this.generateTextDeepseek(prompt, options);
    this._lastModelUsed = this.deepseekModel;
    return text;
  }

  /**
   * Generate and parse schema-constrained JSON. Falls back to DeepSeek if Gemini fails or returns
   * invalid JSON.
   */
  async generateJson<T>(prompt: string, schema: Record<string, unknown>, options: Omit<GenerateOptions, 'schema'> = {}): Promise<T> {
    this.requireAnyKey();
    const withSchema: GenerateOptions = { ...options, schema };

    // Asked to use DeepSeek first: Gemini is only the fallback, and a DeepSeek that failed is not tried twice
    let deepseekTried = false;
    if (options.prefer === 'deepseek' && this.hasDeepseekKey) {
      deepseekTried = true;
      try {
        const parsed = this.parseJsonObject<T>(await this.generateTextDeepseek(prompt, withSchema), 'DeepSeek');
        this._lastModelUsed = this.deepseekModel;
        return parsed;
      } catch (err) {
        if (!this.hasGeminiKey) throw err;
        this.logger?.warn({ err: (err as Error).message }, 'DeepSeek JSON request failed, falling back to Gemini');
      }
    }

    if (this.hasGeminiKey) {
      try {
        const text = await this.generateTextGemini(prompt, withSchema);
        const parsed = this.parseJsonObject<T>(text, 'Gemini');
        this._lastModelUsed = this.model;
        return parsed;
      } catch (err) {
        if (!this.hasDeepseekKey || deepseekTried) throw err;
        this.logger?.warn(
          { err: (err as Error).message, fallbackModel: this.deepseekModel },
          'Gemini JSON request failed, falling back to DeepSeek'
        );
        try {
          const text = await this.generateTextDeepseek(prompt, withSchema);
          const parsed = this.parseJsonObject<T>(text, 'DeepSeek');
          this._lastModelUsed = this.deepseekModel;
          return parsed;
        } catch (dsErr) {
          throw new GeminiError(
            `${(err as Error).message} (Respaldo DeepSeek también falló: ${(dsErr as Error).message})`,
            (err as GeminiError).status
          );
        }
      }
    }

    const text = await this.generateTextDeepseek(prompt, withSchema);
    const parsed = this.parseJsonObject<T>(text, 'DeepSeek');
    this._lastModelUsed = this.deepseekModel;
    return parsed;
  }

  /**
   * Smallest possible real call to each configured provider: what `npm run ai:check` prints, so a wrong model
   * id or an expired key shows up now and not in the middle of a class.
   */
  async check(): Promise<ProviderCheck[]> {
    const results: ProviderCheck[] = [];
    const probe = async (provider: 'gemini' | 'deepseek', model: string, run: () => Promise<string>) => {
      const started = Date.now();
      try {
        const text = await run();
        results.push({ provider, model, ok: true, ms: Date.now() - started, detail: text.trim().slice(0, 40) });
      } catch (err) {
        results.push({ provider, model, ok: false, ms: Date.now() - started, detail: (err as Error).message });
      }
    };
    const options = { temperature: 0, maxOutputTokens: 64 };
    if (this.hasGeminiKey) await probe('gemini', this.model, () => this.generateTextGemini('Responde solo con la palabra: ok', options));
    if (this.hasDeepseekKey) await probe('deepseek', this.deepseekModel, () => this.generateTextDeepseek('Responde solo con la palabra: ok', options));
    return results;
  }

  /**
   * Embed texts in batches. Use taskType RETRIEVAL_DOCUMENT for chunks and
   * RETRIEVAL_QUERY for questions. Vectors are L2-normalised (required when the
   * output is truncated with outputDimensionality).
   */
  async embed(
    texts: string[],
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
    dimensions = 768
  ): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    const BATCH = 50;

    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const data = await this.post(`${API_ROOT}/models/${this.embeddingModel}:batchEmbedContents`, {
        requests: slice.map((text) => ({
          model: `models/${this.embeddingModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: dimensions,
        })),
      }, Math.min(this.timeoutMs, EMBED_TIMEOUT_MS));

      const embeddings: unknown = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== slice.length) {
        throw new GeminiError('Gemini devolvió un número inesperado de embeddings.');
      }
      for (const e of embeddings) {
        const values: unknown = e?.values;
        if (!Array.isArray(values) || values.length === 0 || !values.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          throw new GeminiError('Gemini devolvió un embedding no válido.');
        }
        vectors.push(normalize(Float32Array.from(values as number[])));
      }
    }
    return vectors;
  }
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Dot product of two normalised vectors == cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
