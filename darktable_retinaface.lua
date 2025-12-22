-- darktable_retinaface.lua
-- Skeleton Darktable Lua plugin to call the Python RetinaFace detector
-- and act on detectors' JSON output.
--
-- INSTALL: copy this file to ~/.config/darktable/lua/ and edit PYTHON_CMD
-- then restart darktable.

local dt = require "darktable"
local io = require "io"
local os = require "os"

-- Configure: point to your Python executable and main.py
local PYTHON_CMD = '/home/fickdichweg/#things/VSC/blur/.venv/bin/python'
local PYTHON_SCRIPT = '/home/fickdichweg/#things/VSC/blur/main.py'
local BACKUP_DIR = '/home/fickdichweg/#things/VSC/blur/backups_refs'

local gettext = dt.gettext
local function _(s) return s end

-- Utility: run external python and capture stdout
local function run_detector_and_get_json(image_path)
  local cmd = string.format('"%s" "%s" "%s" --min-conf 0.35 --json', PYTHON_CMD, PYTHON_SCRIPT, image_path)
  local f = io.popen(cmd)
  if not f then return nil, 'popen failed' end
  local out = f:read('*a')
  local ok, status, code = f:close()
  return out
end

-- Minimal JSON parser to extract simple bbox lists (avoid dependencies)
-- Expects JSON like: [{"bbox":[x1,y1,x2,y2],"score":0.9}, ...]
local function simple_parse_json_list(s)
  local results = {}
  if not s or s == '' then return results end
  -- a very small JSON parser for this constrained output
  for obj in s:gmatch('{[^}]+}') do
    local bbox = obj:match('"bbox"%s*:%s*%[([^%]]+)%]')
    local score = obj:match('"score"%s*:%s*([0-9%.eE+-]+)')
    if bbox then
      local nums = {}
      for n in bbox:gmatch('([^,]+)') do
        table.insert(nums, tonumber(n))
      end
      table.insert(results, { bbox = nums, score = tonumber(score) or 0.0 })
    end
  end
  return results
end

-- Main action: run on selected images
local function do_detect_for_selection()
  local sel = dt.gui.selection()
  if not sel or #sel == 0 then
    dt.print(_('No images selected'))
    return
  end
  for _,image in ipairs(sel) do
    local path = image.path .. '/' .. image.filename
    dt.print(string.format('Running detector on %s', path))
    local out = run_detector_and_get_json(path)
    if not out or out == '' then
      dt.print('Detector returned no output for '..path)
    else
      local dets = simple_parse_json_list(out)
      dt.print(string.format('Found %d detections', #dets))
      -- NOTE: here we would call Darktable mask creation API to create ellipse masks
      -- The exact functions vary by Darktable version. To avoid damaging XMP,
      -- we currently call the external writer as fallback:
      -- write JSON to a temp file then call apply_json_to_xmp.py to safely insert masks
      local tmpjson = os.tmpname()
      local cmd_json = string.format('"%s" "%s" "%s" --min-conf 0.35 --json-file "%s"', PYTHON_CMD, PYTHON_SCRIPT, path, tmpjson)
      os.execute(cmd_json)
      -- call helper to apply JSON into XMP
      local apply_script = '/home/fickdichweg/#things/VSC/blur/apply_json_to_xmp.py'
      local cmd_apply = string.format('"%s" "%s" "%s" "%s" --backup-dir "%s"', PYTHON_CMD, apply_script, path, tmpjson, BACKUP_DIR)
      os.execute(cmd_apply)
      dt.print('Wrote masks via helper script for '..path)
      -- remove tmp file if exists
      os.remove(tmpjson)
    end
  end
  dt.print(_('Face detection complete; reload images if needed.'))
end

-- Register a menu item under the 'Image' menu
dt.register_lib_shortcut('retinaface.detect_selected', 'RetinaFace detect selected images', do_detect_for_selection)

-- end of plugin
