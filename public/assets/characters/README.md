# Characters

Rigged human bodies. Drop files here, list the filenames in `index.json`:

```json
["woman-a.fbx", "man-b.fbx", "woman-c.fbx"]
```

**`.fbx` and `.glb` both work** — the engine picks the loader from the
extension. Mixamo only exports FBX, so FBX is the normal case.

Scale doesn't matter. Mixamo exports in centimetres (a character ~180 units
tall); the engine measures each body and rescales it to 1.76m.

Six to eight bodies is plenty — variety comes mostly from clothing colour and
animation timing, not model count.

## Getting them from Mixamo (free)

1. <https://www.mixamo.com> → **Sign in** (top right) → an Adobe ID.
   Free, no Creative Cloud subscription needed.
2. **CHARACTERS** tab → pick a body → **DOWNLOAD** (top right).
3. Format **FBX Binary (.fbx)**, Pose **T-pose**.
4. Save the file here, add its filename to `index.json`.

Any rigged FBX or glTF works. Mixamo bodies are recommended because they share
a skeleton with the clip library in `../animations`.

For more photoreal bodies, **Ready Player Me** exports glTF avatars on the same
Mixamo skeleton, so they work with the identical clips.

Until at least one file is listed here, the venue falls back to the single CC0
character in `../kit/basic/character-soldier.glb`.
