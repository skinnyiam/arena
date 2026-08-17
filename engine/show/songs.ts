import type { PaletteName } from '@/engine/core/palette';

/** The named lighting states the director knows how to render. */
export type LookName =
  | 'blackout'
  /** Working light: the venue lit for people to find their seats. */
  | 'house'
  | 'ambient'
  | 'intro'
  | 'verse'
  | 'build'
  | 'drop'
  | 'chorus'
  | 'breakdown'
  | 'ballad'
  | 'outro';

export type Section = {
  /** Bar this section starts on. */
  bar: number;
  look: LookName;
  /** 0..1 — drives beam brightness, crowd motion, haze, camera shake. */
  energy: number;
  /** 0..1 — fraction of the crowd with phones up. */
  phones?: number;
  palette?: PaletteName;
  lasers?: boolean;
  strobe?: boolean;
  /** One-shots fired on the section's first bar. */
  confetti?: boolean;
  pyro?: boolean;
  label?: string;
};

/**
 * How the room should feel. A ballad and a banger want opposite venues, not the
 * same venue at different brightness — pace, colour, haze and how much the
 * crowd moves all shift together.
 */
export type Mood = 'low' | 'mid' | 'high';

export type Song = {
  /** YouTube video id. */
  id: string;
  title: string;
  artist: string;
  bpm: number;
  /** Seconds from the start of the video to the first musical downbeat. */
  offset: number;
  palette: PaletteName;
  /** Optional hand-authored cue sheet; falls back to `defaultArc()`. */
  arc?: Section[];
  /** Overrides the tempo-derived guess. */
  mood?: Mood;
};

/** Tempo is a decent proxy when a track hasn't been given a mood by hand. */
export function moodFor(song: { bpm: number; mood?: Mood }): Mood {
  if (song.mood) return song.mood;
  if (song.bpm < 95) return 'low';
  if (song.bpm > 122) return 'high';
  return 'mid';
}

/**
 * A generic stadium set arc. Any pasted URL gets this, and it holds up
 * surprisingly well because it follows the 8-bar phrase grammar almost all
 * popular music shares. Hand-author `arc` per song to make it exact.
 */
export function defaultArc(): Section[] {
  return [
    { bar: 0, look: 'intro', energy: 0.22, phones: 0.55, label: 'Intro' },
    { bar: 8, look: 'verse', energy: 0.42, label: 'Verse' },
    { bar: 16, look: 'build', energy: 0.66, label: 'Build' },
    { bar: 24, look: 'drop', energy: 1.0, lasers: true, confetti: true, label: 'Drop' },
    { bar: 40, look: 'chorus', energy: 0.86, lasers: true, label: 'Chorus' },
    { bar: 48, look: 'verse', energy: 0.5, label: 'Verse' },
    { bar: 56, look: 'build', energy: 0.74, strobe: true, label: 'Build' },
    { bar: 64, look: 'drop', energy: 1.0, lasers: true, pyro: true, label: 'Drop' },
    { bar: 80, look: 'breakdown', energy: 0.3, phones: 0.8, label: 'Breakdown' },
    { bar: 88, look: 'ballad', energy: 0.24, phones: 0.95, label: 'Ballad' },
    { bar: 96, look: 'build', energy: 0.8, strobe: true, label: 'Build' },
    { bar: 104, look: 'drop', energy: 1.0, lasers: true, confetti: true, pyro: true, label: 'Drop' },
    { bar: 120, look: 'chorus', energy: 0.9, lasers: true, label: 'Final chorus' },
    { bar: 136, look: 'outro', energy: 0.38, phones: 0.7, label: 'Outro' },
  ];
}

/** Bar the arc runs out at; used to loop long tracks without going static. */
const ARC_END = 152;
const LOOP_FROM = 8;

export function resolveArc(song: Song): Section[] {
  return song.arc && song.arc.length ? [...song.arc].sort((a, b) => a.bar - b.bar) : defaultArc();
}

/**
 * Section covering `bar`. Past the end of the arc we fold back to bar 8 so a
 * seven-minute track keeps cycling verses, builds and drops instead of holding
 * one look forever.
 */
export function sectionAt(arc: Section[], bar: number): Section {
  let b = bar;
  if (b >= ARC_END) b = LOOP_FROM + ((b - LOOP_FROM) % (ARC_END - LOOP_FROM));
  let found = arc[0];
  for (const s of arc) {
    if (s.bar <= b) found = s;
    else break;
  }
  return found;
}

/** Index of the section covering `bar`, so callers can detect transitions. */
export function sectionIndexAt(arc: Section[], bar: number): number {
  let b = bar;
  if (b >= ARC_END) b = LOOP_FROM + ((b - LOOP_FROM) % (ARC_END - LOOP_FROM));
  let idx = 0;
  for (let i = 0; i < arc.length; i++) {
    if (arc[i].bar <= b) idx = i;
    else break;
  }
  return idx;
}

/**
 * Curated starters.
 *
 * NOTE: video ids and BPMs are a starting point — verify them, and expect the
 * odd one to be un-embeddable depending on region and rights holder. The HUD's
 * tap-tempo and offset nudge exist precisely so you can lock any track by ear
 * in a few seconds, then paste the numbers back in here.
 */
export const SONGS: Song[] = [
  {
    id: '60ItHLz5WEA',
    title: 'Faded',
    artist: 'Alan Walker',
    bpm: 90,
    offset: 0.0,
    palette: 'ice',
  },
  {
    id: '9bZkp7q19f0',
    title: 'Gangnam Style',
    artist: 'PSY',
    bpm: 132,
    offset: 0.0,
    palette: 'acid',
  },
  {
    id: 'kJQP7kiw5Fk',
    title: 'Despacito',
    artist: 'Luis Fonsi & Daddy Yankee',
    bpm: 89,
    offset: 0.0,
    palette: 'sunset',
  },
  {
    id: 'JGwWNGJdvx8',
    title: 'Shape of You',
    artist: 'Ed Sheeran',
    bpm: 96,
    offset: 0.0,
    palette: 'royal',
  },
  {
    id: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    bpm: 113,
    offset: 0.0,
    palette: 'neon',
  },
];

/** Pull a video id out of anything a user is likely to paste. */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // /embed/ID, /live/ID, /shorts/ID
      const m = url.pathname.match(/\/(embed|live|shorts|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    /* not a URL */
  }
  return null;
}
