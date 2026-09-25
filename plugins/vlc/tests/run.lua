--[[
 The VLC extension's tests.

    tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua

 subtitledb.lua is loaded with `vlc` absent, which is the point: everything that
 decides anything has to work without a media player, and the parts that do not
 are the ones VLC itself is responsible for.

 The shared cases in plugins/shared/match-cases.json are read with the extension's
 own JSON decoder, so the fixture file is also the decoder's hardest test.
--]]

local failures, checks = 0, 0
local current = "?"

local function fail(message)
  failures = failures + 1
  print(string.format("  FAIL  %s: %s", current, message))
end

local function ok(condition, message)
  checks = checks + 1
  if not condition then fail(message or "assertion failed") end
end

local function equal(got, want, message)
  checks = checks + 1
  if got ~= want then
    fail(string.format("%s: got %s, wanted %s", message or "not equal",
                       tostring(got), tostring(want)))
  end
end

local function near(got, want, message)
  checks = checks + 1
  if math.abs(got - want) > 1e-9 then
    fail(string.format("%s: got %s, wanted %s", message or "not close",
                       tostring(got), tostring(want)))
  end
end

local function test(name, body)
  current = name
  local success, err = pcall(body)
  if not success then fail("error: " .. tostring(err)) end
end

-- VLC is not here. Anything reaching for it is a bug in the file, not in the test.
local here = arg[0]:match("^(.*)[/\\][^/\\]*$") or "."
dofile(here .. "/../subtitledb.lua")
local S = SubtitleDb

-- ---------------------------------------------------------------- the decoder

test("json reads the shapes the API sends", function()
  local value = S.json.decode('{"total": 3, "results": [{"imdb": "tt1", "year": 2023}]}')
  equal(value.total, 3)
  equal(value.results[1].imdb, "tt1")
  equal(value.results[2], nil)
end)

test("json keeps null distinct from a missing key", function()
  -- season null and no season at all mean different things: one is a film, the
  -- other is a row sub_meta has no entry for.
  local value = S.json.decode('{"season": null}')
  ok(value.season == S.json.null, "null decoded as something else")
  equal(S.get(value, "season"), nil)
  equal(S.get(value, "episode"), nil)
end)

test("json reads escapes, including the ones outside the BMP", function()
  equal(S.json.decode('"a\\nb"'), "a\nb")
  equal(S.json.decode('"\\u00e9"'), "\195\169")
  equal(S.json.decode('"\\ud83c\\udfac"'), "\240\159\142\172")
  equal(S.json.decode('"a\\/b"'), "a/b")
end)

