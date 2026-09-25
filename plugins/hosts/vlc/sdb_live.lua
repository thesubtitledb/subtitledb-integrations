--[[
 A VLC interface script that drives the SubtitleDB extension inside a running VLC.

 VLC has no way to open an extension's window from the command line, so this loads
 the extension into an interface script and stands in for vlc.dialog, which only
 extensions get. Everything behind the window is VLC's own: the item it is playing,
 vlc.stream fetching over HTTPS, the file write, and loading the subtitle into the
 player, which is what the last check reads back.

   SDB_EXTENSION=/path/to/subtitledb.lua SDB_RESULT=/path/to/result.txt \
     cvlc -I luaintf --lua-intf sdb_live --vout dummy --aout dummy video.mkv

   SDB_LANGUAGES  API codes, comma separated, each searched and downloaded in turn
                  through the window's language dropdown; English when unset
   SDB_TITLE      the title every search must be answered for, as hex-encoded UTF-8,
                  since on Windows a non-ASCII name does not survive the environment
   SDB_EXPECT     "nothing" for a file the index has no title for, which the window
                  must say plainly rather than list something or report an outage
   SDB_PER_LANGUAGE  the count per language to set through the settings window;
                  no search may list more
   SDB_MANY       API codes the index holds more than that count in, where a search
                  that lists 100 or fewer stopped at the API's first page

 run.sh sets these from media.py's list and runs one VLC per video.
--]]

local lines = {}

