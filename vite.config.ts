import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // near-api-js reaches util.format through is-my-json-valid, and Vite turns a bare `util`
      // into an empty object for the browser: the build passes and the page throws when a
      // Contract validates its arguments. The npm package fills it in (util@0.12.5, the alias
      // create-near-app's Vite template uses). The NEAR console (/app/vault/near) reads over
      // plain JSON-RPC today and does not bundle near-api-js, so nothing resolves through this
      // yet; it is here so the first import of near-api-js under src/ cannot ship that crash.
      util: 'util/',
    },
  },
})
