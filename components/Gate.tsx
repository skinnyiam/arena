'use client';

import type { Artist } from '@/engine/show/catalog';

type Props = {
  artists: Artist[];
  selectedId: string;
  onSelect: (artist: Artist) => void;
  onEnter: () => void;
  leaving: boolean;
  busy: boolean;
};

/**
 * Entry overlay. It exists for a hard technical reason as well as an
 * atmospheric one: browsers will not start unmuted audio without a user
 * gesture, so the show has to begin with a deliberate click.
 */
export default function Gate({ artists, selectedId, onSelect, onEnter, leaving, busy }: Props) {
  const selected = artists.find((a) => a.id === selectedId);

  return (
    <div className={`gate${leaving ? ' gate--leaving' : ''}`}>
      <div className="gate__kicker">Tonight at the arena</div>
      <h1 className="gate__title">
        Doors at 15:30.
        <br />
        Headliner at 20:30.
      </h1>
      <p className="gate__sub">
        A 62,000-seat stadium that runs on its own clock — sunrise to load-out, filling as the
        afternoon goes, dark by the time the headline set starts. Pick who&apos;s playing, then sit
        wherever you like.
      </p>

      <div className="gate__songs">
        {artists.map((a) => (
          <button
            key={a.id}
            className="song"
            aria-pressed={a.id === selectedId}
            onClick={() => onSelect(a)}
          >
            <div className="song__title">{a.name}</div>
            <div className="song__artist">{a.tagline}</div>
          </button>
        ))}
      </div>

      <button className="btn btn--primary gate__enter" onClick={onEnter} disabled={busy}>
        {busy ? 'Cueing…' : `Enter the arena`}
      </button>

      <p className="gate__note">
        {selected ? `${selected.name} headlines. ` : ''}
        The track streams from a hidden YouTube player, whose audio can&apos;t be read back for
        analysis — so the light show runs off a beat clock locked to the player&apos;s time. Build
        the set list by pasting links once you&apos;re inside, and use <code>Tap</code> to lock the
        tempo by ear.
      </p>
    </div>
  );
}