local function say(text)
  lines[#lines + 1] = text
  vlc.msg.info("[sdb-live] " .. text)
end

local function finish(passed)
  local out = io.open(os.getenv("SDB_RESULT"), "w")
  out:write((passed and "PASS" or "FAIL") .. "\n" .. table.concat(lines, "\n") .. "\n")
  out:close()
  vlc.misc.quit()
end

local function sleep(seconds)
  vlc.misc.mwait(vlc.misc.mdate() + seconds * 1000000)
end

local function hex_decode(hex)
  return (string.gsub(hex or "", "%x%x", function(pair)
    return string.char(tonumber(pair, 16))
  end))
end

-- By a UTF-8 path, which on Windows only VLC's own opener takes.
local function open_file(path, mode)
  local opener = (vlc.io and vlc.io.open) or io.open
  local ok, file = pcall(opener, path, mode)
  return ok and file or nil
end

-- The window. Widgets keep what the extension puts in them, and the buttons keep
-- their callbacks so the script can press them.
local Widget = {}
Widget.__index = Widget

local function widget(text)
  return setmetatable({ text = text or "", values = {} }, Widget)
end

function Widget:get_text() return self.text end
function Widget:set_text(text) self.text = text end
function Widget:add_value(label, id) self.values[#self.values + 1] = { id = id, label = label } end
function Widget:set_value(id) self.value = id end
function Widget:get_value() return self.value or (self.values[1] and self.values[1].id) end
function Widget:clear() self.values = {} end
function Widget:get_selection() return self.selection end
function Widget:get_checked() return self.checked end
function Widget:set_checked(checked) self.checked = checked end

local Dialog = {}
Dialog.__index = Dialog

function Dialog:add_label(text)
  local w = widget(text)
  if text == "Ready" then self.message = w end
  return w
end
function Dialog:add_text_input(text)
  local w = widget(text)
  self.inputs[#self.inputs + 1] = w
  return w
end
function Dialog:add_password(text) return widget(text) end
function Dialog:add_html(text) return widget(text) end
function Dialog:add_button(text, action)
  self.buttons[text] = action
  return widget(text)
end
function Dialog:add_dropdown()
  local w = widget()
  self.dropdowns[#self.dropdowns + 1] = w
  return w
end
function Dialog:add_list()
  self.list = widget()
  return self.list
end
function Dialog:add_check_box(text, checked)
  local w = widget(text)
  w.checked = checked
  return w
end
function Dialog:show() end
function Dialog:hide() end
function Dialog:update() end
function Dialog:delete() end
function Dialog:set_title(title) self.title = title end

local window
vlc.dialog = function(title)
  window = setmetatable({ title = title, inputs = {}, buttons = {}, dropdowns = {} }, Dialog)
  return window
end

local function status()
  return window and window.message and window.message.text or ""
end

local function subtitle_tracks()
  local input = vlc.object.input()
  if not input then return 0 end
  local ok, values = pcall(vlc.var.get_list, input, "spu-es")
  if ok and type(values) == "table" then return #values end
  return 0
end

local function press(name)
  local action = window and window.buttons[name]
  if not action then return false, "no button called " .. name end
  return pcall(action)
end

-- The first dropdown is the language, filled from the extension's own table. Returns
-- the name it shows for the code, or nil when it offers no such language.
local function choose_language(code)
  local name
  for _, pair in ipairs(SubtitleDb.LANGUAGES) do
    if pair[1] == code then name = pair[2] end
  end
  local dropdown = window.dropdowns[1]
  for _, value in ipairs(dropdown and dropdown.values or {}) do
    if value.label == name then
      dropdown:set_value(value.id)
      return name
    end
  end
  return nil
end

-- The settings window, filled in as a user would: the count per language goes in the
-- first text box, and Save writes the extension's settings file.
local function set_count(count)
  local ok, err = press("Settings")
  if not ok then
    say("the Settings button raised: " .. tostring(err))
    return false
  end
  local box = window.inputs[1]
  if not (box and tonumber(box.text)) then
    say("the settings window has no count in its first box: " .. tostring(box and box.text))
    return false
  end
  box:set_text(count)
  ok, err = press("Save")
  if not ok then
    say("Save raised: " .. tostring(err))
    return false
  end
  say("set to " .. count .. " subtitles per language")
  return true
end

-- No more than the setting, and past the API's first page where the index holds more.
local function count_ok(list, label, many)
  local most = tonumber(os.getenv("SDB_PER_LANGUAGE") or "")
  if most and #list.values > most then
    say(string.format("%d listed in %s, more than the %d it is set to", #list.values, label, most))
    return false
  end
  if many and #list.values <= 100 then
    say(string.format("%d listed in %s, so it stopped at the API's first page", #list.values, label))
    return false
  end
  return true
end

local function search()
  local started = vlc.misc.mdate()
  local ok, err = press("Search this file")
  if not ok then
    say("the search raised: " .. tostring(err))
    return nil
  end
  say(string.format("search %.1fs: %s", (vlc.misc.mdate() - started) / 1000000, status()))
  local list = window.list
  for i = 1, math.min(3, #list.values) do say("  " .. list.values[i].label) end
  return list
end

-- The first row, then what landed: named for the language, readable as a subtitle,
-- and loaded into the player as one more track.
local function download(list, code)
  local before = subtitle_tracks()
  list.selection = { [list.values[1].id] = list.values[1].label }
  local ok, err = press("Download")
  if not ok then
    say("the download raised: " .. tostring(err))
    return false
  end
  say("download: " .. status())
  local target = string.match(status(), "^Saved and loaded: (.+)$")
  if not target then return false end
  if not string.find(target, "." .. code .. ".", 1, true) then
    say("the file is not named for " .. code)
    return false
  end

  local file = open_file(target, "rb")
  if not file then
    say("nothing at " .. target)
    return false
  end
  local body = file:read("*a") or ""
  file:close()
  say(string.format("saved %s (%d bytes)", target, #body))
  if not (body:find("-->", 1, true) or body:find("[Script Info]", 1, true)
          or body:find("WEBVTT", 1, true)) then
    say("the saved file does not read as a subtitle")
    return false
  end

  local after = before
  for _ = 1, 50 do
    after = subtitle_tracks()
    if after > before then break end
    sleep(0.2)
  end
  say(string.format("subtitle tracks before %d, after %d", before, after))
  if after <= before then
    say("the file was saved but VLC did not load it")
    return false
  end
  return true
end

local function run()
  for _ = 1, 150 do
    if vlc.input.item() and vlc.object.input() then break end
    sleep(0.2)
  end
  local item = vlc.input.item()
  if not item then
    say("VLC never started playing")
    return false
  end
  say(string.format("VLC %s (%s, vlc.io %s), playing %s", tostring(vlc.misc.version()),
                    tostring(_VERSION), vlc.io and "present" or "absent", item:uri()))

  local ok, err = pcall(dofile, os.getenv("SDB_EXTENSION"))
  if not ok then
    say("the extension did not load: " .. tostring(err))
    return false
  end
  ok, err = pcall(activate)
  if not ok then
    say("activate() raised: " .. tostring(err))
    return false
  end
  say("the window filled the title in as: " .. tostring(window.inputs[1] and window.inputs[1].text))

  local want = hex_decode(os.getenv("SDB_TITLE"))
  local expect = os.getenv("SDB_EXPECT") or ""
  local codes, many = {}, {}
  for code in string.gmatch(os.getenv("SDB_LANGUAGES") or "en", "[^,%s]+") do
    codes[#codes + 1] = code
  end
  for code in string.gmatch(os.getenv("SDB_MANY") or "", "[^,%s]+") do many[code] = true end

  local count = os.getenv("SDB_PER_LANGUAGE") or ""
  if count ~= "" and not set_count(count) then return false end

  -- Any language, which once asked the API nothing at all and said "no answer".
  if expect ~= "nothing" then
    window.dropdowns[1]:set_value(1)
    local list = search()
    if not list then return false end
    if #list.values == 0 then
      say("the extension listed nothing in any language")
      return false
    end
    if not count_ok(list, "any language", false) then return false end
  end

  for _, code in ipairs(codes) do
    local name = choose_language(code)
    if not name then
      say("the window offers no language " .. code)
      return false
    end
    local list = search()
    if not list then return false end

    if expect == "nothing" then
      if #list.values > 0 then
        say(string.format("%d listed for a title the index does not have", #list.values))
        return false
      end
      if not string.find(status(), "No title matched", 1, true) then
        say("a title the index does not have should be said to be missing, not: " .. status())
        return false
      end
      return true
    end

    if #list.values == 0 then
      say("the extension listed nothing in " .. name)
      return false
    end
    for i, value in ipairs(list.values) do
      if string.sub(value.label, 1, #name) ~= name then
        say(string.format("row %d is not %s: %s", i, name, value.label))
        return false
      end
    end
    if not count_ok(list, name, many[code]) then return false end
    -- The status line names the title the search was answered for, which a file
    -- played by name alone can get wrong.
    if want ~= "" and not string.find(status(), want, 1, true) then
      say("the search was answered for another title than " .. want)
      return false
    end
    if not download(list, code) then return false end
  end
  return true
end

local ok, passed = pcall(run)
if not ok then say("the harness raised: " .. tostring(passed)) end
finish(ok and passed)
