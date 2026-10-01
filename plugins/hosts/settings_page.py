#!/usr/bin/env python3
"""SubtitleDB's settings page in Jellyfin's or Emby's own web app, in a real browser.

    python3 settings_page.py jellyfin|emby <url> [screenshot]

Signs in as mediaserver.py's user and opens the page the server lists for the plugin.
The page must show what the server holds, with every field labelled. Unticking "Get
latest subtitles on play" and saving must reach the server and say it saved, and so
must ticking it again. An error thrown by the page's script fails it, told from the
server's own by the name the script gives itself; the server's own are printed. Writes
what the browser showed to [screenshot] when it fails. Needs playwright and its Chromium.
"""

from __future__ import annotations

import re
import sys
import time

import mediaserver as M
from playwright.sync_api import sync_playwright

LABEL = "Get latest subtitles on play"
FIELDS = (LABEL, "Subtitles per language", "API address")
SAVED = re.compile(r"settings saved", re.IGNORECASE)
#: In the stack of an error the page's script threw: the script names itself with a
#: sourceURL comment. Jellyfin 10.11 and 12 throw errors of their own on any page.
OURS = re.compile(r"subtitledb", re.IGNORECASE)


def same_id(a, b):
    return (a or "").replace("-", "").lower() == (b or "").replace("-", "").lower()


def page_name(server, plugin):
    """The page the server opens from the plugin's entry in its plugin list."""
    query = {"PageType": "PluginConfiguration"} if server.kind == "emby" else None
    pages = server.call("GET", "/web/ConfigurationPages", query=query) or []
    ours = [p["Name"] for p in pages if same_id(p.get("PluginId"), plugin["Id"])]
    print("the server lists %s for %s" % (ours, M.PROVIDER))
    if len(ours) != 1:
        raise M.Failure("%s should have one settings page, the server lists %s" % (
            M.PROVIDER, [(p.get("Name"), p.get("PluginId")) for p in pages]))
    return ours[0]


def press(page, server, label):
    """Click what ``label`` names. Emby's sign-in cards act on a click on their tile and
    ignore one on the name under it, so there it is the tile above the name, or the
    middle of the card when the name's element is the whole card."""
    if server.kind != "emby":
        label.click()
        return
    box = label.bounding_box()
    y = box["y"] - 40 if box["height"] < 60 else box["y"] + box["height"] / 2
    page.mouse.click(box["x"] + box["width"] / 2, y)


def sign_in(page, server):
    """Through the sign-in page, whether it shows the users or asks for a name."""
    page.goto(server.base + "/web/index.html")
    password = page.locator("input[type=password]:visible")
    # A button in Jellyfin, a card beside the users' in Emby.
    manual = page.get_by_text(re.compile(r"manual login", re.IGNORECASE)).filter(visible=True)
    user = page.get_by_text(M.USER, exact=True).filter(visible=True)
    end = time.time() + 90
    while not password.count():
        if time.time() > end:
            raise M.Failure("no sign-in form")
        if manual.count():
            press(page, server, manual.first)
        elif user.count():
            press(page, server, user.first)
        page.wait_for_timeout(1000)
    name = page.locator("input:visible:not([type=password]):not([type=checkbox])")
    if name.count():
        name.first.fill(M.USER)
    password.first.fill(M.PASSWORD)
    password.first.press("Enter")
    page.wait_for_function("() => !/login|startup|selectserver/i.test(location.href)",
                           timeout=60_000)


def open_page(page, server, name):
    route = "#!/" if server.kind == "emby" else "#/"
    page.goto("%s/web/index.html%sconfigurationpage?name=%s" % (server.base, route, name))
    # Filled from the server: the address is never empty.
    page.wait_for_function(
        "() => { const i = document.querySelector('#ApiBase'); return !!(i && i.value); }",
        timeout=60_000)


def shown(page):
    return {"LookUpOnPlay": page.locator("#LookUpOnPlay").is_checked(),
            "PerLanguage": int(page.locator("#PerLanguage").input_value()),
            "ApiBase": page.locator("#ApiBase").input_value()}


def save_with(page, server, path, on):
    """Set the box by its label, save, and wait for the server to hold it and the page
    to say so."""
    box = page.locator("#LookUpOnPlay")
    if box.is_checked() != on:
        page.get_by_text(LABEL, exact=True).first.click()
    if box.is_checked() != on:
        raise M.Failure("clicking '%s' did not change the box" % LABEL)
    page.locator("#SubtitleDbConfigPage button[type=submit]").click()
    said, held, end = False, None, time.time() + 20
    while time.time() < end and not (said and held is on):
        said = said or page.get_by_text(SAVED).count() > 0
        held = (server.call("GET", path) or {}).get("LookUpOnPlay")
        time.sleep(0.2)
    if held is not on:
        raise M.Failure("saved with the box %s, the server holds %s" % (on, held))
    if not said:
        raise M.Failure("the server holds it, the page never said it saved")


def run(kind, url, shot=None) -> int:
    server = M.Server(kind, url)
    info = server.wait_ready()
    print("%s %s" % (info.get("ProductName") or kind, info.get("Version")))
    server.login()
    plugin = server.plugin()
    path = "/Plugins/%s/Configuration" % plugin["Id"]
    errors, noise = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda err: errors.append(err.stack or err.message))
        page.on("console", lambda msg: msg.type == "error" and noise.append(msg.text))
        step = "sign in"
        try:
            sign_in(page, server)
            step = "open the page"
            name = page_name(server, plugin)
            open_page(page, server, name)
            step = "read the page"
            held = server.call("GET", path) or {}
            want = {key: held.get(key) for key in shown(page)}
            if shown(page) != want:
                raise M.Failure("the page shows %s, the server holds %s" % (shown(page), want))
            hidden = [text for text in FIELDS
                      if not page.get_by_text(text, exact=True).first.is_visible()]
            if hidden:
                raise M.Failure("no visible label %s" % hidden)
            print("PASS  shows what the server holds: %s" % want)
            step = "untick and save"
            save_with(page, server, path, False)
            print("PASS  unticked '%s' and saved" % LABEL)
            step = "tick and save"
            save_with(page, server, path, True)
            print("PASS  ticked it again and saved")
            for line in errors:
                if not OURS.search(line):
                    print("  the server's web app threw: %s" % line.splitlines()[0][:300])
            ours = [line for line in errors if OURS.search(line)]
            if ours:
                raise M.Failure("the page's script threw %s" % ours)
        except Exception as err:  # what the browser showed is the whole report
            print("FAIL  %s: %s" % (step, err))
            print("  at %s" % page.url)
            for line in errors + noise:
                print("  console: %s" % line[:300])
            try:
                print("  page: %s" % re.sub(r"\s+", " ", page.locator("body").inner_text())[:800])
                if shot:
                    page.screenshot(path=shot, full_page=True)
            except Exception as gone:  # the page may be what broke
                print("  the page could not be read: %s" % gone)
            return 1
        finally:
            browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(run(*sys.argv[1:4]))
