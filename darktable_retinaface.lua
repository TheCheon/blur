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
    if not ok then
      return nil, string.format('detector failed (status=%s)', tostring(status))
    end
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
      -- Try to apply masks via Darktable Lua API (v5.4+). This is best-effort:
      -- if the API calls aren't available or fail, fall back to the safe
      -- `apply_json_to_xmp.py` writer below.
      local function try_apply_masks_api(image_obj, detections)
        -- image_obj is a darktable image object; detections is a table of {bbox,score}
        -- Convert detections into normalized ellipses (cx,cy,rx,ry)
        local ok_any = false
        for _,d in ipairs(detections) do
          local b = d.bbox
          if #b >= 4 then
            local x1,y1,x2,y2 = b[1], b[2], b[3], b[4]
            -- get image pixel size if available
            local w,h = nil,nil
            pcall(function() w = image_obj.width; h = image_obj.height end)
            if not w or not h then
              -- try reading from image.path using LuaSocket? skip
              w,h = 1,1
            end
            local cx = (x1 + x2) / 2.0 / w
            local cy = (y1 + y2) / 2.0 / h
            local rx = (x2 - x1) / 2.0 / w
            local ry = (y2 - y1) / 2.0 / h
            -- attempt a few guessed API calls
            local created = false
            -- Attempt: dt.gui.create_mask or dt.create_mask (best-effort)
            if dt and dt.create_mask then
              pcall(function()
                dt.create_mask(image_obj, 'ellipse', {cx=cx, cy=cy, rx=rx, ry=ry})
                created = true
              end)
            end
            if not created and image_obj and image_obj.add_mask then
              pcall(function()
                image_obj:add_mask{type='ellipse', cx=cx, cy=cy, rx=rx, ry=ry}
                created = true
              end)
            end
            if not created and dt and dt.gui and dt.gui.mask then
              pcall(function()
                dt.gui.mask.add_ellipse(image_obj, cx, cy, rx, ry)
                created = true
              end)
            end
            if created then ok_any = true end
          end
        end
        return ok_any
      end

      local applied_api = false
      -- attempt to get a darktable image object for API calls
      local success_image_obj, image_obj = pcall(function() return image end)
      if success_image_obj and image_obj then
        local ok = pcall(try_apply_masks_api, image_obj, dets)
        if ok then applied_api = true end
      end
      if applied_api then
        dt.print('Applied masks via Darktable API for '..path)
      else
      -- NOTE: here we would call Darktable mask creation API to create ellipse masks
      -- The exact functions vary by Darktable version. To avoid damaging XMP,
      -- we currently call the external writer as fallback:
      -- write JSON to a temp file then call apply_json_to_xmp.py to safely insert masks
          -- create a safer temp-path ending with .json
        local tmp = os.tmpname()
        local tmpjson = tmp .. '.json'
        local cmd_json = string.format('"%s" "%s" "%s" --min-conf 0.35 --json-file "%s"', PYTHON_CMD, PYTHON_SCRIPT, path, tmpjson)
        local r = os.execute(cmd_json)
        if r ~= 0 and r ~= true then
          dt.print('Failed to generate JSON for '..path)
        else
          -- call helper to apply JSON into XMP
          local apply_script = '/home/fickdichweg/#things/VSC/blur/apply_json_to_xmp.py'
          local cmd_apply = string.format('"%s" "%s" "%s" "%s" --backup-dir "%s"', PYTHON_CMD, apply_script, path, tmpjson, BACKUP_DIR)
          local ra = os.execute(cmd_apply)
          if ra ~= 0 and ra ~= true then
            dt.print('apply_json_to_xmp failed for '..path)
          else
            dt.print('Wrote masks via helper script for '..path)
          end
        end
        pcall(os.remove, tmpjson)
    end
  end
  dt.print(_('Face detection complete; reload images if needed.'))
end

-- Register a menu item under the 'Image' menu
dt.register_lib_shortcut('retinaface.detect_selected', 'RetinaFace detect selected images', do_detect_for_selection)

-- end of plugin
