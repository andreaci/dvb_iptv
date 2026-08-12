using System.Diagnostics;
using System.Collections.Concurrent;
using System.Net;
using System.Text.RegularExpressions;

var applicationRoot = File.Exists(Path.Combine(Environment.CurrentDirectory, "static", "index.html"))
    ? Environment.CurrentDirectory
    : AppContext.BaseDirectory;
var webRoot = Path.Combine(applicationRoot, "static");

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = applicationRoot,
    WebRootPath = webRoot
});

var listenUrl = Environment.GetEnvironmentVariable("DVB_URLS") ?? "http://0.0.0.0:8080";
builder.WebHost.UseUrls(listenUrl);
builder.Services.AddHttpClient("upstream", client =>
{
    client.Timeout = TimeSpan.FromSeconds(45);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("DVB-country-player/1.0");
});
builder.Services.AddHttpClient("stream", client =>
{
    client.Timeout = TimeSpan.FromSeconds(60);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 DVB-country-player/1.0");
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
{
    AllowAutoRedirect = false,
    AutomaticDecompression = DecompressionMethods.None
});

var app = builder.Build();
var allowedStreams = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
var playlistCacheRoot = Path.Combine(AppContext.BaseDirectory, "cache");
var epgCacheRoot = Path.Combine(Path.GetTempPath(), "dvb-server-cache");
Directory.CreateDirectory(playlistCacheRoot);
Directory.CreateDirectory(epgCacheRoot);

app.MapGet("/api/playlist", async (string country, HttpContext context,
    IHttpClientFactory clients, CancellationToken ct) =>
{
    country = country.Trim().ToLowerInvariant();
    if (!Regex.IsMatch(country, "^[a-z][a-z_]{1,40}$"))
        return Results.BadRequest("Invalid country");

    var url = $"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_{country}.m3u8";
    var localOrigin = $"{context.Request.Scheme}://{context.Request.Host}{context.Request.PathBase}";
    return await Relay(clients, url, playlistCacheRoot, $"playlist_{country}.m3u8",
        "audio/x-mpegurl", TimeSpan.FromDays(1), false, ct,
        bytes => RegisterPlaylistStreams(bytes, allowedStreams),
        bytes => RewriteChannelPlaylist(bytes, localOrigin));
});

app.MapGet("/api/epg", async (string feed, IHttpClientFactory clients, CancellationToken ct) =>
{
    feed = feed.Trim().ToUpperInvariant();
    if (!Regex.IsMatch(feed, "^[A-Z]{2}[0-9]$"))
        return Results.BadRequest("Invalid EPG feed");

    var url = $"https://epgshare01.online/epgshare01/epg_ripper_{feed}.xml.gz";
    return await Relay(clients, url, epgCacheRoot, $"epg-{feed}.xml.gz",
        "application/gzip", TimeSpan.FromHours(1), true, ct);
});

app.MapGet("/api/stream", async (string url, HttpContext context,
    IHttpClientFactory clients, CancellationToken ct) =>
{
    if (!Uri.TryCreate(url, UriKind.Absolute, out var streamUri) ||
        !allowedStreams.ContainsKey(streamUri.AbsoluteUri))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    await ProxyStream(streamUri, context, clients, allowedStreams, ct);
});

var publicExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    ".html", ".css", ".js", ".jpg", ".jpeg", ".png", ".svg", ".webp",
    ".ico", ".woff", ".woff2", ".ttf", ".map"
};
app.Use(async (context, next) =>
{
    var extension = Path.GetExtension(context.Request.Path.Value) ?? "";
    if (extension.Length > 0 && !publicExtensions.Contains(extension))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        context.Context.Response.Headers.CacheControl = context.File.Name == "index.html"
            ? "no-cache"
            : "public,max-age=3600";
    }
});
app.MapFallbackToFile("index.html");

Console.WriteLine($"DVB root: {webRoot}");
Console.WriteLine($"Listening on {listenUrl}");

