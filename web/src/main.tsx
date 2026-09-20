import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import SignIn from './components/SignIn.jsx'
import { authRequired, onAuth, type AuthUser } from './auth.js'
import './styles.css'

function Root() {
  // Cookie mode: no Firebase config at build time — open the app immediately.
  const [user, setUser] = useState<AuthUser | null | undefined>(
    authRequired ? undefined : { uid: 'cookie', email: null, displayName: null }
  )
  useEffect(() => {
    if (!authRequired) return
    return onAuth(setUser)
  }, [])
  if (user === undefined) return <main className="empty"><div className="empty-box">Loading…</div></main>
  return user ? <App /> : <SignIn />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
