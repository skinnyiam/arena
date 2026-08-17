/**
 * Hidden YouTube player used purely as an audio transport.
 *
 * Constraints that shaped this file:
 *  - The iframe is cross-origin, so there is no route to the samples. No FFT.
 *    `getCurrentTime()` is the only signal we get, and it updates at ~4Hz.
 *  - `display:none` / zero-size iframes get playback-throttled by some browsers,
 *    so the player is kept laid out at a real size and hidden behind the canvas.
 *  - Unmuted playback requires a user gesture, hence the entry gate in the UI.
 *  - Plenty of videos disable embedding; `onError` surfaces that to the HUD
 *    instead of leaving the show silently dark.
 */

type YTPlayer = {
  loadVideoById: (id: string) => void;
  cueVideoById: (id: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (s: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setVolume: (v: number) => void;
  unMute: () => void;
  isMuted: () => boolean;
  getPlayerState: () => number;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: unknown) => YTPlayer;
      PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type YouTubeAudioEvents = {
  onStatus?: (status: PlayerStatus) => void;
  onError?: (message: string) => void;
  onDuration?: (seconds: number) => void;
  /** We asked to play and nothing happened — almost always autoplay policy. */
  onBlocked?: () => void;
};

const API_SRC = 'https://www.youtube.com/iframe_api';
let apiPromise: Promise<void> | null = null;

/** Load the IFrame API exactly once per page, whoever asks first. */
function loadApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${API_SRC}"]`);
    if (!existing) {
      const s = document.createElement('script');
      s.src = API_SRC;
      s.async = true;
      s.onerror = () => reject(new Error('Could not reach the YouTube IFrame API.'));
      document.head.appendChild(s);
    }
    // The API script is small but a blocked network shouldn't hang us forever.
    window.setTimeout(() => {
      if (!window.YT?.Player) reject(new Error('YouTube IFrame API timed out.'));
    }, 12000);
  });
  return apiPromise;
}

const ERRORS: Record<number, string> = {
  2: 'That video id looks malformed.',
  5: 'The HTML5 player could not load this video.',
  100: 'Video not found — it may be private or deleted.',
  101: 'The rights holder disabled embedded playback for this video.',
  150: 'The rights holder disabled embedded playback for this video.',
};

export class YouTubeAudio {
  private player: YTPlayer | null = null;
  private events: YouTubeAudioEvents;
  private pendingId: string | null = null;
  private wantPlay = false;
  private blockedTimer: number | null = null;
  /** Volume requested before the player exposed its methods. */
  private pendingVolume: number | null = null;
  status: PlayerStatus = 'idle';
  ready = false;

  constructor(events: YouTubeAudioEvents = {}) {
    this.events = events;
  }

