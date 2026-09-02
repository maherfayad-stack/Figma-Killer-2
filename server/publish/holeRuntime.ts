/**
 * Browser runtime for Layer C server-island ("hole") lazy loading.
 *
 * Self-contained ES module — no dependencies, no TypeScript. The publisher
 * injects a `<script type="module" src="/_studio/hole-runtime.js" defer>` tag
 * into pages that contain at least one `<studio-hole>` placeholder.
 *
 * On load, the runtime uses `IntersectionObserver` with a 200 px root margin
 * to begin fetching each hole's rendered fragment just before it enters the
 * viewport. Holes already in view on initial paint begin fetching immediately.
 *
 * IMPORTANT: the `<studio-hole>` element itself is `display:contents` (so it adds
 * no wrapper box), which means it has NO layout box for IntersectionObserver
 * to observe — observing it directly never fires. We therefore observe the
 * hole's baked placeholder CHILD (which DOES have a box) and swap the whole
 * `<studio-hole>` when it intersects. A hole with no placeholder child has nothing
 * to lazily reveal, so it is fetched eagerly on load.
 *
 * The fragment fetch URL is
 * `/_studio/hole/<nodeId>?v=<publishVersion>&u=<originating-page-url>`. The
 * version parameter lets the hole endpoint detect stale placeholders after a
 * re-publish and return a lightweight sentinel instead of cached stale HTML.
 * The `u` parameter carries the visitor's actual page path + query string so
 * the endpoint can rebuild the route frame (`route.query.*`) and key the cache
 * per query. Cookies ride along automatically (same-origin fetch) and are read
 * by the endpoint only for `perVisitor` holes.
 *
 * When the fetch resolves, `el.outerHTML = html` swaps the placeholder with
 * the server-rendered fragment in-place. No morphdom / idiomorph dependency.
 * A fetch failure is silently swallowed — the author's skeleton content in the
 * placeholder continues to show as a meaningful fallback.
 */

export function runStudioHoleRuntime(): void {
  function studioFetchHole(el: HTMLElement): void {
    const id = el.dataset.studioHole || '';
    const version = el.dataset.studioVersion || '';
    const u = location.pathname + location.search;
    fetch('/_studio/hole/' + encodeURIComponent(id) + '?v=' + encodeURIComponent(version) + '&u=' + encodeURIComponent(u))
      .then(function(r) { return r.text(); })
      .then(function(html) { el.outerHTML = html; })
      .catch(function() {});
  }
  const io = new IntersectionObserver(function(entries) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const hole = e.target.closest('studio-hole[data-studio-hole]') as HTMLElement | null;
      if (hole) studioFetchHole(hole);
    }
  }, { rootMargin: '200px 0px' });
  const holes = document.querySelectorAll('studio-hole[data-studio-hole]');
  for (let i = 0; i < holes.length; i++) {
    const el = holes[i] as HTMLElement;
    // <studio-hole> is display:contents (no box) — observe its placeholder child,
    // which has a box. Holes without a placeholder are fetched eagerly.
    const box = el.firstElementChild;
    if (box) { io.observe(box); } else { studioFetchHole(el); }
  }
}

export const HOLE_RUNTIME_JS = `(${runStudioHoleRuntime.toString()})();`
