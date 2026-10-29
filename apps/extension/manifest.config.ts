import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest(({ command }) => ({
  manifest_version: 3,
  name: 'Local Voice Form Assistant',
  description: pkg.description,
  version: pkg.version,
  minimum_chrome_version: '116',
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  icons: {
    48: 'public/logo.png',
  },
  action: {
    default_icon: {
      48: 'public/logo.png',
    },
    default_title: 'Open Local Voice Form Assistant',
  },
  permissions: [
    'sidePanel',
    'activeTab',
    'scripting',
    'storage',
  ],
  // CRXJS loads its dev worker/modules from Vite. These permissions and CSP
  // exceptions are excluded entirely from the production build.
  host_permissions: command === 'serve'
    ? ['http://localhost/*', 'http://127.0.0.1/*']
    : ['http://127.0.0.1:8765/*'],
  content_security_policy: {
    extension_pages: command === 'serve'
      ? "default-src 'self'; script-src 'self' http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; connect-src 'self' http://127.0.0.1:8765;",
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
}))
