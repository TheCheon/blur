RetinaFace → Darktable integration (hybrid)

Overview
- Python: `main.py` now supports `--json` / `--json-file` to emit detections as JSON.
- Lua: a plugin skeleton (`darktable_retinaface.lua`) is provided to call the Python detector and then trigger XMP updates.

Why hybrid
- Python runs RetinaFace (heavy ML) and returns bbox+score JSON.
- Lua (in Darktable) can call Python, then use the Darktable API to create drawn masks and link them to a censorize module — this keeps XMP consistent.

Files
- `main.py` — detector; use `--json` to print JSON to stdout.
- `darktable_retinaface.lua` — plugin skeleton. Place in `~/.config/darktable/lua/` and adapt `PYTHON_CMD` path.

Example Python usage

```bash
# activate virtualenv (example)
source .venv/bin/activate

# print JSON to stdout
./main.py imgs/tmp/DSCF1372.JPG --min-conf 0.35 --json

# write JSON to file
./main.py imgs/tmp/DSCF1372.JPG --min-conf 0.35 --json-file /tmp/dets.json
```

Installing Lua plugin
1. Copy `darktable_retinaface.lua` to `~/.config/darktable/lua/`.
2. Edit `PYTHON_CMD` at top of the file to point to your venv Python and `main.py` path.
3. Restart darktable.

Notes
- The Lua plugin provided is a tested skeleton that shells out to Python and reads JSON. Creating masks via the Darktable Lua API can differ between DT versions; the plugin includes guidance and safe fallbacks.
- If you want, I can now adapt the plugin to use the exact mask-creation API once you confirm your darktable version (or let me try to detect it), then test live in your environment.
