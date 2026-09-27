// Global app state: settings, persistence helpers and the event bus that links the
// worship side (left) with the streaming side (right).
import { Emitter, deepMerge, debounce } from './util.js';

export const bus = new Emitter();

export const PLATFORM_PRESETS = {
  youtube: { name: 'YouTube', color: '#ff0033', server: 'rtmp://a.rtmp.youtube.com/live2', help: 'YouTube Studio → Go Live → Stream → copy the Stream key.', dashboard: 'https://studio.youtube.com/channel/UC/livestreaming' },
  facebook: { name: 'Facebook', color: '#1877f2', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', help: 'Facebook → Live Producer → "Streaming software" → copy the Stream key. Use a persistent key to avoid re-pasting every week.', dashboard: 'https://www.facebook.com/live/producer' },
  tiktok: { name: 'TikTok', color: '#25f4ee', server: '', help: 'TikTok LIVE Center (or LIVE Studio "Stream key" page) gives you a Server URL and a Stream key — both change every session. Paste both.', dashboard: 'https://livecenter.tiktok.com/producer' },
  instagram: { name: 'Instagram', color: '#e1306c', server: '', help: 'instagram.com (desktop) → Create → Live video → copy the Stream URL and Stream key. Both change every time you go live.', dashboard: 'https://www.instagram.com/' },
  twitch: { name: 'Twitch', color: '#9146ff', server: 'rtmp://live.twitch.tv/app', help: 'Twitch Creator Dashboard → Settings → Stream → Primary Stream key.', dashboard: 'https://dashboard.twitch.tv/settings/stream' },
  custom: { name: 'Custom RTMP', color: '#8b949e', server: 'rtmp://', help: 'Any RTMP/RTMPS server (Restream, vMix, a second church campus…).' },
};

export const DEFAULT_SETTINGS = {
  general: { sceneClick: 'live', confirmStart: true, confirmStop: true, thumbnails: true, split: 0.5, showStats: true, editorSnap: true },
  video: { baseW: 1920, baseH: 1080, outW: 1920, outH: 1080, fps: 30, scaleFilter: 'bicubic' },
  stream: {
    encoder: 'x264', rateControl: 'CBR', bitrate: 4500, keyint: 2, preset: 'veryfast', profile: 'high', tune: '', bframes: 2,
    crf: 21, audioBitrate: 160, sampleRate: 48000, verticalW: 720, verticalH: 1280, intermediateMbps: 0,
  },
  platforms: [
    { id: 'youtube', kind: 'youtube', name: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', enabled: true, orientation: 'landscape' },
    { id: 'facebook', kind: 'facebook', name: 'Facebook', server: 'rtmps://live-api-s.facebook.com:443/rtmp/', enabled: false, orientation: 'landscape' },
    { id: 'tiktok', kind: 'tiktok', name: 'TikTok', server: '', enabled: false, orientation: 'vertical' },
    { id: 'instagram', kind: 'instagram', name: 'Instagram', server: '', enabled: false, orientation: 'vertical' },
  ],
  record: { path: '', format: 'mkv', encoder: 'same', quality: 'high', crf: 20, audioBitrate: 192, filename: '%Y-%m-%d %H-%M-%S Service', withStream: false },
  audio: { monitorDevice: 'default' },
  transition: { type: 'fade', duration: 400, color: '#000000' },
  hotkeys: {
    goLive: 'Ctrl+Shift+L', record: 'Ctrl+Shift+R', transition: 'Ctrl+Enter', scenePrev: '', sceneNext: '',
    scene1: 'Ctrl+1', scene2: 'Ctrl+2', scene3: 'Ctrl+3', scene4: 'Ctrl+4', scene5: 'Ctrl+5', scene6: 'Ctrl+6', scene7: 'Ctrl+7', scene8: 'Ctrl+8', scene9: 'Ctrl+9',
    slideNext: 'Right', slidePrev: 'Left', black: 'B', clear: 'C', logo: 'L', streamOverlay: 'S', goLiveWorship: 'Enter',
  },
  advanced: { autoReconnect: true, retryDelay: 5, maxRetries: 20, ffmpegPath: '', globalHotkeys: false },
  worship: {
    target: 'secondary', netOutput: false, netPort: 5155, netLan: false,
    versesPerSlide: 1, verseNumbers: false, refFormat: 'full', showTranslation: true, defaultTranslation: 'KJV',
    songThemeId: 'lyrics', scriptureThemeId: 'scripture', logoPath: '', transition: 350, songLabelsOnOutput: false,
    streamOverlay: false,
  },
};

export const settings = structuredClone(DEFAULT_SETTINGS);

export async function loadSettings() {
  const saved = await window.api.store.read('settings', null);
  if (saved) {
    const merged = deepMerge(DEFAULT_SETTINGS, saved);
    // arrays replaced wholesale by deepMerge; keep saved platforms if present
    merged.platforms = saved.platforms && saved.platforms.length ? saved.platforms : DEFAULT_SETTINGS.platforms;
    Object.assign(settings, merged);
  }
  if (!settings.record.path) settings.record.path = (await window.api.paths()).videos;
  return settings;
}

const saveNow = () => window.api.store.write('settings', settings);
export const saveSettings = debounce(saveNow, 400);

// Debounced JSON persistence helper for other stores
export function persisted(name, ms = 500) {
  const fn = debounce((data) => window.api.store.write(name, data), ms);
  return fn;
}

// Current worship "live" content, consumed by the stream overlay/source
export const worshipLive = {
  slide: null, // { text, reference, label }
  mode: 'normal',
  kind: '', // 'song' | 'scripture' | 'custom' | 'media'
  theme: null,
  seq: 0,
};
