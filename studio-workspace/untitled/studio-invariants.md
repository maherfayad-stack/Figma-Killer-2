# Studio invariants

1. Parse, never execute. Everything on the canvas was read statically out
   of the AST — no component was rendered, no hook was called.
2. A write must have exactly one honest target. An edit that cannot land
   in exactly one place in the user's source is refused, not brute-forced.
3. `locked` (structure) and `codeProps` (values) are different facts —
   never treat one as implying the other.
4. Never add a wrapper element around existing content — it breaks
   `%`/flex height chains and CSS combinators in the user's own stylesheet.
5. Trust tiers are the gate. Tier 0 runs nothing. You may ASK the user to
   promote a project; you may never promote one yourself.
6. `studio-workspace/` is the user's real project with no other copy.
   There is no delete-a-project tool and none of your tools can reach one.