app.Lifetime.ApplicationStarted.Register(() =>
{
    try
    {
        Process.Start(new ProcessStartInfo("http://localhost:8080")
        {
            UseShellExecute = true
        });
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"Could not open the browser: {error.Message}");
    }
});

app.Lifetime.ApplicationStarted.Register(() =>
{
    _ = Task.Run(() => SyncAllPlaylists(
        webRoot, playlistCacheRoot, app.Services.GetRequiredService<IHttpClientFactory>()));
});

app.Run();

static async Task<IResult> Relay(
    IHttpClientFactory clients, string url, string cacheDirectory, string cacheName,
    string contentType, TimeSpan maxAge, bool requireGzip, CancellationToken ct,
    Action<byte[]>? inspectBytes = null, Func<byte[], byte[]>? transformBytes = null)
{
    var path = Path.Combine(cacheDirectory, cacheName);
    var cacheLock = CacheFileLocks.For(path);
    await cacheLock.WaitAsync(ct);

    try
    {
        if (IsFreshCacheFile(path, maxAge))
        {
            var cachedBytes = await File.ReadAllBytesAsync(path, ct);
            inspectBytes?.Invoke(cachedBytes);
            return Results.Bytes(transformBytes?.Invoke(cachedBytes) ?? cachedBytes, contentType);
        }

        try
        {
            using var response = await clients.CreateClient("upstream")
                .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Upstream returned HTTP {(int)response.StatusCode}");

            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (requireGzip && (bytes.Length < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b))
                throw new InvalidDataException("Upstream returned an invalid gzip file");
            if (!requireGzip && (bytes.Length < 7 || !bytes.AsSpan(0, 7).SequenceEqual("#EXTM3U"u8)))
                throw new InvalidDataException("Upstream returned an invalid playlist");

            inspectBytes?.Invoke(bytes);
            try
            {
                await WriteCacheFile(path, bytes, ct);
            }
            catch (Exception cacheError) when (!ct.IsCancellationRequested)
            {
                Console.Error.WriteLine($"Could not update cache file {path}: {cacheError.Message}");
            }
            return Results.Bytes(transformBytes?.Invoke(bytes) ?? bytes, contentType);
        }
        catch (Exception error) when (!ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"Relay error for {url}: {error.Message}");
            if (File.Exists(path))
            {
                var staleBytes = await File.ReadAllBytesAsync(path, ct);
                inspectBytes?.Invoke(staleBytes);
                return Results.Bytes(transformBytes?.Invoke(staleBytes) ?? staleBytes, contentType);
            }
            return Results.Problem("Upstream service is unavailable", statusCode: 502);
        }
    }
    finally
    {
        cacheLock.Release();
    }
}

