import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Placeholder } from './Placeholder';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('The page has no #root element.');
}

createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
