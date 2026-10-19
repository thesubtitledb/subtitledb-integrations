using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using SubtitleDb.Core;
using Xunit;

namespace SubtitleDb.Tests
{
    /// <summary>The shared cases, run against the C# rules.</summary>
    public class SharedCasesTests
    {
        public static IEnumerable<object[]> Similarity => SharedCases.Section("similarity");

        public static IEnumerable<object[]> LanguageCases => SharedCases.Section("languages");

        public static IEnumerable<object[]> SubtitleRanking => SharedCases.Section("subtitle_ranking");

        public static IEnumerable<object[]> ReleaseCases => SharedCases.Section("carries_release");

        [Theory]
        [MemberData(nameof(ReleaseCases))]
        internal void CarriesReleaseAgrees(Case testCase)
        {
            var element = testCase.Element;
            var expected = element.GetProperty("expect").GetBoolean();
            Assert.Equal(
                expected,
                Matcher.CarriesRelease(Text(element, "release"), Text(element, "title"), Text(element, "episode_title")));
        }

        [Theory]
        [MemberData(nameof(Similarity))]
        internal void SimilarityAgrees(Case testCase)
        {
            var got = Matcher.Similarity(testCase.Text("a"), testCase.Text("b"));
            var min = testCase.Real("min");
            var max = testCase.Real("max");
            if (min.HasValue)
            {
                Assert.True(got >= min.Value - 1e-9, got + " is under " + min.Value);
            }

            if (max.HasValue)
            {
                Assert.True(got <= max.Value + 1e-9, got + " is over " + max.Value);
            }
        }

        [Theory]
        [MemberData(nameof(LanguageCases))]
        internal void LanguagesResolve(Case testCase)
        {
            var code = Languages.ToCode(testCase.Text("input"));
            Assert.Equal(testCase.Text("code"), code);
            Assert.Equal(testCase.Text("name"), Languages.Name(code));
        }

        [Theory]
        [MemberData(nameof(SubtitleRanking))]
        internal void SubtitlesRank(Case testCase)
        {
            var optionsElement = testCase.Get("options")!.Value;
            var hint = new Hint
            {
                Title = Text(optionsElement, "title"),
                Release = Text(optionsElement, "release"),
                Season = Number(optionsElement, "season"),
                Episode = Number(optionsElement, "episode"),
            };

            var options = new MatchOptions
            {
                Languages = Strings(optionsElement, "languages"),
                HearingImpaired = Flag(optionsElement, "hearing_impaired"),
            };
            var formats = Strings(optionsElement, "formats");
            if (formats.Count > 0)
            {
                options.Formats = formats;
            }

            var rows = new List<SubtitleRow>();
            foreach (var element in testCase.Get("subtitles")!.Value.EnumerateArray())
            {
                rows.Add(new SubtitleRow
                {
                    Id = Number(element, "id") ?? 0,
                    Language = Text(element, "language"),
                    Format = Text(element, "format"),
                    Cues = Number(element, "cues") ?? 0,
                    Downloads = Number(element, "downloads") ?? 0,
                    ReleaseName = Text(element, "release_name"),
                    HearingImpaired = Flag(element, "hearing_impaired") ?? false,
                    Season = Number(element, "season"),
                    Episode = Number(element, "episode"),
                });
            }

            var ranked = Matcher.Rank(rows, hint, options);
            var got = ranked.Candidates.ConvertAll(c => c.Subtitle.Id);
            var wanted = new List<long>();
            foreach (var id in testCase.Get("expect_order")!.Value.EnumerateArray())
            {
                wanted.Add(id.GetInt64());
            }

            Assert.Equal(wanted, got);

            var unrenderable = testCase.Number("expect_unrenderable");
            if (unrenderable.HasValue)
            {
                Assert.Equal(unrenderable.Value, ranked.Unrenderable);
            }

            var same = testCase.Get("expect_same_release");
            if (same.HasValue)
            {
                var wantSame = new List<long>();
                foreach (var id in same.Value.EnumerateArray())
                {
                    wantSame.Add(id.GetInt64());
                }

                Assert.Equal(
                    wantSame,
                    ranked.Candidates.Where(c => c.Reason.Contains("same release")).Select(c => c.Subtitle.Id).ToList());
            }
        }

        private static string? Text(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }

        private static int? Number(JsonElement element, string name)
        {
            return element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
                ? value.GetInt32()
                : (int?)null;
        }

        private static bool? Flag(JsonElement element, string name)
        {
            if (!element.TryGetProperty(name, out var value))
            {
                return null;
            }

            return value.ValueKind == JsonValueKind.True ? true
                : value.ValueKind == JsonValueKind.False ? false
                : (bool?)null;
        }

        private static List<string> Strings(JsonElement element, string name)
        {
            var outp = new List<string>();
            if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray())
                {
                    var text = item.GetString();
                    if (text != null)
                    {
                        outp.Add(text);
                    }
                }
            }

            return outp;
        }
    }
}
