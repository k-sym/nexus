import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const outputDir = process.argv[2] ?? 'dist'
const assetsDir = join(outputDir, 'assets')
const entryLimitBytes = 225 * 1024
const entryFiles = (await readdir(assetsDir)).filter(name => /^index-[\w-]+\.js$/.test(name))

if (entryFiles.length !== 1) {
  throw new Error(`Expected one JavaScript entry bundle in ${assetsDir}, found ${entryFiles.length}`)
}

const entryFile = entryFiles[0]
const { size } = await stat(join(assetsDir, entryFile))
const sizeKb = size / 1024

if (size > entryLimitBytes) {
  throw new Error(`${entryFile} is ${sizeKb.toFixed(1)} KB; entry budget is 225 KB`)
}

console.log(`[bundle-size] ${entryFile}: ${sizeKb.toFixed(1)} KB / 225 KB`)
