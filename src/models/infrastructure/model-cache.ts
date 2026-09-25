import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OpenCodeModelMeta } from '../domain/model.js';

const MODEL_CACHE_FILE = 'models_cache.json';

export function readModelCache(dir: string): OpenCodeModelMeta[] | undefined {
  try {
    if (dir) {
      const cacheFile = path.join(dir, MODEL_CACHE_FILE);
      if (fs.existsSync(cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch {}
  return undefined;
}

export function writeModelCache(dir: string, models: OpenCodeModelMeta[]): void {
  try {
    if (dir) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(dir, MODEL_CACHE_FILE), JSON.stringify(models), 'utf-8');
    }
  } catch {}
}
