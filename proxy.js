/**
 * CORS Proxy Server — Production Ready untuk VPS
 * 
 * Setup di VPS:
 *   npm install express cors
 *   npm install -g pm2
 *   pm2 start proxy.js --name live-proxy
 *   pm2 save && pm2 startup
 * 
 * Untuk HTTPS (wajib jika app di-host dengan HTTPS):
 *   Install nginx + certbot, lalu reverse proxy ke port 3001
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS: izinkan semua origin ───────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['*'],
  exposedHeaders: ['*'],
}));

// ─── Health check endpoint ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'live-cors-proxy', timestamp: new Date().toISOString() });
});

// ─── Proxy endpoint ────────────────────────────────────────────────────────
// Format: /proxy/<URL_LENGKAP>
// Contoh: https://proxy.domainmu.com/proxy/https://cdn.server.com/live.m3u8
app.use('/proxy', (req, res) => {
  // Ambil URL target dari path setelah /proxy/
  const rawTarget = req.originalUrl.substring('/proxy/'.length);

  if (!rawTarget || !rawTarget.startsWith('http')) {
    return res.status(400).json({
      error: 'URL tidak valid',
      hint: 'Format: /proxy/https://target-url',
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawTarget);
  } catch {
    return res.status(400).json({ error: 'URL tidak bisa di-parse' });
  }

  const protocol = rawTarget.startsWith('https') ? https : http;

  const options = {
    method: req.method || 'GET',
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept':          '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      'Referer':         parsedUrl.origin + '/',
      'Origin':          parsedUrl.origin,
      'Connection':      'keep-alive',
    },
  };

  const proxyReq = protocol.request(rawTarget, options, (proxyRes) => {
    // Header yang tidak diteruskan (bisa konflik dengan CORS atau Caching yang kita set)
    const STRIP = [
      'set-cookie',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'x-frame-options',
      'content-security-policy',
      'cache-control',
      'expires',
      'pragma'
    ];

    // Forward header dari sumber asli
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!STRIP.includes(key.toLowerCase())) {
        // Tangkap redirect (301/302) dan pastikan browser redirect-nya lewat proxy lagi
        if (key.toLowerCase() === 'location' && typeof value === 'string' && value.startsWith('http')) {
          res.setHeader(key, `/proxy/${value}`);
        } else {
          res.setHeader(key, value);
        }
      }
    }

    // Tambahkan CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    // MATIKAN CACHE BROWSER - Sangat penting untuk live stream HLS agar playlist selalu update!
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);

    proxyRes.on('error', (err) => {
      console.error('[proxy] Stream error:', err.message);
    });
  });

  // Timeout 30 detik
  proxyReq.setTimeout(30000, () => {
    console.error('[proxy] Timeout:', rawTarget.substring(0, 80));
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Timeout dari server asal' });
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] Fetch error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Gagal menjangkau server asal', detail: err.message });
  });

  req.pipe(proxyReq);
});

// ─── 404 fallback ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan', endpoints: ['/health', '/proxy/<url>'] });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CORS Proxy berjalan di http://0.0.0.0:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Proxy format: http://localhost:${PORT}/proxy/<URL_STREAM>`);
});
