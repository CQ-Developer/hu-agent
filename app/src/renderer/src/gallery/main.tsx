import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './gallery.css'
import Gallery from './Gallery'

const container = document.getElementById('root')
if (!container) {
  throw new Error('root container not found')
}

createRoot(container).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
)
