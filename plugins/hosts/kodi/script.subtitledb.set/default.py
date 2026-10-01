"""Test helper: set one of the SubtitleDB addon's settings from inside Kodi.

    RunAddon(script.subtitledb.set, id=<setting>, value=<value>)
"""
import sys

import xbmc
import xbmcaddon

args = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
xbmcaddon.Addon("service.subtitles.subtitledb").setSetting(args["id"], args["value"])
xbmc.log("[script.subtitledb.set] %s=%s" % (args["id"], args["value"]), xbmc.LOGINFO)
