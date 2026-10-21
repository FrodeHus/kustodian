import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { hasHost, NO_HOST_MESSAGE } from './bridge';
import { applyTheme, initialTheme } from './shell/theme';
import './styles.css';

// The host puts the saved theme in the start URL, so the first paint is already in it.
applyTheme(initialTheme(location.search));

const root = document.getElementById('root');
if (!root) {
  throw new Error('The page has no #root element.');
}

// A production build without its host says so rather than showing an app that can do nothing.
createRoot(root).render(
  <StrictMode>
    {import.meta.env.DEV || hasHost() ? (
      <App />
    ) : (
      <p role="alert" className="flex h-full items-center justify-center bg-bg text-text">
        {NO_HOST_MESSAGE}
      </p>
    )}
  </StrictMode>,
);
