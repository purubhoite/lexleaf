import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { DEFAULT_APPEARANCE } from '@core/persistence/appearance';
import { DEFAULT_REDUCE_MOTION } from '@core/persistence/motion';

import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { resolveDesktopBridge } from './platform/desktopBridge';
import { applyAppearance } from './theme/applyAppearance';
import { applyMotion } from './theme/applyMotion';
import './styles/tokens.css';
import './styles/global.css';
import './styles/reader.css';

/*
 * The appearance, written once, before React renders (ADR-030).
 *
 * `index.html` already carries `data-theme="system"`, so the first paint is
 * never the wrong palette; this restates it from the one value both
 * processes share. It is the only place in the renderer that writes the
 * attribute, and when 6.8 adds the stored preference (ADR-031) it is the
 * only line that changes.
 */
applyAppearance(document.documentElement, DEFAULT_APPEARANCE);

/*
 * The motion state, written the same way and for the same reason
 * (ADR-032). `system` leaves the operating system's own reduced-motion
 * setting to the media query in `global.css`; this attribute is the other
 * half of that contract, the one an explicit preference will drive when
 * 6.8 adds the surface that stores it.
 */
applyMotion(document.documentElement, DEFAULT_REDUCE_MOTION);

const container = document.getElementById('root');

if (container === null) {
  throw new Error('Renderer entry point is missing the #root element.');
}

/*
 * The one error boundary, wrapped around the whole application (M7.1,
 * ADR-035). It is here rather than inside `App` because the thing it has
 * to survive is `App` itself failing to render: a boundary inside the
 * tree it guards goes down with it.
 */
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App bridge={resolveDesktopBridge(window)} />
    </ErrorBoundary>
  </StrictMode>,
);
