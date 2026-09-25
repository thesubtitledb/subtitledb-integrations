using System.Collections.Generic;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using SubtitleDb.Core;
using SubtitleDb.Emby;
using Xunit;

namespace SubtitleDb.Emby.Tests
{
    /// <summary>
    /// What Emby hands over, and what it gets back. The ranking itself is covered once
    /// for every plugin in plugins/dotnet/tests/SubtitleDb.Tests.
    /// </summary>
    public class ProviderTests
    {
        private static SubtitleSearchRequest Film()
        {
            return new SubtitleSearchRequest
            {
                ContentType = VideoContentType.Movie,
                Name = "Anatomy of a Fall",
                ProductionYear = 2023,
                Language = "eng",
                MediaPath = "/media/films/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv",
                ProviderIds = new ProviderIdDictionary(
                    new Dictionary<string, string> { { "Imdb", "tt17009710" }, { "Tmdb", "915935" } }),
            };
        }

        private static SubtitleSearchRequest Episode()
        {
            return new SubtitleSearchRequest
            {
                ContentType = VideoContentType.Episode,
                Name = "Ozymandias",
                SeriesName = "Breaking Bad",
                ParentIndexNumber = 5,
                IndexNumber = 14,
                Language = "eng",
                MediaPath = "/media/tv/Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv",
                ProviderIds = new ProviderIdDictionary(
                    new Dictionary<string, string> { { "Imdb", "tt2301451" } }),
            };
        }

        [Fact]
        public void AFilmCarriesItsIdsAndItsName()
        {
            var hint = SubtitleDbSubtitleProvider.HintFrom(Film());

            Assert.Equal("tt17009710", hint.ImdbId);
            Assert.Equal(915935, hint.TmdbId);
            Assert.Equal("Anatomy of a Fall", hint.Title);
            Assert.Equal("Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL", hint.Release);
        }

        [Fact]
        public void AnEpisodeSearchesTheSeries()
        {
            var hint = SubtitleDbSubtitleProvider.HintFrom(Episode());

            Assert.Equal("Breaking Bad", hint.Title);
            Assert.Equal("Ozymandias", hint.EpisodeTitle);
            Assert.Equal(5, hint.Season);
            Assert.Equal(14, hint.Episode);
            Assert.Equal("tt2301451", hint.ImdbId);
        }

        [Fact]
        public void TheSeriesIdIsNotTheEpisodesId()
        {
            // Emby fills ProviderIds from the series when the episode has none of its
            // own. It goes to the ladder as the series' id, which it drills to the
            // season and episode, and not as the episode's.
            var request = Episode();
            request.ProviderIds = new ProviderIdDictionary(
                new Dictionary<string, string> { { "Imdb", "tt0903747" } });
            request.SeriesProviderIds = new ProviderIdDictionary(
                new Dictionary<string, string> { { "Imdb", "tt0903747" } });

            var hint = SubtitleDbSubtitleProvider.HintFrom(request);

            Assert.Null(hint.ImdbId);
            Assert.Equal("tt0903747", hint.SeriesImdbId);
            Assert.Equal("Breaking Bad", hint.Title);
            Assert.Equal(5, hint.Season);
        }

        [Fact]
        public void AnEpisodeWithNoIdOfItsOwnCarriesItsSeriesId()
        {
            // An episode scraped from TVDB often has no IMDb id, and its series has
            // one. By name, the API answers "Friends" with Matlock.
            var request = Episode();
            request.ProviderIds = new ProviderIdDictionary(
                new Dictionary<string, string> { { "Tvdb", "303821" } });
            request.SeriesProviderIds = new ProviderIdDictionary(
                new Dictionary<string, string> { { "Imdb", "tt0108778" }, { "Tvdb", "79168" } });

            var hint = SubtitleDbSubtitleProvider.HintFrom(request);

            Assert.Null(hint.ImdbId);
            Assert.Equal("tt0108778", hint.SeriesImdbId);
        }

        [Fact]
        public void AFilmCarriesNoSeriesId()
        {
            Assert.Null(SubtitleDbSubtitleProvider.HintFrom(Film()).SeriesImdbId);
        }

        [Fact]
        public void AnIdThatIsNotAnImdbIdIsDropped()
        {
            var request = Episode();
            request.ProviderIds = new ProviderIdDictionary(
                new Dictionary<string, string> { { "Imdb", "81189" } });

            Assert.Null(SubtitleDbSubtitleProvider.HintFrom(request).ImdbId);
        }

        [Fact]
        public void TheLanguageComesFromWhicheverFieldEmbyFilled()
        {
            var request = Film();
            request.Language = null;
            request.LanguageInfo = new CultureDto
            {
                Name = "Portuguese (Brazil)",
                TwoLetterISOLanguageNames = new[] { "pt-BR" },
                ThreeLetterISOLanguageNames = new[] { "por" },
            };

            // pt-BR, not pt: the corpus files Brazilian Portuguese under pb, and a
            // viewer handed European Portuguese thinks the plugin is broken.
            Assert.Equal(new[] { "pb" }, SubtitleDbSubtitleProvider.OptionsFrom(request).Languages);
        }

        [Fact]
        public void AHearingImpairedRequestIsAPreferenceInBothDirections()
        {
            var request = Film();
            request.IsHearingImpaired = true;
            Assert.True(SubtitleDbSubtitleProvider.OptionsFrom(request).HearingImpaired);

            request.IsHearingImpaired = false;
            Assert.False(SubtitleDbSubtitleProvider.OptionsFrom(request).HearingImpaired);

            request.IsHearingImpaired = null;
            Assert.Null(SubtitleDbSubtitleProvider.OptionsFrom(request).HearingImpaired);
        }

        [Fact]
        public void WithNothingSetASearchReadsFiveHundredPerLanguage()
        {
            Assert.Equal(500, SubtitleDbSubtitleProvider.OptionsFrom(Film()).Limit);
            Assert.Equal(500, new PluginConfiguration().PerLanguage);
        }

        [Fact]
        public void ARowIsLabelledWithSomethingThatTellsItFromTheNextOne()
        {
            var row = new SubtitleRow
            {
                Id = 481207,
                Language = "pb",
                Format = "srt",
                Cues = 900,
                Downloads = 4200,
            };
            var info = SubtitleDbSubtitleProvider.Describe(
                new Candidate(row, 100, "preferred language pb"), "SubtitleDB");

            Assert.Equal("481207", info.Id);
            Assert.Equal("Portuguese (Brazil) - 900 lines", info.Name);
            Assert.Equal("pob", info.Language);
            Assert.False(info.IsHashMatch);
        }

        [Fact]
        public void OnlyASubtitleRecordedAgainstThisFileIsMarkedAsMatchingIt()
        {
            var row = new SubtitleRow { Id = 1, Language = "en", Format = "srt", Cues = 900 };
            var same = SubtitleDbSubtitleProvider.Describe(
                new Candidate(row, 160, "preferred language en, same release"), "SubtitleDB");
            var close = SubtitleDbSubtitleProvider.Describe(
                new Candidate(row, 120, "preferred language en, release name is close"), "SubtitleDB");

            Assert.True(same.IsHashMatch);
            Assert.False(close.IsHashMatch);
        }
    }
}
