import { initializeApp } from 'firebase/app'
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from 'firebase/auth'

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
})
const auth = getAuth(app)

export interface AuthUser { uid: string; email: string | null; displayName: string | null }

// Cached for <img>/<video>/EventSource URLs that cannot send Authorization headers.
// Refreshed on auth change and before expiry via getIdToken().
let cachedIdToken: string | null = null

async function refreshCachedToken(): Promise<void> {
  const u = auth.currentUser
  cachedIdToken = u ? await u.getIdToken() : null
}

onAuthStateChanged(auth, () => { void refreshCachedToken() })
setInterval(() => { void refreshCachedToken() }, 50 * 60 * 1000)

export const onAuth = (cb: (u: AuthUser | null) => void): (() => void) =>
  onAuthStateChanged(auth, u =>
    cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null))

export const signInWithGoogle = async (): Promise<void> => {
  await signInWithPopup(auth, new GoogleAuthProvider())
}
export const signInWithEmail = async (email: string, password: string): Promise<void> => {
  await signInWithEmailAndPassword(auth, email, password)
}
export const registerWithEmail = async (email: string, password: string): Promise<void> => {
  await createUserWithEmailAndPassword(auth, email, password)
}
export const signOutUser = (): Promise<void> => signOut(auth)

// The SDK refreshes the token on its own; getIdToken() returns a fresh one when the
// cached one is near expiry, so callers never deal with refresh.
export async function authHeader(): Promise<Record<string, string>> {
  const u = auth.currentUser
  if (!u) return {}
  const token = await u.getIdToken()
  cachedIdToken = token
  return { Authorization: `Bearer ${token}` }
}

/** Sync query suffix for media / SSE URLs. Prefer authHeader() for fetch. */
export function tokenQuery(): string {
  return cachedIdToken ? `?token=${encodeURIComponent(cachedIdToken)}` : ''
}

export async function freshTokenQuery(): Promise<string> {
  await refreshCachedToken()
  return tokenQuery()
}
