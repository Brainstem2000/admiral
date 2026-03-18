import { execSync } from 'child_process'
import { cpSync, existsSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')
const BUN = process.execPath

console.log('Building Admiral...')

const finalBinary = process.platform === 'win32' ? 'admiral.exe' : 'admiral'
const tempBinary = process.platform === 'win32' ? 'admiral.new.exe' : 'admiral.new'

// 1. Build the React SPA with Vite
console.log('\n[1/3] Building frontend...')
execSync(`"${BUN}" x vite build`, { cwd: join(ROOT, 'src/frontend'), stdio: 'inherit' })

// 2. Copy dist to root so it's alongside the binary
const srcDist = join(ROOT, 'src/frontend/dist')
const outDist = join(ROOT, 'dist')
if (existsSync(outDist)) rmSync(outDist, { recursive: true, force: true })
cpSync(srcDist, outDist, { recursive: true })
console.log('[2/3] Frontend assets copied to ./dist/')

// 3. Compile the Hono server into a single binary
console.log('[3/3] Compiling server binary...')
const finalBinaryPath = join(ROOT, finalBinary)
const tempBinaryPath = join(ROOT, tempBinary)
if (existsSync(tempBinaryPath)) rmSync(tempBinaryPath, { force: true })
execSync(`"${BUN}" build src/server/index.ts --compile --outfile ${tempBinary}`, { cwd: ROOT, stdio: 'inherit' })

try {
	if (existsSync(finalBinaryPath)) rmSync(finalBinaryPath, { force: true })
	renameSync(tempBinaryPath, finalBinaryPath)
} catch (error) {
	console.warn(`\nWarning: Could not replace ${finalBinary} (likely locked by a running process).`)
	console.warn(`New binary was built at: ${tempBinary}`)
	console.warn('Stop the running process, then replace the old binary manually.')
	console.warn(String(error))
}

console.log('\nBuild complete! Run: ./admiral')
console.log('Note: the dist/ directory must be alongside the admiral binary.')
