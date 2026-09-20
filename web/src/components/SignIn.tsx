import { useState } from 'react'
import { signInWithGoogle, signInWithEmail, registerWithEmail } from '../auth.js'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isNew, setIsNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'Sign in failed') }
    finally { setBusy(false) }
  }

  return (
    <main className="empty">
      <div className="empty-box signin-box">
        <div className="empty-icon">⚡</div>
        <h2>Sign in to <em>StickerForge</em></h2>
        <p>your packs follow you to any device</p>

        <button className="btn btn-primary" disabled={busy} onClick={() => void run(signInWithGoogle)}>
          Continue with Google
        </button>

        <form
          className="signin-form"
          onSubmit={e => {
            e.preventDefault()
            void run(() => (isNew ? registerWithEmail : signInWithEmail)(email, password))
          }}
        >
          <input type="email" required placeholder="you@example.com" autoComplete="email"
            value={email} onChange={e => setEmail(e.target.value)} />
          <input type="password" required minLength={6} placeholder="password"
            autoComplete={isNew ? 'new-password' : 'current-password'}
            value={password} onChange={e => setPassword(e.target.value)} />
          <button className="btn" type="submit" disabled={busy}>
            {isNew ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setIsNew(v => !v)}>
          {isNew ? 'I already have an account' : 'Create an account'}
        </button>

        {error && <div className="warn-line">✗ {error}</div>}
      </div>
    </main>
  )
}
