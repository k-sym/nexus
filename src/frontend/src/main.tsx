import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyBackgroundMotion } from './appearance';

// Apply the saved background-motion preference before first paint so there is
// no flash of the wrong state. Default is a static starfield (off).
applyBackgroundMotion();

// Pause ambient background animations whenever the window is unfocused or
// hidden. A paused CSS animation does zero compositor work, so the renderer
// stops burning GPU/CPU when the app isn't in the foreground.
const syncAmbientMotion = () => {
  const idle = document.hidden || !document.hasFocus();
  document.documentElement.classList.toggle('ambient-paused', idle);
};
window.addEventListener('focus', syncAmbientMotion);
window.addEventListener('blur', syncAmbientMotion);
document.addEventListener('visibilitychange', syncAmbientMotion);
syncAmbientMotion();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
