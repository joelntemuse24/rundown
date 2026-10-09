#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');
if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  // Unbuilt checkout: run the TypeScript source through tsx.
  const { register } = await import('tsx/esm/api');
  register();
  await import(pathToFileURL(join(root, 'src', 'cli.ts')).href);
}
