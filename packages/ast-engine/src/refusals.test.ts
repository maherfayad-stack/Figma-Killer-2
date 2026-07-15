import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { CanvasOp, NodeUid } from '@ccs/protocol';
import { applyOp } from './apply-op.js';
import { ApplyOpError } from './errors.js';
import { deriveUidPathsForFile, type DerivedUidPathEntry } from './uid-path.js';

const REL = 'src/Frame.tsx';

function uidFor(source: string, predicate: (e: DerivedUidPathEntry) => boolean): NodeUid {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('f.tsx', source);
  const entries = deriveUidPathsForFile(sf);
  const match = entries.find(predicate);
  if (!match) throw new Error('uidFor: no matching node found');
  return `${REL}:${match.astPath}` as NodeUid;
}

const byTag = (tag: string) => (e: DerivedUidPathEntry) => e.tagName === tag;

function expectApplyOpError(source: string, op: CanvasOp, code: ApplyOpError['code']) {
  try {
    applyOp(source, op);
    expect.fail(`expected applyOp to throw ApplyOpError(${code})`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApplyOpError);
    expect((err as ApplyOpError).code).toBe(code);
  }
}

describe('refusals: dynamic-locked (§0 editable-surface contract)', () => {
  it('set-text on a node inside .map()', () => {
    const source = `export function Frame({ items }: { items: string[] }) {\n  return (\n    <ul>\n      {items.map((item) => (\n        <li key={item}>{item}</li>\n      ))}\n    </ul>\n  );\n}\n`;
    const uid = uidFor(source, byTag('li'));
    expectApplyOpError(source, { t: 'set-text', uid, text: 'x' }, 'dynamic-locked');
  });

  it('set-prop on a node inside a ternary', () => {
    const source = `export function Frame({ ok }: { ok: boolean }) {\n  return (\n    <div>{ok ? <button>Yes</button> : <span>No</span>}</div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('button'));
    expectApplyOpError(source, { t: 'set-prop', uid, name: 'title', value: 'x' }, 'dynamic-locked');
  });

  it('delete-node on a node inside a logical && expression', () => {
    const source = `export function Frame({ show }: { show: boolean }) {\n  return (\n    <div>{show && <p>hi</p>}</div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('p'));
    expectApplyOpError(source, { t: 'delete-node', uid }, 'dynamic-locked');
  });

  it('insert-node targeting a dynamic parent', () => {
    const source = `export function Frame({ items }: { items: string[] }) {\n  return (\n    <ul>\n      {items.map((item) => (\n        <li key={item}>{item}</li>\n      ))}\n    </ul>\n  );\n}\n`;
    const uid = uidFor(source, byTag('li'));
    expectApplyOpError(
      source,
      { t: 'insert-node', parentUid: uid, index: 0, source: { kind: 'element', tag: 'span' } },
      'dynamic-locked',
    );
  });
});

describe('refusals: not-editable', () => {
  it('set-prop refuses an expression value on an existing attribute', () => {
    const source = `export function Frame({ onClick }: { onClick: () => void }) {\n  return (\n    <div>\n      <button onClick={onClick}>Go</button>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('button'));
    expectApplyOpError(source, { t: 'set-prop', uid, name: 'onClick', value: 'not-a-function' }, 'not-editable');
  });

  it('set-classes refuses a fully-dynamic className (identifier reference)', () => {
    const source = `export function Frame({ klass }: { klass: string }) {\n  return (\n    <div className={klass}>\n      <span>x</span>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('div'));
    expectApplyOpError(source, { t: 'set-classes', uid, add: ['flex'], remove: [] }, 'not-editable');
  });

  it('set-classes refuses when cn() has no string-literal first arg', () => {
    const source = `import { cn } from './utils';\nexport function Frame({ klass }: { klass: string }) {\n  return (\n    <div className={cn(klass)}>\n      <span>x</span>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('div'));
    expectApplyOpError(source, { t: 'set-classes', uid, add: ['flex'], remove: [] }, 'not-editable');
  });

  it('set-classes refuses className when it IS the spread itself (className passed via spread)', () => {
    const source = `export function Frame(props: { rest?: { className?: string } }) {\n  return (\n    <div {...props.rest}>\n      <span>x</span>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('div'));
    // No `className` attribute exists directly (it's only inside the spread) —
    // set-classes creates a brand-new `className` attribute alongside the
    // spread, which is valid/expected (not a refusal): the spread's own
    // `className` (if any at runtime) would be overridden by JSX's
    // last-wins semantics, same tradeoff a human editing this file would
    // face. Documented here as a behavior check, not a refusal.
    const result = applyOp(source, { t: 'set-classes', uid, add: ['flex'], remove: [] });
    expect(result.newText).toContain('className="flex"');
  });

  it('set-text refuses a self-closing element (no body)', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <img src="/a.png" />\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('img'));
    expectApplyOpError(source, { t: 'set-text', uid, text: 'x' }, 'not-editable');
  });

  it('set-prop refuses targeting a JSX fragment (no attributes)', () => {
    const source = `export function Frame() {\n  return (\n    <>\n      <span>a</span>\n    </>\n  );\n}\n`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile('f.tsx', source);
    const fragment = deriveUidPathsForFile(sf).find((e) => e.type === 'JSXFragment')!;
    expectApplyOpError(
      source,
      { t: 'set-prop', uid: `${REL}:${fragment.astPath}` as NodeUid, name: 'title', value: 'x' },
      'not-editable',
    );
  });
});

describe('refusals: uid-not-found', () => {
  it('set-text with an unknown astPath', () => {
    expectApplyOpError(
      `export function Frame() {\n  return <div>hi</div>;\n}\n`,
      { t: 'set-text', uid: `${REL}:d0.99` as NodeUid, text: 'x' },
      'uid-not-found',
    );
  });

  it('insert-node with an unknown parentUid', () => {
    expectApplyOpError(
      `export function Frame() {\n  return <div>hi</div>;\n}\n`,
      { t: 'insert-node', parentUid: `${REL}:d9` as NodeUid, index: 0, source: { kind: 'element', tag: 'span' } },
      'uid-not-found',
    );
  });

  it('move-node with an unknown newParentUid', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <span>a</span>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('span'));
    expectApplyOpError(
      source,
      { t: 'move-node', uid, newParentUid: `${REL}:d9` as NodeUid, index: 0 },
      'uid-not-found',
    );
  });
});

