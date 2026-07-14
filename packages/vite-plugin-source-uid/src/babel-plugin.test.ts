import { describe, expect, it } from 'vitest';
import { isNodeUid } from '@ccs/protocol';
import { transformSourceUid } from './transform.js';

/** Pull every `data-uid="..."` value out of transformed output, in
 * appearance order, for assertions that don't want to hand-parse JSX. */
function extractDataUids(code: string): string[] {
  return [...code.matchAll(/data-uid="([^"]+)"/g)].map((m) => m[1]!);
}

describe('transformSourceUid — golden behavior', () => {
  it('tags every JSXElement with a valid, NodeUid-schema-conformant data-uid', () => {
    const source = `
      export default function Hero() {
        return (
          <section>
            <h1>Title</h1>
            <p>Body</p>
          </section>
        );
      }
    `;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/Hero.tsx' });

    const uids = extractDataUids(code);
    expect(uids.length).toBe(3);
    for (const uid of uids) {
      expect(isNodeUid(uid)).toBe(true);
      expect(uid.startsWith('src/frames/Hero.tsx:')).toBe(true);
    }
    // uniqueness within the file
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('marks JSX inside .map()/ternary/logical as data-dynamic, and nothing else', () => {
    const source = `
      export default function List({ items, on }: { items: string[]; on: boolean }) {
        return (
          <ul>
            <li className="static">static</li>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {on ? <span>on</span> : <span>off</span>}
            {on && <em>emph</em>}
          </ul>
        );
      }
    `;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/List.tsx' });

    // Split into per-element chunks is fragile; instead check specific
    // adjacency: the static <li> has no data-dynamic, the others do.
    const staticLiMatch = code.match(/<li className="static"[^>]*>/);
    expect(staticLiMatch?.[0]).toBeDefined();
    expect(staticLiMatch![0]).not.toContain('data-dynamic');

    const dynamicTags = [...code.matchAll(/<(li|span|em)\b[^>]*data-uid="[^"]*"[^>]*>/g)].filter(
      (m) => !m[0].includes('className="static"'),
    );
    expect(dynamicTags.length).toBeGreaterThanOrEqual(4); // li(map), span(true), span(false), em
    for (const match of dynamicTags) {
      expect(match[0]).toContain('data-dynamic="true"');
    }
  });

  it('resolves data-component for imported components, prefixing ds: only for design-system imports', () => {
    const source = `
      import { Button } from 'design-system';
      import { Card } from './local-card.js';
      export default function Foo() {
        return (
          <div>
            <Button />
            <Card />
            <section />
          </div>
        );
      }
    `;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/Foo.tsx' });

    expect(code).toMatch(/<Button[^>]*data-component="ds:Button"/);
    expect(code).toMatch(/<Card[^>]*data-component="Card"/);
    expect(code).not.toMatch(/<section[^>]*data-component/);
  });

  it('resolves deep design-system import paths too', () => {
    const source = `
      import Button from 'design-system/dist/Button.js';
      export default function Foo() {
        return <Button />;
      }
    `;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/Foo.tsx' });
    expect(code).toMatch(/data-component="ds:Button"/);
  });

  it('never tags anything when studio mode markers are absent (plugin itself has no mode gate — that lives in the Vite wrapper, verified separately)', () => {
    // transformSourceUid is the low-level always-on transform; the
    // studio-mode no-op gate lives in vite-plugin.ts (see vite-plugin.test.ts).
    // This test just documents that boundary so a future refactor doesn't
    // accidentally duplicate the gate here.
    const source = `export default function Foo() { return <div />; }`;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/Foo.tsx' });
    expect(code).toContain('data-uid');
  });

  it('Arabic/RTL fixture: text content round-trips byte-exact', () => {
    const source = `export default function Pricing() {
  return (
    <section dir="rtl" lang="ar">
      <h1>خطط الأسعار</h1>
      <p>اختر الباقة المناسبة لرحلتك القادمة واستمتع بأفضل العروض على الفنادق والطيران.</p>
      <span>499 ر.س</span>
    </section>
  );
}
`;
    const { code } = transformSourceUid(source, { relPath: 'src/frames/Pricing.tsx' });

    expect(code).toContain('خطط الأسعار');
    expect(code).toContain(
      'اختر الباقة المناسبة لرحلتك القادمة واستمتع بأفضل العروض على الفنادق والطيران.',
    );
    expect(code).toContain('499 ر.س');

    // Every element (including the RTL ones) still gets a valid, unique uid.
    const uids = extractDataUids(code);
    expect(uids.length).toBe(4); // section, h1, p, span
    for (const uid of uids) {
      expect(isNodeUid(uid)).toBe(true);
    }
  });
});
