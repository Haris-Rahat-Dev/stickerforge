import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import SignIn from './components/SignIn.jsx'
import { onAuth, type AuthUser } from './auth.js'
import './styles.css'

function Root() {
  // undefined = Firebase has not reported yet; null = signed out.
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined)
  useEffect(() => onAuth(setUser), [])
  if (user === undefined) return <main className="empty"><div className="empty-box">Loading…</div></main>
  return user ? <App /> : <SignIn />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
