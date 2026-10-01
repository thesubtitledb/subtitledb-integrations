using System;
using System.Collections.Generic;
using System.Reflection;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using SubtitleDb.Jellyfin;
using Xunit;

namespace SubtitleDb.Jellyfin.Tests
{
    /// <summary>
    /// What the lookup on play hands Jellyfin. The decisions after that are Core's
    /// (OnPlayTests); the event, the save and the refresh run in plugins/hosts.
    /// </summary>
    public class PlaybackLookupTests
    {
        private static readonly string[] Providers = { "Open Subtitles", "SubtitleDB", "Podnapisi" };

        [Fact]
        public void AnEpisodeIsAskedForAsJellyfinAsksForItAndOfSubtitleDbAlone()
        {
            var episode = new Episode
            {
                Name = "Ozymandias",
                SeriesName = "Breaking Bad",
                ParentIndexNumber = 5,
                IndexNumber = 14,
                ProductionYear = 2013,
                Path = "/media/tv/Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv",
                ProviderIds = new Dictionary<string, string> { { "Imdb", "tt2301451" } },
            };

            var request = PlaybackLookup.Request(
                episode, "eng", new LibraryOptions { RequirePerfectSubtitleMatch = true }, Providers);

            Assert.Equal(VideoContentType.Episode, request.ContentType);
            Assert.Equal("eng", request.Language);
            Assert.Equal("Breaking Bad", request.SeriesName);
            Assert.Equal("Ozymandias", request.Name);
            Assert.Equal(5, request.ParentIndexNumber);
            Assert.Equal(14, request.IndexNumber);
            Assert.Equal("tt2301451", request.ProviderIds["Imdb"]);
            Assert.Equal(episode.Path, request.MediaPath);
            Assert.True(request.IsPerfectMatch);
            Assert.True(request.IsAutomated);
            // The other providers may count each download against an account.
            Assert.Equal(new[] { "Open Subtitles", "Podnapisi" }, request.DisabledSubtitleFetchers);
        }

        [Fact]
        public void AFilmIsAskedForAsAFilmUnderTheLibrarysMatchRule()
        {
            var film = new Movie
            {
                Name = "Anatomy of a Fall",
                ProductionYear = 2023,
                Path = "/media/films/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv",
            };

            var request = PlaybackLookup.Request(
                film, "fre", new LibraryOptions { RequirePerfectSubtitleMatch = false }, new[] { "SubtitleDB" });

            Assert.Equal(VideoContentType.Movie, request.ContentType);
            Assert.Equal(2023, request.ProductionYear);
            Assert.False(request.IsPerfectMatch);
            Assert.Null(request.SeriesName);
            Assert.Empty(request.DisabledSubtitleFetchers);
        }

        [Fact]
        public void OnlyAFilmOrAnEpisodeIsLookedUpAndNeverATrailer()
        {
            Assert.False(PlaybackLookup.Wanted(new Movie { Path = "/media/films/x-trailer.mkv", ExtraType = ExtraType.Trailer }));
            Assert.False(PlaybackLookup.Wanted(new Video { Path = "/media/home/holiday.mkv" }));
            Assert.False(PlaybackLookup.Wanted(new MediaBrowser.Controller.Entities.Audio.Audio { Path = "/media/music/x.flac" }));
            Assert.False(PlaybackLookup.Wanted(null));
        }

        [Fact]
        public void TheLookupIsStartedWithJellyfin()
        {
            // Jellyfin 10.9 dropped IServerEntryPoint: a hosted service in the container
            // is how a plugin runs anything from startup.
            var services = new ServiceList();

            new PluginServiceRegistrator().RegisterServices(services, null!);

            Assert.Contains(services, d =>
                d.ServiceType == typeof(IHostedService) && d.ImplementationType == typeof(PlaybackLookup));
        }

        [Fact]
        public void TheAudioLanguageIsTheDefaultAudioStreams()
        {
            var sources = DispatchProxy.Create<IMediaSourceManager, Streams>();
            ((Streams)(object)sources).Answer = new List<MediaStream>
            {
                new MediaStream { Type = MediaStreamType.Video },
                new MediaStream { Type = MediaStreamType.Audio, Language = "ger" },
                new MediaStream { Type = MediaStreamType.Audio, Language = "eng", IsDefault = true },
                new MediaStream { Type = MediaStreamType.Subtitle, Language = "fre", IsDefault = true },
            };

            Assert.Equal("eng", PlaybackLookup.Spoken(sources, Guid.NewGuid()));
        }

        [Fact]
        public void AJellyfinThatAnswersNoStreamsGivesNoAudioLanguage()
        {
            Assert.Null(PlaybackLookup.Spoken(DispatchProxy.Create<IMediaSourceManager, Streams>(), Guid.NewGuid()));
        }

        [Fact]
        public void TheLookupIsOnUnlessTurnedOff()
        {
            Assert.True(new Configuration.PluginConfiguration().LookUpOnPlay);
        }

        /// <summary>A media source manager whose GetMediaStreams answers <see cref="Answer"/>.</summary>
        public class Streams : DispatchProxy
        {
            public List<MediaStream>? Answer { get; set; }

            protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
            {
                return targetMethod?.Name == "GetMediaStreams" ? Answer : null;
            }
        }

        private sealed class ServiceList
            : List<Microsoft.Extensions.DependencyInjection.ServiceDescriptor>,
              Microsoft.Extensions.DependencyInjection.IServiceCollection
        {
        }
    }
}
