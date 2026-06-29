import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { Loader2, ShieldCheck, Zap, Settings, Check, ChevronDown, RefreshCw, WifiOff } from 'lucide-react';

const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor;
const LOAD_TIMEOUT_MS = 20000;

// ─── Daftar proxy yang akan dicoba berurutan ───────────────────────────────
// Setiap entry: { label, buildUrl(targetUrl) }
// buildUrl: fungsi yang mengubah URL asli → URL via proxy
const CF_WORKER_URL  = import.meta.env.VITE_CF_WORKER_URL  || '';
const VPS_PROXY_URL  = import.meta.env.VITE_VPS_PROXY_URL  || '';

const PROXY_CHAIN = isCapacitor ? [] : [
  {
    label: 'Local Proxy',
    // Di dev pakai Vite middleware; di preview/prod pakai node proxy.js
    buildUrl: (u) => import.meta.env.DEV
      ? `/proxy/${u}`
      : `http://localhost:3001/proxy/${u}`,
  },
  // VPS Proxy — paling andal jika VITE_VPS_PROXY_URL diisi
  ...(VPS_PROXY_URL ? [{
    label: 'VPS Proxy',
    buildUrl: (u) => `${VPS_PROXY_URL}/proxy/${u}`,
  }] : []),
  // Cloudflare Worker — diaktifkan jika VITE_CF_WORKER_URL diisi di .env
  ...(CF_WORKER_URL ? [{
    label: 'CF Worker',
    buildUrl: (u) => `${CF_WORKER_URL}/proxy/${u}`,
  }] : []),
  {
    label: 'corsproxy.io',
    buildUrl: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  },
  {
    label: 'allorigins',
    buildUrl: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  },
];

// ─── Label resolusi ────────────────────────────────────────────────────────
const getResolutionLabel = (level) => {
  if (!level) return 'Auto';
  const h = level.height;
  if (h >= 1080) return '1080p (FHD)';
  if (h >= 720)  return '720p (HD)';
  if (h >= 480)  return '480p (SD)';
  if (h >= 360)  return '360p';
  if (h >= 240)  return '240p';
  if (h > 0)     return `${h}p`;
  if (level.bitrate) return `~${Math.round(level.bitrate / 1000)} kbps`;
  return 'Standar';
};

// ─── Helper: buat xhrSetup untuk HLS.js berdasarkan buildUrl ──────────────
const makeXhrSetup = (buildUrl) => (xhr, requestUrl) => {
  if (requestUrl.startsWith('http')) {
    xhr.open('GET', buildUrl(requestUrl), true);
  }
};

