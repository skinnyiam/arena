'use client';

import { useState } from 'react';
import type { CameraMode, SeatInfo } from '@/engine/camera/CameraRig';
import type { Quality } from '@/engine/core/renderer';
import type { VenueState } from '@/engine/Engine';
import type { PlayerStatus } from '@/engine/media/youtube';
import type { Artist, CatalogTrack } from '@/engine/show/catalog';
import type { Mood } from '@/engine/show/songs';
import { PALETTES, type PaletteName } from '@/engine/core/palette';
import { TIME_PRESETS } from '@/engine/show/schedule';

const MODES: Array<{ mode: CameraMode; label: string; key: string }> = [
  { mode: 'cinematic', label: 'Cinematic', key: '1' },
  { mode: 'walk', label: 'Walk up', key: '2' },
  { mode: 'seat', label: 'Seat POV', key: '3' },
  { mode: 'orbit', label: 'Orbit', key: '4' },
  { mode: 'fly', label: 'Free fly', key: '5' },
  { mode: 'stage', label: 'On stage', key: '6' },
];

const QUALITIES: Quality[] = ['low', 'medium', 'high'];

const MOODS: Array<{ value: Mood; label: string; hint: string }> = [
  { value: 'low', label: 'Calm', hint: 'Ballad: dim, slow, thick haze' },
  { value: 'mid', label: 'Warm', hint: 'Mid-tempo: steady movement' },
  { value: 'high', label: 'Hype', hint: 'Full rig, fast, hard hits' },
];

const SPEEDS: Array<{ label: string; scale: number; title: string }> = [
  { label: 'Live', scale: 1 / 3600, title: 'Venue time runs at wall-clock speed' },
  { label: '60×', scale: 1 / 60, title: 'One venue hour per real minute' },
  { label: '300×', scale: 1 / 12, title: 'A whole venue day in five minutes' },
];

