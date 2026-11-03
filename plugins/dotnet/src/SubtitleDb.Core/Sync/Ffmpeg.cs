using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Core.Sync
{
    /// <summary>A stream of a media file, as ffprobe lists it.</summary>
    public sealed class ProbeStream
    {
        public int Index { get; set; }

        /// <summary>audio, subtitle, video.</summary>
        public string Type { get; set; } = string.Empty;

        public string Codec { get; set; } = string.Empty;

        public int Channels { get; set; }

        public string? Language { get; set; }

        public bool IsDefault { get; set; }

        public bool IsForced { get; set; }
    }

    public sealed class MediaInfo
    {
        public double Duration { get; set; }

        public IReadOnlyList<ProbeStream> Streams { get; set; } = Array.Empty<ProbeStream>();
    }

    /// <summary>
    /// The host's own ffmpeg and ffprobe, which every media server ships. Only what the
    /// sync needs: the streams, a stretch of one audio stream as 16 kHz mono, and a
    /// text subtitle stream as SRT.
    /// </summary>
    public sealed class Ffmpeg
    {
        /// <summary>Subtitle codecs that are text, so ffmpeg can write them as SRT.</summary>
        public static readonly string[] TextCodecs = { "subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text" };

        private readonly string _ffmpeg;
        private readonly string _ffprobe;

        public Ffmpeg(string ffmpeg, string ffprobe)
        {
            _ffmpeg = ffmpeg;
            _ffprobe = ffprobe;
        }

        public async Task<MediaInfo> ProbeAsync(string video, CancellationToken cancellationToken)
        {
            var json = await RunAsync(
                _ffprobe,
                new[] { "-v", "error", "-print_format", "json", "-show_format", "-show_streams", video },
                cancellationToken).ConfigureAwait(false);
            return ParseProbe(json);
        }

        internal static MediaInfo ParseProbe(byte[] json)
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var info = new MediaInfo();
            if (root.TryGetProperty("format", out var format)
                && format.TryGetProperty("duration", out var d)
                && double.TryParse(d.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var duration))
            {
                info.Duration = duration;
            }

            var streams = new List<ProbeStream>();
            if (root.TryGetProperty("streams", out var list))
            {
                foreach (var s in list.EnumerateArray())
                {
                    var stream = new ProbeStream
                    {
                        Index = s.GetProperty("index").GetInt32(),
                        Type = Str(s, "codec_type") ?? string.Empty,
                        Codec = Str(s, "codec_name") ?? string.Empty,
                        Channels = s.TryGetProperty("channels", out var ch) && ch.ValueKind == JsonValueKind.Number ? ch.GetInt32() : 0,
                    };
                    if (s.TryGetProperty("tags", out var tags))
                    {
                        stream.Language = Str(tags, "language");

                        // Many releases title a forced track so and leave its flag unset.
                        stream.IsForced |= (Str(tags, "title") ?? string.Empty).IndexOf("forced", StringComparison.OrdinalIgnoreCase) >= 0;
                    }

                    if (s.TryGetProperty("disposition", out var disp))
                    {
                        stream.IsDefault = Flag(disp, "default");
                        stream.IsForced |= Flag(disp, "forced");
                    }

                    streams.Add(stream);
                }
            }

            info.Streams = streams;
            return info;
        }

        /// <summary>
        /// <paramref name="seconds"/> of audio from <paramref name="start"/>, 16 kHz mono.
        /// From 5 channels up only the centre one, where films put the dialogue: mixed
        /// down with music and effects, Silero found a third of the speech on the bench.
        /// </summary>
        public async Task<float[]> AudioAsync(string video, ProbeStream stream, double start, double seconds, CancellationToken cancellationToken)
        {
            IEnumerable<string> Args(bool centre) => new[]
            {
                "-nostdin", "-v", "error",
                "-ss", start.ToString("0.###", CultureInfo.InvariantCulture),
                "-t", seconds.ToString("0.###", CultureInfo.InvariantCulture),
                "-i", video,
                "-map", "0:" + stream.Index.ToString(CultureInfo.InvariantCulture),
            }
            .Concat(centre ? new[] { "-af", "pan=mono|c0=FC" } : Array.Empty<string>())
            .Concat(new[] { "-ac", "1", "-ar", "16000", "-f", "s16le", "-" });

            byte[] pcm;
            try
            {
                pcm = await RunAsync(_ffmpeg, Args(stream.Channels >= 5), cancellationToken).ConfigureAwait(false);
            }
            catch (IOException) when (stream.Channels >= 5)
            {
                // A layout with no centre channel; the plain mix will do.
                pcm = await RunAsync(_ffmpeg, Args(false), cancellationToken).ConfigureAwait(false);
            }

            var o = new float[pcm.Length / 2];
            for (var i = 0; i < o.Length; i++)
            {
                o[i] = (short)(pcm[2 * i] | (pcm[(2 * i) + 1] << 8)) / 32768f;
            }

            return o;
        }

        /// <summary>A text subtitle stream as SRT.</summary>
        public async Task<string> SubtitleAsync(string video, ProbeStream stream, CancellationToken cancellationToken)
        {
            var srt = await RunAsync(
                _ffmpeg,
                new[] { "-nostdin", "-v", "error", "-i", video, "-map", "0:" + stream.Index.ToString(CultureInfo.InvariantCulture), "-f", "srt", "-" },
                cancellationToken).ConfigureAwait(false);
            return Encoding.UTF8.GetString(srt);
        }

        /// <summary>Runs a program to the end and returns what it wrote; IOException when it fails.</summary>
        internal static async Task<byte[]> RunAsync(string program, IEnumerable<string> args, CancellationToken cancellationToken)
        {
            var info = new ProcessStartInfo(program, string.Join(" ", args.Select(Quote)))
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = false,
                CreateNoWindow = true,
            };

            using var process = new Process { StartInfo = info };
            try
            {
                process.Start();
            }
            catch (Exception err) when (!(err is OperationCanceledException))
            {
                throw new IOException(program + " did not start: " + err.Message, err);
            }

            try
            {
                // Low priority: this runs beside playback, and a stutter costs more than a slower sync.
                process.PriorityClass = ProcessPriorityClass.BelowNormal;
            }
            catch (Exception)
            {
                // Not allowed here; it runs at the normal priority.
            }

            using (cancellationToken.Register(() => Kill(process)))
            {
                var output = new MemoryStream();
                var copy = process.StandardOutput.BaseStream.CopyToAsync(output, 81920, cancellationToken);
                var errors = process.StandardError.ReadToEndAsync();
                await Task.WhenAll(copy, errors).ConfigureAwait(false);
                process.WaitForExit();
                cancellationToken.ThrowIfCancellationRequested();
                if (process.ExitCode != 0)
                {
                    var said = errors.Result.Trim();
                    throw new IOException(Path.GetFileName(program) + " exited " + process.ExitCode.ToString(CultureInfo.InvariantCulture)
                        + (said.Length > 0 ? ": " + said.Split('\n').Last().Trim() : string.Empty));
                }

                return output.ToArray();
            }
        }

        /// <summary>One argument quoted the way both the Windows C runtime and .NET on Linux split them.</summary>
        internal static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"', '\\' }) < 0)
            {
                return arg;
            }

            var sb = new StringBuilder("\"");
            var slashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\')
                {
                    slashes++;
                    continue;
                }

                sb.Append('\\', c == '"' ? (slashes * 2) + 1 : slashes);
                slashes = 0;
                sb.Append(c);
            }

            sb.Append('\\', slashes * 2);
            return sb.Append('"').ToString();
        }

        private static void Kill(Process process)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
            }
            catch (Exception)
            {
                // Gone already.
            }
        }

        private static string? Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static bool Flag(JsonElement e, string name) =>
            e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.GetInt32() != 0;
    }
}
