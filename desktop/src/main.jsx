import React from 'react';
import { createRoot } from 'react-dom/client';
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import App from './App.jsx';
import './styles.css';

// Atlassian Design System tokens (the look of Jira, Confluence and Rovo),
// following the OS light/dark setting.
setGlobalTheme({
  colorMode: 'auto',
  light: 'light',
  dark: 'dark',
  shape: 'shape',
  spacing: 'spacing',
  typography: 'typography',
}).finally(() => createRoot(document.getElementById('root')).render(<App />));
