using System.Collections.Generic;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using SubtitleDb.Core;
using SubtitleDb.Jellyfin;
using Xunit;

namespace SubtitleDb.Jellyfin.Tests
{
    /// <summary>
    /// What Jellyfin hands over, and what it gets back. The ranking itself is covered
    /// once for every plugin in plugins/dotnet/tests/SubtitleDb.Tests.
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
                TwoLetterISOLanguageName = "en",
                MediaPath = "/media/films/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv",
                ProviderIds = new Dictionary<string, string> { { "Imdb", "tt17009710" }, { "Tmdb", "915935" } },
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
                ProductionYear = 2013,
                Language = "eng",
                MediaPath = "/media/tv/Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv",
                ProviderIds = new Dictionary<string, string> { { "Imdb", "tt2301451" } },
            };
        }

        [Fact]
        public void AFilmCarriesItsIdsAndItsName()
        {
            var hint = SubtitleDbSubtitleProvider.HintFrom(Film());

            Assert.Equal("tt17009710", hint.ImdbId);
            Assert.Equal(915935, hint.TmdbId);
            Assert.Equal("Anatomy of a Fall", hint.Title);
            Assert.Equal(2023, hint.Year);
            Assert.Null(hint.Season);
            Assert.Equal("Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL", hint.Release);
        }

        [Fact]
        public void AnEpisodeSearchesTheSeries()
        {
            // Jellyfin's Name on an episode is the episode's own title, which is the
            // wrong thing to search for and the right thing to choose between episodes
            // with. The series name is the query.
            var hint = SubtitleDbSubtitleProvider.HintFrom(Episode());

            Assert.Equal("Breaking Bad", hint.Title);
            Assert.Equal("Ozymandias", hint.EpisodeTitle);
            Assert.Equal(5, hint.Season);
            Assert.Equal(14, hint.Episode);
        }

        [Fact]
        public void AnIdThatIsNotAnImdbIdIsDropped()
        {
            // Whatever metadata provider ran fills ProviderIds, and a TVDB id sent as
            // an IMDb id resolves to somebody else's film.
            var request = Episode();
            request.ProviderIds = new Dictionary<string, string> { { "Imdb", "81189" }, { "Tvdb", "81189" } };

            Assert.Null(SubtitleDbSubtitleProvider.HintFrom(request).ImdbId);
        }

        [Fact]
        public void AnEpisodesTmdbIdIsNotTheFilmsTmdbId()
        {
            // The map the API reads is keyed by a film's TMDB id. An episode's would
            // resolve to nothing at best.
            var request = Episode();
            request.ProviderIds = new Dictionary<string, string> { { "Tmdb", "62161" } };

            Assert.Null(SubtitleDbSubtitleProvider.HintFrom(request).TmdbId);
        }

        [Fact]
        public void NoPathIsNoReleaseName()
        {
            Assert.Null(SubtitleDbSubtitleProvider.ReleaseName(null));
            Assert.Null(SubtitleDbSubtitleProvider.ReleaseName("   "));
            Assert.Equal("Film.2023.1080p", SubtitleDbSubtitleProvider.ReleaseName("/m/Film.2023.1080p.mkv"));
        }

        [Fact]
        public void ARowIsLabelledWithSomethingThatTellsItFromTheNextOne()
        {
            // Most of the corpus has no release name, so thirty English candidates
            // would otherwise read "English" thirty times over.
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
            Assert.Equal("pob", info.ThreeLetterISOLanguageName);
            Assert.Equal(4200, info.DownloadCount);
            Assert.False(info.IsHashMatch);
        }

        [Fact]
        public void OnlyASubtitleRecordedAgainstThisFileIsMarkedAsMatchingIt()
        {
            // Jellyfin draws IsHashMatch as "matches your file", and downloads it
            // unattended when it is asked for a perfect match.
            var row = new SubtitleRow { Id = 1, Language = "en", Format = "srt", Cues = 900 };
            var same = SubtitleDbSubtitleProvider.Describe(
                new Candidate(row, 160, "preferred language en, same release"), "SubtitleDB");
            var close = SubtitleDbSubtitleProvider.Describe(
                new Candidate(row, 120, "preferred language en, release name is close"), "SubtitleDB");

            Assert.True(same.IsHashMatch);
            Assert.False(close.IsHashMatch);
        }

        [Fact]
        public void AnEpisodeCarriesTheSeriesIdTheLibraryHolds()
        {
            // Jellyfin's request carries only the episode's ids, and a TVDB-scraped
            // episode often has no IMDb id. By name, the API answers "Friends" with
            // Matlock; the series' id, drilled to the episode, cannot go wrong that way.
            var request = Episode();
            request.ProviderIds = new Dictionary<string, string> { { "Tvdb", "303821" } };

            var hint = SubtitleDbSubtitleProvider.HintFrom(request, "tt0108778");

            Assert.Null(hint.ImdbId);
            Assert.Equal("tt0108778", hint.SeriesImdbId);
            Assert.Equal(5, hint.Season);
        }

        [Fact]
        public void AFilmCarriesNoSeriesId()
        {
            Assert.Null(SubtitleDbSubtitleProvider.HintFrom(Film(), "tt0108778").SeriesImdbId);
        }

        [Fact]
        public void TheProviderNamesItselfAndSaysWhatItCanDo()
        {
            var provider = new SubtitleDbSubtitleProvider(
                new Microsoft.Extensions.Logging.Abstractions.NullLogger<SubtitleDbSubtitleProvider>(),
                new StubHttpClientFactory());

            Assert.Equal("SubtitleDB", provider.Name);
            Assert.Contains(VideoContentType.Movie, provider.SupportedMediaTypes);
            Assert.Contains(VideoContentType.Episode, provider.SupportedMediaTypes);
        }

        [Fact]
        public void TheProviderIsRegisteredWhereJellyfinLooksForIt()
        {
            // The subtitle manager is built from the container. A provider that is not
            // in it loads with the plugin and is never asked anything: the live run
            // against 10.10.7 found exactly that.
            var services = new Services();

            new PluginServiceRegistrator().RegisterServices(services, null!);

            Assert.Contains(services, d =>
                d.ServiceType == typeof(ISubtitleProvider)
                && d.ImplementationType == typeof(SubtitleDbSubtitleProvider));
        }

        [Fact]
        public void TheSettingsPageReadsAndWritesEverySetting()
        {
            // A setting the page never fills is saved back empty, and one it never
            // writes is a setting nobody can change.
            var page = new System.IO.StreamReader(typeof(Plugin).Assembly.GetManifestResourceStream(
                "SubtitleDb.Jellyfin.Configuration.configPage.html")!).ReadToEnd();
            foreach (var property in typeof(Configuration.PluginConfiguration).GetProperties())
            {
                if (property.DeclaringType != typeof(Configuration.PluginConfiguration))
                {
                    continue;
                }

                Assert.Contains("id=\"" + property.Name + "\"", page, System.StringComparison.Ordinal);
                Assert.Contains("= config." + property.Name + ";", page, System.StringComparison.Ordinal);
                Assert.Contains("config." + property.Name + " = ", page, System.StringComparison.Ordinal);
            }

            Assert.Equal(500, new Configuration.PluginConfiguration().PerLanguage);
        }

        private sealed class StubHttpClientFactory : System.Net.Http.IHttpClientFactory
        {
            public System.Net.Http.HttpClient CreateClient(string name) => new System.Net.Http.HttpClient();
        }

        private sealed class Services
            : List<Microsoft.Extensions.DependencyInjection.ServiceDescriptor>,
              Microsoft.Extensions.DependencyInjection.IServiceCollection
        {
        }
    }
}
