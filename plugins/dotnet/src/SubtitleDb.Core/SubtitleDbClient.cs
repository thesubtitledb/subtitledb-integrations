using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Core
{
    /// <summary>A request that reached the API and came back not-OK.</summary>
    public sealed class SubtitleDbException : Exception
    {
        public SubtitleDbException(string message, HttpStatusCode? status = null)
            : base(message)
        {
            Status = status;
        }

        public HttpStatusCode? Status { get; }

        /// <summary>400 and 404 mean "this rung does not apply", not "give up".</summary>
        public bool Fallthrough =>
            Status == HttpStatusCode.NotFound || Status == HttpStatusCode.BadRequest;
    }

    /// <summary>
    /// The SubtitleDB open API. No key, no account, no quota, so there is nothing to
    /// configure but the base URL, which exists so a test can point somewhere else.
    /// </summary>
    /// <remarks>
    /// Both hosts hand plugins an <see cref="HttpClient"/> (Jellyfin through
    /// IHttpClientFactory, Emby through IHttpClient's inner one), so this takes one
    /// rather than owning a socket pool of its own.
    /// </remarks>
    public sealed class SubtitleDbClient
    {
        public const string DefaultApiBase = "https://api.thesubtitledb.org";

        private static readonly TimeSpan RetryBase = TimeSpan.FromMilliseconds(300);
        private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(8);

        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        private readonly HttpClient _http;
        private readonly Random _jitter = new Random();

        public SubtitleDbClient(HttpClient http, string? apiBase = null, string? client = null)
        {
            _http = http ?? throw new ArgumentNullException(nameof(http));
            ApiBase = (apiBase ?? DefaultApiBase).TrimEnd('/');
            ClientName = string.IsNullOrWhiteSpace(client) ? "subtitledb-plugin" : client!;
        }

        public string ApiBase { get; }

        /// <summary>Sent as a query parameter, not a header: names the plugin in our logs.</summary>
        public string ClientName { get; }

        public int Retries { get; set; } = 2;

        /// <summary>Delay between attempts. A test sets it to zero.</summary>
        public Func<TimeSpan, CancellationToken, Task> Delay { get; set; } = (d, ct) => Task.Delay(d, ct);

        // The lookup surface: one identifier in, the whole title back as one bundle.
        // tmdb is the headline key; by-imdb sits beside it, first-class and the same
        // bundle shape, because media servers identify content by IMDb id. by-title
        // resolves free text server-side, so no ranked list of titles crosses the wire.
        // Every verb drills to a season or episode when the caller passes the numbers.

        public Task<LookupBundle> ByTmdbAsync(
            long tmdb,
            int? season,
            int? episode,
            string? language,
            int limit,
            int offset,
            CancellationToken cancellationToken)
        {
            return GetAsync<LookupBundle>(
                "/v1/by-tmdb/" + tmdb.ToString(CultureInfo.InvariantCulture) + Drill(season, episode),
                PageParameters(language, limit, offset),
                cancellationToken);
        }

        public Task<LookupBundle> ByImdbAsync(
            string imdb,
            int? season,
            int? episode,
            string? language,
            int limit,
            int offset,
            CancellationToken cancellationToken)
        {
            return GetAsync<LookupBundle>(
                "/v1/by-imdb/" + ImdbDigits(imdb) + Drill(season, episode),
                PageParameters(language, limit, offset),
                cancellationToken);
        }

        public Task<LookupBundle> ByTitleAsync(
            string query,
            int? season,
            int? episode,
            string? language,
            int limit,
            int offset,
            CancellationToken cancellationToken)
        {
            // Free text goes in a query parameter, not the path: title text carries
            // dots and slashes a path segment cannot.
            var parameters = PageParameters(language, limit, offset);
            parameters["q"] = query;
            return GetAsync<LookupBundle>(
                "/v1/by-title" + Drill(season, episode), parameters, cancellationToken);
        }

        /// <summary>
        /// Look up the title a single subtitle belongs to, by its id. The bundle carries
        /// that one file in <see cref="LookupBundle.Subtitle"/>, with its download_url.
        /// </summary>
        public Task<LookupBundle> BySubidAsync(long id, CancellationToken cancellationToken)
        {
            return GetAsync<LookupBundle>(
                "/v1/by-subid/" + id.ToString(CultureInfo.InvariantCulture), null, cancellationToken);
        }

        /// <summary>The <c>/season/:s[/episode/:e]</c> suffix a series lookup narrows with, or ''.</summary>
        private static string Drill(int? season, int? episode)
        {
            if (!season.HasValue)
            {
                return string.Empty;
            }

            var path = "/season/" + season.Value.ToString(CultureInfo.InvariantCulture);
            return episode.HasValue
                ? path + "/episode/" + episode.Value.ToString(CultureInfo.InvariantCulture)
                : path;
        }

        /// <summary>
        /// Fetch the bytes from a download_url the API published.
        /// </summary>
        /// <remarks>
        /// The URL is used as published rather than rebuilt: it redirects to wherever
        /// the file currently lives, and that address is not ours to store. Only our
        /// own hosts are followed, before and after the redirect, so a download cannot
        /// be turned into a request to somewhere else.
        /// </remarks>
        public async Task<byte[]> DownloadAsync(string url, CancellationToken cancellationToken)
        {
            if (!IsOurs(url))
            {
                throw new SubtitleDbException("refusing to download from " + url);
            }

            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.TryAddWithoutValidation("Accept", "*/*");
                using (var response = await _http
                    .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                    .ConfigureAwait(false))
                {
                    var landed = response.RequestMessage?.RequestUri?.ToString() ?? url;
                    if (!IsOurs(landed))
                    {
                        throw new SubtitleDbException("download redirected off our hosts");
                    }

                    if (!response.IsSuccessStatusCode)
                    {
                        throw new SubtitleDbException(
                            "download failed: " + (int)response.StatusCode, response.StatusCode);
                    }

                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var buffer = new MemoryStream())
                    {
                        await stream.CopyToAsync(buffer, 81920, cancellationToken).ConfigureAwait(false);
                        return buffer.ToArray();
                    }
                }
            }
        }

        private static Dictionary<string, string?> PageParameters(string? language, int limit, int offset)
        {
            return new Dictionary<string, string?>
            {
                // One code per request. lang does take up to 16 comma separated codes
                // now, but the callers here fan out instead; see Finder.
                { "lang", language },
                { "limit", limit.ToString(CultureInfo.InvariantCulture) },
                // Left off the first page, so its address is the one it always was.
                { "offset", offset > 0 ? offset.ToString(CultureInfo.InvariantCulture) : null },
            };
        }

        internal string BuildUrl(string path, IDictionary<string, string?>? parameters)
        {
            var query = new List<string>();
            if (parameters != null)
            {
                foreach (var pair in parameters)
                {
                    if (string.IsNullOrEmpty(pair.Value))
                    {
                        continue;
                    }

                    query.Add(Uri.EscapeDataString(pair.Key) + "=" + Uri.EscapeDataString(pair.Value!));
                }
            }

            query.Add("client=" + Uri.EscapeDataString(ClientName));
            return ApiBase + path + "?" + string.Join("&", query);
        }

        private async Task<T> GetAsync<T>(
            string path,
            IDictionary<string, string?>? parameters,
            CancellationToken cancellationToken)
        {
            var url = BuildUrl(path, parameters);
            SubtitleDbException? last = null;

            for (var attempt = 0; attempt <= Retries; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                HttpResponseMessage? response = null;
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                    {
                        request.Headers.TryAddWithoutValidation("Accept", "application/json");
                        response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    }

                    if (response.IsSuccessStatusCode)
                    {
                        var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                        var parsed = JsonSerializer.Deserialize<T>(body, Json);
                        if (parsed == null)
                        {
                            throw new SubtitleDbException("the API sent an empty body");
                        }

                        return parsed;
                    }

                    var status = response.StatusCode;
                    var message = await ErrorMessageAsync(response).ConfigureAwait(false);

                    // A 4xx other than 429 says the same thing however many times we ask.
                    if ((int)status < 500 && status != (HttpStatusCode)429)
                    {
                        throw new SubtitleDbException(message, status);
                    }

                    last = new SubtitleDbException(message, status);
                    if (attempt < Retries)
                    {
                        await Delay(Backoff(attempt, RetryAfter(response)), cancellationToken)
                            .ConfigureAwait(false);
                    }
                }
                catch (HttpRequestException err)
                {
                    last = new SubtitleDbException("cannot reach " + ApiBase + ": " + err.Message);
                    if (attempt < Retries)
                    {
                        await Delay(Backoff(attempt, null), cancellationToken).ConfigureAwait(false);
                    }
                }
                catch (JsonException err)
                {
                    throw new SubtitleDbException("the API sent something that is not JSON: " + err.Message);
                }
                finally
                {
                    response?.Dispose();
                }
            }

            throw last ?? new SubtitleDbException("request failed");
        }

        private static async Task<string> ErrorMessageAsync(HttpResponseMessage response)
        {
            try
            {
                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using (var document = JsonDocument.Parse(body))
                {
                    var root = document.RootElement;
                    if (root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                    {
                        return message.GetString() ?? string.Empty;
                    }

                    if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                    {
                        return error.GetString() ?? string.Empty;
                    }
                }
            }
            catch (JsonException)
            {
                // A body that is not JSON is still an error; the status carries it.
            }

            return "HTTP " + (int)response.StatusCode;
        }

        private static TimeSpan? RetryAfter(HttpResponseMessage response)
        {
            var delta = response.Headers.RetryAfter?.Delta;
            if (delta.HasValue)
            {
                return delta;
            }

            var date = response.Headers.RetryAfter?.Date;
            return date.HasValue ? date.Value - DateTimeOffset.UtcNow : (TimeSpan?)null;
        }

        /// <summary>
        /// Honour Retry-After, else exponential backoff with full jitter. The jitter is
        /// not decoration: a media server scanning a library asks about many files at
        /// once, and un-jittered backoff marches all of them into the next wall together.
        /// </summary>
        private TimeSpan Backoff(int attempt, TimeSpan? retryAfter)
        {
            if (retryAfter.HasValue && retryAfter.Value > TimeSpan.Zero)
            {
                return retryAfter.Value < MaxBackoff ? retryAfter.Value : MaxBackoff;
            }

            var ceiling = TimeSpan.FromTicks(Math.Min(RetryBase.Ticks * (1L << attempt), MaxBackoff.Ticks));
            lock (_jitter)
            {
                return TimeSpan.FromTicks((long)(_jitter.NextDouble() * ceiling.Ticks));
            }
        }

        /// <summary>The API takes either spelling; the digits leave nothing to slip.</summary>
        internal static string ImdbDigits(string? value)
        {
            var text = (value ?? string.Empty).Trim().ToLowerInvariant();
            return text.StartsWith("tt", StringComparison.Ordinal) ? text.Substring(2) : text;
        }

        /// <summary>True for the API host and the files host it redirects to, nothing else.</summary>
        internal bool IsOurs(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var target) ||
                !Uri.TryCreate(ApiBase, UriKind.Absolute, out var api))
            {
                return false;
            }

            if (target.Scheme != Uri.UriSchemeHttps && target.Scheme != Uri.UriSchemeHttp)
            {
                return false;
            }

            if (string.Equals(target.Host, api.Host, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            // api.thesubtitledb.org redirects to files.thesubtitledb.org. Both are
            // ours; the split exists so a rate limit on one is not sidestepped.
            var parts = api.Host.Split('.');
            if (parts.Length < 2)
            {
                return false;
            }

            var root = parts[parts.Length - 2] + "." + parts[parts.Length - 1];
            return string.Equals(target.Host, root, StringComparison.OrdinalIgnoreCase)
                || target.Host.EndsWith("." + root, StringComparison.OrdinalIgnoreCase);
        }
    }
}
