import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import './globals.css'
import { primeTimeZone } from './lib/displayTime'

// Resolve the operator's display zone before first paint, so the formatters that
// cannot use a hook render in the right zone immediately rather than showing the
// fallback for a frame. Failure is non-fatal: the fallback IS the default zone.
void primeTimeZone()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