test("json refuses what it cannot read rather than guessing", function()
  -- A decoder that guesses turns a broken answer into wrong subtitles.
  for _, bad in ipairs({ "", "{", "[1,]", '{"a"}', "tru", '{"a":1} trailing', "'x'" }) do
    local value, err = S.json.decode(bad)
    ok(value == nil, "accepted " .. string.format("%q", bad))
    ok(type(err) == "string" and #err > 0, "no message for " .. string.format("%q", bad))
  end
end)

test("json reads numbers the way the API writes them", function()
  equal(S.json.decode("[1]")[1], 1)
  near(S.json.decode("[23.976]")[1], 23.976)
  equal(S.json.decode("[-5]")[1], -5)
  near(S.json.decode("[1e3]")[1], 1000)
end)

-- --------------------------------------------------------------- the fixtures

local function read_file(path)
  local file = assert(io.open(path, "rb"), "cannot open " .. path)
  local body = file:read("*a")
  file:close()
  return body
end

local cases = assert(S.json.decode(read_file(here .. "/../../shared/match-cases.json")),
                     "the shared cases did not decode")

test("similarity agrees with the other languages", function()
  for _, case in ipairs(cases.similarity) do
    current = "similarity: " .. (case.why or (case.a .. " ~ " .. case.b))
    local got = S.similarity(case.a, case.b)
    if S.get(case, "min") then
      ok(got >= case.min - 1e-9, string.format("%.3f is under %.3f", got, case.min))
    end
    if S.get(case, "max") then
      ok(got <= case.max + 1e-9, string.format("%.3f is over %.3f", got, case.max))
    end
  end
end)

test("subtitles rank the way they do everywhere else", function()
  for _, case in ipairs(cases.subtitle_ranking) do
    current = "subtitle ranking: " .. case.why
    local options = case.options
    local hint = {
      release = S.get(options, "release"),
      season = S.get(options, "season"),
      episode = S.get(options, "episode"),
    }
    local opts = {
      languages = S.get(options, "languages") or {},
      hearing_impaired = S.get(options, "hearing_impaired"),
      formats = S.get(options, "formats"),
    }
    local ranked, unrenderable = S.rank(case.subtitles, hint, opts)
    local got = {}
    for _, candidate in ipairs(ranked) do got[#got + 1] = candidate.id end
    equal(#got, #case.expect_order, "wrong number of candidates")
    for i, want in ipairs(case.expect_order) do
      equal(got[i], want, "position " .. i)
    end
    if S.get(case, "expect_unrenderable") then
      equal(unrenderable, case.expect_unrenderable)
    end
  end
end)

test("languages resolve to the same names", function()
  for _, case in ipairs(cases.languages) do
    -- The extension carries names for the codes it lists in its dropdowns, and
    -- resolves nothing else: the three-letter and regional spellings are a media
    -- server's problem, and VLC has no media server.
    local code = S.get(case, "code")
    if code and S.language_name(code) then
      equal(S.language_name(code), case.name, "name for " .. code)
    end
  end
end)

-- --------------------------------------------------------------- the filename

test("a film name gives up its title and year", function()
  local got = S.parse_filename("/media/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv")
  equal(got.title, "Anatomy of a Fall")
  equal(got.year, 2023)
  equal(got.season, nil)
  equal(got.group, "KOVAL")
  equal(got.container, "mkv")
end)

test("an episode name gives up its numbers", function()
  local got = S.parse_filename("Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv")
  equal(got.title, "Breaking Bad")
  equal(got.season, 5)
  equal(got.episode, 14)
end)

test("the other ways an episode is written", function()
  for _, case in ipairs({
    { "Show.1x02.mkv", 1, 2 },
    { "Show.Season 3 Episode 7.mkv", 3, 7 },
    { "Show.s01.e02.mkv", 1, 2 },
    { "Show.S01E02E03.mkv", 1, 2 },
  }) do
    current = "episode marker: " .. case[1]
    local got = S.parse_filename(case[1])
    equal(got.season, case[2], "season")
    equal(got.episode, case[3], "episode")
  end
end)

test("WEB-DL is not a release group called DL", function()
  local got = S.parse_filename("Some.Film.2019.1080p.WEB-DL.mkv")
  equal(got.group, nil)
  equal(got.title, "Some Film")
  local other = S.parse_filename("Some.Film.2019.1080p.Blu-Ray.mkv")
  equal(other.group, nil)
end)

test("a series called 2012 is not a year", function()
  local got = S.parse_filename("2012.S01E01.720p.mkv")
  equal(got.title, "2012")
  equal(got.year, nil)
  equal(got.season, 1)
end)

test("a resolution is not a year", function()
  equal(S.parse_filename("Film.2160p.mkv").year, nil)
  equal(S.parse_filename("Film.1080p.x264.mkv").year, nil)
end)

test("a url is read as the file at the end of it", function()
  equal(S.basename("https://host/path/The%20Matrix%201999.mkv?token=abc"),
        "The Matrix 1999.mkv")
  local got = S.parse_filename("file:///media/The%20Matrix.1999.mkv")
  equal(got.title, "The Matrix")
  equal(got.year, 1999)
end)

test("a name with nothing in it does not throw", function()
  for _, input in ipairs({ "", "x", "....mkv", "/", "file://" }) do
    current = "empty name: " .. string.format("%q", input)
    local got = S.parse_filename(input)
    ok(type(got.title) == "string", "no title field")
  end
end)

-- -------------------------------------------------------------------- the API

test("a request names the route the API serves and identifies the client", function()
  local url = S.build_url("/v1/by-title", { { "q", "anatomy of a fall" } })
  ok(url:find("/v1/by-title", 1, true) ~= nil, "wrong path: " .. url)
  ok(url:find("q=anatomy%%20of%%20a%%20fall") ~= nil, "query not encoded: " .. url)
  ok(url:find("client=vlc", 1, true) ~= nil, "no client parameter")
end)

test("an empty parameter is left off rather than sent empty", function()
  -- lang= is not "no language filter", it is a filter for the empty language.
  local url = S.build_url("/v1/by-imdb/1", { { "lang", nil }, { "limit", 100 } })
  ok(url:find("lang=") == nil, "an empty lang was sent: " .. url)
  ok(url:find("limit=100", 1, true) ~= nil)
end)

test("the ladder asks by id first, then falls back to the title", function()
  local asked = {}
  local saved = S.fetch
  S.fetch = function(url)
    asked[#asked + 1] = url
    if url:find("by-imdb/17009710", 1, true) then
      return '{"title":{},"subtitles":{"items":[{"id":1,"language":"en","format":"srt",'
        .. '"cues":900,"download_url":"https://api.thesubtitledb.org/get/1"}]}}'
    end
    return '{"error":"not_found","message":"no such title"}'
  end
  local found = S.search({ imdb_id = "tt17009710" }, { languages = { "en" } })
  S.fetch = saved
  equal(#found, 1)
  equal(#asked, 1, "a title lookup was made even though the id answered")
end)

test("the answer says which title it was for", function()
  -- Found by the live run: "Friends" resolved to another show, and the list gave
  -- no sign of it.
  local saved = S.fetch
  S.fetch = function()
    return '{"title":{"imdb":"tt26591147","name":"Matlock","year":2024},'
      .. '"subtitles":{"items":[{"id":1,"language":"en","format":"srt","cues":900}]}}'
  end
  local _, _, info = S.search({ title = "Friends", season = 1, episode = 1 }, { languages = { "en" } })
  S.fetch = saved
  equal(S.get(info.title, "imdb"), "tt26591147")
  equal(S.title_line(info.title), " for Matlock (2024)")
  equal(S.title_line(nil), "")
end)

test("one request per language, a fan-out we choose not one lang forces", function()
  local langs = {}
  local saved = S.fetch
  S.fetch = function(url)
    langs[#langs + 1] = url:match("lang=(%w+)")
    local id = #langs
    return string.format('{"title":{},"subtitles":{"items":[{"id":%d,"language":"%s",'
      .. '"format":"srt","cues":900}]}}', id, langs[#langs])
  end
  local found = S.search({ imdb_id = "tt1" }, { languages = { "fr", "en" } })
  S.fetch = saved
  equal(#langs, 2)
  equal(langs[1], "fr")
  equal(#found, 2)
  equal(S.get(found[1].row, "language"), "fr", "the caller's language order was lost")
end)

test("an explicit tmdb id leads, and a 404 there falls through to imdb", function()
  -- tmdb is the headline key, but its map is only partial, so by-tmdb 404s for many
  -- ids and the imdb rung answers.
  local asked = {}
  local saved = S.fetch
  S.fetch = function(url)
    asked[#asked + 1] = url
    if url:find("by-tmdb", 1, true) then
      return '{"error":"not_found","message":"no map"}'
    end
    return '{"title":{},"subtitles":{"items":[{"id":3,"language":"en","format":"srt","cues":900}]}}'
  end
  local found, _, info = S.search({ tmdb_id = 603, imdb_id = "tt1" }, { languages = { "en" } })
  S.fetch = saved
  equal(#found, 1)
  equal(info.tier, "explicit-imdb")
  ok(asked[1]:find("by-tmdb/603", 1, true) ~= nil, "tmdb was not tried first")
end)

test("an episode drills by title on the season and episode numbers", function()
  local asked = {}
  local saved = S.fetch
  S.fetch = function(url)
    asked[#asked + 1] = url
    return '{"title":{},"subtitles":{"items":[{"id":7,"language":"en",'
      .. '"format":"srt","cues":900,"season":5,"episode":14}]}}'
  end
  local found, _, info = S.search(
    { title = "Breaking Bad", season = 5, episode = 14 }, { languages = { "en" } })
  S.fetch = saved
  equal(#found, 1)
  equal(found[1].id, 7)
  equal(info.tier, "title")
  ok(asked[1]:find("/season/5/episode/14", 1, true) ~= nil, "the drill was not in the path")
end)

test("an answer that is not JSON is reported, not swallowed", function()
  local saved = S.fetch
  S.fetch = function() return "<html>502 Bad Gateway</html>" end
  local found, err = S.search({ imdb_id = "tt1" }, { languages = {} })
  S.fetch = saved
  ok(err ~= nil and err:find("unreadable", 1, true) ~= nil, "not the parse error: " .. tostring(err))
  equal(#found, 0)
end)

--- A fetch that pages the way the API does: at most `limit` rows, from `offset`.
local function paged(total, asked, honour_offset)
  return function(url)
    asked[#asked + 1] = url
    local offset = honour_offset == false and 0 or tonumber(url:match("offset=(%d+)") or "0")
    local rows = {}
    for id = offset + 1, math.min(offset + tonumber(url:match("limit=(%d+)")), total) do
      rows[#rows + 1] = string.format('{"id":%d,"language":"en","format":"srt","cues":900}', id)
    end
    return string.format('{"title":{},"subtitles":{"total":%d,"items":[%s]}}',
      total, table.concat(rows, ","))
  end
end

test("with no language chosen it asks once, unfiltered", function()
  -- ipairs reads { nil } as empty, so this once asked nothing and said "no answer".
  local asked, saved = {}, S.fetch
  S.fetch = paged(3, asked)
  local found, err = S.search({ imdb_id = "tt1" }, { languages = {} })
  S.fetch = saved
  equal(err, nil)
  equal(#found, 3)
  equal(#asked, 1)
  ok(asked[1]:find("lang=", 1, true) == nil, "a language was sent: " .. asked[1])
end)

test("a long list is read past the first hundred", function()
  -- The API sends rows in the order they were added, so the one in sync with the
  -- file can sit on page three. The Matrix has 147 English rows.
  local asked, saved = {}, S.fetch
  S.fetch = paged(250, asked)
  local found = S.search({ imdb_id = "tt1" }, { languages = { "en" }, limit = 500 })
  S.fetch = saved
  equal(#found, 250)
  equal(#asked, 3)
  ok(asked[1]:find("offset=", 1, true) == nil, "the first page carried an offset")
  ok(asked[3]:find("limit=100&offset=200", 1, true) ~= nil, asked[3])
end)

test("the limit ends the read", function()
  local asked, saved = {}, S.fetch
  S.fetch = paged(1000, asked)
  local found = S.search({ imdb_id = "tt1" }, { languages = { "en" }, limit = 150 })
  S.fetch = saved
  equal(#found, 150)
  equal(#asked, 2)
  ok(asked[2]:find("limit=50&offset=100", 1, true) ~= nil, asked[2])
end)

test("a page that brings nothing new ends the read", function()
  -- What a server that ignored offset would send, and what one past its offset cap
  -- does send. Reading on would ask the same page again until the limit.
  local asked, saved = {}, S.fetch
  S.fetch = paged(1000, asked, false)
  local found = S.search({ imdb_id = "tt1" }, { languages = { "en" }, limit = 500 })
  S.fetch = saved
  equal(#found, 100)
  equal(#asked, 2)
end)

test("a setting is read as rows per language", function()
  equal(S.per_language(nil), 500)
  equal(S.per_language(""), 500)
  equal(S.per_language("junk"), 500)
  equal(S.per_language("300"), 300)
  equal(S.per_language(0), 100)
  equal(S.per_language("99999"), 2000)
end)

-- ------------------------------------------------------------- where it lands

test("a download is named so VLC picks it up on its own next time", function()
  local candidate = { id = 7, row = { format = "srt", language = "en" } }
  equal(S.target_path("file:///media/Film.2023.mkv", candidate, true, "/tmp"),
        "/media/Film.2023.en.srt")
end)

test("the stored format is kept, because it decides the parser", function()
  local candidate = { id = 7, row = { format = "ass", language = "fr" } }
  equal(S.target_path("file:///media/Film.mkv", candidate, true, "/tmp"),
        "/media/Film.fr.ass")
end)

test("a stream that is not a local file falls back to VLC's own directory", function()
  local candidate = { id = 7, row = { format = "srt", language = "en" } }
  equal(S.target_path("https://host/Film.mkv", candidate, true, "/cfg"),
        "/cfg/subtitledb-7.srt")
end)

test("on Windows the URI carries a drive letter, and the path starts there", function()
  -- file:///C:/... minus the scheme is /C:/..., which is no path on Windows, and
  -- VLC there loads a subtitle from C:\x\Film.en.srt but not from C:/x/Film.en.srt.
  local candidate = { id = 7, row = { format = "srt", language = "en" } }
  equal(S.target_path("file:///C:/Users/x/Film.mkv", candidate, true, "C:\\tmp"),
        "C:\\Users\\x\\Film.en.srt")
  equal(S.target_path("file:///C:/x/Am%C3%A9lie%20%282001%29/Am%C3%A9lie.2001.mkv",
                      candidate, true, "C:\\tmp"),
        "C:\\x\\Amélie (2001)\\Amélie.2001.en.srt")
end)

test("a share gets back the two slashes the scheme took, as backslashes", function()
  local candidate = { id = 7, row = { format = "srt", language = "en" } }
  equal(S.target_path("file://server/share/Film.mkv", candidate, true, "/tmp"),
        "\\\\server\\share\\Film.en.srt")
end)

test("a name the index has no title for is said to be missing, not an outage", function()
  -- VLC's stream comes back empty for a 404 and for a dead host alike, and the
  -- extension used to report both as no answer from the API.
  local saved = S.fetch
  local miss = S.NO_ANSWER .. S.API_BASE
  S.fetch = function(url)
    if url:find(S.PROBE_PATH, 1, true) then return '{"title":{}}' end
    return nil, miss
  end
  equal(S.explain_miss(miss, { title = "Qwxvbn Kfjtrl" }), "No title matched Qwxvbn Kfjtrl")
  equal(S.explain_miss(miss, { imdb_id = "tt0000001" }), "No title matched tt0000001")
  S.fetch = function() return nil, miss end
  equal(S.explain_miss(miss, { title = "Qwxvbn Kfjtrl" }), "SubtitleDB did not answer")
  S.fetch = saved
  equal(S.explain_miss("unreadable answer: x", { title = "Film" }), "unreadable answer: x")
end)

-- ------------------------------------------------------ what VLC hands over

test("an episode is searched by its series, not the title VLC rewrote", function()
  -- VLC 3's own file name reader turns the title of Show.S01E01.mkv into
  -- "Show S01E01", which matches no title: the live run against 3.0.20 got a 404.
  local parsed = S.parse_filename("file:///tv/Game.of.Thrones.S01E01.720p.HDTV.x264-GROUP.mkv")
  local meta = { title = "Game of Thrones S01E01", showName = "Game of Thrones ",
                 seasonNumber = "01", episodeNumber = "01" }
  equal(S.guess_title(meta, parsed), "Game of Thrones")
  equal(S.guess_title({ showName = " Game of Thrones " }, { season = 1, episode = 1 }),
        "Game of Thrones", "showName when the name gave no title")
end)

test("a film keeps the title its file carries", function()
  local parsed = S.parse_filename("file:///films/Matrix.1999.1080p.mkv")
  equal(S.guess_title({ title = "The Matrix" }, parsed), "The Matrix")
  equal(S.guess_title({}, parsed), parsed.title)
end)

test("a download is loaded through whichever call this VLC has", function()
  -- vlc.player is VLC 4. VLC 3 has vlc.input.add_subtitle and nothing else: the live
  -- run against 3.0.20 saved the file and reported it loaded when it was not.
  local got = {}
  local function add(path, select) got[#got + 1] = { path, select } end
  ok(S.load_subtitle({ player = { add_subtitle = add } }, "/a.srt"), "VLC 4 call not used")
  ok(S.load_subtitle({ input = { add_subtitle = add } }, "/b.srt"), "VLC 3 call not used")
  equal(got[2] and got[2][1], "/b.srt")
  equal(got[2] and got[2][2], true, "not selected")
  ok(not S.load_subtitle({ input = { add_subtitle = function() error("no current input") end } },
                         "/c.srt"), "a call that raised reads as loaded")
  ok(not S.load_subtitle({}, "/d.srt"), "no call at all reads as loaded")
end)

-- ------------------------------------------------------------- what VLC needs

test("the file gives VLC the entry points it looks for", function()
  for _, name in ipairs({ "descriptor", "activate", "deactivate", "close", "menu",
                          "trigger_menu", "meta_changed" }) do
    ok(type(_G[name]) == "function", name .. " is missing")
  end
  local d = descriptor()
  equal(d.title, "SubtitleDB")
  ok(d.capabilities ~= nil, "no capabilities declared")
end)

test("it stays inside the Lua VLC actually embeds", function()
  -- VLC is on 5.1: no goto, no integer division, no utf8 library. This is the
  -- kind of thing that works everywhere it is tested and fails on a user's box.
  local source = read_file(here .. "/../subtitledb.lua")
  for _, banned in ipairs({ "goto ", "//", "utf8%.", "<close>", "<const>" }) do
    local at = source:find(banned)
    if at and banned == "//" then
      -- A // inside a string or a URL is not integer division.
      at = nil
      for position in source:gmatch("()//") do
        local line = source:sub(source:sub(1, position):find("\n[^\n]*$") or 1, position + 20)
        if not line:find("http") and not line:find('"') then at = position end
      end
    end
    ok(at == nil, "5.4-only syntax in the extension: " .. banned)
  end
end)

test("the file says it is MIT, because it travels alone", function()
  -- An extension is one .lua dropped into a directory, with no LICENSE beside it.
  local source = read_file(here .. "/../subtitledb.lua")
  ok(source:find("^%-%- SPDX%-License%-Identifier: MIT\n%-%- Copyright %(c%) 2026 TheSubtitleDb%.org\n"),
     "subtitledb.lua does not open with its license and copyright lines")
end)

print(string.format("%d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
