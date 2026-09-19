# Firebase Auth Implementation Plan (Plan 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the anonymous `sf_uid` cookie with real Firebase accounts, so a user signs in on any machine and sees their own files, jobs, and packs.

**Architecture:** The browser runs the Firebase Auth JS SDK and obtains an ID token. Every `/api/*` request carries it as `Authorization: Bearer <token>`. Express verifies the token's signature against Google's public JWKS using `jose` — `firebase-admin` is deliberately not used, because verification alone does not need it. `req.userId` becomes the Firebase `uid`; every existing `owner === req.userId` check is untouched, because `owner` was always an opaque string. Data, binaries, and SQLite stay on the VM.

**Tech Stack:** Node 22.5+ (built-in `node:sqlite`, `node:test`), Express 4, `jose` (new, server), `firebase` (new, web SDK), React 18, Vite 6, bash + curl + python3 for e2e.

## Global Constraints

- Node 22.5+ required (project already depends on built-in `node:sqlite`).
- Exactly two new dependencies: `jose` (server) and `firebase` (web). **Do not add `firebase-admin`.**
- Firebase **Spark (free) plan only.** No Cloud Storage, no Cloud Functions, no Cloud Run. These are Blaze-only and are out of scope.
- `owner` stays an opaque `string` throughout. No type narrowing to a Firebase-specific type.
- `GET /api/pack/:code` and `GET /api/pack/:code/file/:name` **must remain unauthenticated.** The Android app fetches by unguessable pack code and sends no token. Breaking this breaks the phone handoff.
- The `sf_uid` cookie must never be set again. No claim/migration endpoint is built — existing anonymous data is abandoned deliberately.
- Do **not** add a Claude co-author or attribution line to commit messages (user preference in CLAUDE.md).
- Commits happen on branch `main` with the `Haris-Rahat-Dev` git identity, which is already configured. Do not push; the user pushes.

---

### Task 1: Token verifier module

A pure, dependency-injected verifier. Isolating it from Express is what makes it testable without a network or a real Firebase project.

**Files:**
- Create: `server/src/auth.ts`
- Create: `server/test/auth.test.ts`
- Modify: `package.json` (add `jose`, add `test` script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createVerifier(opts: VerifierOptions): (token: string) => Promise<string>` — resolves to the Firebase `uid`, rejects on any invalid token.
  - `interface VerifierOptions { projectId: string; jwksUrl?: string }`
  - Task 2 consumes `createVerifier`.

- [ ] **Step 1: Install `jose` and add a test script**

```bash
npm install jose@^5.9.6
npm pkg set scripts.test="node --test server/test/"
```

- [ ] **Step 2: Leave `server/tsconfig.json` alone**

Do **not** add `test` to its `include`. That tsconfig sets `"rootDir": "src"`, so
including the test directory breaks `npm run build`. Tests are run directly by
`node --test`, which strips TypeScript types natively on this Node version, and are
deliberately outside the compiled output.

Run: `node -v`
Expected: v22.6.0 or newer (native type stripping). The repo is on v26.

- [ ] **Step 3: Write the failing test**

This mints tokens with a locally generated RSA key and serves the matching public JWKS from an in-process HTTP server, so no Firebase project or network is needed.

Create `server/test/auth.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose'
import { createVerifier } from '../src/auth.ts'

const PROJECT = 'stickerforge-test'
const ISSUER = `https://securetoken.google.com/${PROJECT}`

// Generate one keypair, serve its public half as a JWKS, mint tokens with the private half.
async function harness() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const jwksUrl = `http://127.0.0.1:${port}/jwks`

  const mint = (claims: Record<string, unknown> = {}, sub = 'uid-abc') =>
    new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(PROJECT)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)

  return { jwksUrl, mint, close: () => server.close() }
}

test('accepts a well-formed token and returns its uid', async () => {
  const h = await harness()
  const verify = createVerifier({ projectId: PROJECT, jwksUrl: h.jwksUrl })
  assert.equal(await verify(await h.mint({}, 'uid-abc')), 'uid-abc')
  h.close()
})

test('rejects a token issued for a different project', async () => {
  const h = await harness()
  const verify = createVerifier({ projectId: 'some-other-project', jwksUrl: h.jwksUrl })
  await assert.rejects(() => verify(await h.mint()))
  h.close()
})