export default function VideoPlayer({ url, title }) {
  const videoRef        = useRef(null);
  const hlsRef          = useRef(null);
  const loadingTimerRef = useRef(null);
  const hasStartedRef   = useRef(false); // true setelah manifest parsed & video mulai play

  // proxyIdx: -1 = direct, 0..N = index ke PROXY_CHAIN
  const [proxyIdx,       setProxyIdx]       = useState(-1);
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState(null);
  const [isDash,         setIsDash]         = useState(false);
  const [retryKey,       setRetryKey]       = useState(0);

  // Resolusi
  const [levels,         setLevels]         = useState([]);
  const [currentLevel,   setCurrentLevel]   = useState(-1);
  const [showQualityMenu,setShowQualityMenu] = useState(false);

  // Reset saat saluran berubah
  useEffect(() => {
    setProxyIdx(-1);
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setShowQualityMenu(false);
    setRetryKey(0);
  }, [url]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setRetryKey(k => k + 1);
  }, []);

  const handleRetryDirect = useCallback(() => {
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setProxyIdx(-1);
    setRetryKey(k => k + 1);
  }, []);

  const handleQualityChange = useCallback((levelIndex) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
      setCurrentLevel(levelIndex);
    }
    setShowQualityMenu(false);
  }, []);

  // ── Main effect: init player ───────────────────────────────────────────────
  useEffect(() => {
    let hls;
    let dashPlayer;
    const video = videoRef.current;
    let cancelled = false;
    hasStartedRef.current = false;

    const currentProxy = proxyIdx >= 0 ? PROXY_CHAIN[proxyIdx] : null;

    // Fungsi: coba proxy berikutnya, atau tampilkan error jika sudah habis
    const tryNextProxy = (reason) => {
      const next = proxyIdx + 1;
      if (!isCapacitor && next < PROXY_CHAIN.length) {
        console.log(`[VideoPlayer] ${reason} → Mencoba proxy #${next}: ${PROXY_CHAIN[next].label}`);
        clearTimeout(loadingTimerRef.current);
        if (!cancelled) setProxyIdx(next);
      } else {
        const finalMsg = isCapacitor
          ? 'Waktu habis memuat tayangan. Server mungkin sedang mati.'
          : `Semua jalur gagal. Stream mungkin geo-block atau server mati.\n(Direct → ${PROXY_CHAIN.map(p => p.label).join(' → ')})`;
        clearTimeout(loadingTimerRef.current);
        if (!cancelled) {
          setError(finalMsg);
          setLoading(false);
        }
      }
    };

    const init = async () => {
      setError(null);
      setLoading(true);

      if (!url) { setLoading(false); return; }

      const checkIsDash = url.includes('.mpd');
      setIsDash(checkIsDash);

      // Timeout global
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => {
        // Jika sudah berhasil play, timeout tidak relevan
        if (!cancelled && !hasStartedRef.current) tryNextProxy('Timeout');
      }, LOAD_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(loadingTimerRef.current);
        hasStartedRef.current = true;
        if (!cancelled) setLoading(false);
      };
      const onFail = (msg) => {
        clearTimeout(loadingTimerRef.current);
        if (!cancelled) { setError(msg); setLoading(false); }
      };

      // ── DASH ──────────────────────────────────────────────────────────────
      if (checkIsDash) {
        try {
          const dashjs = await import('dashjs');
          const MediaPlayer = dashjs.default?.MediaPlayer || dashjs.MediaPlayer;
          if (!MediaPlayer) throw new Error('dashjs MediaPlayer tidak tersedia');

          const dashUrl = currentProxy ? currentProxy.buildUrl(url) : url;
          dashPlayer = MediaPlayer().create();
          dashPlayer.initialize(video, dashUrl, true);

          const events = (dashjs.default?.MediaPlayer?.events || dashjs.MediaPlayer?.events);
          dashPlayer.on(events.PLAYBACK_PLAYING, onReady);
          dashPlayer.on(events.STREAM_INITIALIZED, onReady);

          dashPlayer.on(events.ERROR, () => {
            dashPlayer?.destroy(); dashPlayer = null;
            tryNextProxy('DASH error');
          });
        } catch (e) {
          console.error('DASH init error:', e);
          onFail('Gagal memuat pemutar DASH. Coba saluran HLS saja.');
        }
        return;
      }

      // ── HLS via HLS.js ────────────────────────────────────────────────────
      if (Hls.isSupported()) {
        const hlsConfig = {
          debug: false,
          enableWorker: true,
          lowLatencyMode: true,
          // Jika pakai proxy, semua request (manifest + segment) ikut di-proxy
          ...(currentProxy && { xhrSetup: makeXhrSetup(currentProxy.buildUrl) }),
        };

        hls = new Hls(hlsConfig);
        hlsRef.current = hls;
        hls.loadSource(currentProxy ? currentProxy.buildUrl(url) : url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
          onReady();
          if (!cancelled) {
            setLevels(data.levels || []);
            setCurrentLevel(-1);
          }
          video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) {
            // Non-fatal: biarkan HLS.js recover sendiri
            console.warn('[HLS] non-fatal:', data.type, data.details);
            return;
          }
          console.error('[HLS] fatal:', data.type, data.details);

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            // Media error → coba recover dulu sebelum menyerah
            console.warn('[HLS] Fatal Media Error — mencoba recoverMediaError...');
            hls.recoverMediaError();
            return;
          }

          // Fatal network error
          hls.destroy(); hls = null; hlsRef.current = null;

          if (hasStartedRef.current) {
            // Video sudah pernah play → jangan ganti proxy, mungkin gangguan sementara
            onFail('Tayangan terputus. Server mungkin gangguan sementara. Coba lagi.');
          } else {
            // Belum play sama sekali → coba proxy berikutnya
            tryNextProxy(`HLS ${data.type}`);
          }
        });

        return;
      }

      // ── Native HLS (Safari/iOS) ───────────────────────────────────────────
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = currentProxy ? currentProxy.buildUrl(url) : url;
        video.addEventListener('loadedmetadata', () => {
          onReady();
          video.play().catch(() => {});
        });
        video.addEventListener('error', () => tryNextProxy('Native video error'));
        return;
      }

      onFail('Format video tidak didukung browser ini.');
    };

    init();

    return () => {
      cancelled = true;
      clearTimeout(loadingTimerRef.current);
      if (hls) { hls.destroy(); hlsRef.current = null; }
      if (dashPlayer) dashPlayer.destroy();
      if (video) video.src = '';
      hasStartedRef.current = false;
    };
  }, [url, proxyIdx, retryKey]);

  // ─── UI helpers ──────────────────────────────────────────────────────────
  const activeLabel   = currentLevel === -1 ? 'Auto' : getResolutionLabel(levels[currentLevel]);
  const sortedLevels  = [...levels]
    .map((lvl, idx) => ({ ...lvl, index: idx }))
    .sort((a, b) => (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0));

  const currentProxyLabel = proxyIdx >= 0 ? PROXY_CHAIN[proxyIdx]?.label : null;

  // Loading message berdasarkan proxy yang aktif
  const loadingMsg = proxyIdx === -1
    ? 'Memuat Tayangan...'
    : `Mencoba via ${currentProxyLabel}...`;

  return (
    <div className="w-full h-full bg-black rounded-xl overflow-hidden shadow-2xl border border-slate-800 relative group flex items-center justify-center">

      {/* ── Top overlay: judul + badge ── */}
      <div className="absolute top-0 left-0 w-full p-4 bg-gradient-to-b from-black/80 to-transparent z-30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none flex justify-between items-center">
        <h2 className="text-white text-lg font-semibold drop-shadow-md">{title || 'Pilih Saluran'}</h2>
        <div className="flex gap-2">
          {isDash && !error && (
            <div className="flex items-center gap-1 bg-blue-500/20 text-blue-400 px-3 py-1 rounded-full text-xs border border-blue-500/30">
              <Zap className="w-4 h-4" /> DASH
            </div>
          )}
          {currentProxyLabel && !error && (
            <div className="flex items-center gap-1 bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs border border-emerald-500/30">
              <ShieldCheck className="w-4 h-4" /> {currentProxyLabel}
            </div>
          )}
        </div>
      </div>

      {/* ── Tombol Kualitas ── */}
      {levels.length > 1 && !error && !loading && (
        <div className="absolute bottom-14 right-4 z-40">
          <button
            onClick={() => setShowQualityMenu(prev => !prev)}
            title="Pilih Kualitas / Resolusi"
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '6px 12px', borderRadius: '9999px',
              background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.15)',
              color: '#e2e8f0', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', backdropFilter: 'blur(8px)',
              transition: 'all 0.2s', letterSpacing: '0.03em',
            }}
          >
            <Settings style={{ width: '14px', height: '14px' }} />
            {activeLabel}
            <ChevronDown style={{
              width: '12px', height: '12px', transition: 'transform 0.2s',
              transform: showQualityMenu ? 'rotate(180deg)' : 'rotate(0deg)',
            }} />
          </button>

          {showQualityMenu && (
            <div style={{
              position: 'absolute', bottom: '110%', right: 0,
              minWidth: '170px', background: 'rgba(15,23,42,0.97)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px',
              overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              backdropFilter: 'blur(14px)',
            }}>
              <div style={{
                padding: '10px 14px 6px', fontSize: '10px', fontWeight: '700',
                letterSpacing: '0.08em', color: '#64748b', textTransform: 'uppercase',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                Kualitas Video
              </div>

              {/* Auto */}
              <button
                onClick={() => handleQualityChange(-1)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '9px 14px',
                  background: currentLevel === -1 ? 'rgba(250,189,0,0.12)' : 'transparent',
                  border: 'none', color: currentLevel === -1 ? '#fac500' : '#cbd5e1',
                  fontSize: '13px', fontWeight: currentLevel === -1 ? '700' : '400',
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { if (currentLevel !== -1) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                onMouseLeave={e => { if (currentLevel !== -1) e.currentTarget.style.background = 'transparent'; }}
              >
                <span>⚡ Auto (Adaptif)</span>
                {currentLevel === -1 && <Check style={{ width: '14px', height: '14px' }} />}
              </button>

              <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />

              {sortedLevels.map((lvl) => {
                const label    = getResolutionLabel(lvl);
                const isActive = currentLevel === lvl.index;
                const kbps     = lvl.bitrate ? Math.round(lvl.bitrate / 1000) : null;
                return (
                  <button
                    key={lvl.index}
                    onClick={() => handleQualityChange(lvl.index)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      width: '100%', padding: '9px 14px',
                      background: isActive ? 'rgba(250,189,0,0.12)' : 'transparent',
                      border: 'none', color: isActive ? '#fac500' : '#cbd5e1',
                      fontSize: '13px', fontWeight: isActive ? '700' : '400',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                      <span>{label}</span>
                      {kbps && <span style={{ fontSize: '10px', color: isActive ? '#fac50099' : '#475569', fontWeight: '400' }}>~{kbps} kbps</span>}
                    </span>
                    {isActive && <Check style={{ width: '14px', height: '14px', flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Placeholder ── */}
      {!url && !error && !loading && (
        <div className="flex flex-col items-center justify-center text-slate-500 absolute inset-0 z-10">
          <svg className="w-16 h-16 mb-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p className="text-lg">Pilih saluran dari daftar untuk mulai menonton</p>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && !error && url && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20">
          <Loader2 className="w-12 h-12 text-worldcup-gold animate-spin mb-4" />
          <p className="text-slate-300 font-medium">{loadingMsg}</p>
          {proxyIdx >= 0 && (
            <p className="text-slate-500 text-xs mt-2">
              Jalur {proxyIdx + 1}/{PROXY_CHAIN.length}: {currentProxyLabel}
            </p>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/95 z-20 p-6 text-center border-t-4 border-red-500">
          <div style={{
            width: '64px', height: '64px', borderRadius: '50%',
            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px',
          }}>
            <WifiOff style={{ width: '32px', height: '32px', color: '#ef4444' }} />
          </div>
          <p className="text-white text-lg font-bold mb-1">Tayangan Gagal Dimuat</p>
          <p className="text-slate-400 text-xs max-w-xs mb-6" style={{ lineHeight: '1.6', whiteSpace: 'pre-line' }}>{error}</p>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              onClick={handleRetry}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '9px 18px', borderRadius: '9999px',
                background: 'linear-gradient(135deg, #fac500, #e6b000)',
                border: 'none', color: '#0f172a',
                fontSize: '13px', fontWeight: '700', cursor: 'pointer',
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              <RefreshCw style={{ width: '14px', height: '14px' }} />
              Coba Lagi
            </button>

            {proxyIdx !== -1 && (
              <button
                onClick={handleRetryDirect}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '9px 18px', borderRadius: '9999px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#94a3b8', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#e2e8f0'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#94a3b8'; }}
              >
                Tanpa Proxy
              </button>
            )}
          </div>

          <p style={{ marginTop: '16px', fontSize: '10px', color: '#334155' }}>
            Sudah mencoba {proxyIdx + 2} jalur • Coba saluran lain
          </p>
        </div>
      )}

      <video
        ref={videoRef}
        controls
        className={`w-full h-full object-contain ${(!url || error) ? 'opacity-0 absolute' : 'opacity-100 relative z-10'}`}
        style={{ maxHeight: 'calc(100vh - 4rem)' }}
        playsInline
      />
    </div>
  );
}
