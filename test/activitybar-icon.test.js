import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));

function activityBarIconPath() {
  const containers = manifest.contributes?.viewsContainers?.activitybar ?? [];
  assert.ok(containers.length > 0, 'manifest must declare an activitybar viewsContainer');
  return containers[0].icon;
}

test('activitybar icon: points to an existing file separate from the marketplace icon', () => {
  const iconRel = activityBarIconPath();
  assert.ok(iconRel, 'viewsContainer must declare an icon');
  assert.notEqual(iconRel, manifest.icon, 'activitybar icon must not reuse the marketplace icon');
  assert.ok(existsSync(resolve(rootDir, iconRel)), `activitybar icon file must exist: ${iconRel}`);
});

test('activitybar icon: is 24x24 with a centered viewBox', () => {
  const svg = readFileSync(resolve(rootDir, activityBarIconPath()), 'utf8');
  assert.match(svg, /viewBox="0 0 24 24"/, 'svg must use a 24x24 viewBox');
  assert.match(svg, /width="24"/, 'svg width must be 24');
  assert.match(svg, /height="24"/, 'svg height must be 24');
});

test('activitybar icon: is monochrome with no gradients, filters, or background rect', () => {
  const svg = readFileSync(resolve(rootDir, activityBarIconPath()), 'utf8');
  assert.doesNotMatch(svg, /<linearGradient/i, 'must not contain linear gradients');
  assert.doesNotMatch(svg, /<radialGradient/i, 'must not contain radial gradients');
  assert.doesNotMatch(svg, /<filter/i, 'must not contain filters');
  assert.doesNotMatch(svg, /url\(#/, 'must not reference paint servers (url(#...))');
  assert.doesNotMatch(svg, /feGaussianBlur|feMerge/i, 'must not contain glow filter primitives');
  assert.doesNotMatch(svg, /<rect[^>]*width="24"/, 'must not contain a full-bleed background rect');
});
