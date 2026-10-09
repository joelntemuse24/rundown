import type { Config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  content: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export class ModelError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

/** One chat completion against any OpenAI-compatible endpoint. No tools, temperature 0.2. */
export async function complete(cfg: Pick<Config, 'baseURL' | 'apiKey' | 'model'>, messages: ChatMessage[]): Promise<Completion> {
  if (!cfg.apiKey) throw new ModelError('No model key configured. Set RUNDOWN_API_KEY or apiKey in ~/.config/rundown/config.json.');
  let res: Response;
  try {
    res = await fetch(cfg.baseURL.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        'x-title': 'Rundown',
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2 }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? 'model call timed out after 180 seconds' : `model endpoint unreachable: ${(err as Error).message}`;
    throw new ModelError(msg);
  }
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {}
    const unavailable = [402, 404, 429, 502, 503].includes(res.status);
    throw new ModelError(
      unavailable ? `The model ${cfg.model} is unavailable right now (${res.status}): ${detail}` : `model call failed (${res.status}): ${detail}`,
      res.status,
    );
  }
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ModelError('model endpoint returned a non-JSON response');
  }
  if (json.error) throw new ModelError(`model error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new ModelError('model returned an empty completion');
  return {
    content,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    model: json.model ?? cfg.model,
  };
}
