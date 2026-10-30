import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {writeFileSync} from 'node:fs'

const nm = (pkg: string) => new URL(`node_modules/${pkg}`, import.meta.url).pathname

// Dev only (Electron shell). The Go backend runs on a fixed port under the
// `kubeinsdev` build tag (see internal/controller/dev_on.go); proxying keeps
// the page same-origin, so the server's Origin check passes untouched and
// wailsBridge.ts needs no changes. Must match KUBE_INS_DEV_PORT on both sides.
const DEV_GO = `http://127.0.0.1:${process.env.KUBE_INS_DEV_PORT ?? 34567}`

// Vite serves index.html itself, so the token the Go asset handler normally
// injects never gets there. Dev builds skip the token check, but the bridge
// still needs a value present to install itself.
const devToken = () => ({
  name: 'kube-ins-dev-token',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) =>
    html.replace('<head>', '<head><script>window.__KUBE_INS_RPC__="dev";</script>'),
})

// lara-dark-cyan ships its own Inter (two variable woff2, ~0.7MB) through
// @font-face. Nothing asks for that family — the app is Plex — so the files
// were never fetched, yet Vite still copied them into every build. Dropping
// the two @font-face blocks before Vite resolves their url()s keeps them out.
const stripLaraFonts = () => ({
  name: 'kube-ins-strip-lara-fonts',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('lara-dark-cyan/theme.css')) return undefined
    return { code: code.replace(/@font-face\s*\{[^}]*\}/g, ''), map: null }
  },
})

// main.go embeds frontend/dist, so a fresh checkout needs the tracked
// .gitkeep there. Vite empties the directory on every build; without this a
// plain `npm run build` deleted the placeholder, and committing that broke
// every CI Go build.
const keepGitkeep = () => ({
  name: 'kube-ins-keep-gitkeep',
  apply: 'build' as const,
  closeBundle() {
    writeFileSync(new URL('dist/.gitkeep', import.meta.url), '')
  },
})

// Vendor chunks. Without these, Rollup hoists every shared dependency of the
// lazy panels back into one chunk and the code splitting buys nothing: the
// libraries below are exactly the weight the app used to pay at launch.
// Matching is on the module path, so a nested copy under another package's
// node_modules lands in the same chunk as its top-level one.
const VENDOR_CHUNKS: Record<string, string[]> = {
  monaco: ['monaco-editor', '@monaco-editor/react', 'monaco-yaml'],
  reactflow: ['reactflow', '@reactflow/', '@dagrejs/dagre'],
  charts: ['chart.js'],
  xterm: ['@xterm/'],
  primereact: ['primereact'],
}

const vendorChunk = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined
  // Compare against the path *after* node_modules so a package name that also
  // appears in the repo path cannot match by accident.
  const path = id.split('node_modules/').pop() ?? ''
  for (const [chunk, packages] of Object.entries(VENDOR_CHUNKS)) {
    if (packages.some((pkg) => path.startsWith(pkg))) return chunk
  }
  return undefined
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), devToken(), stripLaraFonts(), keepGitkeep()],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => vendorChunk(id) },
    },
    // Set to catch regressions, not to silence the warning. Exactly one chunk
    // is expected to exceed it — `monaco`, which is ~3.6MB of editor that no
    // amount of splitting makes smaller and which is loaded on demand anyway.
    // Vite prints oversized chunks in yellow, so a *second* yellow line in the
    // build table is the signal that something new got too big.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    proxy: {
      '/rpc': { target: DEV_GO, changeOrigin: true },
      '/events': { target: DEV_GO, changeOrigin: true, ws: true },
    },
  },
  resolve: {
    // Monaco's default entry (`editor.main`) statically imports the css, html,
    // json and TypeScript *language services* — the TypeScript one carries the
    // whole compiler — plus ~80 basic-language grammars. This app edits
    // Kubernetes YAML and nothing else. `edcore.main` is the same editor with
    // every editor contribution (find, folding, suggest, hover, context menu)
    // and no languages; lib/monacoBootstrap.ts then adds the one grammar we do
    // want.
    //
    // Aliased rather than imported directly so that *every* importer gets the
    // trimmed build — otherwise one `import 'monaco-editor'` left anywhere
    // silently pulls the full entry back in and undoes it.
    //
    // Array form, because the object form matches by prefix: aliasing the bare
    // string also rewrote `monaco-editor/esm/...` deep imports into nonsense
    // paths. A regex anchors it to the bare specifier.
    alias: [
      { find: /^monaco-editor$/, replacement: nm('monaco-editor/esm/vs/editor/edcore.main.js') },
      ...Object.entries({
      'next/navigation': new URL('src/lib/next-stub.ts', import.meta.url).pathname,
      'next/router': new URL('src/lib/next-stub.ts', import.meta.url).pathname,
      '@fontsource/inter/400.css': nm('@fontsource/inter/400.css'),
      '@fontsource/inter/500.css': nm('@fontsource/inter/500.css'),
      '@fontsource/inter/600.css': nm('@fontsource/inter/600.css'),
      '@fontsource/inter/700.css': nm('@fontsource/inter/700.css'),
      '@fontsource/jetbrains-mono/400.css': nm('@fontsource/jetbrains-mono/400.css'),
      '@fontsource/jetbrains-mono/500.css': nm('@fontsource/jetbrains-mono/500.css'),
      '@fontsource/jetbrains-mono/600.css': nm('@fontsource/jetbrains-mono/600.css'),
      }).map(([find, replacement]) => ({ find, replacement })),
    ]
  }
})
