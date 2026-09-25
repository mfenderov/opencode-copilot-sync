import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkTagStreamParser } from '../out/chat/infrastructure/sse-reader.js';

test('ThinkTagStreamParser splits inline text/thinking when both are in one chunk', () => {
  const parser = new ThinkTagStreamParser();
  const { text, thinking } = parser.feed('<think>reasoning here</think>the answer');
  assert.equal(thinking, 'reasoning here');
  assert.equal(text, 'the answer');
});

test('ThinkTagStreamParser handles the opening tag split across two chunks', () => {
  const parser = new ThinkTagStreamParser();
  const r1 = parser.feed('before<thi');
  const r2 = parser.feed('nk>reasoning</think>after');
  assert.equal(r1.text, 'before');
  assert.equal(r1.thinking, '');
  assert.equal(r2.text, 'after');
  assert.equal(r2.thinking, 'reasoning');
});

test('ThinkTagStreamParser handles the closing tag split across two chunks', () => {
  const parser = new ThinkTagStreamParser();
  const r1 = parser.feed('<think>reasoning</thi');
  const r2 = parser.feed('nk>after');
  assert.equal(r1.thinking, 'reasoning');
  assert.equal(r1.text, '');
  assert.equal(r2.thinking, '');
  assert.equal(r2.text, 'after');
});

test('ThinkTagStreamParser handles a tag split one character at a time', () => {
  const parser = new ThinkTagStreamParser();
  const full = '<think>slow reasoning</think>slow answer';
  let text = '';
  let thinking = '';
  for (const ch of full) {
    const r = parser.feed(ch);
    text += r.text;
    thinking += r.thinking;
  }
  assert.equal(thinking, 'slow reasoning');
  assert.equal(text, 'slow answer');
});

test('ThinkTagStreamParser does not misfire on a near-match that is not actually a tag', () => {
  const parser = new ThinkTagStreamParser();
  // "<thing>" shares a long prefix with "<think>" but is not the tag itself.
  const { text, thinking } = parser.feed('a <thing> b');
  assert.equal(text, 'a <thing> b');
  assert.equal(thinking, '');
});

test('ThinkTagStreamParser flush() emits a dangling partial tag as plain text outside a think block', () => {
  const parser = new ThinkTagStreamParser();
  const fed = parser.feed('done<thi');
  assert.equal(fed.text, 'done');
  const flushed = parser.flush();
  assert.equal(flushed.text, '<thi');
  assert.equal(flushed.thinking, '');
});

test('ThinkTagStreamParser flush() emits a buffered partial closing-tag match as thinking when the stream ends mid-block', () => {
  const parser = new ThinkTagStreamParser();
  // Trailing "<" is a valid partial prefix of "</think>", so it's held back
  // (not yet known whether more chunks will complete the tag) rather than
  // emitted immediately as thinking text.
  const fed = parser.feed('<think>never closed<');
  assert.equal(fed.thinking, 'never closed');
  const flushed = parser.flush();
  assert.equal(flushed.thinking, '<');
  assert.equal(flushed.text, '');
});

test('ThinkTagStreamParser handles multiple think blocks in the same stream', () => {
  const parser = new ThinkTagStreamParser();
  const r = parser.feed('<think>one</think>mid<think>two</think>end');
  assert.equal(r.thinking, 'onetwo');
  assert.equal(r.text, 'midend');
});
