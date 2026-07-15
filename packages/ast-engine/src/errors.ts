/**
 * ApplyOpError — frozen refusal shape (ADR-0018 item 2, additive over the
 * P0 stub). `applyOp` throws this instead of returning an error value; the
 * daemon (WS-B) catches it and replies with the frozen `op-rejected`
 * DaemonEvent `{t:'op-rejected', opId, reason: message}`.
 *
 * Codes (frozen, do not add without a new ADR):
 *  - `dynamic-locked`  — target (or an ancestor) is inside a `.map()`/other
 *    CallExpression callback, ternary, or logical `&&`/`||` (§0 contract).
 *  - `not-editable`    — a `set-prop` value is an expression/spread, not a
 *    literal or template string ("edit in code"); or a `set-classes`
 *    target's className is fully dynamic (pitfall #2).
 *  - `uid-not-found`   — the op's uid (or parentUid/newParentUid) doesn't
 *    resolve to any node in the parsed source.
 *  - `unsupported`     — a structurally valid op this engine deliberately
 *    does not (yet) implement, e.g. a `{token}` set-prop value (P4 scope,
 *    ADR-0018 item 12 — flagged, not guessed).
 */
export type ApplyOpErrorCode = 'dynamic-locked' | 'not-editable' | 'uid-not-found' | 'unsupported';

export class ApplyOpError extends Error {
  readonly code: ApplyOpErrorCode;

  constructor(code: ApplyOpErrorCode, message: string) {
    super(message);
    this.name = 'ApplyOpError';
    this.code = code;
  }
}
