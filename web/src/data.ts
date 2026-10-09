import type { Facts } from '../../src/facts';
import type { Depth, Replay } from '../../src/schema';

export type { Depth, Facts, Replay };

export interface Doc {
  id: string;
  status: 'pending' | 'ready' | 'failed';
  model: string;
  created_at: string;
  source: { kind: 'pr' | 'diff' | 'local' | 'fixture'; label: string; pr_url?: string; root?: string };
  context: { title?: string; body?: string; commits?: string[] };
  facts: Facts;
  diff: string;
  replay: Replay | null;
  error: string | null;
  current_head?: string;
}

export interface ListedReplay {
  id: string;
  title: string;
  label: string;
  status: Doc['status'];
  created_at: string;
}

export type Boot =
  | { mode: 'home'; replays: ListedReplay[]; hosted: boolean; origin: string }
  | { mode: 'export'; doc: Doc; depth: Depth }
  | { mode: 'server'; depth: Depth }
  | null;

export function readBoot(): Boot {
  const el = document.getElementById('rundown-data');
  try {
    return el ? JSON.parse(el.textContent || 'null') : null;
  } catch {
    return null;
  }
}

export async function postGenerate(body: Record<string, unknown>): Promise<{ id: string; url: string; text: string }> {
  const res = await fetch('/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
  if (!res.ok) throw new Error(json.error || `Server returned ${res.status}.`);
  return json;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function relativeTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
