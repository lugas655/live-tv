import { useState, useEffect, useMemo } from 'react';
import { Search, Play, Tv, MonitorPlay, WifiOff } from 'lucide-react';
import parser from 'iptv-playlist-parser';
import VideoPlayer from './components/VideoPlayer';

const M3U_URL = import.meta.env.VITE_M3U_URL;


export default function App() {
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const fetchPlaylist = async () => {
      try {
        setLoading(true);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(M3U_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) throw new Error('Gagal mengambil data playlist');
        const m3uString = await response.text();
        const parsed = parser.parse(m3uString);
        
        // Filter saluran: hapus yang formatnya jelas-jelas tidak didukung browser (RTMP, UDP, dsb)
        const validChannels = parsed.items
          .filter(item => {
            if (!item.url) return false;
            const u = item.url.toLowerCase();
            // Coret link rtmp, udp, atau format tidak wajar
            if (u.includes('rtmp://') || u.includes('udp/')) return false;
            return true;
          })
          .map((item, index) => {
            const cleanUrl = item.url.split('|')[0];
            return {
              id: index,
              name: item.name || `Channel ${index + 1}`,
              logo: item.tvg?.logo || null,
              group: item.group?.title || 'Uncategorized',
              url: cleanUrl,
            };
        });

        setChannels(validChannels);
      } catch (err) {
        console.error('Error fetching playlist:', err);
        if (err.name === 'AbortError') {
          setError('Waktu habis memuat playlist. Periksa koneksi internet Anda.');
        } else {
          setError('Gagal memuat playlist. Pastikan koneksi internet Anda stabil.');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchPlaylist();
  }, []);

  const filteredChannels = useMemo(() => {
    if (!searchQuery) return channels;
    return channels.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [channels, searchQuery]);

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      
      {/* Sidebar - Channel List */}
      <div 
        className={`${sidebarOpen ? 'w-80 translate-x-0' : 'w-0 -translate-x-full'} 
        transition-all duration-300 ease-in-out flex flex-col bg-slate-900 border-r border-slate-800 shadow-2xl z-20 absolute md:relative h-full shrink-0`}
      >
        {/* Sidebar Header */}
        <div className="p-4 bg-slate-900/95 sticky top-0 z-10 border-b border-slate-800/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-gradient-to-br from-worldcup-gold to-yellow-600 p-2 rounded-lg shadow-lg shadow-yellow-900/20">
              <MonitorPlay className="w-6 h-6 text-slate-950" />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
              WorldCup Live
            </h1>
          </div>
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder="Cari saluran..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 text-sm rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-worldcup-gold/50 focus:border-worldcup-gold/30 transition-all placeholder-slate-500"
            />
          </div>
        </div>

        {/* Channel List */}
        <div className="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3">
              <div className="w-6 h-6 border-2 border-worldcup-gold border-t-transparent rounded-full animate-spin"></div>
              <p className="text-sm text-slate-400">Memuat saluran...</p>
            </div>
          ) : error ? (
            <div className="p-4 text-center text-red-400 bg-red-950/20 rounded-xl m-2 border border-red-900/50">
              <WifiOff className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{error}</p>
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="text-center p-8 text-slate-500">
              <p>Saluran tidak ditemukan.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredChannels.map(channel => (
                <button
                  key={channel.id}
                  onClick={() => setActiveChannel(channel)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200 group text-left ${
                    activeChannel?.id === channel.id 
                      ? 'bg-gradient-to-r from-worldcup-gold/20 to-transparent border border-worldcup-gold/30' 
                      : 'hover:bg-slate-800/50 border border-transparent'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 overflow-hidden bg-slate-800 ${activeChannel?.id === channel.id ? 'shadow-lg shadow-worldcup-gold/20' : ''}`}>
                    {channel.logo ? (
                      <img src={channel.logo} alt={channel.name} className="w-full h-full object-contain p-1" onError={(e) => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
                    ) : null}
                    <Tv className={`w-5 h-5 ${channel.logo ? 'hidden' : 'block'} ${activeChannel?.id === channel.id ? 'text-worldcup-gold' : 'text-slate-500'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className={`text-sm font-medium truncate ${activeChannel?.id === channel.id ? 'text-white' : 'text-slate-300 group-hover:text-white'}`}>
                      {channel.name}
                    </h3>
                    <p className="text-xs text-slate-500 truncate">{channel.group}</p>
                  </div>
                  {activeChannel?.id === channel.id && (
                    <Play className="w-4 h-4 text-worldcup-gold shrink-0 animate-pulse" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Content - Video Player */}
      <div className="flex-1 flex flex-col relative h-full bg-black/40">
        
        {/* Top Navigation Bar */}
        <div className="h-16 flex items-center justify-between px-4 bg-slate-900/50 backdrop-blur-md border-b border-slate-800/50">
          <button 
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          
          <div className="flex items-center gap-2 text-sm text-slate-400 font-medium">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            LIVE
          </div>
        </div>

        {/* Video Container */}
        <div className="flex-1 p-4 md:p-6 lg:p-8 flex items-center justify-center overflow-hidden">
          <div className="w-full max-w-6xl aspect-video mx-auto">
            <VideoPlayer 
              url={activeChannel?.url} 
              title={activeChannel?.name}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
