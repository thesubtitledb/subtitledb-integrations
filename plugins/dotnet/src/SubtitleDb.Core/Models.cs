using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace SubtitleDb.Core
{
    /// <summary>One row of the corpus, as the API sends it.</summary>
    /// <remarks>
    /// Season, episode, release name and fps come from subs.sub_meta, which has no
    /// entry for every id: null here means unknown, never zero and never "no".
    /// </remarks>
    public sealed class SubtitleRow
    {
        [JsonPropertyName("id")] public long Id { get; set; }
        [JsonPropertyName("imdb")] public string? Imdb { get; set; }
        [JsonPropertyName("language")] public string? Language { get; set; }
        [JsonPropertyName("format")] public string? Format { get; set; }
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("year")] public int? Year { get; set; }
        [JsonPropertyName("season")] public int? Season { get; set; }
        [JsonPropertyName("episode")] public int? Episode { get; set; }
        [JsonPropertyName("cues")] public int Cues { get; set; }
        [JsonPropertyName("duration_s")] public double? DurationSeconds { get; set; }
        [JsonPropertyName("bytes")] public long Bytes { get; set; }
        [JsonPropertyName("encoding")] public string? Encoding { get; set; }
        [JsonPropertyName("release_name")] public string? ReleaseName { get; set; }
        [JsonPropertyName("uploader")] public string? Uploader { get; set; }
        [JsonPropertyName("hearing_impaired")] public bool HearingImpaired { get; set; }
        [JsonPropertyName("fps")] public double? Fps { get; set; }
        [JsonPropertyName("downloads")] public int Downloads { get; set; }

        /// <summary>Stable URL on the API host. It 302s to the files host.</summary>
        [JsonPropertyName("download_url")] public string? DownloadUrl { get; set; }
    }

    /// <summary>The title a bundle resolved to, film or episode.</summary>
    public sealed class TitleRow
    {
        [JsonPropertyName("imdb_id")] public long ImdbId { get; set; }
        [JsonPropertyName("imdb")] public string? Imdb { get; set; }
        [JsonPropertyName("tmdb_id")] public long? TmdbId { get; set; }
        [JsonPropertyName("media_type")] public string? MediaType { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("year")] public int? Year { get; set; }
        [JsonPropertyName("kind")] public string? Kind { get; set; }
        [JsonPropertyName("subtitle_count")] public int SubtitleCount { get; set; }
        [JsonPropertyName("poster_path")] public string? PosterPath { get; set; }
    }

    /// <summary>One page of a bundle's subtitles: <c>{ total, items }</c>, never a bare list.</summary>
    public sealed class SubtitlePage
    {
        [JsonPropertyName("total")] public int Total { get; set; }
        [JsonPropertyName("items")] public List<SubtitleRow> Items { get; set; } = new List<SubtitleRow>();
    }

    /// <summary>
    /// One identifier resolved to a whole title. Every lookup answers with the same
    /// shape, drilled or not: the files live in <see cref="Subtitles"/> and a season
    /// or episode slug narrows what lands there. A by-subid lookup also carries the
    /// one file it named in <see cref="Subtitle"/>.
    /// </summary>
    public sealed class LookupBundle
    {
        [JsonPropertyName("title")] public TitleRow? Title { get; set; }
        [JsonPropertyName("subtitles")] public SubtitlePage? Subtitles { get; set; }

        /// <summary>The single file a by-subid lookup was scoped to, if any.</summary>
        [JsonPropertyName("subtitle")] public SubtitleRow? Subtitle { get; set; }

        /// <summary>
        /// The subtitle page that belongs to exactly what was asked for. Always the
        /// top-level bucket: a drill narrows what lands there rather than moving it.
        /// </summary>
        public List<SubtitleRow> ScopedItems()
        {
            return Subtitles?.Items ?? new List<SubtitleRow>();
        }
    }
}
