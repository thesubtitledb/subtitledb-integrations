using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace SubtitleDb.Jellyfin
{
    /// <summary>
    /// Runs the lookup on play when a player asks Jellyfin for a video's tracks, before
    /// Jellyfin answers, so a subtitle found is in the list the player starts with.
    /// </summary>
    /// <remarks>
    /// Every Jellyfin player asks /Items/{itemId}/PlaybackInfo before it plays, and
    /// picks tracks by their numbers in that answer. The playback start event comes
    /// after the answer, too late for a new file to be in it.
    /// </remarks>
    public sealed class PlaybackInfoFilter : IAsyncActionFilter
    {
        private readonly PlaybackLookup _lookup;

        public PlaybackInfoFilter(PlaybackLookup lookup)
        {
            _lookup = lookup;
        }

        /// <summary>Jellyfin's two PlaybackInfo actions, GET and POST, and nothing else.</summary>
        internal static bool IsPlaybackInfo(string? controller, string? action)
        {
            return controller == "MediaInfo"
                && (action == "GetPlaybackInfo" || action == "GetPostedPlaybackInfo");
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (context.ActionDescriptor is ControllerActionDescriptor action
                && IsPlaybackInfo(action.ControllerName, action.ActionName)
                && Guid.TryParse(context.RouteData.Values["itemId"]?.ToString(), out var id))
            {
                await _lookup.BeforePlayAsync(id, context.HttpContext.RequestAborted).ConfigureAwait(false);
            }

            await next().ConfigureAwait(false);
        }
    }
}