test('rejects a token with a tampered payload', async () => {
  const h = await harness()
  const verify = createVerifier({ projectId: PROJECT, jwksUrl: h.jwksUrl })
  const token = await h.mint()
  const [head, , sig] = token.split('.')
  const evil = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url')
  await assert.rejects(() => verify(`${head}.${evil}.${sig}`))
  h.close()
})

test('rejects garbage and empty strings', async () => {
  const h = await harness()
  const verify = createVerifier({ projectId: PROJECT, jwksUrl: h.jwksUrl })
  await assert.rejects(() => verify('not-a-token'))
  await assert.rejects(() => verify(''))
  h.close()
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/auth.ts'`

- [ ] **Step 5: Write the implementation**

Create `server/src/auth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Firebase ID tokens are RS256 JWTs signed by Google. Verifying one needs only the
// public JWKS — not firebase-admin, and not a service account key. jose caches the
// key set in memory and refetches on rotation, so this is one network call per hour.
const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

export interface VerifierOptions {
  projectId: string
  /** Override for tests. Defaults to Google's published secure-token JWKS. */
  jwksUrl?: string
}

/**
 * Returns a function that verifies a Firebase ID token and resolves to its uid.
 * Rejects on a bad signature, wrong project, expired token, or malformed input.
 */
export function createVerifier(opts: VerifierOptions): (token: string) => Promise<string> {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl ?? GOOGLE_JWKS))
  return async (token: string): Promise<string> => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${opts.projectId}`,
      audience: opts.projectId,
    })
    const uid = payload.sub
    if (!uid) throw new Error('token has no subject')
    return uid
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# pass 4`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/src/auth.ts server/test/auth.test.ts
git commit -m "Add Firebase ID token verifier (jose, no firebase-admin)"
```

---

### Task 2: Replace the cookie middleware

**Files:**
- Modify: `server/src/index.ts:34-53` (the cookie middleware block)
- Modify: `server/test/auth.test.ts` (add the route-guard tests)
- Create: `.env.example`

**Interfaces:**
- Consumes: `createVerifier` from Task 1.
- Produces:
  - `req.userId: string` — now a Firebase uid, same name and type as before.
  - Unauthenticated `/api/*` requests receive `401 {"error":"sign in required"}`.
  - `PUBLIC_PATHS` — the regex allowlist keeping the Android pack routes open.

- [ ] **Step 1: Write the failing test**

Append to `server/test/auth.test.ts`:

```ts
import { publicPath } from '../src/auth.ts'

test('pack fetch routes stay public for the Android app', () => {
  assert.equal(publicPath('/api/pack/demo'), true)
  assert.equal(publicPath('/api/pack/ABC123/file/sticker_0.webp'), true)
})

test('every other api route is protected', () => {
  assert.equal(publicPath('/api/files'), false)
  assert.equal(publicPath('/api/upload'), false)
  assert.equal(publicPath('/api/packs'), false)
  assert.equal(publicPath('/api/packs/ABC123/build'), false)
  assert.equal(publicPath('/api/job/xyz'), false)
})

test('a path merely containing /api/pack/ is not public', () => {
  assert.equal(publicPath('/api/packs/ABC/stickers'), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `publicPath` is not exported from `../src/auth.ts`

- [ ] **Step 3: Add `publicPath` to the verifier module**

Append to `server/src/auth.ts`:

```ts
// The Android app fetches a built pack by its unguessable code and sends no token.
// These two shapes — and only these — must stay reachable without authentication.
const PUBLIC = [
  /^\/api\/pack\/[A-Za-z0-9_-]+$/,
  /^\/api\/pack\/[A-Za-z0-9_-]+\/file\/[A-Za-z0-9_.-]+$/,
]

export const publicPath = (pathname: string): boolean => PUBLIC.some(re => re.test(pathname))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `# pass 7`, `# fail 0`

- [ ] **Step 5: Replace the middleware in `server/src/index.ts`**

Delete the whole cookie block at lines 34–53 (from the `// Anonymous per-browser identity:` comment through the closing `})` of `app.use`) and put this in its place:

```ts
// Firebase accounts. The browser holds the session and sends an ID token per request;
// we verify its signature against Google's public JWKS. `owner` stays an opaque string,
// so every `owner === req.userId` check below is unchanged — it is just a real account
// now instead of a cookie. The phone never sends a token: it reads packs by their
// unguessable code, which is why publicPath() exists.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { userId: string } }
}

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID
if (!FIREBASE_PROJECT_ID) {
  console.error('FIREBASE_PROJECT_ID is not set — refusing to start. See .env.example')
  process.exit(1)
}
const verifyToken = createVerifier({
  projectId: FIREBASE_PROJECT_ID,
  jwksUrl: process.env.FIREBASE_JWKS_URL,   // tests only; unset in production
})

app.use('/api', async (req, res, next) => {
  if (publicPath(req.baseUrl + req.path)) return next()
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'sign in required' })
  try {
    req.userId = await verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'sign in required' })
  }
})
```

Add `createVerifier` and `publicPath` to the import block at the top of the file:

```ts
import { createVerifier, publicPath } from './auth.js'
```

- [ ] **Step 6: Create `.env.example`**

```bash
cat > .env.example <<'EOF'
# Firebase project that issues ID tokens. Server refuses to start without it.
FIREBASE_PROJECT_ID=your-project-id

# Web client config (Firebase console → Project settings → Your apps → Web app).
# These are public values by design; Firebase security comes from rules, not secrecy.
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_APP_ID=

# Tests only. Points the verifier at a local JWKS instead of Google's. Leave unset.
# FIREBASE_JWKS_URL=
EOF
```

- [ ] **Step 7: Verify it compiles and the server refuses to start unconfigured**

Run: `npm run typecheck`
Expected: PASS

Run: `npm run build && node server/dist/index.js`
Expected: prints `FIREBASE_PROJECT_ID is not set — refusing to start. See .env.example` and exits non-zero.

- [ ] **Step 8: Commit**

```bash
git add server/src/auth.ts server/src/index.ts server/test/auth.test.ts .env.example
git commit -m "Require a verified Firebase ID token on /api; drop the sf_uid cookie"
```

---

### Task 3: Web sign-in

**Files:**
- Create: `web/src/auth.ts`
- Create: `web/src/components/SignIn.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/api.ts` (every `fetch` and the upload `XMLHttpRequest`)
- Modify: `package.json` (add `firebase`)

**Interfaces:**
- Consumes: the 401 contract from Task 2.
- Produces:
  - `onAuth(cb: (user: AuthUser | null) => void): () => void` — subscribes to sign-in state, returns an unsubscribe.
  - `interface AuthUser { uid: string; email: string | null; displayName: string | null }`
  - `signInWithGoogle(): Promise<void>`, `signInWithEmail(email: string, password: string): Promise<void>`, `registerWithEmail(email: string, password: string): Promise<void>`, `signOutUser(): Promise<void>`
  - `authHeader(): Promise<Record<string, string>>` — `{ Authorization: 'Bearer …' }`, or `{}` when signed out. Task 4's e2e does not use this; plans 2–5 do.

- [ ] **Step 1: Install the web SDK**

```bash
npm install firebase@^11.1.0
```

- [ ] **Step 2: Write the auth module**

Create `web/src/auth.ts`:

```ts
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
  return u ? { Authorization: `Bearer ${await u.getIdToken()}` } : {}
}
```

- [ ] **Step 3: Attach the header to every API call**

In `web/src/api.ts`, add the import and a wrapper, then route every existing `fetch(...)` through it:

```ts
import { authHeader } from './auth.js'

// Every /api call carries the ID token. One wrapper so no call site can forget it.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(await authHeader()) } })
}
```

Replace each `fetch(` with `apiFetch(` in `listFiles`, `deleteFile`, `filmstripUrl`, `detectCrop`, `convert`, `quickConvert`, `packJson`, and `getJob`.

For the upload path, the `XMLHttpRequest` in `uploadFile` needs the header set after `open()`. Change:

```ts
    xhr.open('POST', `${BASE}/api/upload`)
```

to:

```ts
    xhr.open('POST', `${BASE}/api/upload`)
    void authHeader().then(h => {
      for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v)
      xhr.send(fd)
    })
```

and delete the trailing `xhr.send(fd)` at the end of the function, so the body is sent only once the header is attached.

Leave `videoUrl`, `outputPreviewUrl`, `downloadWebm`, and `downloadTray` alone for now — they are `<img>`/`<video>`/anchor URLs that cannot carry a header. Plan 2 replaces them with short-lived signed URLs. Note this in a comment:

```ts
// ponytail: these return bare URLs for <img>/<video>/download, which cannot send an
// Authorization header. Plan 2 swaps them for short-lived signed URLs.
```

- [ ] **Step 4: Write the sign-in screen**

Create `web/src/components/SignIn.tsx`:

```tsx
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
      <div className="empty-box">
        <div className="empty-icon">⚡</div>
        <h2>Sign in to <em>StickerForge</em></h2>
        <p>your packs follow you to any device</p>

        <button className="btn btn-primary" disabled={busy} onClick={() => run(signInWithGoogle)}>
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

        <button className="btn btn-ghost btn-sm" onClick={() => setIsNew(v => !v)}>
          {isNew ? 'I already have an account' : 'Create an account'}
        </button>

        {error && <div className="warn-line">✗ {error}</div>}
      </div>
    </main>
  )
}
```

- [ ] **Step 5: Gate the app on sign-in**

Replace `web/src/main.tsx` entirely with this. It keeps the repo's existing import
style (`./App.jsx`, `./styles.css`, default `React`/`ReactDOM` imports):

```tsx
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
```

- [ ] **Step 6: Add a sign-out control**

In `web/src/App.tsx`, import `signOutUser` from `./auth.js` and add a button to the `<header className="header">` block, after `<Steps stage={stage} />`:

```tsx
<button className="btn btn-ghost btn-sm" onClick={() => void signOutUser()}>Sign out</button>
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck`
Expected: PASS

Run: `npm run build`
Expected: PASS, `web/dist` written.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json web/src/auth.ts web/src/api.ts web/src/main.tsx web/src/App.tsx web/src/components/SignIn.tsx
git commit -m "Web: Firebase sign-in screen and bearer token on every API call"
```

---

### Task 4: E2E suite under auth

The existing 44 assertions all hit `/api` unauthenticated and will now 401. The suite mints its own token against a local JWKS, exactly as the unit tests do.

**Files:**
- Create: `scripts/e2e-token.mjs`
- Modify: `scripts/e2e.sh`

**Interfaces:**
- Consumes: `FIREBASE_JWKS_URL` and `FIREBASE_PROJECT_ID` from Task 2.
- Produces: an `api()` bash helper wrapping `curl` with the auth header.

- [ ] **Step 1: Write the token minter**

Create `scripts/e2e-token.mjs`:

```js
// Mints an ID token for the e2e suite and serves the matching JWKS, so the suite can
// exercise the real auth path without a Firebase project. Prints "<jwksUrl> <token>"
// then stays alive serving the key set until killed.
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'stickerforge-e2e'
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' }

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ keys: [jwk] }))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))

const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
  .setIssuer(`https://securetoken.google.com/${PROJECT}`)
  .setAudience(PROJECT)
  .setSubject('e2e-user')
  .setIssuedAt()
  .setExpirationTime('2h')
  .sign(privateKey)

console.log(`http://127.0.0.1:${server.address().port}/jwks ${token}`)
```

- [ ] **Step 2: Boot the minter before the server in `scripts/e2e.sh`**

Insert immediately after `cd "$(dirname "$0")/.."` in the `── boot ──` block, before the `node server/dist/index.js` line:

```bash
export FIREBASE_PROJECT_ID=stickerforge-e2e
node scripts/e2e-token.mjs > "$DATA_DIR/token.txt" &
TOKEN_PID=$!
for i in $(seq 1 40); do [ -s "$DATA_DIR/token.txt" ] && break; sleep 0.25; done
read -r FIREBASE_JWKS_URL TOKEN < "$DATA_DIR/token.txt"
export FIREBASE_JWKS_URL
[ -n "$TOKEN" ] && ok "auth: minted e2e token" || { echo "token minter failed"; exit 1; }
```

Change the server boot line to pass both variables through:

```bash
DATA_DIR="$DATA_DIR" PORT=$PORT FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID FIREBASE_JWKS_URL=$FIREBASE_JWKS_URL node server/dist/index.js >"$DATA_DIR/server.log" 2>&1 &
```

Add `kill $TOKEN_PID 2>/dev/null` next to the existing `kill $SERVER_PID` in the teardown at the end of the file.

- [ ] **Step 3: Add the `api()` helper and route every call through it**

Add next to the `assert_eq` helpers near the top:

```bash
api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }
```

Replace every `curl -s` in the suite with `api` — including inside `check_spec`, the upload calls, the convert calls, and the pack calls. Two exceptions that must stay bare `curl -s`, because they test the public Android path:

- the readiness probe loop (`curl -s -o /dev/null "$BASE/api/files"`), which must now expect 401 rather than 200 — change it to:

```bash
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" = "401" ] && break; sleep 0.5; done
```

- any `GET $BASE/api/pack/...` assertion.

- [ ] **Step 4: Add the two new auth assertions**

Add a block right after the boot section:

```bash
echo "── auth ──"
assert_eq "auth: unauthenticated /api/files is 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" "401"
assert_eq "auth: bad token is 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer garbage' "$BASE/api/files")" "401"
assert_eq "auth: valid token is 200" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/files")" "200"
```

The existing suite has **no pack section**, so there is no built pack to fetch. Assert
instead that the public route bypasses auth entirely — it must return anything except
401. Add an `assert_ne` helper next to `assert_eq`:

```bash
assert_ne() { # desc actual notexpected
  if [ "$2" != "$3" ]; then ok "$1"; else fail "$1 (got: $2, must not be: $3)"; fi
}
```

and the assertion, in the same `── auth ──` block:

```bash
assert_ne "auth: pack GET bypasses auth for the phone" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pack/zzzznotreal")" "401"
```

- [ ] **Step 5: Run the suite**

Run: `npm run build && npm run test:e2e`
Expected: all 44 previous assertions still pass, plus 5 new ones (1 boot + 4 auth). `FAIL=0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/e2e-token.mjs scripts/e2e.sh
git commit -m "E2E: mint a local ID token so the suite runs under auth"
```

---

### Task 5: Documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the architecture and commands sections**

In `AGENTS.md`, under `server/src/`, add:

```
  auth.ts            Firebase ID token verification (jose) + public-path allowlist
```

Under **Commands**, add:

```bash
npm test             # node:test unit tests (auth verifier)
```

Add a new section after **WhatsApp spec**:

```markdown
## Accounts

Firebase Auth on the **Spark (free)** plan — 50K MAU, no billing account. The browser
holds the session; every `/api` request carries `Authorization: Bearer <id token>`.
The server verifies the signature against Google's public JWKS with `jose`.
**`firebase-admin` is deliberately not a dependency** — verification alone does not
need it.

`FIREBASE_PROJECT_ID` is required; the server refuses to start without it. See
`.env.example`.

`GET /api/pack/:code` and `/api/pack/:code/file/:name` stay **unauthenticated** — the
Android app fetches by unguessable pack code and sends no token. `publicPath()` in
`server/src/auth.ts` is that allowlist; do not widen it.

Cloud Storage and Cloud Run are Blaze-only and are **not** used. Videos, encodes, and
SQLite stay on the VM.
```

Remove the sentence in the **Gotchas** or flow section describing the anonymous cookie, if present.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "Docs: accounts section, auth.ts, npm test"
```

---

## Manual verification before calling this done

Automated tests cannot cover the real Firebase handshake. Do this once by hand:

1. Create a Firebase project on the free Spark plan.
2. Console → Authentication → Sign-in method → enable **Google** and **Email/Password**.
3. Console → Authentication → Settings → Authorized domains → add `localhost` and the VM's Tailscale hostname.
4. Copy the web config into `.env` using `.env.example` as the template.
5. `npm run dev`, sign in with Google, upload a video, build a pack.
6. Sign out, sign in as a second account, and confirm the first account's files are **not** visible.
7. On the phone, confirm Load pack still works — it must, since that path sends no token.

Step 6 is the one that proves the whole plan. If a second account can see the first account's files, `owner` is not being threaded correctly and the remaining plans must not start.

## Remaining plans

2. **Model** — Source/Sticker/Pack split, derived editability, source deletion at build, reference counting. Includes splitting `removeFile()` in `server/src/db.ts:48`, which currently deletes `jobs WHERE file_id = ?` and would therefore destroy a sticker when its source is deleted.
3. **UI** — packs home, pack canvas with staging shelf, install drawer.
4. **Reuse** — All stickers screen, search, cross-pack add, emoji editing.
5. **Firestore** — job status listener replacing the 600ms poll loop.