type Props = {
  hidden: boolean;

  status: PlayerStatus;
  playing: boolean;
  onPlayPause: () => void;
  volume: number;
  onVolume: (v: number) => void;

  artists: Artist[];
  artist: Artist;
  onArtist: (a: Artist) => void;
  setList: CatalogTrack[];
  trackIndex: number;
  onTrack: (i: number) => void;
  onAddTrack: (url: string) => void;
  onRemoveTrack: (id: string) => void;
  addError: string | null;
  setListOpen: boolean;
  onToggleSetList: () => void;

  bpm: number;
  offset: number;
  onTap: () => void;
  onNudgeOffset: (delta: number) => void;

  venue: VenueState | null;
  onHour: (h: number) => void;
  timeScale: number;
  onTimeScale: (s: number) => void;
  followSchedule: boolean;
  onToggleFollow: () => void;

  sectionLabel: string;
  onConfetti: () => void;
  onPyro: () => void;
  micOn: boolean;
  onToggleMic: () => void;
  quality: Quality;
  onQuality: (q: Quality) => void;

  mode: CameraMode;
  onMode: (m: CameraMode) => void;
  shot: string;
  seat: SeatInfo | null;

  fps: number;
  crowd: number;
  error: string | null;
  mood: Mood;
  onMood: (m: Mood) => void;
  palette: PaletteName;
  onPalette: (p: PaletteName) => void;
  onImmersive: () => void;
  onDismissError: () => void;
  showHint: boolean;
};

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
      <rect x="1" y="1" width="3.4" height="11" rx="1" fill="currentColor" />
      <rect x="7.6" y="1" width="3.4" height="11" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
      <path
        d="M2 1.4v10.2a1 1 0 0 0 1.53.85l8-5.1a1 1 0 0 0 0-1.7l-8-5.1A1 1 0 0 0 2 1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function Hud(p: Props) {
  const [urlDraft, setUrlDraft] = useState('');

  const statusText =
    p.status === 'error'
      ? 'Playback blocked'
      : p.status === 'loading'
        ? 'Buffering'
        : p.playing
          ? p.sectionLabel
          : (p.venue?.slot.label ?? 'Paused');

  const nowPlaying = p.setList[p.trackIndex];

  return (
    <div className={`hud${p.hidden ? ' hud--hidden' : ''}`}>
      {/* ---------------------------------------------------------- brand --- */}
      <div className="brand">
        <span className="brand__mark">Arena</span>
        <span className="badge">
          <span className={`badge__dot${p.playing ? '' : ' badge__dot--idle'}`} />
          {statusText}
        </span>
        {p.venue && (
          <span className="badge badge--clock">
            <strong>{p.venue.clockText}</strong>
            <span className="badge__sep" />
            {p.venue.slot.label}
            <span className="badge__muted">· {p.venue.slot.detail}</span>
          </span>
        )}
      </div>

      {/* ------------------------------------------------------- day bar --- */}
      {p.venue && (
        <div className="panel daybar">
          <div className="daybar__row">
            <span className="label">Venue day</span>
            <div className="daybar__spacer" />
            {SPEEDS.map((s) => (
              <button
                key={s.label}
                className="chip"
                title={s.title}
                aria-pressed={Math.abs(p.timeScale - s.scale) < 1e-9}
                onClick={() => p.onTimeScale(s.scale)}
              >
                {s.label}
              </button>
            ))}
            <button
              className="chip"
              aria-pressed={p.followSchedule}
              title="Start and stop the sets automatically, the way the venue would"
              onClick={p.onToggleFollow}
            >
              Auto
            </button>
          </div>

          <input
            className="daybar__slider"
            type="range"
            min={0}
            max={24}
            step={0.05}
            value={p.venue.hour}
            onChange={(e) => p.onHour(Number(e.target.value))}
            aria-label="Time of day"
          />

          <div className="daybar__row daybar__row--tight">
            {TIME_PRESETS.map((t) => (
              <button key={t.label} className="chip chip--ghost" onClick={() => p.onHour(t.hour)}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="daybar__meta">
            <span>{Math.round(p.venue.occupancy * 100)}% full</span>
            <span>{p.venue.slot.phase === 'closed' ? 'closed' : `next in ${p.venue.minutesToNext}m`}</span>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- camera --- */}
      <div className="panel rail">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className="rail__btn"
            aria-pressed={p.mode === m.mode}
            onClick={() => p.onMode(m.mode)}
          >
            {m.label}
            <span className="rail__key">{m.key}</span>
          </button>
        ))}
        {p.mode === 'cinematic' && p.shot && (
          <div className="label" style={{ padding: '6px 12px 2px' }}>
            {p.shot}
          </div>
        )}
        {p.mode === 'fly' && (
          <div className="label" style={{ padding: '6px 12px 2px', lineHeight: 1.6 }}>
            WASD · Q/E · Shift
          </div>
        )}
        {p.mode === 'walk' && (
          <div className="label" style={{ padding: '6px 12px 2px', lineHeight: 1.6 }}>
            WASD to walk · Shift to run
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------- seat --- */}
      {p.seat && (p.mode === 'seat' || p.mode === 'stage') && !p.setListOpen && (
        <div className="panel seat">
          <div className="label">Your seat</div>
          <div className="seat__label">{p.seat.label}</div>
          <div className="seat__meta">
            <span>{p.seat.distance} m to stage</span>
            <span>{p.seat.height} m up</span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- setlist --- */}
      {p.setListOpen && (
        <div className="panel setlist">
          <div className="setlist__head">
            <div>
              <div className="label">Set list</div>
              <div className="setlist__artist">{p.artist.name}</div>
            </div>
            <button className="btn btn--ghost" onClick={p.onToggleSetList} aria-label="Close">
              ×
            </button>
          </div>

          <ol className="setlist__items">
            {p.setList.map((t, i) => (
              <li key={t.id} className={i === p.trackIndex ? 'is-current' : undefined}>
                <button className="setlist__play" onClick={() => p.onTrack(i)}>
                  <span className="setlist__num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="setlist__title">{t.title}</span>
                  <span className="setlist__bpm">{t.bpm}</span>
                </button>
                {t.custom && (
                  <button
                    className="setlist__remove"
                    onClick={() => p.onRemoveTrack(t.id)}
                    aria-label={`Remove ${t.title}`}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
            {!p.setList.length && <li className="setlist__empty">No tracks yet — add one below.</li>}
          </ol>

          <form
            className="setlist__add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!urlDraft.trim()) return;
              p.onAddTrack(urlDraft);
              setUrlDraft('');
            }}
          >
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="Paste a YouTube link to add"
              aria-label="Add track by URL"
              spellCheck={false}
            />
            <button type="submit" className="btn">
              Add
            </button>
          </form>
          {p.addError && <div className="setlist__err">{p.addError}</div>}
          <div className="setlist__note">
            Added tracks are saved in this browser. Use <strong>Tap</strong> and the offset nudge to
            lock the light show to the beat.
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ transport --- */}
      <div className="panel bar">
        <div className="bar__group">
          <button
            className="btn btn--primary"
            onClick={p.onPlayPause}
            aria-label={p.playing ? 'Pause' : 'Play'}
          >
            <PlayIcon playing={p.playing} />
          </button>

          <select
            className="select"
            value={p.artist.id}
            onChange={(e) => {
              const a = p.artists.find((x) => x.id === e.target.value);
              if (a) p.onArtist(a);
            }}
            aria-label="Artist"
          >
            {p.artists.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <button
            className={`btn ${p.setListOpen ? 'btn--on' : 'btn--ghost'}`}
            onClick={p.onToggleSetList}
            title="Set list (L)"
          >
            Set list
            {nowPlaying && <span className="btn__sub">{nowPlaying.title}</span>}
          </button>

          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.volume}
            onChange={(e) => p.onVolume(Number(e.target.value))}
            aria-label="Volume"
          />
        </div>

        <div className="bar__div" />

        {/* Tempo lock — the control that makes an arbitrary track work: tap
            four beats and the whole light show falls into place. */}
        <div className="bar__group">
          <div className="tempo">
            <strong>{p.bpm.toFixed(1)}</strong> BPM
          </div>
          <button className="btn btn--ghost" onClick={p.onTap} title="Tap four beats (T)">
            Tap
          </button>
          <div className="tempo">
            offset{' '}
            <strong>
              {p.offset >= 0 ? '+' : ''}
              {p.offset.toFixed(2)}s
            </strong>
            <span className="stepper">
              <button onClick={() => p.onNudgeOffset(-0.05)} aria-label="Nudge earlier">
                −
              </button>
              <button onClick={() => p.onNudgeOffset(0.05)} aria-label="Nudge later">
                +
              </button>
            </span>
          </div>
        </div>

        <div className="bar__div" />

        {/* Lighting design. Mood is inferred from tempo but overridable — a
            slow track gets dim, unhurried light; a banger gets the full rig. */}
        <div className="bar__group">
          <div className="tempo" title="How hard the lighting rig works">
            {MOODS.map((m) => (
              <button
                key={m.value}
                className="chip"
                aria-pressed={p.mood === m.value}
                onClick={() => p.onMood(m.value)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
          <select
            className="select"
            style={{ maxWidth: 108 }}
            value={p.palette}
            onChange={(e) => p.onPalette(e.target.value as PaletteName)}
            aria-label="Lighting palette"
            title="Gel colours for the rig"
          >
            {(Object.keys(PALETTES) as PaletteName[]).map((name) => (
              <option key={name} value={name}>
                {name[0].toUpperCase() + name.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="bar__div" />

        <div className="bar__group">
          <button className="btn btn--ghost" onClick={p.onConfetti} title="Confetti (C)">
            Confetti
          </button>
          <button className="btn btn--ghost" onClick={p.onPyro} title="Pyro (P)">
            Pyro
          </button>
          <button
            className={`btn ${p.micOn ? 'btn--on' : 'btn--ghost'}`}
            onClick={p.onToggleMic}
            title="Let the microphone drive the show from the room"
          >
            Listen
          </button>
          <button
            className="btn btn--ghost"
            onClick={p.onImmersive}
            title="Hide every control for an uninterrupted view (H)"
          >
            Immersive
          </button>
          <select
            className="select"
            style={{ maxWidth: 110 }}
            value={p.quality}
            onChange={(e) => p.onQuality(e.target.value as Quality)}
            aria-label="Quality"
          >
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {q[0].toUpperCase() + q.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="stats">
        <span>{p.fps} fps</span>
        <span>{p.crowd.toLocaleString()} in attendance</span>
        <span>H to hide</span>
      </div>

      {p.error ? (
        <div className="toast" role="alert">
          <span>{p.error}</span>
          <button onClick={p.onDismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : (
        p.showHint && <div className="hint">Click any seat to sit there · drag to look around</div>
      )}
    </div>
  );
}
