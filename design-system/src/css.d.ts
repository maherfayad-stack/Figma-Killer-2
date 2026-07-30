// This scaffold has no bundler-specific ambient types (it's a plain library,
// consumed by whatever bundler the file-app using it runs — Vite in our
// case, which already declares `*.css` module imports via `vite/client`).
// This local declaration keeps the package typecheck-clean in isolation.
declare module '*.css';
