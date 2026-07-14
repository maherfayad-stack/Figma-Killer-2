import { describe, expect, it } from 'vitest';
import { deriveUidPaths } from './uid-path.js';

describe('deriveUidPaths — astPath derivation contract', () => {
  it('assigns sequential root ids and nested child indices in source order', () => {
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
    const entries = deriveUidPaths(source);
    const byTag = Object.fromEntries(entries.map((e) => [e.tagName, e.astPath]));

    expect(byTag.section).toBe('d0');
    expect(byTag.h1).toBe('d0.0');
    expect(byTag.p).toBe('d0.1');
  });

  it('numbers multiple top-level JSX roots in the order they appear', () => {
    const source = `
      function Bar() {
        return <span>bar</span>;
      }
      export default function Foo() {
        return <div>foo</div>;
      }
    `;
    const entries = deriveUidPaths(source);
    const byTag = Object.fromEntries(entries.map((e) => [e.tagName, e.astPath]));

    expect(byTag.span).toBe('d0');
    expect(byTag.div).toBe('d1');
  });

  it('is invariant to reformatting, added whitespace, and comments', () => {
    const original = `
      export default function Hero() {
        return (
          <section className="a">
            <h1>Title</h1>
            <p>Body</p>
          </section>
        );
      }
    `;
    const reformatted = `
      // a totally unrelated comment
      export default function Hero() {

        return <section className="a">
          {/* another comment */}
          <h1>
            Title
          </h1>


          <p>Body</p>
        </section>;
      }
    `;

    const originalPaths = deriveUidPaths(original).map((e) => ({
      tag: e.tagName,
      astPath: e.astPath,
    }));
    const reformattedPaths = deriveUidPaths(reformatted).map((e) => ({
      tag: e.tagName,
      astPath: e.astPath,
    }));

    expect(reformattedPaths).toEqual(originalPaths);
  });

  it('handles JSX nested through .map()/ternary/logical without losing ordering', () => {
    const source = `
      export default function List({ items, showFooter, error }: { items: string[]; showFooter: boolean; error?: string }) {
        return (
          <ul>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
            {showFooter ? <footer>footer</footer> : <div>no footer</div>}
            {error && <span>{error}</span>}
          </ul>
        );
      }
    `;
    const entries = deriveUidPaths(source);
    const byTag = Object.fromEntries(entries.map((e) => [e.tagName, e.astPath]));

    // <ul> is the root; li/footer/div/span are all its direct JSX children
    // (the .map/ternary/logical wrappers are skipped, not counted as their
    // own path segment) in source order.
    expect(byTag.ul).toBe('d0');
    expect(byTag.li).toBe('d0.0');
    expect(byTag.footer).toBe('d0.1');
    expect(byTag.div).toBe('d0.2');
    expect(byTag.span).toBe('d0.3');
  });

  it('counts JSXFragment nodes for numbering even though they get no data-uid attribute', () => {
    const source = `
      export default function Frag() {
        return (
          <>
            <div>a</div>
            <div>b</div>
          </>
        );
      }
    `;
    const entries = deriveUidPaths(source);
    const fragment = entries.find((e) => e.type === 'JSXFragment');
    const divs = entries.filter((e) => e.tagName === 'div');

    expect(fragment?.astPath).toBe('d0');
    expect(divs.map((d) => d.astPath)).toEqual(['d0.0', 'd0.1']);
  });
});
