import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 3397
const BASE = `http://127.0.0.1:${PORT}`
const OUT = path.join(ROOT, 'scripts', 'shots')

fs.mkdirSync(OUT, { recursive: true })

const server = spawn('node', ['server/dist/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: '/tmp/opencode/sf-shots-data' },
  stdio: 'ignore'
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/api/files`)
      if (res.ok) return
    } catch {}
    await sleep(400)
  }
  throw new Error('server did not start')
}

async function waitForIdle(page) {
  await page.waitForNetworkIdle({ idleTime: 600, timeout: 15000 }).catch(() => {})
}

try {
  await waitForServer()
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--font-render-hinting=none']
  })
  const page = await browser.newPage()

  // 1 — empty state
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 })
  await sleep(900)
  await page.screenshot({ path: path.join(OUT, '1-empty.png') })
  console.log('shot 1-empty')

  // 2 — import two videos via the file input
  const input = await page.$('input[type=file]')
  await input.uploadFile(path.join(process.env.HOME, 'Downloads', '____avy_2_-_WvBgrI.mp4'))
  await sleep(2500)
  await input.uploadFile(path.join(process.env.HOME, 'Downloads', 'Joe_Shitpost____-_1CfQWn.mp4'))
  await sleep(3500)
  await page.screenshot({ path: path.join(OUT, '2-grid.png') })
  console.log('shot 2-grid')

  // 3 — editor modal
  await page.click('.card')
  await sleep(2200)
  await page.screenshot({ path: path.join(OUT, '3-editor.png') })
  console.log('shot 3-editor')

  // 4 — editor with border on + crop pos moved
  const btns = await page.$$('.controls-col .btn-ghost')
  for (const b of btns) {
    const t = await b.evaluate(el => el.textContent)
    if (t.includes('White border')) { await b.click(); break }
  }
  await sleep(400)
  await page.screenshot({ path: path.join(OUT, '4-editor-border.png') })
  console.log('shot 4-editor-border')

  // 5 — convert → result panel
  await page.click('.convert-btn')
  await sleep(20000)
  await page.screenshot({ path: path.join(OUT, '5-result.png') })
  console.log('shot 5-result')

  // 6 — batch panel (close modal, run batch)
  await page.keyboard.press('Escape').catch(() => {})
  const closeBtn = await page.$('.modal-head .icon-btn')
  if (closeBtn) await closeBtn.click()
  await sleep(500)
  const fab = await page.$('.fab')
  if (fab) {
    await fab.click()
    await sleep(25000)
    await page.screenshot({ path: path.join(OUT, '6-batch.png'), fullPage: true })
    console.log('shot 6-batch')
  }

  await browser.close()
  console.log('DONE')
} catch (err) {
  console.error('SHOT-ERROR:', err.message)
  process.exitCode = 1
} finally {
  server.kill()
}
