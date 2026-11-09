import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui-kit/tokens.css';
import './ui-kit/base.css';
import { App } from './shell/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
