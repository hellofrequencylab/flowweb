import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noDashes, shortenerFor } from '../src/flows/short-links.ts';

describe('noDashes (FW-C-084)', () => {
  it('turns em and en dashes into commas', () => {
    expect(noDashes('your workshop caught my eye—the idea sounds lovely')).toBe(
      'your workshop caught my eye, the idea sounds lovely',
    );
    expect(noDashes('A – B')).toBe('A, B');
    expect(noDashes('open 5–7pm')).toBe('open 5 to 7pm');
    expect(noDashes('ends here—.')).toBe('ends here.');
    expect(noDashes('plain-hyphen stays')).toBe('plain-hyphen stays');
  });
});

describe('shortenerFor (FW-C-084)', () => {
  const long = 'https://frequencylocal.com/start/host?persona=practitioner&utm_source=flowweb&utm_content=t1';
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), 'fw-short-'));
    mkdirSync(join(h, 'creds'), { recursive: true });
    writeFileSync(join(h, 'creds', 'crd_frequencyoutcomes'), 'test-secret-not-real-0123456789', {
      mode: 0o600,
    });
    return h;
  };

  it('keeps every link when there is no secret', async () => {
    const h = mkdtempSync(join(tmpdir(), 'fw-short-'));
    const s = shortenerFor({ fwHome: h, site: 'http://127.0.0.1:1' });
    expect(await s.shorten(`Start here: ${long}`, 'x')).toBe(`Start here: ${long}`);
  });

  it('swaps flowweb links for the short link Frequency answers, and keeps others', async () => {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        seen.push(b);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ short_url: 'https://frequencylocal.com/q/abc1234' }));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as { port: number }).port;
    try {
      const s = shortenerFor({ fwHome: home(), site: `http://127.0.0.1:${port}` });
      const out = await s.shorten(`Start here: ${long}.\nMore: https://example.com/page`, 'Front Porch');
      expect(out).toBe('Start here: https://frequencylocal.com/q/abc1234.\nMore: https://example.com/page');
      expect(JSON.parse(seen[0] ?? '{}')).toEqual({ url: long, title: 'Front Porch' });
    } finally {
      srv.close();
    }
  });

  it('keeps the long link when Frequency fails', async () => {
    const s = shortenerFor({ fwHome: home(), site: 'http://127.0.0.1:1' });
    expect(await s.shorten(`Start here: ${long}`, 'x')).toBe(`Start here: ${long}`);
  });
});
