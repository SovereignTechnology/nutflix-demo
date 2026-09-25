/**
 * Security review F25: a clicked external link is only ever opened by main, after the user chose
 * to in the trusted prompt window, and only if it is an https link.
 */
import { describe, expect, it } from 'vitest';

import { ExternalLinks, LINK_LIMIT, LINK_WINDOW_MS, externalLink } from '../external-links.js';

function rig() {
  let now = 1_000;
  const asked: { url: string; done: (open: boolean) => void }[] = [];
  const opened: string[] = [];
  const logged: string[] = [];
  const links = new ExternalLinks({
    ask: (url, done) => {
      asked.push({ url, done });
      return true;
    },
    open: (url) => opened.push(url),
    now: () => now,
    log: (_l, e) => logged.push(e),
  });
  return {
    links,
    asked,
    opened,
    logged,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('externalLink (what main may open)', () => {
  it('takes https links and gives back the normalised form', () => {
    expect(externalLink('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(externalLink('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it.each([
    ['plain http', 'http://example.com/'],
    ['javascript:', 'javascript:alert(1)'],
    ['file:', 'file:///etc/passwd'],
    ['nostr:', 'nostr:npub1xyz'],
    ['the app itself', 'app://nutflix/index.html'],
    ['user-info', 'https://user:pw@example.com/'],
    ['whitespace', 'https://exa mple.com/'],
    ['a bidi override', 'https://example.com/\u202egnp.exe'],
    ['a Unicode host', 'https://ëxample.com/'],
    ['an overlong link', `https://example.com/${'a'.repeat(3000)}`],
    ['empty', ''],
    ['a number', 42],
    ['nothing', undefined],
  ])('refuses %s', (_label, raw) => {
    expect(externalLink(raw)).toBeUndefined();
  });
});

describe('ExternalLinks', () => {
  it('asks, and opens main’s own copy only when the user chose to', () => {
    const r = rig();
    r.links.request('https://example.com/x', true);
    expect(r.asked.map((a) => a.url)).toEqual(['https://example.com/x']);
    expect(r.opened).toEqual([]);
    r.asked[0]?.done(true);
    expect(r.opened).toEqual(['https://example.com/x']);
    r.links.request('https://example.com/y', true);
    r.asked[1]?.done(false);
    expect(r.opened).toEqual(['https://example.com/x']);
  });

  it('asks nothing for another webContents or a link it may not open', () => {
    const r = rig();
    r.links.request('https://example.com/x', false);
    r.links.request('http://example.com/x', true);
    expect(r.asked).toEqual([]);
    expect(r.logged).toEqual(['link.refused', 'link.refused']);
  });

  it('one question at a time, and at most LINK_LIMIT per window', () => {
    const r = rig();
    r.links.request('https://example.com/1', true);
    r.links.request('https://example.com/2', true); // while the first is open: dropped
    expect(r.asked).toHaveLength(1);
    expect(r.logged).toContain('link.busy');
    r.asked[0]?.done(false);
    for (let i = 1; i < LINK_LIMIT; i++) {
      r.links.request(`https://example.com/n${String(i)}`, true);
      r.asked.at(-1)?.done(false);
    }
    expect(r.asked).toHaveLength(LINK_LIMIT);
    r.links.request('https://example.com/over', true);
    expect(r.asked).toHaveLength(LINK_LIMIT);
    expect(r.logged).toContain('link.throttled');
    r.tick(LINK_WINDOW_MS);
    r.links.request('https://example.com/later', true);
    expect(r.asked).toHaveLength(LINK_LIMIT + 1);
  });
});