  /**
   * @param initialVideoId REQUIRED. The IFrame API builds the embed URL at
   * construction time; passing no videoId yields an iframe with an empty src
   * that never fires `onReady`, so `ready` stays false and every subsequent
   * load() silently parks the id and plays nothing. This cost an evening.
   */
  async mount(host: HTMLElement, initialVideoId: string) {
    await loadApi();
    if (!window.YT?.Player) throw new Error('YouTube API unavailable');
    if (!this.pendingId) this.pendingId = initialVideoId;

    await new Promise<void>((resolve) => {
      const inner = document.createElement('div');
      host.appendChild(inner);

      this.player = new window.YT!.Player(inner, {
        width: 320,
        height: 180,
        videoId: this.pendingId ?? initialVideoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          fs: 0,
          iv_load_policy: 3,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            if (this.pendingVolume !== null && typeof this.player?.setVolume === 'function') {
              this.player.setVolume(this.pendingVolume);
              this.pendingVolume = null;
            }
            // A track may have been requested while the API was still loading.
            // The player was constructed without a videoId, so apply it now —
            // otherwise `playVideo()` fires at an empty player and stays silent.
            if (this.pendingId && this.wantPlay) {
              this.setStatus('loading');
              this.player!.loadVideoById(this.pendingId);
              this.unmute();
              this.armBlockedCheck();
            }
            const d = this.player?.getDuration?.() ?? 0;
            if (d) this.events.onDuration?.(d);
            resolve();
          },
          onStateChange: (e: { data: number }) => {
            const S = window.YT!.PlayerState;
            const next: PlayerStatus =
              e.data === S.PLAYING
                ? 'playing'
                : e.data === S.PAUSED
                  ? 'paused'
                  : e.data === S.ENDED
                    ? 'ended'
                    : e.data === S.BUFFERING
                      ? 'loading'
                      : this.status === 'error'
                        ? 'error'
                        : 'idle';
            this.setStatus(next);
            if (e.data === S.PLAYING) {
              this.clearBlockedCheck();
              const d = this.player?.getDuration?.() ?? 0;
              if (d) this.events.onDuration?.(d);
            }
          },
          onError: (e: { data: number }) => {
            this.setStatus('error');
            this.events.onError?.(ERRORS[e.data] ?? `Playback error (${e.data}).`);
          },
        },
      });
    });
  }

  private setStatus(s: PlayerStatus) {
    if (s === this.status) return;
    this.status = s;
    this.events.onStatus?.(s);
  }

  /** A muted player reports "playing" perfectly happily while making no sound. */
  private unmute() {
    try {
      if (this.player?.isMuted?.()) this.player.unMute();
    } catch {
      /* older player shim */
    }
  }

  /**
   * Autoplay policies fail silently: the call returns, no error fires, and the
   * player simply never starts. Watch for that and tell the user to press play.
   */
  private armBlockedCheck() {
    this.clearBlockedCheck();
    this.blockedTimer = window.setTimeout(() => {
      if (this.wantPlay && this.status !== 'playing' && this.status !== 'loading') {
        this.events.onBlocked?.();
      }
    }, 2600);
  }

  private clearBlockedCheck() {
    if (this.blockedTimer !== null) {
      window.clearTimeout(this.blockedTimer);
      this.blockedTimer = null;
    }
  }

  load(id: string, autoplay = true) {
    this.pendingId = id;
    this.wantPlay = autoplay;
    if (!this.player || !this.ready) return; // applied in onReady
    this.setStatus('loading');
    if (autoplay) {
      this.player.loadVideoById(id);
      this.unmute();
      this.armBlockedCheck();
    } else {
      this.player.cueVideoById(id);
    }
  }

  play() {
    this.wantPlay = true;
    if (!this.player || !this.ready || typeof this.player.playVideo !== 'function') return;
    if (this.pendingId && (this.status === 'idle' || this.status === 'error')) {
      // Nothing playable cued yet: load rather than play into the void.
      this.load(this.pendingId, true);
      return;
    }
    this.unmute();
    this.player.playVideo();
    this.armBlockedCheck();
  }

  pause() {
    this.wantPlay = false;
    this.clearBlockedCheck();
    if (typeof this.player?.pauseVideo === 'function') this.player.pauseVideo();
  }

  seek(seconds: number) {
    this.player?.seekTo(Math.max(0, seconds), true);
  }

  /**
   * 0..1. The proximity mixer starts pushing volume from the first frame, but
   * a freshly-constructed YT.Player object has no methods on it until the
   * iframe handshake completes — calling setVolume before then throws. Park it.
   */
  setVolume(v: number) {
    const level = Math.round(Math.max(0, Math.min(1, v)) * 100);
    const p = this.player;
    if (!p || !this.ready || typeof p.setVolume !== 'function') {
      this.pendingVolume = level;
      return;
    }
    p.setVolume(level);
  }

  get time(): number {
    try {
      if (!this.ready) return 0;
      return this.player?.getCurrentTime?.() ?? 0;
    } catch {
      return 0;
    }
  }

  get duration(): number {
    try {
      return this.player?.getDuration?.() ?? 0;
    } catch {
      return 0;
    }
  }

  dispose() {
    this.clearBlockedCheck();
    try {
      this.player?.destroy();
    } catch {
      /* iframe already gone */
    }
    this.player = null;
    this.ready = false;
  }
}
