using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Tests
{
    /// <summary>
    /// A fetch stub that records every call, because the traffic a media server
    /// spends is the thing worth asserting: a library scan multiplies whatever one
    /// search costs by the number of files in it.
    /// </summary>
    public sealed class StubHandler : HttpMessageHandler
    {
        private readonly List<Route> _routes = new List<Route>();

        public List<string> Calls { get; } = new List<string>();

        public StubHandler On(string contains, string json, HttpStatusCode status = HttpStatusCode.OK)
        {
            _routes.Add(new Route(contains, json, status, null));
            return this;
        }

        public StubHandler OnRedirect(string contains, string location)
        {
            _routes.Add(new Route(contains, string.Empty, HttpStatusCode.Redirect, location));
            return this;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            Calls.Add(url);

            foreach (var route in _routes)
            {
                if (url.IndexOf(route.Contains, StringComparison.Ordinal) < 0)
                {
                    continue;
                }

                var response = new HttpResponseMessage(route.Status)
                {
                    Content = new StringContent(route.Body, Encoding.UTF8, "application/json"),
                    RequestMessage = request,
                };

                if (route.Location != null)
                {
                    // HttpClient follows this itself, so the test sees where it landed.
                    response.Headers.Location = new Uri(route.Location);
                }

                return Task.FromResult(response);
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("{\"error\":\"not_found\",\"message\":\"no stub\"}"),
                RequestMessage = request,
            });
        }

        private sealed class Route
        {
            public Route(string contains, string body, HttpStatusCode status, string? location)
            {
                Contains = contains;
                Body = body;
                Status = status;
                Location = location;
            }

            public string Contains { get; }

            public string Body { get; }

            public HttpStatusCode Status { get; }

            public string? Location { get; }
        }
    }
}
