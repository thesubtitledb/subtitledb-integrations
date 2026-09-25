-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 TheSubtitleDb.org

--[[
 SubtitleDB for VLC

 Subtitles from the SubtitleDB open index, inside VLC. No account, no key, no
 quota, so there is no login anywhere in this extension.

 One file, because that is how VLC installs an extension: drop it in the
 extensions directory and it appears under View. Everything it needs is here,
 including a small JSON reader, since VLC's Lua has none.

 The window follows vlsub's layout, which is what a VLC user already knows: the
 title and the numbers at the top, three language choices, the results in the
 middle, and the actions along the bottom. That project is GPL-3.0, so the
 arrangement is reproduced and none of its code is.

 The rules that decide which subtitle is best are the ones every SubtitleDB
 plugin uses, and plugins/shared/match-cases.json holds the cases this file is
 tested against alongside the Python, C# and TypeScript ones.
--]]

SubtitleDb = {}
local S = SubtitleDb

S.VERSION = "0.3.0"
S.API_BASE = "https://api.thesubtitledb.org"
S.FORMATS = { srt = true, ass = true, ssa = true, sub = true, vtt = true }

-- ===========================================================================
-- JSON
-- ===========================================================================
--
-- Enough of RFC 8259 to read what this API sends, and strict about the rest: a
-- decoder that guesses turns a broken response into wrong subtitles rather than
-- into an error message.

local json = {}
S.json = json

local escapes = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f",
                  n = "\n", r = "\r", t = "\t" }

