// Capture the HUD screens from ?sim=preview into docs/screens/*.png.
//
// The README's screen reference is only worth having if it stays true, so it is
// generated rather than hand-pasted: re-run this after a layout change and the
// images follow. Grabs the preview canvas itself (not a viewport screenshot), so
// each file is exactly the 576×288 lens at 2×, with no browser chrome.
//
//   npm --prefix src/glasses run capture:screens        # against a running dev server
//   npm --prefix src/glasses run capture:screens -- --url http://localhost:5273
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screens')

const urlArg = process.argv.indexOf('--url')
const BASE = urlArg > -1 ? process.argv[urlArg + 1] : 'http://localhost:5273'

// One entry per screen the reference documents. `project` drills the sessions
// screen into a project; `screen` overrides what pickScreen would choose.
const SHOTS = [
  { file: 'projects', fixture: 'list', screen: 'projects', project: 0 },
  { file: 'sessions', fixture: 'list', screen: 'sessions', project: 0 },
  { file: 'detail', fixture: 'detail-working', screen: 'detail', project: 0 },
  { file: 'detail-paginated', fixture: 'detail-long', screen: 'detail', project: 0 },
  { file: 'approval', fixture: 'approval', screen: 'approval', project: 0 },
  { file: 'question', fixture: 'question-multi', screen: 'question', project: 0 },
  { file: 'interrupt', fixture: 'list', screen: 'interrupt', project: 0 },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(`${BASE}/?sim=preview`, { waitUntil: 'networkidle' })
await mkdir(OUT, { recursive: true })

for (const shot of SHOTS) {
  const selects = page.locator('select')
  await selects.nth(0).selectOption(shot.fixture)
  await selects.nth(1).selectOption(shot.screen)
  await page.locator('input[type=number]').fill(String(shot.project))
  // The canvas repaints in an effect after the state change; wait for the readout
  // to settle rather than sleeping a fixed amount.
  await page.waitForTimeout(150)

  // Export at the lens's true 576×288 rather than the preview's 2× backing store:
  // it is the honest resolution for a reference doc, it stays legible in a README,
  // and it keeps each regeneration from adding ~4× the bytes to git history.
  // Downscaling a 2× render supersamples, so the text is smoother than drawing at 1×.
  const dataUrl = await page.locator('canvas').evaluate((c) => {
    const out = document.createElement('canvas')
    out.width = c.width / 2
    out.height = c.height / 2
    const ctx = out.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(c, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  })
  const png = Buffer.from(dataUrl.split(',')[1], 'base64')
  await writeFile(join(OUT, `${shot.file}.png`), png)
  console.log(`${shot.file}.png  ${(png.length / 1024).toFixed(1)} KB  (${shot.fixture} / ${shot.screen})`)
}

await browser.close()

if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'))
  process.exit(1)
}