describe('refusals: unsupported', () => {
  it('set-prop refuses a {token} value (P4 scope, flagged CR)', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <p>hi</p>\n    </div>\n  );\n}\n`;
    const uid = uidFor(source, byTag('p'));
    expectApplyOpError(
      source,
      { t: 'set-prop', uid, name: 'color', value: { token: 'color.primary' } },
      'unsupported',
    );
  });

  it('move-node refuses moving a node into its own subtree', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <section>\n        <span>a</span>\n      </section>\n    </div>\n  );\n}\n`;
    const sectionUid = uidFor(source, byTag('section'));
    const spanUid = uidFor(source, byTag('span'));
    expectApplyOpError(
      source,
      { t: 'move-node', uid: sectionUid, newParentUid: spanUid, index: 0 },
      'unsupported',
    );
  });

  it('wrap-node refuses a non-contiguous set of uids', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <span>a</span>\n      <p>b</p>\n      <em>c</em>\n    </div>\n  );\n}\n`;
    const spanUid = uidFor(source, byTag('span'));
    const emUid = uidFor(source, byTag('em'));
    expectApplyOpError(
      source,
      { t: 'wrap-node', uids: [spanUid, emUid], wrapper: { tag: 'div', classes: '' } },
      'unsupported',
    );
  });

  it('wrap-node refuses uids with different parents', () => {
    const source = `export function Frame() {\n  return (\n    <div>\n      <section>\n        <span>a</span>\n      </section>\n      <p>b</p>\n    </div>\n  );\n}\n`;
    const spanUid = uidFor(source, byTag('span'));
    const pUid = uidFor(source, byTag('p'));
    expectApplyOpError(
      source,
      { t: 'wrap-node', uids: [spanUid, pUid], wrapper: { tag: 'div', classes: '' } },
      'unsupported',
    );
  });
});
