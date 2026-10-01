import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { prepareSecrets } from './lib/settings';
import { registerServiceWorker } from './lib/share';
import './styles.css';

registerServiceWorker();

// The secrets come out of the phone's encrypted store before anything reads
// the settings; in a browser there is no such store and this returns at once.
void prepareSecrets().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