static async Task SyncAllPlaylists(string webRoot, string cacheDirectory,
    IHttpClientFactory clients)
{
    var scriptPath = Path.Combine(webRoot, "scripts.js");
    if (!File.Exists(scriptPath)) return;

    var countries = Regex.Matches(
            await File.ReadAllTextAsync(scriptPath),
            @"\[\s*\""([a-z][a-z_]*)\""\s*,\s*\""[A-Z]{2}\""")
        .Select(match => match.Groups[1].Value)
        .Distinct(StringComparer.Ordinal)
        .ToArray();
    if (countries.Length == 0) return;

    var staleCountries = countries
        .Where(country => !IsFreshCacheFile(
            Path.Combine(cacheDirectory, $"playlist_{country}.m3u8"), TimeSpan.FromDays(1)))
        .ToArray();
    if (staleCountries.Length == 0)
    {
        Console.WriteLine($"Playlist cache is current: {countries.Length} countries.");
        return;
    }

    var probe = staleCountries[0];
    if (!await TryRefreshPlaylist(probe, cacheDirectory, clients))
    {
        Console.WriteLine("Playlist provider unavailable; using the local cache.");
        return;
    }

    await Parallel.ForEachAsync(staleCountries.Where(country => country != probe),
        new ParallelOptions { MaxDegreeOfParallelism = 6 },
        async (country, _) => await TryRefreshPlaylist(country, cacheDirectory, clients));

    Console.WriteLine($"Playlist cache synchronized: {countries.Length} countries.");
}

static async Task<bool> TryRefreshPlaylist(string country, string cacheDirectory,
    IHttpClientFactory clients)
{
    var url = $"https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_{country}.m3u8";
    var path = Path.Combine(cacheDirectory, $"playlist_{country}.m3u8");
    var cacheLock = CacheFileLocks.For(path);
    await cacheLock.WaitAsync();

    try
    {
        if (IsFreshCacheFile(path, TimeSpan.FromDays(1))) return true;

        using var response = await clients.CreateClient("upstream")
            .GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode) return false;

        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length < 7 || !bytes.AsSpan(0, 7).SequenceEqual("#EXTM3U"u8)) return false;

        await WriteCacheFile(path, bytes, CancellationToken.None);
        return true;
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"Playlist cache refresh failed for {country}: {error.Message}");
        return false;
    }
    finally
    {
        cacheLock.Release();
    }
}

static bool IsFreshCacheFile(string path, TimeSpan maxAge) =>
    maxAge > TimeSpan.Zero && File.Exists(path) &&
    DateTime.UtcNow - File.GetLastWriteTimeUtc(path) < maxAge;

static async Task WriteCacheFile(string path, byte[] bytes, CancellationToken ct)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";

    try
    {
        await File.WriteAllBytesAsync(temporaryPath, bytes, ct);
        File.Move(temporaryPath, path, true);
    }
    finally
    {
        if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
    }
}

static byte[] RewriteChannelPlaylist(byte[] bytes, string localOrigin)
{
    var text = System.Text.Encoding.UTF8.GetString(bytes);
    var rewritten = string.Join("\n", text.Replace("\r\n", "\n").Split('\n').Select(rawLine =>
    {
        var line = rawLine.Trim();
        if (!Uri.TryCreate(line, UriKind.Absolute, out var uri) || !IsLikelyHls(uri.AbsoluteUri))
            return rawLine;

        return $"{localOrigin}/api/stream?url={Uri.EscapeDataString(uri.AbsoluteUri)}&type=hls";
    }));
    return System.Text.Encoding.UTF8.GetBytes(rewritten);
}

static bool IsLikelyHls(string url)
{
    return Regex.IsMatch(url, @"\.m3u8(?:$|[?#])", RegexOptions.IgnoreCase) ||
           Regex.IsMatch(url, @"[?&](?:format|type)=(?:hls|m3u8)(?:&|$)", RegexOptions.IgnoreCase) ||
           Regex.IsMatch(url, @"[?&]output=7(?:&|$)", RegexOptions.IgnoreCase) ||
           Regex.IsMatch(url, @"/hls(?:/|$)", RegexOptions.IgnoreCase);
}

static void RegisterPlaylistStreams(byte[] bytes, ConcurrentDictionary<string, byte> allowed)
{
    foreach (var rawLine in System.Text.Encoding.UTF8.GetString(bytes).Split('\n'))
    {
        var line = rawLine.Trim();
        if (Uri.TryCreate(line, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            allowed.TryAdd(uri.AbsoluteUri, 0);
    }
}

static async Task ProxyStream(Uri initialUri, HttpContext context,
    IHttpClientFactory clients, ConcurrentDictionary<string, byte> allowed,
    CancellationToken ct)
{
    var currentUri = initialUri;
    HttpResponseMessage? upstream = null;

    try
    {
        for (var redirect = 0; redirect < 6; redirect++)
        {
            if (!await IsPublicHttpUri(currentUri))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            if (context.Request.Headers.TryGetValue("Range", out var range))
                request.Headers.TryAddWithoutValidation("Range", range.ToString());

            upstream = await clients.CreateClient("stream")
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

            if ((int)upstream.StatusCode is >= 300 and < 400 && upstream.Headers.Location is not null)
            {
                currentUri = upstream.Headers.Location.IsAbsoluteUri
                    ? upstream.Headers.Location
                    : new Uri(currentUri, upstream.Headers.Location);
                upstream.Dispose();
                upstream = null;
                continue;
            }
            break;
        }

        if (upstream is null)
        {
            context.Response.StatusCode = StatusCodes.Status502BadGateway;
            return;
        }

        context.Response.StatusCode = (int)upstream.StatusCode;
        var mediaType = upstream.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";

        if (upstream.IsSuccessStatusCode &&
            (mediaType.Contains("mpegurl", StringComparison.OrdinalIgnoreCase) ||
             currentUri.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase)))
        {
            var manifest = await upstream.Content.ReadAsStringAsync(ct);
            var rewritten = RewriteHlsManifest(manifest, currentUri, allowed);
            context.Response.ContentType = "application/vnd.apple.mpegurl";
            await context.Response.WriteAsync(rewritten, ct);
            return;
        }

        context.Response.ContentType = mediaType;
        CopyHeader(upstream, context, "Accept-Ranges");
        CopyHeader(upstream, context, "Content-Range");
        CopyHeader(upstream, context, "Content-Length");
        await upstream.Content.CopyToAsync(context.Response.Body, ct);
    }
    catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    catch (Exception error)
    {
        Console.Error.WriteLine($"Stream proxy error for {currentUri}: {error.Message}");
        if (!context.Response.HasStarted)
            context.Response.StatusCode = StatusCodes.Status502BadGateway;
    }
    finally
    {
        upstream?.Dispose();
    }
}

static string RewriteHlsManifest(string manifest, Uri baseUri,
    ConcurrentDictionary<string, byte> allowed)
{
    string Proxy(Uri uri)
    {
        allowed.TryAdd(uri.AbsoluteUri, 0);
        return "/api/stream?url=" + Uri.EscapeDataString(uri.AbsoluteUri);
    }

    return string.Join("\n", manifest.Replace("\r\n", "\n").Split('\n').Select(line =>
    {
        var trimmed = line.Trim();
        if (trimmed.Length > 0 && !trimmed.StartsWith('#') &&
            Uri.TryCreate(baseUri, trimmed, out var mediaUri))
            return Proxy(mediaUri);

        return Regex.Replace(line, "URI=\"([^\"]+)\"", match =>
            Uri.TryCreate(baseUri, match.Groups[1].Value, out var resourceUri)
                ? $"URI=\"{Proxy(resourceUri)}\""
                : match.Value, RegexOptions.IgnoreCase);
    }));
}

static async Task<bool> IsPublicHttpUri(Uri uri)
{
    if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
    if (uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return false;

    try
    {
        var addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost);
        return addresses.Length > 0 && addresses.All(IsPublicAddress);
    }
    catch { return false; }
}

static bool IsPublicAddress(IPAddress address)
{
    if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
    if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) ||
        address.Equals(IPAddress.IPv6Any) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal)
        return false;

    var bytes = address.GetAddressBytes();
    if (bytes.Length != 4) return !address.IsIPv6Multicast;
    return bytes[0] switch
    {
        0 or 10 or 127 => false,
        169 when bytes[1] == 254 => false,
        172 when bytes[1] is >= 16 and <= 31 => false,
        192 when bytes[1] == 168 => false,
        >= 224 => false,
        _ => true
    };
}

static void CopyHeader(HttpResponseMessage source, HttpContext target, string name)
{
    if (source.Headers.TryGetValues(name, out var values) ||
        source.Content.Headers.TryGetValues(name, out values))
        target.Response.Headers[name] = values.ToArray();
}

static class CacheFileLocks
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks =
        new(StringComparer.OrdinalIgnoreCase);

    public static SemaphoreSlim For(string path) =>
        Locks.GetOrAdd(Path.GetFullPath(path), _ => new SemaphoreSlim(1, 1));
}
