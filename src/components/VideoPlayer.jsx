import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { Loader2, ShieldCheck, Zap, Settings, Check, ChevronDown, RefreshCw, WifiOff, Globe } from 'lucide-react';

const LOAD_TIMEOUT_MS = 20000;

// ─── Daftar pilihan proxy ──────────────────────────────────────────────────
const PROXY_OPTIONS = [
  {
    id: 'direct',
    label: 'Direct',
    desc: 'Tanpa proxy',
    buildUrl: (u) => u,
    xhrSetup: null,
  },
  {
    id: 'server',
    label: 'Proxy Server',
    desc: 'Via VPS / lokal',
    buildUrl: (u) => `/proxy/${u}`,
    xhrSetup: (xhr, url) => {
      if (url.startsWith('http')) xhr.open('GET', `/proxy/${url}`, true);
    },
    fetchSetup: (context, Request) => {
      if (context.url.startsWith('http')) {
        context.url = `/proxy/${context.url}`;
      }
      // Hls.js fetchSetup can return a Request object or let it use the mutated context.url
      return new Request(context.url, typeof Request === 'object' ? Request : undefined);
    }
  },
  {
    id: 'corsproxy',
    label: 'corsproxy.io',
    desc: 'Public proxy 1',
    buildUrl: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    xhrSetup: (xhr, url) => {
      if (url.startsWith('http')) xhr.open('GET', `https://corsproxy.io/?url=${encodeURIComponent(url)}`, true);
    },
    fetchSetup: (context, Request) => {
      if (context.url.startsWith('http')) context.url = `https://corsproxy.io/?url=${encodeURIComponent(context.url)}`;
      return new Request(context.url, typeof Request === 'object' ? Request : undefined);
    }
  },
  {
    id: 'allorigins',
    label: 'allorigins',
    desc: 'Public proxy 2',
    buildUrl: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    xhrSetup: (xhr, url) => {
      if (url.startsWith('http')) xhr.open('GET', `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, true);
    },
    fetchSetup: (context, Request) => {
      if (context.url.startsWith('http')) context.url = `https://api.allorigins.win/raw?url=${encodeURIComponent(context.url)}`;
      return new Request(context.url, typeof Request === 'object' ? Request : undefined);
    }
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

export default function VideoPlayer({ url, title }) {
  const videoRef        = useRef(null);
  const hlsRef          = useRef(null);
  const loadingTimerRef = useRef(null);
  const hasRecoveredNetworkErrorRef = useRef(false);

  const [selectedProxy, setSelectedProxy] = useState(PROXY_OPTIONS[1]); // default: Proxy Server
  const [loading,        setLoading]       = useState(false);
  const [error,          setError]         = useState(null);
  const [isDash,         setIsDash]        = useState(false);
  const [retryKey,       setRetryKey]      = useState(0);

  // Resolusi / kualitas
  const [levels,          setLevels]          = useState([]);
  const [currentLevel,    setCurrentLevel]    = useState(-1);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showProxyMenu,   setShowProxyMenu]   = useState(false);

  useEffect(() => {
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setShowQualityMenu(false);
    setShowProxyMenu(false);
    setRetryKey(0);
    hasRecoveredNetworkErrorRef.current = false;
  }, [url]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setRetryKey(k => k + 1);
  }, []);

  const handleSelectProxy = useCallback((proxy) => {
    setSelectedProxy(proxy);
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setShowProxyMenu(false);
    setRetryKey(k => k + 1);
  }, []);

  const handleQualityChange = useCallback((levelIndex) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex;
      setCurrentLevel(levelIndex);
    }
    setShowQualityMenu(false);
  }, []);

  // ── Main effect: init player ──────────────────────────────────────────────
  useEffect(() => {
    let hls;
    let dashPlayer;
    const video = videoRef.current;
    let cancelled = false;
    const proxy = selectedProxy;

    const init = async () => {
      setError(null);
      setLoading(true);

      if (!url) { setLoading(false); return; }

      const checkIsDash = url.includes('.mpd');
      setIsDash(checkIsDash);

      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => {
        if (!cancelled) {
          setError('Waktu habis memuat tayangan. Coba proxy lain.');
          setLoading(false);
        }
      }, LOAD_TIMEOUT_MS);

      const onReady = () => {
        clearTimeout(loadingTimerRef.current);
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
          if (!MediaPlayer) throw new Error('dashjs tidak tersedia');
          dashPlayer = MediaPlayer().create();
          dashPlayer.initialize(video, proxy.buildUrl(url), true);
          const events = dashjs.default?.MediaPlayer?.events || dashjs.MediaPlayer?.events;
          dashPlayer.on(events.PLAYBACK_PLAYING, onReady);
          dashPlayer.on(events.STREAM_INITIALIZED, onReady);
          dashPlayer.on(events.ERROR, () => {
            dashPlayer?.destroy(); dashPlayer = null;
            onFail('Gagal memutar DASH. Coba proxy lain.');
          });
        } catch (e) {
          onFail('Gagal memuat pemutar DASH.');
        }
        return;
      }

      // ── HLS ───────────────────────────────────────────────────────────────
      if (Hls.isSupported()) {
        const hlsConfig = {
          debug: false,
          enableWorker: true,
          lowLatencyMode: true,
          ...(proxy.xhrSetup && { xhrSetup: proxy.xhrSetup }),
          ...(proxy.fetchSetup && { fetchSetup: proxy.fetchSetup }),
        };

        hls = new Hls(hlsConfig);
        hlsRef.current = hls;
        hls.loadSource(proxy.buildUrl(url));
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
          if (!data.fatal) return;
          console.error('[HLS] fatal:', data.type, data.details);

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
             if (!hasRecoveredNetworkErrorRef.current) {
                 console.warn('[HLS] Fatal Network Error — mencoba startLoad()...');
                 hasRecoveredNetworkErrorRef.current = true;
                 hls.startLoad();
                 return;
             }
             // Jika masih gagal walau sudah dicoba recover
             console.error('[HLS] Fatal Network Error tidak bisa di-recover.');
          }

          hls.destroy(); hls = null; hlsRef.current = null;
          onFail('Tayangan gagal dimuat. Coba pilih proxy lain di bawah video.');
        });

        return;
      }

      // ── Native HLS (Safari) ───────────────────────────────────────────────
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxy.buildUrl(url);
        video.addEventListener('loadedmetadata', () => { onReady(); video.play().catch(() => {}); });
        video.addEventListener('error', () => onFail('Gagal memutar. Coba proxy lain.'));
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
    };
  }, [url, selectedProxy, retryKey]);

  // ─── UI helpers ──────────────────────────────────────────────────────────
  const activeLabel  = currentLevel === -1 ? 'Auto' : getResolutionLabel(levels[currentLevel]);
  const sortedLevels = [...levels]
    .map((lvl, idx) => ({ ...lvl, index: idx }))
    .sort((a, b) => (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0));

  const btnStyle = (active) => ({
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '6px 12px', borderRadius: '9999px',
    background: active ? 'rgba(250,189,0,0.2)' : 'rgba(0,0,0,0.75)',
    border: active ? '1px solid rgba(250,189,0,0.4)' : '1px solid rgba(255,255,255,0.15)',
    color: active ? '#fac500' : '#e2e8f0',
    fontSize: '12px', fontWeight: '600',
    cursor: 'pointer', backdropFilter: 'blur(8px)',
    transition: 'all 0.2s', letterSpacing: '0.03em',
  });

  const menuStyle = {
    position: 'absolute', bottom: '110%', right: 0,
    minWidth: '180px', background: 'rgba(15,23,42,0.97)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px',
    overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    backdropFilter: 'blur(14px)',
  };

  const menuHeaderStyle = {
    padding: '10px 14px 6px', fontSize: '10px', fontWeight: '700',
    letterSpacing: '0.08em', color: '#64748b', textTransform: 'uppercase',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  };

  const menuItemStyle = (isActive) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '9px 14px',
    background: isActive ? 'rgba(250,189,0,0.12)' : 'transparent',
    border: 'none', color: isActive ? '#fac500' : '#cbd5e1',
    fontSize: '13px', fontWeight: isActive ? '700' : '400',
    cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s',
  });

  return (
    <div
      className="w-full h-full bg-black rounded-xl overflow-hidden shadow-2xl border border-slate-800 relative group flex items-center justify-center"
      onClick={() => { setShowQualityMenu(false); setShowProxyMenu(false); }}
    >
      {/* ── Top overlay: judul + badge ── */}
      <div className="absolute top-0 left-0 w-full p-4 bg-gradient-to-b from-black/80 to-transparent z-30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none flex justify-between items-center">
        <h2 className="text-white text-lg font-semibold drop-shadow-md">{title || 'Pilih Saluran'}</h2>
        <div className="flex gap-2">
          {isDash && !error && (
            <div className="flex items-center gap-1 bg-blue-500/20 text-blue-400 px-3 py-1 rounded-full text-xs border border-blue-500/30">
              <Zap className="w-4 h-4" /> DASH
            </div>
          )}
          {selectedProxy.id !== 'direct' && !error && !loading && (
            <div className="flex items-center gap-1 bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded-full text-xs border border-emerald-500/30">
              <ShieldCheck className="w-4 h-4" /> {selectedProxy.label}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom controls: Proxy + Kualitas ── */}
      {!error && !loading && url && (
        <div
          className="absolute bottom-14 left-0 right-0 px-4 z-40 flex justify-between items-end"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Tombol Proxy */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowProxyMenu(p => !p); setShowQualityMenu(false); }}
              style={btnStyle(selectedProxy.id !== 'direct')}
              title="Pilih Proxy"
            >
              <Globe style={{ width: '14px', height: '14px' }} />
              {selectedProxy.label}
              <ChevronDown style={{ width: '12px', height: '12px', transition: 'transform 0.2s', transform: showProxyMenu ? 'rotate(180deg)' : 'rotate(0deg)' }} />
            </button>

            {showProxyMenu && (
              <div style={{ ...menuStyle, left: 0, right: 'auto' }}>
                <div style={menuHeaderStyle}>Pilih Proxy</div>
                {PROXY_OPTIONS.map((opt) => {
                  const isActive = selectedProxy.id === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectProxy(opt)}
                      style={menuItemStyle(isActive)}
                      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                        <span>{opt.label}</span>
                        <span style={{ fontSize: '10px', color: isActive ? '#fac50099' : '#475569', fontWeight: '400' }}>{opt.desc}</span>
                      </span>
                      {isActive && <Check style={{ width: '14px', height: '14px', flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tombol Kualitas (hanya jika ada multi-level) */}
          {levels.length > 1 && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => { setShowQualityMenu(p => !p); setShowProxyMenu(false); }}
                style={btnStyle(false)}
                title="Pilih Kualitas"
              >
                <Settings style={{ width: '14px', height: '14px' }} />
                {activeLabel}
                <ChevronDown style={{ width: '12px', height: '12px', transition: 'transform 0.2s', transform: showQualityMenu ? 'rotate(180deg)' : 'rotate(0deg)' }} />
              </button>

              {showQualityMenu && (
                <div style={menuStyle}>
                  <div style={menuHeaderStyle}>Kualitas Video</div>
                  <button
                    onClick={() => handleQualityChange(-1)}
                    style={menuItemStyle(currentLevel === -1)}
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
                        style={menuItemStyle(isActive)}
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
          <p className="text-slate-300 font-medium">Memuat tayangan...</p>
          {selectedProxy.id !== 'direct' && (
            <p className="text-slate-500 text-xs mt-1">via {selectedProxy.label}</p>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/95 z-20 p-6 text-center border-t-4 border-red-500">
          <div style={{
            width: '60px', height: '60px', borderRadius: '50%',
            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '14px',
          }}>
            <WifiOff style={{ width: '28px', height: '28px', color: '#ef4444' }} />
          </div>
          <p className="text-white text-base font-bold mb-1">Tayangan Gagal Dimuat</p>
          <p className="text-slate-400 text-xs max-w-xs mb-5" style={{ lineHeight: '1.6' }}>{error}</p>

          {/* Tombol Retry */}
          <button
            onClick={handleRetry}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '9px 20px', borderRadius: '9999px',
              background: 'linear-gradient(135deg, #fac500, #e6b000)',
              border: 'none', color: '#0f172a',
              fontSize: '13px', fontWeight: '700', cursor: 'pointer',
              marginBottom: '16px',
            }}
          >
            <RefreshCw style={{ width: '14px', height: '14px' }} />
            Coba Lagi
          </button>

          {/* Pilihan Proxy langsung di error screen */}
          <p style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>Atau coba dengan proxy lain:</p>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {PROXY_OPTIONS.map((opt) => {
              const isActive = selectedProxy.id === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelectProxy(opt)}
                  style={{
                    padding: '6px 14px', borderRadius: '9999px',
                    background: isActive ? 'rgba(250,189,0,0.15)' : 'rgba(255,255,255,0.05)',
                    border: isActive ? '1px solid rgba(250,189,0,0.4)' : '1px solid rgba(255,255,255,0.1)',
                    color: isActive ? '#fac500' : '#94a3b8',
                    fontSize: '12px', fontWeight: isActive ? '700' : '400',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <video
        ref={videoRef}
        controls
        autoPlay
        className={`w-full h-full object-contain ${(!url || error) ? 'opacity-0 absolute' : 'opacity-100 relative z-10'}`}
        style={{ maxHeight: 'calc(100vh - 4rem)' }}
        playsInline
      />
    </div>
  );
}
