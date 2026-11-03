using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace SubtitleDb.Core.Sync
{
    /// <summary>One subtitle cue, times in seconds.</summary>
    public sealed class Cue
    {
        public Cue(double start, double end, string text)
        {
            Start = start;
            End = end;
            Text = text;
        }

        public double Start { get; }

        public double End { get; }

        public string Text { get; }
    }

    public enum SubtitleFormat
    {
        Srt,
        Vtt,
        Ass,
    }

    /// <summary>
    /// SRT, WebVTT and ASS/SSA, as in subtitledb-sync's subtitle.ts. Keeps the original
    /// lines so a re-timed file differs only in its timestamps; the BOM and line endings
    /// are kept too.
    /// </summary>
    public sealed class SubtitleDoc
    {
        private static readonly Regex SrtTs = new Regex(@"(\d+):(\d\d):(\d\d)[,.](\d{1,3})", RegexOptions.CultureInvariant);
        private static readonly Regex VttTs = new Regex(@"(?:(\d+):)?(\d\d):(\d\d)\.(\d{3})", RegexOptions.CultureInvariant);
        private static readonly Regex AssTs = new Regex(@"(\d+):(\d\d):(\d\d)\.(\d\d)", RegexOptions.CultureInvariant);

        private readonly string[] _lines;
        private readonly int[] _timingLines;
        private readonly int _assStart;
        private readonly int _assEnd;
        private readonly int _assText;

        private SubtitleDoc(SubtitleFormat format, Cue[] cues, string[] lines, int[] timingLines, string newline, bool bom, int assStart = 1, int assEnd = 2, int assText = 9)
        {
            Format = format;
            Cues = cues;
            _lines = lines;
            _timingLines = timingLines;
            Newline = newline;
            Bom = bom;
            _assStart = assStart;
            _assEnd = assEnd;
            _assText = assText;
        }

        public SubtitleFormat Format { get; }

        public IReadOnlyList<Cue> Cues { get; }

        public string Newline { get; }

        public bool Bom { get; }

        public static SubtitleFormat DetectFormat(string text)
        {
            var head = text.Length > 2000 ? text.Substring(0, 2000) : text;
            if (Regex.IsMatch(head, "^﻿?WEBVTT"))
            {
                return SubtitleFormat.Vtt;
            }

            if (Regex.IsMatch(head, @"^\[Script Info\]", RegexOptions.Multiline) || Regex.IsMatch(text, @"^\[Events\]", RegexOptions.Multiline))
            {
                return SubtitleFormat.Ass;
            }

            return SubtitleFormat.Srt;
        }

        /// <summary>The format from the extension when it names one, else from the text.</summary>
        public static SubtitleDoc Parse(string text, string? extension = null)
        {
            var format = (extension ?? string.Empty).TrimStart('.').ToLowerInvariant() switch
            {
                "srt" => SubtitleFormat.Srt,
                "vtt" => SubtitleFormat.Vtt,
                "ass" or "ssa" => SubtitleFormat.Ass,
                _ => DetectFormat(text),
            };

            var bom = text.StartsWith("﻿", StringComparison.Ordinal);
            if (bom)
            {
                text = text.Substring(1);
            }

            var newline = text.Contains("\r\n") ? "\r\n" : "\n";
            var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            return format == SubtitleFormat.Ass ? ParseAss(lines, newline, bom) : ParseSrtOrVtt(lines, format, newline, bom);
        }

        /// <summary>A copy with every cue time mapped through <paramref name="map"/>, text untouched.</summary>
        public SubtitleDoc Retime(Func<double, double> map) =>
            new SubtitleDoc(
                Format,
                Cues.Select(c => new Cue(map(c.Start), map(c.End), c.Text)).ToArray(),
                _lines,
                _timingLines,
                Newline,
                Bom,
                _assStart,
                _assEnd,
                _assText);

        /// <summary>A copy with <paramref name="prefix"/> at the start of every cue's text.</summary>
        public SubtitleDoc Prefix(string prefix)
        {
            var lines = (string[])_lines.Clone();
            var cues = new Cue[Cues.Count];
            for (var i = 0; i < cues.Length; i++)
            {
                var c = Cues[i];
                var li = _timingLines[i];
                if (Format == SubtitleFormat.Ass)
                {
                    if (_assText >= 0)
                    {
                        // Insert after the comma that opens the Text field, so tags stay valid.
                        var at = 9;
                        for (var f = 0; f < _assText && at >= 0; f++)
                        {
                            at = lines[li].IndexOf(',', at);
                            at = at < 0 ? -1 : at + 1;
                        }

                        if (at >= 0)
                        {
                            lines[li] = lines[li].Substring(0, at) + prefix + lines[li].Substring(at);
                        }
                    }
                }
                else if (li + 1 < lines.Length && lines[li + 1].Trim().Length > 0)
                {
                    lines[li + 1] = prefix + lines[li + 1];
                }

                cues[i] = new Cue(c.Start, c.End, prefix + c.Text);
            }

            return new SubtitleDoc(Format, cues, lines, _timingLines, Newline, Bom, _assStart, _assEnd, _assText);
        }

        /// <summary>Back into the document's own format, rewriting only timing lines.</summary>
        public string Stringify()
        {
            var lines = (string[])_lines.Clone();
            for (var i = 0; i < Cues.Count; i++)
            {
                var li = _timingLines[i];
                var c = Cues[i];
                var old = lines[li];
                if (Format == SubtitleFormat.Ass)
                {
                    var parts = old.Substring(9).Split(',');
                    parts[_assStart] = FormatAssTime(c.Start);
                    parts[_assEnd] = FormatAssTime(c.End);
                    lines[li] = old.Substring(0, 9) + string.Join(",", parts);
                }
                else if (Format == SubtitleFormat.Vtt)
                {
                    var arrow = old.IndexOf("-->", StringComparison.Ordinal);
                    var rest = VttTs.Replace(old.Substring(arrow + 3), string.Empty, 1).TrimStart();
                    lines[li] = $"{FormatVttTime(c.Start)} --> {FormatVttTime(c.End)}" + (rest.Length > 0 ? " " + rest : string.Empty);
                }
                else
                {
                    lines[li] = $"{FormatSrtTime(c.Start)} --> {FormatSrtTime(c.End)}";
                }
            }

            return (Bom ? "﻿" : string.Empty) + string.Join(Newline, lines);
        }

        public static string FormatSrtTime(double t)
        {
            var (h, m, s, ms) = Split(t);
            return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00},{3:000}", h, m, s, ms);
        }

        public static string FormatVttTime(double t)
        {
            var (h, m, s, ms) = Split(t);
            return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}.{3:000}", h, m, s, ms);
        }

        public static string FormatAssTime(double t)
        {
            var total = Math.Max(0, Signals.RoundLong(t * 100));
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0}:{1:00}:{2:00}.{3:00}",
                total / 360000,
                total % 360000 / 6000,
                total % 6000 / 100,
                total % 100);
        }

        private static (long H, long M, long S, long Ms) Split(double t)
        {
            var total = Math.Max(0, Signals.RoundLong(t * 1000));
            return (total / 3600000, total % 3600000 / 60000, total % 60000 / 1000, total % 1000);
        }

        private static double? SrtTime(string s)
        {
            var m = SrtTs.Match(s);
            if (!m.Success)
            {
                return null;
            }

            return (Num(m.Groups[1]) * 3600) + (Num(m.Groups[2]) * 60) + Num(m.Groups[3]) + (Num(m.Groups[4].Value.PadRight(3, '0')) / 1000);
        }

        private static double? VttTime(string s)
        {
            var m = VttTs.Match(s);
            if (!m.Success)
            {
                return null;
            }

            var h = m.Groups[1].Success ? Num(m.Groups[1]) : 0;
            return (h * 3600) + (Num(m.Groups[2]) * 60) + Num(m.Groups[3]) + (Num(m.Groups[4]) / 1000);
        }

        private static double? AssTime(string s)
        {
            var m = AssTs.Match(s);
            if (!m.Success)
            {
                return null;
            }

            return (Num(m.Groups[1]) * 3600) + (Num(m.Groups[2]) * 60) + Num(m.Groups[3]) + (Num(m.Groups[4]) / 100);
        }

        private static double Num(Group g) => Num(g.Value);

        private static double Num(string s) => double.Parse(s, NumberStyles.None, CultureInfo.InvariantCulture);

        private static SubtitleDoc ParseSrtOrVtt(string[] lines, SubtitleFormat format, string newline, bool bom)
        {
            var cues = new List<Cue>();
            var timing = new List<int>();
            Func<string, double?> time = format == SubtitleFormat.Vtt ? VttTime : SrtTime;
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                var arrow = line.IndexOf("-->", StringComparison.Ordinal);
                if (arrow < 0)
                {
                    continue;
                }

                var start = time(line.Substring(0, arrow));
                var end = time(line.Substring(arrow + 3));
                if (start == null || end == null)
                {
                    continue;
                }

                var text = new List<string>();
                for (var j = i + 1; j < lines.Length && lines[j].Trim().Length > 0; j++)
                {
                    text.Add(lines[j]);
                }

                cues.Add(new Cue(start.Value, end.Value, string.Join("\n", text)));
                timing.Add(i);
            }

            return new SubtitleDoc(format, cues.ToArray(), lines, timing.ToArray(), newline, bom);
        }

        private static SubtitleDoc ParseAss(string[] lines, string newline, bool bom)
        {
            var cues = new List<Cue>();
            var timing = new List<int>();
            int startField = 1, endField = 2, textField = 9;
            var inEvents = false;
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                if (line.StartsWith("[", StringComparison.Ordinal))
                {
                    inEvents = line.StartsWith("[Events]", StringComparison.OrdinalIgnoreCase);
                    continue;
                }

                if (!inEvents)
                {
                    continue;
                }

                if (line.StartsWith("Format:", StringComparison.OrdinalIgnoreCase))
                {
                    var fields = line.Substring(7).Split(',').Select(f => f.Trim().ToLowerInvariant()).ToList();
                    startField = Math.Max(0, fields.IndexOf("start"));
                    endField = Math.Max(0, fields.IndexOf("end"));
                    textField = fields.IndexOf("text");
                    continue;
                }

                if (!line.StartsWith("Dialogue:", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var parts = line.Substring(9).Split(',');
                var start = startField < parts.Length ? AssTime(parts[startField]) : null;
                var end = endField < parts.Length ? AssTime(parts[endField]) : null;
                if (start == null || end == null)
                {
                    continue;
                }

                var text = textField >= 0 && textField < parts.Length ? string.Join(",", parts.Skip(textField)).Trim() : string.Empty;
                cues.Add(new Cue(start.Value, end.Value, text));
                timing.Add(i);
            }

            return new SubtitleDoc(SubtitleFormat.Ass, cues.ToArray(), lines, timing.ToArray(), newline, bom, startField, endField, textField);
        }
    }
}
