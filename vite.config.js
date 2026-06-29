import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import http from 'http'
import https from 'https'
import { URL } from 'url'

// Plugin CORS proxy untuk development (menggantikan node proxy.js saat npm run dev)
function corsProxyPlugin() {
  return {
    name: 'cors-proxy',
    configureServer(server) {
      server.middlewares.use('/proxy', (req, res) => {
        const targetUrl = req.url.substring(1)

        if (!targetUrl || !targetUrl.startsWith('http')) {
          res.statusCode = 400
          res.end('Target URL tidak valid')
          return
        }

        try {
          const parsedUrl = new URL(targetUrl)
          const options = {
            method: req.method,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Referer': parsedUrl.origin,
              'Origin': parsedUrl.origin,
              'Accept': '*/*',
            },
          }

          const protocol = targetUrl.startsWith('https') ? https : http

          const proxyReq = protocol.request(targetUrl, options, (proxyRes) => {
            const headersToSkip = ['set-cookie', 'access-control-allow-origin', 'access-control-allow-methods']

            Object.keys(proxyRes.headers).forEach(key => {
              if (!headersToSkip.includes(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key])
              }
            })

            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', '*')

            res.statusCode = proxyRes.statusCode
            proxyRes.pipe(res)
          })

          proxyReq.setTimeout(30000, () => {
            proxyReq.destroy()
            if (!res.headersSent) {
              res.statusCode = 504
              res.end('Timeout')
            }
          })

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.statusCode = 500
              res.end('Error: ' + err.message)
            }
          })

          req.pipe(proxyReq)
        } catch (err) {
          res.statusCode = 500
          res.end('URL parse error')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), corsProxyPlugin()],
})