local function utf8_char(code)
  -- VLC's Lua is 5.1 and has no utf8 library, so the four byte forms are
  -- assembled here. Anything above the BMP arrives as a surrogate pair.
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
  elseif code < 0x10000 then
    return string.char(0xE0 + math.floor(code / 0x1000),
                       0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
  end
  return string.char(0xF0 + math.floor(code / 0x40000),
                     0x80 + math.floor(code / 0x1000) % 0x40,
                     0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
end

local function skip_space(str, pos)
  local _, stop = string.find(str, "^[ \n\r\t]*", pos)
  return stop + 1
end

local parse_value

local function parse_string(str, pos)
  local out, i = {}, pos + 1
  while true do
    local c = string.sub(str, i, i)
    if c == "" then return nil, "unterminated string" end
    if c == '"' then return table.concat(out), i + 1 end
    if c == "\\" then
      local e = string.sub(str, i + 1, i + 1)
      if escapes[e] then
        out[#out + 1] = escapes[e]
        i = i + 2
      elseif e == "u" then
        local hex = string.sub(str, i + 2, i + 5)
        local code = tonumber(hex, 16)
        if not code then return nil, "bad \\u escape" end
        i = i + 6
        -- A high surrogate is only half a character; the low half follows it.
        if code >= 0xD800 and code <= 0xDBFF and string.sub(str, i, i + 1) == "\\u" then
          local low = tonumber(string.sub(str, i + 2, i + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            i = i + 6
          end
        end
        out[#out + 1] = utf8_char(code)
      else
        return nil, "bad escape \\" .. e
      end
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
end

local function parse_number(str, pos)
  local text = string.match(str, "^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
  local value = tonumber(text)
  if not value then return nil, "bad number" end
  return value, pos + #text
end

local function parse_array(str, pos)
  local out = {}
  pos = skip_space(str, pos + 1)
  if string.sub(str, pos, pos) == "]" then return out, pos + 1 end
  while true do
    local value, next_pos = parse_value(str, pos)
    if value == nil and next_pos ~= nil and type(next_pos) == "string" then
      return nil, next_pos
    end
    out[#out + 1] = value
    pos = skip_space(str, next_pos)
    local c = string.sub(str, pos, pos)
    if c == "]" then return out, pos + 1 end
    if c ~= "," then return nil, "expected , or ] in array" end
    pos = skip_space(str, pos + 1)
  end
end

local function parse_object(str, pos)
  local out = {}
  pos = skip_space(str, pos + 1)
  if string.sub(str, pos, pos) == "}" then return out, pos + 1 end
  while true do
    if string.sub(str, pos, pos) ~= '"' then return nil, "expected a key" end
    local key, next_pos = parse_string(str, pos)
    if key == nil then return nil, next_pos end
    pos = skip_space(str, next_pos)
    if string.sub(str, pos, pos) ~= ":" then return nil, "expected :" end
    local value
    value, next_pos = parse_value(str, skip_space(str, pos + 1))
    if value == nil and type(next_pos) == "string" then return nil, next_pos end
    out[key] = value
    pos = skip_space(str, next_pos)
    local c = string.sub(str, pos, pos)
    if c == "}" then return out, pos + 1 end
    if c ~= "," then return nil, "expected , or } in object" end
    pos = skip_space(str, pos + 1)
  end
end

-- null has to be a value rather than nil, or a key that is present and null and a
-- key that is absent become the same thing.
json.null = setmetatable({}, { __tostring = function() return "null" end })

parse_value = function(str, pos)
  local c = string.sub(str, pos, pos)
  if c == '"' then return parse_string(str, pos) end
  if c == "{" then return parse_object(str, pos) end
  if c == "[" then return parse_array(str, pos) end
  if string.sub(str, pos, pos + 3) == "true" then return true, pos + 4 end
  if string.sub(str, pos, pos + 4) == "false" then return false, pos + 5 end
  if string.sub(str, pos, pos + 3) == "null" then return json.null, pos + 4 end
  if string.find(c, "^[-%d]") then return parse_number(str, pos) end
  return nil, "unexpected character " .. (c == "" and "end of input" or c)
end

--- Decode a JSON document. Returns the value, or nil and a message.
function json.decode(str)
  if type(str) ~= "string" or str == "" then return nil, "empty response" end
  local value, pos = parse_value(str, skip_space(str, 1))
  if value == nil then return nil, tostring(pos) end
  if skip_space(str, pos) <= #str then return nil, "trailing data" end
  return value
end

--- json.null and nil read the same way everywhere else in this file.
function S.get(tbl, key)
  if type(tbl) ~= "table" then return nil end
  local value = tbl[key]
  if value == nil or value == json.null then return nil end
  return value
end

-- ===========================================================================
-- Languages
-- ===========================================================================

S.LANGUAGES = {
  { "en", "English" }, { "es", "Spanish" }, { "fr", "French" }, { "de", "German" },
  { "it", "Italian" }, { "pt", "Portuguese" }, { "pb", "Portuguese (Brazil)" },
  { "nl", "Dutch" }, { "pl", "Polish" }, { "ru", "Russian" }, { "uk", "Ukrainian" },
  { "cs", "Czech" }, { "sk", "Slovak" }, { "hu", "Hungarian" }, { "ro", "Romanian" },
  { "bg", "Bulgarian" }, { "el", "Greek" }, { "tr", "Turkish" }, { "ar", "Arabic" },
  { "he", "Hebrew" }, { "fa", "Persian" }, { "hi", "Hindi" }, { "bn", "Bengali" },
  { "ta", "Tamil" }, { "te", "Telugu" }, { "ml", "Malayalam" }, { "th", "Thai" },
  { "vi", "Vietnamese" }, { "id", "Indonesian" }, { "ms", "Malay" }, { "tl", "Tagalog" },
  { "ja", "Japanese" }, { "ko", "Korean" }, { "zh", "Chinese" },
  { "zt", "Chinese (traditional)" }, { "ze", "Chinese (bilingual)" },
  { "sv", "Swedish" }, { "no", "Norwegian" }, { "da", "Danish" }, { "fi", "Finnish" },
  { "is", "Icelandic" }, { "et", "Estonian" }, { "lv", "Latvian" }, { "lt", "Lithuanian" },
  { "hr", "Croatian" }, { "sr", "Serbian" }, { "bs", "Bosnian" }, { "sl", "Slovenian" },
  { "mk", "Macedonian" }, { "sq", "Albanian" }, { "ca", "Catalan" }, { "eu", "Basque" },
  { "gl", "Galician" }, { "hy", "Armenian" }, { "ka", "Georgian" }, { "kk", "Kazakh" },
  { "mn", "Mongolian" }, { "my", "Burmese" }, { "km", "Khmer" }, { "si", "Sinhala" },
  { "ur", "Urdu" }, { "uz", "Uzbek" }, { "sw", "Swahili" }, { "eo", "Esperanto" },
  { "oc", "Occitan" }, { "ku", "Kurdish" }, { "tt", "Tatar" }, { "pm", "Portuguese (Mozambique)" },
}

function S.language_name(code)
  if not code or code == "" then return nil end
  for _, pair in ipairs(S.LANGUAGES) do
    if pair[1] == code then return pair[2] end
  end
  return string.upper(code)
end

-- ===========================================================================
-- Filenames
-- ===========================================================================
--
-- VLC is the one host with no metadata to read: there is a path and whatever the
-- file's own tags say. So the name has to carry the title, the year and the
-- numbers, and this reads the same four things packages/core/src/filename.ts does
-- and stops there.

local TAGS = {}
for tag in string.gmatch([[2160p 1080p 1080i 720p 576p 480p 4k uhd bluray blu-ray brrip
bdrip bdremux remux webrip web-dl webdl web hdtv pdtv dvdrip dvdscr dvd hdrip cam camrip
telesync telecine workprint r5 vodrip hdcam x264 x265 h264 h265 hevc avc xvid divx vp9 av1
10bit 8bit hdr hdr10 hdr10plus dovi dv sdr hlg aac aac2 ac3 eac3 dts dtshd truehd atmos flac
mp3 opus ddp5 ddp dd5 dd commentary proper repack internal limited extended uncut unrated
remastered directors imax theatrical criterion anniversary multi dual subbed dubbed subs sub
hardsub raw complete amzn nf netflix dsnp hmax max atvp hulu pcok stan crav ma]], "%S+") do
  TAGS[tag] = true
end

local CONTAINERS = {}
for ext in string.gmatch("mkv mp4 avi m4v mov wmv flv webm mpg mpeg ts m2ts ogv", "%S+") do
  CONTAINERS[ext] = true
end

function S.basename(input)
  if not input or input == "" then return "" end
  local s = string.gsub(input, "[?#].*$", "")
  s = string.match(s, "([^/\\]*)$") or s
  -- A VLC path is a URL, so the name arrives percent-encoded.
  s = string.gsub(s, "%%(%x%x)", function(hex)
    return string.char(tonumber(hex, 16))
  end)
  return s
end

local function tokenise(base)
  local out = {}
  local cleaned = string.gsub(base, "[%[%]%(%)_{}]", " ")
  cleaned = string.gsub(cleaned, "[%.%-%+]", " ")
  for token in string.gmatch(cleaned, "%S+") do
    out[#out + 1] = token
  end
  return out
end

--- title, year, season, episode out of a release name.
function S.parse_filename(input)
  local name = S.basename(input)
  local base, container = name, nil
  local stem, ext = string.match(name, "^(.*)%.([%a%d]+)$")
  if stem and CONTAINERS[string.lower(ext)] then
    base, container = stem, string.lower(ext)
  end

  -- A trailing -GROUP, unless it is the tail of a hyphenated tag: WEB-DL and
  -- Blu-Ray both end in a hyphen and a short token, and a naive match reports
  -- groups called DL and Ray.
  local rest, group = base, nil
  local head, candidate = string.match(base, "^(.*)%-([%w_%.]+)$")
  if candidate and #candidate >= 2 and #candidate <= 20 then
    local lower = string.lower(candidate)
    local prev = tokenise(head)
    prev = prev[#prev]
    if not TAGS[lower] and not (prev and TAGS[string.lower(prev .. "-" .. candidate)]) then
      rest, group = head, candidate
    end
  end

  local season, episode, episode_cut
  local patterns = {
    "()[sS](%d%d?)[%s%._%-]*[eE](%d%d?%d?)",
    "()(%d%d?)[xX](%d%d?%d?)",
    "()[sS]eason[%s%._%-]*(%d%d?)[%s%._%-]*[eE]pisode[%s%._%-]*(%d%d?%d?)",
  }
  for _, pattern in ipairs(patterns) do
    local at, a, b = string.match(rest, pattern)
    if at then
      season, episode, episode_cut = tonumber(a), tonumber(b), at
      break
    end
  end

  -- The last year before any episode marker, so "2012 S01E01" reads as a series
  -- called 2012 rather than as a year.
  local year, year_cut
  local space = episode_cut and string.sub(rest, 1, episode_cut - 1) or rest
  local this_year = tonumber(os.date("%Y")) or 2026
  local at = 1
  while true do
    local start, stop, found = string.find(space, "(%d%d%d%d)", at)
    if not start then break end
    local value = tonumber(found)
    local before = string.sub(space, start - 1, start - 1)
    local after = string.sub(space, stop + 1, stop + 1)
    -- A four digit run inside a longer number is not a year, and one with nothing
    -- in front of it is the name rather than the date: "2012.S01E01" is a series
    -- called 2012, and reading it as a year leaves nothing to search for.
    if value >= 1900 and value <= this_year + 2
      and not string.match(before, "%d") and not string.match(after, "%d")
      and #tokenise(string.sub(space, 1, start - 1)) > 0 then
      year, year_cut = value, start
    end
    at = stop + 1
  end

  local cut = #rest + 1
  if episode_cut and episode_cut < cut then cut = episode_cut end
  if year_cut and year_cut < cut then cut = year_cut end

  local title_tokens = {}
  for _, token in ipairs(tokenise(string.sub(rest, 1, cut - 1))) do
    if TAGS[string.lower(token)] then break end
    title_tokens[#title_tokens + 1] = token
  end

  return {
    title = table.concat(title_tokens, " "),
    year = year,
    season = season,
    episode = episode,
    group = group,
    container = container,
    release = base,
  }
end

-- ===========================================================================
-- Matching
-- ===========================================================================

local ACCENTS = {
  ["\195\160"] = "a", ["\195\161"] = "a", ["\195\162"] = "a", ["\195\163"] = "a",
  ["\195\164"] = "a", ["\195\165"] = "a", ["\195\167"] = "c", ["\195\168"] = "e",
  ["\195\169"] = "e", ["\195\170"] = "e", ["\195\171"] = "e", ["\195\172"] = "i",
  ["\195\173"] = "i", ["\195\174"] = "i", ["\195\175"] = "i", ["\195\177"] = "n",
  ["\195\178"] = "o", ["\195\179"] = "o", ["\195\180"] = "o", ["\195\181"] = "o",
  ["\195\182"] = "o", ["\195\185"] = "u", ["\195\186"] = "u", ["\195\187"] = "u",
  ["\195\188"] = "u", ["\195\189"] = "y",
}

--- Fold case, accents and punctuation, so two spellings of one title compare equal.
function S.normalise(value)
  if not value then return "" end
  local s = string.lower(value)
  -- A combining mark is the same letter written the other way: "e" followed by
  -- U+0301 is the decomposed form of the precomposed byte pair below. Dropping
  -- these is what NFKD plus a strip of the marks does elsewhere, and without it
  -- two spellings of one accented title score 0.73 instead of 1.
  s = string.gsub(s, "\204[\128-\191]", "")
  s = string.gsub(s, "\205[\128-\175]", "")
  -- Lua 5.1 has no Unicode, so the Latin-1 letters are folded from their UTF-8
  -- bytes. Everything else non-ASCII becomes a separator, which is what the
  -- character class below would do to it anyway.
  s = string.gsub(s, "\195[\128-\191]", function(pair)
    return ACCENTS[pair] or " "
  end)
  s = string.gsub(s, "[^a-z0-9]+", " ")
  return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

--- Dice coefficient over bigrams. Forgiving of word order and punctuation.
function S.similarity(a, b)
  local x, y = S.normalise(a), S.normalise(b)
  if x == "" or y == "" then return 0 end
  if x == y then return 1 end
  local grams, total = {}, 0
  for i = 1, #x - 1 do
    local g = string.sub(x, i, i + 1)
    grams[g] = (grams[g] or 0) + 1
    total = total + 1
  end
  local overlap = 0
  for i = 1, #y - 1 do
    local g = string.sub(y, i, i + 1)
    total = total + 1
    if (grams[g] or 0) > 0 then
      grams[g] = grams[g] - 1
      overlap = overlap + 1
    end
  end
  if total == 0 then return 0 end
  return (2 * overlap) / total
end

local function wrong_episode(row, hint)
  if not hint.season or not hint.episode then return false end
  local season, episode = S.get(row, "season"), S.get(row, "episode")
  if not season or not episode then return false end
  return season ~= hint.season or episode ~= hint.episode
end

function S.score_subtitle(row, hint, opts)
  local score, reasons = 0, {}
  local language = S.get(row, "language") or ""
  if opts.languages and #opts.languages > 0 then
    local rank
    for i, code in ipairs(opts.languages) do
      if code == language then rank = i - 1 break end
    end
    if rank then
      score = score + 100 - rank * 20
      reasons[#reasons + 1] = "preferred language " .. language
    else
      score = score - 50
    end
  end
  if opts.hearing_impaired ~= nil then
    if (S.get(row, "hearing_impaired") == true) == opts.hearing_impaired then
      score = score + 15
    else
      score = score - 15
    end
  end
  local release = S.get(row, "release_name")
  if release and release ~= "" and hint.release then
    local sim = S.similarity(release, hint.release)
    if sim >= 0.95 then
      score = score + 60
      reasons[#reasons + 1] = "same release"
    elseif sim > 0.5 then
      score = score + sim * 30
      reasons[#reasons + 1] = "release name is close"
    end
  end
  if hint.season and S.get(row, "season") and not wrong_episode(row, hint) then
    score = score + 20
  end
  if (S.get(row, "cues") or 0) == 0 then
    score = score - 500
    reasons[#reasons + 1] = "no cues"
  end
  if #reasons == 0 then
    reasons[1] = language .. " " .. (S.get(row, "format") or "")
  end
  return score, table.concat(reasons, ", ")
end

--- Filter to what VLC can render, then order best first.
function S.rank(rows, hint, opts)
  local kept, unrenderable, wrong = {}, 0, 0
  -- Whatever the caller can render, defaulting to what VLC can. A hard filter,
  -- not a preference: a player handed a format it cannot parse shows an empty
  -- track, which is the most confusing failure a subtitle plugin has.
  local renderable = S.FORMATS
  if opts.formats then
    renderable = {}
    for _, format in ipairs(opts.formats) do renderable[string.lower(format)] = true end
  end
  for _, row in ipairs(rows or {}) do
    local format = string.lower(S.get(row, "format") or "")
    if not renderable[format] then
      unrenderable = unrenderable + 1
    elseif wrong_episode(row, hint) then
      wrong = wrong + 1
    else
      local score, reason = S.score_subtitle(row, hint, opts)
      kept[#kept + 1] = { row = row, score = score, reason = reason,
                          id = S.get(row, "id") or 0 }
    end
  end
  -- The id breaks ties, so two runs of one search list the same order.
  table.sort(kept, function(a, b)
    if a.score == b.score then return a.id < b.id end
    return a.score > b.score
  end)
  return kept, unrenderable, wrong
end

--- What one row reads as in the list.
function S.label(candidate)
  local row = candidate.row
  local bits = { S.language_name(S.get(row, "language")) or "Unknown" }
  if S.get(row, "hearing_impaired") then bits[#bits + 1] = "HI" end
  local release = S.get(row, "release_name")
  if release and release ~= "" then
    bits[#bits + 1] = string.sub(release, 1, 40)
  elseif (S.get(row, "cues") or 0) > 0 then
    bits[#bits + 1] = tostring(S.get(row, "cues")) .. " lines"
  end
  return table.concat(bits, " - ")
end

-- ===========================================================================
-- The API
-- ===========================================================================

function S.url_encode(value)
  value = string.gsub(tostring(value), "([^%w%-%.%_%~])", function(c)
    return string.format("%%%02X", string.byte(c))
  end)
  return value
end

function S.build_url(path, params)
  local parts = {}
  for _, pair in ipairs(params or {}) do
    if pair[2] ~= nil and pair[2] ~= "" then
      parts[#parts + 1] = pair[1] .. "=" .. S.url_encode(pair[2])
    end
  end
  parts[#parts + 1] = "client=vlc"
  return S.API_BASE .. path .. "?" .. table.concat(parts, "&")
end

S.NO_ANSWER = "no answer from "

--- Read a URL whole. Replaced in tests; in VLC this is the only network call.
function S.fetch(url)
  local stream = vlc.stream(url)
  if not stream then return nil, S.NO_ANSWER .. S.API_BASE end
  local chunks = {}
  while true do
    local chunk = stream:read(65536)
    if not chunk or #chunk == 0 then break end
    chunks[#chunks + 1] = chunk
  end
  return table.concat(chunks)
end

--- One request the API always answers: the film its own live tests use. Swap for a
--- health route once the API has one.
S.PROBE_PATH = "/v1/by-imdb/0133093"

--- What to tell the user when no rung answered. VLC's stream comes back empty for a
--- 404 and for a dead host alike, so a name the index has no title for would read
--- as an outage. One ask that always has an answer tells the two apart.
function S.explain_miss(err, hint)
  if string.sub(err or "", 1, #S.NO_ANSWER) ~= S.NO_ANSWER then return err end
  if not S.fetch(S.build_url(S.PROBE_PATH, { { "limit", 1 } })) then
    return "SubtitleDB did not answer"
  end
  local asked = hint and (hint.title or hint.imdb_id or hint.tmdb_id)
  if asked then return "No title matched " .. tostring(asked) end
  return "No title matched this file"
end

function S.get_json(url)
  local body, err = S.fetch(url)
  if not body then return nil, err end
  local value, decode_err = S.json.decode(body)
  if not value then return nil, "unreadable answer: " .. tostring(decode_err) end
  local message = S.get(value, "message")
  if message and S.get(value, "error") then return nil, message end
  return value
end

--- The most rows the API returns for one request. More takes an offset.
S.PAGE = 100
--- What a search reads per language when the settings do not say.
S.PER_LANGUAGE = 500
--- The most the setting may ask for, in rows per language.
S.MOST_PER_LANGUAGE = 2000

--- A setting read as rows per language: 100 to 2000, else 500.
function S.per_language(value)
  local n = tonumber(value)
  if not n then return S.PER_LANGUAGE end
  return math.min(math.max(math.floor(n), S.PAGE), S.MOST_PER_LANGUAGE)
end

--- The subtitle page that belongs to exactly what was asked for: always the
--- top-level bucket, a page object { total, items }. Every lookup answers with the
--- same shape, drilled or not; a drill narrows what lands in `subtitles` rather than
--- moving it under an `episode` or `season` key, which the API never sent.
local function scoped_items(bundle)
  local page = S.get(bundle, "subtitles")
  return (page and S.get(page, "items")) or {}
end

--- The ladder, the same rungs every SubtitleDB plugin walks: tmdb, then imdb, then
--- free text. tmdb is the headline key and leads; imdb sits behind it because media
--- servers identify content by IMDb id. Free text is resolved server-side by by-title,
--- so no list of titles crosses the wire. Each verb returns one bundle; the scoped
--- page is what gets ranked.
function S.search(hint, opts)
  local cap = S.per_language(opts.limit)

  -- Fetch one verb, up to `cap` rows per preferred language, and merge them in the
  -- caller's order. The API sends 100 rows a request, in the order they were added
  -- rather than how well they match, so the one in sync with a popular film's file
  -- can sit past the first page. A language is read on until the title runs out,
  -- the cap is reached, or a page brings nothing new.
  -- Returns rows on a hit (even an empty table, which still stops the ladder), or
  -- (nil, err) on a miss so the caller can fall through to the next rung.
  local function via(path, base_params)
    local rows, seen, first = {}, {}, nil
    local languages = opts.languages or {}
    -- One unfiltered ask when no language was chosen. A count, because ipairs
    -- reads { nil } as empty and would ask nothing at all.
    for i = 1, math.max(#languages, 1) do
      local read = 0
      while read < cap do
        local params = { { "limit", math.min(S.PAGE, cap - read) } }
        if read > 0 then params[#params + 1] = { "offset", read } end
        for _, pair in ipairs(base_params or {}) do params[#params + 1] = pair end
        params[#params + 1] = { "lang", languages[i] }
        local value, err = S.get_json(S.build_url(path, params))
        if not value then
          if first == nil then return nil, err end
          break
        end
        first = first or value
        local items, fresh = scoped_items(value), 0
        for _, row in ipairs(items) do
          local id = S.get(row, "id")
          if id and not seen[id] then
            seen[id] = true
            rows[#rows + 1] = row
            fresh = fresh + 1
          end
        end
        read = read + #items
        -- No new row means the offset was ignored or went past the end.
        local total = S.get(S.get(value, "subtitles"), "total") or 0
        if fresh == 0 or read >= total then break end
      end
    end
    return rows, nil, S.get(first, "title")
  end

  -- The /season/:s[/episode/:e] suffix a series lookup narrows with.
  local function drill(path)
    if hint.season then
      path = path .. "/season/" .. tostring(hint.season)
      if hint.episode then path = path .. "/episode/" .. tostring(hint.episode) end
    end
    return path
  end

  local pages, tier, err, title = nil, "none", nil, nil

  if hint.tmdb_id then
    pages, err, title = via(drill("/v1/by-tmdb/" .. tostring(hint.tmdb_id)))
    if pages then tier = "explicit-tmdb" end
  end

  if not pages and hint.imdb_id then
    pages, err, title = via(drill("/v1/by-imdb/" .. string.gsub(hint.imdb_id, "^tt", "")))
    if pages then tier = "explicit-imdb" end
  end

  if not pages and hint.title and hint.title ~= "" then
    pages, err, title = via(drill("/v1/by-title"), { { "q", hint.title } })
    if pages then tier = "title" end
  end

  if not pages then return {}, err or "nothing found" end
  local ranked, unrenderable, wrong = S.rank(pages, hint, opts)
  return ranked, nil, { tier = tier, unrenderable = unrenderable, wrong_episode = wrong,
                        title = title }
end

--- " for Doctor Who (2005)", or "" when the answer named no title. A title read off
--- a file name can resolve to another one, and the list alone would not show it.
function S.title_line(title)
  local name = S.get(title, "name")
  if not name then return "" end
  local year = S.get(title, "year")
  local when = type(year) == "number" and string.format(" (%d)", year) or ""
  return " for " .. tostring(name) .. when
end

-- ===========================================================================
-- VLC
-- ===========================================================================

local dlg, widgets, results, config = nil, {}, {}, nil

function descriptor()
  return {
    title = "SubtitleDB",
    version = S.VERSION,
    author = "SubtitleDB",
    url = "https://thesubtitledb.org",
    shortdesc = "Subtitles from SubtitleDB",
    description = "Subtitles from the SubtitleDB open index. No account, no key.",
    capabilities = { "menu", "input-listener" },
  }
end

local function default_config()
  return {
    language = "en", language2 = "", language3 = "",
    api_base = S.API_BASE,
    per_language = S.PER_LANGUAGE,
    save_next_to_video = true,
    overwrite = false,
  }
end

local function config_path()
  return vlc.config.userdatadir() .. "/subtitledb.conf"
end

--- A file by a UTF-8 path, or nil. Lua's own io.open takes the name in the system
--- code page, which on Windows files "Amélie" under another name; VLC's takes UTF-8
--- and hands back a file object that reads and writes but has no lines(), so
--- nothing here uses it.
function S.open_file(path, mode)
  local opener = (type(vlc) == "table" and vlc.io and vlc.io.open) or io.open
  local ok, file = pcall(opener, path, mode)
  if ok and file then return file end
  return nil
end

local function load_config()
  config = default_config()
  local file = S.open_file(config_path(), "r")
  if not file then return end
  local text = file:read("*a") or ""
  file:close()
  for line in string.gmatch(text, "[^\r\n]+") do
    local key, value = string.match(line, "^([%w_]+)=(.*)$")
    if key and config[key] ~= nil then
      if value == "true" or value == "false" then
        config[key] = value == "true"
      else
        config[key] = value
      end
    end
  end
  S.API_BASE = config.api_base
end

local function save_config()
  local file = S.open_file(config_path(), "w")
  if not file then return end
  for key, value in pairs(config) do
    file:write(key .. "=" .. tostring(value) .. "\n")
  end
  file:close()
end

function activate()
  load_config()
  show_main()
end

function deactivate()
  close_dlg()
end

function close()
  vlc.deactivate()
end

function menu()
  return { "Search", "Settings", "Help" }
end

function trigger_menu(id)
  if id == 1 then show_main()
  elseif id == 2 then show_config()
  else show_help() end
end

function meta_changed() end

function close_dlg()
  if dlg then
    dlg:delete()
    dlg = nil
  end
  widgets = {}
end

local function message(text)
  if widgets.message then widgets.message:set_text(text) end
end

--- The window, laid out the way a VLC user already knows it.
function show_main()
  close_dlg()
  dlg = vlc.dialog("SubtitleDB")

  local guess = current_guess()

  dlg:add_label("Title:", 1, 1, 1, 1)
  widgets.title = dlg:add_text_input(guess.title or "", 2, 1, 4, 1)
  dlg:add_button("Search this file", search_this_file, 6, 1, 1, 1)

  dlg:add_label("Season:", 1, 2, 1, 1)
  widgets.season = dlg:add_text_input(guess.season and tostring(guess.season) or "", 2, 2, 1, 1)
  dlg:add_label("Episode:", 3, 2, 1, 1)
  widgets.episode = dlg:add_text_input(guess.episode and tostring(guess.episode) or "", 4, 2, 1, 1)
  dlg:add_button("Search by name", search_by_name, 6, 2, 1, 1)

  dlg:add_label("Year:", 1, 3, 1, 1)
  widgets.year = dlg:add_text_input(guess.year and tostring(guess.year) or "", 2, 3, 1, 1)
  dlg:add_label("IMDb id:", 3, 3, 1, 1)
  widgets.imdb = dlg:add_text_input(guess.imdb_id or "", 4, 3, 1, 1)

  dlg:add_label("Language:", 1, 4, 1, 1)
  widgets.language = dlg:add_dropdown(2, 4, 4, 1)
  dlg:add_label("Second language:", 1, 5, 1, 1)
  widgets.language2 = dlg:add_dropdown(2, 5, 4, 1)
  dlg:add_label("Third language:", 1, 6, 1, 1)
  widgets.language3 = dlg:add_dropdown(2, 6, 4, 1)

  fill_languages(widgets.language, config.language, "Any")
  fill_languages(widgets.language2, config.language2, "None")
  fill_languages(widgets.language3, config.language3, "None")

  dlg:add_label("Search results:", 1, 7, 6, 1)
  widgets.list = dlg:add_list(1, 8, 6, 1)
  widgets.message = dlg:add_label("Ready", 1, 9, 6, 1)

  dlg:add_button("Download", download_selected, 1, 10, 1, 1)
  dlg:add_button("Open page", open_page, 2, 10, 1, 1)
  dlg:add_button("Settings", show_config, 5, 10, 1, 1)
  dlg:add_button("Help", show_help, 6, 10, 1, 1)
end

function fill_languages(dropdown, selected, empty_label)
  dropdown:add_value(empty_label, 1)
  for i, pair in ipairs(S.LANGUAGES) do
    dropdown:add_value(pair[2], i + 1)
    if pair[1] == selected then dropdown:set_value(i + 1) end
  end
end

local function chosen_languages()
  local out, seen = {}, {}
  for _, widget in ipairs({ widgets.language, widgets.language2, widgets.language3 }) do
    local index = widget and widget:get_value() or 1
    local pair = S.LANGUAGES[index - 1]
    if pair and not seen[pair[1]] then
      seen[pair[1]] = true
      out[#out + 1] = pair[1]
    end
  end
  return out
end

--- The title to search by, from the item's metadata and what its file name gave up.
--- For an episode it is the series from the file name. VLC's own file name reader
--- rewrites an episode's title to "Show S01E01", which matches no title, and a tag
--- title on an episode is usually the episode's own. For a film, a title the file
--- carries wins over the guess from its name.
function S.guess_title(meta, parsed)
  meta = meta or {}
  if parsed.season then
    if parsed.title and parsed.title ~= "" then return parsed.title end
    local show = string.match(meta["showName"] or "", "^%s*(.-)%s*$")
    return show ~= "" and show or nil
  end
  if meta["title"] and meta["title"] ~= "" then return meta["title"] end
  return parsed.title
end

--- Hand a saved file to what is playing. VLC 4 has this on vlc.player; VLC 3 has it
--- on vlc.input, and raises when nothing is playing. True when VLC took the file.
function S.load_subtitle(api, path)
  local add = (api.player and api.player.add_subtitle)
      or (api.input and api.input.add_subtitle)
  if not add then return false end
  return (pcall(add, path, true))
end

--- What VLC is playing, read as far as it can be.
function current_guess()
  local item = vlc.input.item()
  if not item then return {} end
  local parsed = S.parse_filename(item:uri())
  local meta = item:metas() or {}
  return {
    title = S.guess_title(meta, parsed),
    year = parsed.year,
    season = parsed.season,
    episode = parsed.episode,
    release = parsed.release,
    imdb_id = nil,
  }
end

local function hint_from_form()
  local guess = current_guess()
  local imdb = widgets.imdb and widgets.imdb:get_text() or ""
  local season = tonumber(widgets.season and widgets.season:get_text() or "")
  local episode = tonumber(widgets.episode and widgets.episode:get_text() or "")
  return {
    imdb_id = imdb ~= "" and imdb or nil,
    title = widgets.title and widgets.title:get_text() or guess.title,
    year = tonumber(widgets.year and widgets.year:get_text() or ""),
    season = season,
    episode = episode,
    release = guess.release,
  }
end

local function run_search(hint)
  message("Searching...")
  local found, err, info = S.search(hint, { languages = chosen_languages(),
                                            limit = config.per_language })
  if err and (not found or #found == 0) then
    message(S.explain_miss(err, hint))
    results = {}
    return
  end
  results = found
  widgets.list:clear()
  for i, candidate in ipairs(results) do
    widgets.list:add_value(S.label(candidate), i)
  end
  if #results == 0 then
    message("Nothing found for this film")
  else
    local extra = ""
    if info and info.wrong_episode > 0 then
      extra = string.format(" (%d for other episodes)", info.wrong_episode)
    end
    message(string.format("%d subtitles%s%s", #results, S.title_line(info and info.title), extra))
  end
end

function search_this_file()
  run_search(hint_from_form())
end

function search_by_name()
  local hint = hint_from_form()
  hint.imdb_id = nil
  run_search(hint)
end

local function selected()
  local selection = widgets.list and widgets.list:get_selection()
  if not selection then return nil end
  for index in pairs(selection) do
    return results[index]
  end
  return nil
end

function open_page()
  local candidate = selected()
  if not candidate then message("Pick one first") return end
  vlc.msg.info("[subtitledb] https://thesubtitledb.org/#/subtitle/" .. tostring(candidate.id))
  message("The address is in the messages window")
end

--- Where the .srt goes, and what it is called.
function S.target_path(video_uri, candidate, save_next_to_video, tmp_dir)
  local format = string.lower(S.get(candidate.row, "format") or "srt")
  if not S.FORMATS[format] then format = "srt" end
  local language = S.get(candidate.row, "language") or "und"
  if save_next_to_video and video_uri and string.sub(video_uri, 1, 7) == "file://" then
    local path = string.gsub(video_uri, "^file://", "")
    path = string.gsub(path, "%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
    -- On Windows a drive letter follows the scheme's three slashes, so what is
    -- left starts /C:/, which is not a path. A share's URI has the host right
    -- after the scheme, so what is left is server/share/..., missing its two
    -- leading slashes. Both want backslashes: VLC refuses to load a subtitle
    -- from a Windows path written with forward ones, and says nothing.
    path = string.gsub(path, "^/(%a:)", "%1")
    if string.match(path, "^%a:") then
      path = string.gsub(path, "/", "\\")
    elseif not string.match(path, "^[/\\]") then
      path = "\\\\" .. string.gsub(path, "/", "\\")
    end
    local stem = string.match(path, "^(.*)%.[^%.]+$") or path
    return stem .. "." .. language .. "." .. format
  end
  return tmp_dir .. "/subtitledb-" .. tostring(candidate.id) .. "." .. format
end

function download_selected()
  local candidate = selected()
  if not candidate then message("Pick one first") return end
  local url = S.get(candidate.row, "download_url")
  if not url then message("That subtitle has no file") return end

  message("Downloading...")
  local body, err = S.fetch(url)
  if not body or body == "" then
    message(err or "The file did not download")
    return
  end

  local item = vlc.input.item()
  local target = S.target_path(item and item:uri() or nil, candidate,
                               config.save_next_to_video, vlc.config.userdatadir())
  if not config.overwrite then
    local existing = S.open_file(target, "r")
    if existing then
      existing:close()
      target = string.gsub(target, "(%.[^%.]+)$", ".subtitledb%1")
    end
  end

  local file = S.open_file(target, "wb")
  if not file then
    message("Cannot write " .. target)
    return
  end
  file:write(body)
  file:close()

  if S.load_subtitle(vlc, target) then
    message("Saved and loaded: " .. target)
  else
    message("Saved: " .. target)
  end
end

function show_config()
  close_dlg()
  dlg = vlc.dialog("SubtitleDB settings")
  dlg:add_label("Language:", 1, 1, 1, 1)
  widgets.language = dlg:add_dropdown(2, 1, 3, 1)
  dlg:add_label("Second language:", 1, 2, 1, 1)
  widgets.language2 = dlg:add_dropdown(2, 2, 3, 1)
  dlg:add_label("Third language:", 1, 3, 1, 1)
  widgets.language3 = dlg:add_dropdown(2, 3, 3, 1)
  fill_languages(widgets.language, config.language, "Any")
  fill_languages(widgets.language2, config.language2, "None")
  fill_languages(widgets.language3, config.language3, "None")

  dlg:add_label("Save beside the video:", 1, 4, 1, 1)
  widgets.save_next_to_video = dlg:add_dropdown(2, 4, 3, 1)
  widgets.save_next_to_video:add_value("Yes", 1)
  widgets.save_next_to_video:add_value("No, keep it with VLC's settings", 2)
  widgets.save_next_to_video:set_value(config.save_next_to_video and 1 or 2)

  dlg:add_label("Overwrite an existing file:", 1, 5, 1, 1)
  widgets.overwrite = dlg:add_dropdown(2, 5, 3, 1)
  widgets.overwrite:add_value("No", 1)
  widgets.overwrite:add_value("Yes", 2)
  widgets.overwrite:set_value(config.overwrite and 2 or 1)

  dlg:add_label("Subtitles per language:", 1, 6, 1, 1)
  widgets.per_language = dlg:add_text_input(tostring(S.per_language(config.per_language)), 2, 6, 3, 1)

  dlg:add_label("API address:", 1, 7, 1, 1)
  widgets.api_base = dlg:add_text_input(config.api_base, 2, 7, 3, 1)
  widgets.message = dlg:add_label("There is no account to set up", 1, 8, 4, 1)

  dlg:add_button("Save", apply_config, 3, 9, 1, 1)
  dlg:add_button("Cancel", show_main, 4, 9, 1, 1)
end

function apply_config()
  local codes = chosen_languages()
  config.language = codes[1] or ""
  config.language2 = codes[2] or ""
  config.language3 = codes[3] or ""
  config.save_next_to_video = widgets.save_next_to_video:get_value() == 1
  config.overwrite = widgets.overwrite:get_value() == 2
  config.per_language = S.per_language(widgets.per_language:get_text())
  local api_base = widgets.api_base:get_text()
  if api_base and api_base ~= "" then
    config.api_base = api_base
    S.API_BASE = api_base
  end
  save_config()
  show_main()
end

function show_help()
  close_dlg()
  dlg = vlc.dialog("SubtitleDB help")
  dlg:add_label("<b>Subtitles from the SubtitleDB open index.</b>", 1, 1, 4, 1)
  dlg:add_label("There is no account, no key and no quota. Nothing to sign up for.", 1, 2, 4, 1)
  dlg:add_label("<b>Search this file</b> uses what the file name says: the title,"
    .. " the year, and the season and episode when it has them.", 1, 3, 4, 1)
  dlg:add_label("<b>Search by name</b> ignores the IMDb id and searches the title"
    .. " you typed instead.", 1, 4, 4, 1)
  dlg:add_label("A subtitle recorded against the exact file you are playing is"
    .. " listed first, because that is the one that will be in sync.", 1, 5, 4, 1)
  dlg:add_label("Downloads are saved beside the video by default, named so VLC"
    .. " loads them on its own next time.", 1, 6, 4, 1)
  dlg:add_button("Back", show_main, 4, 7, 1, 1)
end
