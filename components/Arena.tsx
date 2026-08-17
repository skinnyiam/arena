'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Gate from './Gate';
import Hud from './Hud';
import { createEngine, type Engine, type VenueState } from '@/engine/Engine';
import type { CameraMode, SeatInfo } from '@/engine/camera/CameraRig';
import type { Quality } from '@/engine/core/renderer';
import { YouTubeAudio, type PlayerStatus } from '@/engine/media/youtube';
import { MicAnalyser } from '@/engine/show/analyser';
import { TapTempo } from '@/engine/show/clock';
import {
  addCustomTrack,
  ARTISTS,
  removeCustomTrack,
  setListFor,
  supportFor,
  toSong,
  type Artist,
  type CatalogTrack,
} from '@/engine/show/catalog';
import type { ShowSlot } from '@/engine/show/schedule';
import { moodFor, parseYouTubeId, type Mood } from '@/engine/show/songs';
import type { PaletteName } from '@/engine/core/palette';

export default function Arena() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const ytRef = useRef<YouTubeAudio | null>(null);
  const micRef = useRef<MicAnalyser | null>(null);
  const tapRef = useRef<TapTempo | null>(null);
  const volumeRef = useRef(0.85);
  /** Distance attenuation from the engine, multiplied into the master level. */
  const proximityRef = useRef(1);
  const hasSongRef = useRef(false);
  /** Engine callbacks are registered once; this keeps them off stale state. */
  const phaseHandlerRef = useRef<(slot: ShowSlot) => void>(() => {});

  const [artist, setArtist] = useState<Artist>(ARTISTS[0]);
  const [setList, setSetList] = useState<CatalogTrack[]>(() => setListFor(ARTISTS[0]));
  const [trackIndex, setTrackIndex] = useState(0);
  const [setListOpen, setSetListOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [bpm, setBpm] = useState(ARTISTS[0].tracks[0]?.bpm ?? 120);
  const [offset, setOffset] = useState(0);
  const [sectionLabel, setSectionLabel] = useState('House lights');
  const [seat, setSeat] = useState<SeatInfo | null>(null);
  const [mode, setMode] = useState<CameraMode>('cinematic');
  const [shot, setShot] = useState('');
  const [fps, setFps] = useState(0);
  const [crowd, setCrowd] = useState(0);
  const [quality, setQuality] = useState<Quality>('high');
  const [volume, setVolume] = useState(0.85);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueState | null>(null);
  const [timeScale, setTimeScale] = useState(1 / 3600);
  const [followSchedule, setFollowSchedule] = useState(true);
  const [gateOpen, setGateOpen] = useState(true);
  const [gateLeaving, setGateLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [debugPlayer, setDebugPlayer] = useState(false);
  const [propCount, setPropCount] = useState(0);
  const [enterFade, setEnterFade] = useState(false);
  const [mood, setMood] = useState<Mood>('mid');
  const [palette, setPalette] = useState<PaletteName>(ARTISTS[0].palette);

  const playing = status === 'playing';
  const supportAct = useMemo(() => supportFor(artist), [artist]);

  // ---- engine --------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = createEngine(canvas, {
      onSection: (s) => setSectionLabel(s.label ?? s.look),
      onSeat: (info) => setSeat(info),
      onMode: (m) => setMode(m),
      onShot: (name) => setShot(name),
      onStats: (f, c) => {
        setFps(f);
        setCrowd(c);
      },
      onVenue: (v) => setVenue(v),
      onPhase: (slot) => phaseHandlerRef.current(slot),
      onEnterVenue: () => {
        setEnterFade(true);
        window.setTimeout(() => {
          engineRef.current?.enterBowl();
          setSeat(null);
          window.setTimeout(() => setEnterFade(false), 120);
        }, 420);
      },
      onProximity: (v) => {
        proximityRef.current = v;
        ytRef.current?.setVolume(volumeRef.current * v);
      },
      onWorldReady: ({ props, error }) => {
        if (error) setError(`Street assets failed to load: ${error}`);
        else setPropCount(props);
      },
    });
    engineRef.current = engine;
    setVenue(engine.getVenueState());
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // ---- hidden audio transport ---------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const yt = new YouTubeAudio({
      onStatus: (s) => setStatus(s),
      onError: (m) => setError(m),
      onBlocked: () =>
        setError(
          'The browser blocked autoplay, so the track never started. Press play (or Space) to start the music — press Y to show the player if it stays silent.',
        ),
    });
    ytRef.current = yt;
    // The player must be constructed with a real video id — see YouTubeAudio.mount.
    yt.mount(host, setListFor(ARTISTS[0])[0]?.id ?? ARTISTS[0].tracks[0].id)
      .then(() => {
        if (!cancelled) yt.setVolume(volumeRef.current * proximityRef.current);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      yt.dispose();
      ytRef.current = null;
    };
  }, []);

  // ---- media → engine bridge ----------------------------------------------
  // The player's clock is polled at ~12Hz (it only updates about that often),
  // while the mic analyser needs every frame. One loop, two rates.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sinceSync = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;

      const engine = engineRef.current;
      if (!engine) return;

      const mic = micRef.current;
      if (mic?.active) {
        mic.update(dt);
        engine.setMicFeatures(mic.features);
      }

      sinceSync += dt;
      const yt = ytRef.current;
      if (yt?.ready && hasSongRef.current && sinceSync >= 0.08) {
        sinceSync = 0;
        engine.syncTime(yt.time, yt.status === 'playing');
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    engineRef.current?.setTempo(bpm, offset);
  }, [bpm, offset]);

  // ---- playback ------------------------------------------------------------
  const playSong = useCallback((a: Artist, track: CatalogTrack) => {
    const song = toSong(a, track);
    setBpm(song.bpm);
    setOffset(song.offset);
    setError(null);
    hasSongRef.current = true;
    // The track's own mood/palette become the new baseline; the HUD can still
    // override either afterwards.
    setMood(moodFor(song));
    setPalette(song.palette);
    engineRef.current?.setSong(song);
    ytRef.current?.load(song.id, true);
  }, []);

  const playTrack = useCallback(
    (i: number) => {
      const list = setList;
      if (!list.length) return;
      const idx = ((i % list.length) + list.length) % list.length;
      setTrackIndex(idx);
      playSong(artist, list[idx]);
    },
    [artist, playSong, setList],
  );

  /** Load a whole act's set from the top — used when a phase begins. */
  const startSet = useCallback(
    (act: Artist) => {
      const list = setListFor(act);
      if (!list.length) return;
      if (act.id !== artist.id) {
        setArtist(act);
        setSetList(list);
      }
      setTrackIndex(0);
      playSong(act, list[0]);
    },
    [artist.id, playSong],
  );

  // The venue schedule drives playback: sets start when the schedule says so,
  // and the music stops during the changeover. `Auto` opts out.
  phaseHandlerRef.current = (slot: ShowSlot) => {
    if (!followSchedule || gateOpen) return;
    if (slot.set === 'headliner') startSet(artist);
    else if (slot.set === 'support') startSet(supportAct);
    // Deliberately no pause on 'none' phases — house music keeps running, and
    // silence on a clock scrub reads as the app breaking, not as a changeover.
  };

  // Auto-advance through the set list.
  useEffect(() => {
    if (status !== 'ended') return;
    if (!setList.length) return;
    const next = trackIndex + 1;
    if (next < setList.length) playTrack(next);
    else ytRef.current?.pause();
  }, [status, setList.length, trackIndex, playTrack]);

  // ---- actions -------------------------------------------------------------
  const handleArtist = useCallback(
    (a: Artist) => {
      setArtist(a);
      const list = setListFor(a);
      setSetList(list);
      setTrackIndex(0);
      if (list.length && !gateOpen) playSong(a, list[0]);
    },
    [gateOpen, playSong],
  );

  const handleEnter = useCallback(() => {
    setBusy(true);
    // This click is the only user gesture we're guaranteed — both the effects
    // graph and unmuted playback depend on starting here.
    void engineRef.current?.startAudio();
    const list = setListFor(artist);
    setSetList(list);
    setTrackIndex(0);
    if (list.length) playSong(artist, list[0]);
    setGateLeaving(true);
    window.setTimeout(() => {
      setGateOpen(false);
      setBusy(false);
    }, 520);
  }, [artist, playSong]);

  const handlePlayPause = useCallback(() => {
    const yt = ytRef.current;
    if (!yt) return;
    if (!hasSongRef.current) {
      if (setList.length) playTrack(trackIndex);
      return;
    }
    if (yt.status === 'playing') yt.pause();
    else yt.play();
  }, [playTrack, setList.length, trackIndex]);

  const handleAddTrack = useCallback(
    (url: string) => {
      const id = parseYouTubeId(url);
      if (!id) {
        setAddError(`Couldn't read a video id from "${url.trim().slice(0, 48)}".`);
        return;
      }
      setAddError(null);
      // Title is unknown without the Data API, so it gets a placeholder the
      // user can live with; tempo defaults to whatever is currently dialled in.
      const track: CatalogTrack = {
        id,
        title: `Track ${setList.length + 1}`,
        bpm,
        offset: 0,
        custom: true,
      };
      addCustomTrack(artist.id, track);
      setSetList(setListFor(artist));
    },
    [artist, bpm, setList.length],
  );

  const handleRemoveTrack = useCallback(
    (id: string) => {
      removeCustomTrack(artist.id, id);
      const list = setListFor(artist);
      setSetList(list);
      setTrackIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
    },
    [artist],
  );

  const handleTap = useCallback(() => {
    if (!tapRef.current) tapRef.current = new TapTempo();
    const next = tapRef.current.tap(performance.now());
    if (next) setBpm(next);
  }, []);

  const handleNudgeOffset = useCallback((delta: number) => {
    setOffset((o) => Math.round((o + delta) * 100) / 100);
  }, []);

  const handleVolume = useCallback((v: number) => {
    volumeRef.current = v;
    setVolume(v);
    ytRef.current?.setVolume(v * proximityRef.current);
    engineRef.current?.setSfxVolume(v * 0.7);
  }, []);

  const handleToggleMic = useCallback(async () => {
    if (micRef.current?.active) {
      micRef.current.stop();
      engineRef.current?.setMicFeatures(null);
      setMicOn(false);
      return;
    }
    try {
      if (!micRef.current) micRef.current = new MicAnalyser();
      await micRef.current.start();
      setMicOn(true);
      setError(null);
    } catch (e) {
      setError(
        `Microphone unavailable: ${(e as Error).message} — the show will keep running off the beat clock.`,
      );
      setMicOn(false);
    }
  }, []);

  const handleQuality = useCallback((q: Quality) => {
    setQuality(q);
    engineRef.current?.setQuality(q);
  }, []);

  const handleMode = useCallback((m: CameraMode) => {
    engineRef.current?.setMode(m);
  }, []);

  const handleHour = useCallback((h: number) => {
    engineRef.current?.setHour(h);
  }, []);

  const handleTimeScale = useCallback((s: number) => {
    setTimeScale(s);
    engineRef.current?.setTimeScale(s);
  }, []);

  // ---- shortcuts -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const engine = engineRef.current;
      if (!engine) return;

      switch (e.code) {
        case 'Digit1': handleMode('cinematic'); break;
        case 'Digit2': handleMode('walk'); break;
        case 'Digit3': handleMode('seat'); break;
        case 'Digit4': handleMode('orbit'); break;
        case 'Digit5': handleMode('fly'); break;
        case 'Digit6': handleMode('stage'); break;
        case 'Space':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'KeyC': engine.trigger('confetti'); break;
        case 'KeyP': engine.trigger('pyro'); break;
        case 'KeyT': handleTap(); break;
        case 'KeyN': engine.nextShot(); break;
        case 'KeyL': setSetListOpen((v) => !v); break;
        case 'KeyH': setHudHidden((v) => !v); break;
        case 'Escape': setHudHidden(false); break;
        case 'KeyY': setDebugPlayer((v) => !v); break;
        case 'BracketLeft': handleNudgeOffset(-0.05); break;
        case 'BracketRight': handleNudgeOffset(0.05); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleMode, handleNudgeOffset, handlePlayPause, handleTap]);

  return (
    <div className="arena">
      <canvas ref={canvasRef} className="arena__canvas" />
      <div ref={hostRef} className={`yt-host${debugPlayer ? ' yt-host--debug' : ''}`} />
      <div className={`fade${enterFade ? ' fade--on' : ''}`} aria-hidden="true" />
      {hudHidden && <div className="ghost-hint">H to show controls</div>}

      {!gateOpen && (
        <Hud
          hidden={hudHidden}
          status={status}
          playing={playing}
          onPlayPause={handlePlayPause}
          volume={volume}
          onVolume={handleVolume}
          artists={ARTISTS}
          artist={artist}
          onArtist={handleArtist}
          setList={setList}
          trackIndex={trackIndex}
          onTrack={playTrack}
          onAddTrack={handleAddTrack}
          onRemoveTrack={handleRemoveTrack}
          addError={addError}
          setListOpen={setListOpen}
          onToggleSetList={() => setSetListOpen((v) => !v)}
          bpm={bpm}
          offset={offset}
          onTap={handleTap}
          onNudgeOffset={handleNudgeOffset}
          venue={venue}
          onHour={handleHour}
          timeScale={timeScale}
          onTimeScale={handleTimeScale}
          followSchedule={followSchedule}
          onToggleFollow={() => setFollowSchedule((v) => !v)}
          sectionLabel={sectionLabel}
          onConfetti={() => engineRef.current?.trigger('confetti')}
          onPyro={() => engineRef.current?.trigger('pyro')}
          micOn={micOn}
          onToggleMic={handleToggleMic}
          quality={quality}
          onQuality={handleQuality}
          mode={mode}
          onMode={handleMode}
          shot={shot}
          seat={seat}
          fps={fps}
          crowd={crowd}
          error={error}
          mood={mood}
          onMood={(m) => {
            setMood(m);
            engineRef.current?.setLighting({ mood: m });
          }}
          palette={palette}
          onPalette={(pal) => {
            setPalette(pal);
            engineRef.current?.setLighting({ palette: pal });
          }}
          onImmersive={() => setHudHidden(true)}
          onDismissError={() => setError(null)}
          showHint={!seat}
        />
      )}

      {gateOpen && (
        <Gate
          artists={ARTISTS}
          selectedId={artist.id}
          onSelect={handleArtist}
          onEnter={handleEnter}
          leaving={gateLeaving}
          busy={busy}
        />
      )}
    </div>
  );
}
