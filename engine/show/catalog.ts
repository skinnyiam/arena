import type { PaletteName } from '@/engine/core/palette';
import type { Section, Song } from './songs';

/**
 * The artist catalogue.
 *
 * Picking an artist should play that artist's set and nothing else, with the
 * light show cued to each track — which needs BPM and a downbeat offset per
 * song, and ideally a hand-authored arc. None of that can be derived from a
 * YouTube URL, so the catalogue is curated data.
 *
 * The shipped set lists are deliberately short. Rather than pad them with video
 * ids I can't verify, the app lets you build a set list by pasting links; those
 * additions persist per artist in localStorage and sit alongside the curated
 * tracks. Tap-tempo locks the beat grid in a few seconds.
 */
export type CatalogTrack = {
  /** YouTube video id. */
  id: string;
  title: string;
  bpm: number;
  /** Seconds from the start of the video to the first musical downbeat. */
  offset: number;
  palette?: PaletteName;
  arc?: Section[];
  /** Added by the user at runtime rather than shipped with the app. */
  custom?: boolean;
};

export type Artist = {
  id: string;
  name: string;
  tagline: string;
  palette: PaletteName;
  tracks: CatalogTrack[];
};

/**
 * NOTE: verify these ids and tempos against the real videos before shipping —
 * embedding permissions and regional availability both vary, and a wrong BPM
 * is immediately obvious in the light show. The HUD's Tap and offset controls
 * exist to correct any of it live.
 */
export const ARTISTS: Artist[] = [
  {
    id: 'alan-walker',
    name: 'Alan Walker',
    tagline: 'Melodic house · masked',
    palette: 'ice',
    tracks: [{ id: '60ItHLz5WEA', title: 'Faded', bpm: 90, offset: 0 }],
  },
  {
    id: 'psy',
    name: 'PSY',
    tagline: 'K-pop · maximum confetti',
    palette: 'acid',
    tracks: [{ id: '9bZkp7q19f0', title: 'Gangnam Style', bpm: 132, offset: 0 }],
  },
  {
    id: 'luis-fonsi',
    name: 'Luis Fonsi',
    tagline: 'Latin pop · golden hour',
    palette: 'sunset',
    tracks: [{ id: 'kJQP7kiw5Fk', title: 'Despacito', bpm: 89, offset: 0 }],
  },
  {
    id: 'ed-sheeran',
    name: 'Ed Sheeran',
    tagline: 'One man, one loop pedal',
    palette: 'royal',
    tracks: [{ id: 'JGwWNGJdvx8', title: 'Shape of You', bpm: 96, offset: 0 }],
  },
  {
    id: 'rick-astley',
    name: 'Rick Astley',
    tagline: 'Never gonna let you down',
    palette: 'neon',
    tracks: [{ id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', bpm: 113, offset: 0 }],
  },
];

export function findArtist(id: string): Artist | undefined {
  return ARTISTS.find((a) => a.id === id);
}

/** Whoever opens for a given headliner — the next act round the catalogue. */
export function supportFor(headliner: Artist): Artist {
  const i = ARTISTS.findIndex((a) => a.id === headliner.id);
  return ARTISTS[(i + 1) % ARTISTS.length];
}

export function toSong(artist: Artist, track: CatalogTrack): Song {
  return {
    id: track.id,
    title: track.title,
    artist: artist.name,
    bpm: track.bpm,
    offset: track.offset,
    palette: track.palette ?? artist.palette,
    arc: track.arc,
  };
}

// ---------------------------------------------------------------------------
// User-built set lists
// ---------------------------------------------------------------------------

const KEY = (artistId: string) => `arena.setlist.${artistId}`;

function safeParse(raw: string | null): CatalogTrack[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is CatalogTrack =>
        !!t && typeof t === 'object' && typeof (t as CatalogTrack).id === 'string',
    );
  } catch {
    return [];
  }
}

export function loadCustomTracks(artistId: string): CatalogTrack[] {
  if (typeof window === 'undefined') return [];
  return safeParse(window.localStorage.getItem(KEY(artistId)));
}

export function saveCustomTracks(artistId: string, tracks: CatalogTrack[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY(artistId), JSON.stringify(tracks));
  } catch {
    /* private mode / quota — the set list just won't persist */
  }
}

export function addCustomTrack(artistId: string, track: CatalogTrack): CatalogTrack[] {
  const next = loadCustomTracks(artistId).filter((t) => t.id !== track.id);
  next.push({ ...track, custom: true });
  saveCustomTracks(artistId, next);
  return next;
}

export function removeCustomTrack(artistId: string, trackId: string): CatalogTrack[] {
  const next = loadCustomTracks(artistId).filter((t) => t.id !== trackId);
  saveCustomTracks(artistId, next);
  return next;
}

/** Curated tracks first, then anything the user has added. */
export function setListFor(artist: Artist): CatalogTrack[] {
  return [...artist.tracks, ...loadCustomTracks(artist.id)];
}
