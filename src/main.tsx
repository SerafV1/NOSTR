import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import App from './App.tsx'
import { watchPictures } from './utils/pictureBudget'
import { watchMemory } from './utils/memoryTrail'

// Pictures are asked for at the size they are drawn, and let go of while
// they are far from the screen — see utils/pictureBudget
watchPictures()
// A record of what the page holds over time, readable in Settings
watchMemory()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    <Analytics />
  </React.StrictMode>,
)
