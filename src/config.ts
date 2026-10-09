import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Depth } from './schema.js';

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  depth: Depth;
  port: number;
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'openrouter/free';

export const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rundown', 'config.json');
export const cacheDir = () => process.env.RUNDOWN_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'rundown');

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      console.error(`rundown: ignoring unreadable config at ${p}`);
    }
  }
  const env = process.env;
  const depth = (env.RUNDOWN_DEPTH || file.depth || 'median') as Depth;
  return {
    baseURL: env.RUNDOWN_BASE_URL || file.baseURL || DEFAULT_BASE_URL,
    apiKey: env.RUNDOWN_API_KEY || file.apiKey || '',
    model: env.RUNDOWN_MODEL || file.model || DEFAULT_MODEL,
    depth: ['shallow', 'median', 'deep'].includes(depth) ? depth : 'median',
    port: Number(env.PORT || file.port || 5200),
  };
}
