# arena

A 3D concert venue in the browser. You arrive on foot, walk in through the
gates, take a seat, and a lighting show plays to whatever track you choose.

Next.js 16 · TypeScript · three.js

```bash
npm install
npm run dev        # http://localhost:3000
```

## What's here

| Area | Notes |
|---|---|
| Venue | Procedural bowl — three seating decks, ribbon boards, roof, stage, thrust and B-stage |
| Lighting rig | 74 moving heads, volumetric beams, lasers, blinders, strobes, LED walls |
| Show director | Cue-sheet arc (intro → build → drop → breakdown) locked to a beat clock |
| Time of day | Authored sky keyframes from midnight to dusk, with sun, shadows and cloud deck |
| Crowd | Up to 44,000 instanced attendees; the nearest few dozen are swapped for rigged, animated characters |
| Approach | Street, car park and forecourt built from CC0 models on a tile grid |
| Audio | Hidden YouTube player for music, plus synthesised footsteps and crowd murmur |

## The one constraint that shapes everything

The music plays in a **cross-origin YouTube iframe**, so its samples never
reach the Web Audio API. There is no FFT and no way to attach a panner.

Consequences:

- The light show runs off a **beat clock** — BPM plus a downbeat offset, phase-locked
  to the player's `getCurrentTime()` (which only updates ~4×/second). Tap-tempo and
  offset nudge in the HUD let you lock any track by ear.
- "Music gets louder as you approach" is done by driving the player's own volume
  from your distance to the building. It can't reproduce direction or muffling.
- For genuine audio reactivity, the **Listen** button taps the microphone, which
  hears the room and drives the show from the actual mix.

## Assets

Props and the fallback character are CC0 (Kenney), committed under
`public/assets/kit/`. Each kit lives in its own folder **with its own
`Textures/colormap.png`** — these models carry no vertex colour, so a missing or
wrong colormap renders everything pure white.

Better characters are a drop-in, no code change:

```
public/assets/characters/   rigged bodies  + index.json
public/assets/animations/   shared clips   + index.json
```

`.fbx` and `.glb` both load. Scale is measured per file and normalised, so
Mixamo's centimetre exports need no adjustment. Every Mixamo rig shares bone
names, so one clip exported *Without Skin* animates every character. See the
README in each folder.

## Controls

`1`–`6` camera modes · `Space` play/pause · click to travel · drag to look ·
`WASD` walk, `Shift` run · `T` tap tempo · `L` set list · `C`/`P` confetti/pyro ·
`H` hide the interface · `Y` reveal the audio player
