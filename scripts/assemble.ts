/**
 * Assembles the two Escape binaries into ONE installable product.
 *
 * Packaging note: the GPUIX shell CANNOT be shipped as a `bun build --compile`
 * binary. `@gpuix/native` is a NAPI addon loaded via a *runtime* require of
 * `@gpuix/native-darwin-arm64`; a compiled Bun binary is hermetic (its module
 * root is a virtual /$bunfs path) and cannot reach a real .node file. So the
 * shell ships as a JS bundle executed by a bundled Bun runtime, with the
 * dependency closure on disk:
 *
 *   <root>/MacOS/escape-shell      launcher: execs bin/bun on app/shell.js
 *   <root>/Resources/bin/escape    Go engine (spawned as `escape rpc`)
 *   <root>/Resources/bin/bun       Bun runtime
 *   <root>/Resources/app/shell.js  bundled UI (native binding external)
 *   <root>/Resources/app/node_modules/  runtime dependency closure
 *
 * Layout produced:
 *   default   -> build/release/{escape-shell,bin/,app/}
 *   --app     -> build/Escape.app/Contents/{MacOS,Resources}
 */
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

const root = join(import.meta.dir, '..')
const build = join(root, 'build')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version: string = pkg.version

const engineSrc = join(build, 'engine', 'escape')
const shellJs = join(build, 'app', 'shell.js')
const nodeModules = join(root, 'node_modules')

// The Bun runtime that is running this script (falls back to PATH lookup).
const bunExe = process.execPath && existsSync(process.execPath) ? process.execPath : 'bun'

function requireBuilt(): void {
  for (const f of [engineSrc, shellJs, nodeModules]) {
    if (!existsSync(f)) {
      console.error(`missing ${f} — run \`bun run build\` and \`bun install\` first`)
      process.exit(1)
    }
  }
}

const LAUNCHER = `#!/bin/sh
# Escape desktop launcher: runs the bundled UI on the bundled Bun runtime.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/{{BIN}}/bun" "$DIR/{{APP}}/shell.js" "$@"
`

function infoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>CFBundleExecutable</key><string>escape-shell</string>',
    '  <key>CFBundleIdentifier</key><string>dev.escape.shell</string>',
    '  <key>CFBundleName</key><string>Escape</string>',
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
    `  <key>CFBundleVersion</key><string>${version}</string>`,
    '  <key>LSMinimumSystemVersion</key><string>12.0</string>',
    '  <key>NSHighResolutionCapable</key><true/>',
    '</dict></plist>',
  ].join('\n')
}

/** Build the shared payload (bin/ + app/) into `dest`. */
function payload(dest: string): void {
  const bin = join(dest, 'bin')
  const app = join(dest, 'app')
  mkdirSync(bin, { recursive: true })
  mkdirSync(app, { recursive: true })
  cpSync(engineSrc, join(bin, 'escape'))
  cpSync(bunExe, join(bin, 'bun'))
  cpSync(shellJs, join(app, 'shell.js'))
  cpSync(nodeModules, join(app, 'node_modules'), { recursive: true, dereference: true })
  writeFileSync(join(app, 'package.json'), '{"type":"module"}\n')
  // launcher lives at <dest>/escape-shell and execs ./bin/bun ./app/shell.js
  const launcher = join(dest, 'escape-shell')
  writeFileSync(launcher, LAUNCHER.replace('{{BIN}}', 'bin').replace('{{APP}}', 'app'))
  chmodSync(launcher, 0o755)
  cpSync(launcher, join(dest, 'bin', 'escape-shell')) // convenience alias
}

function flat(): void {
  const release = join(build, 'release')
  mkdirSync(release, { recursive: true })
  payload(release)
  console.log(`release: ${release}`)
}

function app(): void {
  const bundle = join(build, 'Escape.app')
  const contents = join(bundle, 'Contents')
  const macos = join(contents, 'MacOS')
  const res = join(contents, 'Resources')
  mkdirSync(macos, { recursive: true })
  payload(res)
  // MacOS/escape-shell is the bundle executable; it execs ../Resources/bin/bun.
  writeFileSync(join(macos, 'escape-shell'), LAUNCHER.replace('{{BIN}}', '../Resources/bin').replace('{{APP}}', '../Resources/app'))
  chmodSync(join(macos, 'escape-shell'), 0o755)
  writeFileSync(join(contents, 'Info.plist'), infoPlist())
  console.log(`app: ${bundle}`)
}

requireBuilt()
if (process.argv.includes('--app')) app()
else flat()
