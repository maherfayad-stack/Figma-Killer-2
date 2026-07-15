import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ccs/ui/tokens.css';
import { App } from './App.js';
import { readDir } from './engine/query-params.js';

document.documentElement.dir = readDir();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
