import fs from 'node:fs'
import admin from 'firebase-admin'

// The Android app fetches a built pack by its unguessable code and sends no token.
// These two shapes — and only these — must stay reachable without authentication.
const PUBLIC = [
  /^\/api\/pack\/[A-Za-z0-9_-]+$/,
  /^\/api\/pack\/[A-Za-z0-9_-]+\/file\/[A-Za-z0-9_.-]+$/,
]

export const publicPath = (pathname: string): boolean => PUBLIC.some(re => re.test(pathname))

export type TokenVerifier = (token: string) => Promise<string>

/**
 * Wraps firebase-admin's verifyIdToken (or a test double) into a uid resolver.
 */
export function createVerifier(
  verifyIdToken: (token: string) => Promise<{ uid: string }>
): TokenVerifier {
  return async (token: string): Promise<string> => {
    const decoded = await verifyIdToken(token)
    if (!decoded.uid) throw new Error('token has no uid')
    return decoded.uid
  }
}

/**
 * Boot firebase-admin from a service-account JSON file.
 * E2E sets FIREBASE_E2E_BYPASS=1 and sends Bearer e2e:<uid> (no Google call).
 */
export function initAuth(): TokenVerifier {
  if (process.env.FIREBASE_E2E_BYPASS === '1') {
    return async (token: string) => {
      if (!token.startsWith('e2e:')) throw new Error('e2e token required')
      const uid = token.slice(4)
      if (!uid) throw new Error('e2e token has no uid')
      return uid
    }
  }

  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!saPath) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not set — refusing to start. See .env.example')
    process.exit(1)
  }
  if (!fs.existsSync(saPath)) {
    console.error(`FIREBASE_SERVICE_ACCOUNT file not found: ${saPath}`)
    process.exit(1)
  }

  const cred = JSON.parse(fs.readFileSync(saPath, 'utf8')) as admin.ServiceAccount
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(cred) })
  }
  return createVerifier(t => admin.auth().verifyIdToken(t))
}
