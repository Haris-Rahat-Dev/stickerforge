import fs from 'node:fs'
import admin from 'firebase-admin'
import type { Request, Response, NextFunction } from 'express'

// The Android app fetches a built pack by its unguessable code and sends no token.
// These two shapes — and only these — must stay reachable without authentication.
// Same charset and length as CODE_RE in index.ts — the two must not disagree, or a
// code that auth waves through gets rejected by the route that serves it.
const PUBLIC = [
  /^\/api\/pack\/[a-z0-9-]{1,32}$/,
  /^\/api\/pack\/[a-z0-9-]{1,32}\/file\/[\w.-]{1,64}$/,
]

export const publicPath = (pathname: string): boolean => PUBLIC.some(re => re.test(pathname))

export type TokenVerifier = (token: string) => Promise<string>
export type AuthMode = 'firebase' | 'cookie' | 'e2e'

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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export function resolveAuthMode(): AuthMode {
  if (process.env.FIREBASE_E2E_BYPASS === '1') {
    // The bypass lets any caller claim any uid. It must never answer beyond this machine.
    if (!LOOPBACK.has(process.env.HOST || '127.0.0.1')) {
      throw new Error('FIREBASE_E2E_BYPASS=1 is only allowed with a loopback HOST')
    }
    return 'e2e'
  }
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT
  if (saPath && fs.existsSync(saPath)) return 'firebase'
  return 'cookie'
}

function cookieUid(req: Request, res: Response): string {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
  )
  let uid = cookies['sf_uid']
  if (!uid || !/^[0-9a-f-]{36}$/.test(uid)) {
    uid = crypto.randomUUID()
    res.cookie('sf_uid', uid, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 365 * 24 * 3600 * 1000 })
  }
  return uid
}

/**
 * Firebase when FIREBASE_SERVICE_ACCOUNT points at a real JSON; otherwise anonymous
 * sf_uid cookie so dogfood/deploy works without a Firebase project.
 * E2E sets FIREBASE_E2E_BYPASS=1 and sends Bearer e2e:<uid>.
 */
export function createAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  const mode = resolveAuthMode()

  let verify: TokenVerifier | null = null
  if (mode === 'e2e') {
    verify = async (token: string) => {
      if (!token.startsWith('e2e:')) throw new Error('e2e token required')
      const uid = token.slice(4)
      if (!uid) throw new Error('e2e token has no uid')
      return uid
    }
    console.log('auth: e2e bypass (Bearer e2e:<uid>)')
  } else if (mode === 'firebase') {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT!
    const cred = JSON.parse(fs.readFileSync(saPath, 'utf8')) as admin.ServiceAccount
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) })
    }
    verify = createVerifier(t => admin.auth().verifyIdToken(t))
    console.log('auth: firebase-admin')
  } else {
    console.warn('auth: cookie sf_uid (FIREBASE_SERVICE_ACCOUNT unset — Firebase optional until available)')
  }

  return (req, res, next) => {
    if (publicPath(req.baseUrl + req.path)) return next()

    if (mode === 'cookie') {
      req.userId = cookieUid(req, res)
      return next()
    }

    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const queryToken = typeof req.query.token === 'string' ? req.query.token : ''
    const token = bearer || queryToken
    if (!token || !verify) return res.status(401).json({ error: 'sign in required' })

    verify(token)
      .then(uid => { req.userId = uid; next() })
      .catch(() => res.status(401).json({ error: 'sign in required' }))
  }
}
