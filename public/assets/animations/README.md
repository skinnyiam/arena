# Animations

Animation-only exports, shared by every character. List them in `index.json`:

```json
["dancing.fbx", "cheering.fbx", "talking.fbx", "drinking.fbx", "idle.fbx"]
```

**`.fbx` and `.glb` both work.** Mixamo exports FBX.

## Why these are separate from the characters

Every Mixamo rig uses the same bone names (`mixamorig:Hips`, `mixamorig:Spine`,
…), so a clip exported against one character drives all of them. One download
of "Hip Hop Dancing" animates the entire crowd.

## Getting them from Mixamo

1. <https://www.mixamo.com> → **Sign in** with your Adobe ID.
2. **ANIMATIONS** tab → search for the motion → click it to preview.
3. **DOWNLOAD** → Format **FBX Binary (.fbx)**, Skin **Without Skin**.
   Tick **In Place** for anything done standing still, or the character
   will drift away from their seat.
4. Save here, add the filename to `index.json`.

## What the crowd asks for

Clips are matched to roles by substring, against both the clip name and the
filename — so naming the file `dancing.fbx` is enough.

| Role  | Matches                                         |
|-------|-------------------------------------------------|
| dance | dance, dancing, hip hop, shuffle, twist, groove  |
| cheer | cheer, clap, applaud, excited, jump              |
| talk  | talk, conversation, argu                         |
| drink | drink, sipping, bottle                           |
| idle  | idle, breathing, stand                           |
| walk  | walk                                             |
| sit   | sit                                              |

Starter set: *Hip Hop Dancing*, *Cheering*, *Clapping*, *Talking*, *Drinking*,
*Standing Idle*.
