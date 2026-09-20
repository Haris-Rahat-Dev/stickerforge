import { initializeApp } from 'firebase/app'
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  type Auth,
} from 'firebase/auth'

export interface AuthUser { uid: string; email: string | null; displayName: string | null }

// Build-time: if web Firebase config is missing, skip the SDK and rely on cookie auth.
export const authRequired = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY &&
  import.meta.env.VITE_FIREBASE_PROJECT_ID &&
  import.meta.env.VITE_FIREBASE_APP_ID
)

let auth: Auth | null = null
let cachedIdToken: string | null = null

if (authRequired) {
  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  })
  auth = getAuth(app)
  onAuthStateChanged(auth, () => { void refreshCachedToken() })
  setInterval(() => { void refreshCachedToken() }, 50 * 60 * 1000)
}

async function refreshCachedToken(): Promise<void> {
  const u = auth?.currentUser
  cachedIdToken = u ? await u.getIdToken() : null
}

export const onAuth = (cb: (u: AuthUser | null) => void): (() => void) => {
  if (!auth) {
    cb({ uid: 'cookie', email: null, displayName: null })
    return () => {}
  }
  return onAuthStateChanged(auth, u =>
    cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null))
}

export const signInWithGoogle = async (): Promise<void> => {
  if (!auth) throw new Error('Firebase is not configured')
  await signInWithPopup(auth, new GoogleAuthProvider())
}
export const signInWithEmail = async (email: string, password: string): Promise<void> => {
  if (!auth) throw new Error('Firebase is not configured')
  await signInWithEmailAndPassword(auth, email, password)
}
export const registerWithEmail = async (email: string, password: string): Promise<void> => {
  if (!auth) throw new Error('Firebase is not configured')
  await createUserWithEmailAndPassword(auth, email, password)
}
export const signOutUser = async (): Promise<void> => {
  if (!auth) return
  await signOut(auth)
}

export async function authHeader(): Promise<Record<string, string>> {
  const u = auth?.currentUser
  if (!u) return {}
  const token = await u.getIdToken()
  cachedIdToken = token
  return { Authorization: `Bearer ${token}` }
}

export function tokenQuery(): string {
  return cachedIdToken ? `?token=${encodeURIComponent(cachedIdToken)}` : ''
}

export async function freshTokenQuery(): Promise<string> {
  await refreshCachedToken()
  return tokenQuery()
}
