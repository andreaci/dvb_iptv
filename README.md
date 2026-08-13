# DVB

DVB is a small self-hosted IPTV web player packaged with a lightweight C# server. It provides a country selector, downloads public channel playlists, displays XMLTV programme information, and plays HLS, DASH, and browser-native streams from a television-style interface.

The application does not require Node.js, PHP, or a separate web server. The published Windows build contains the .NET runtime and serves both the user interface and its supporting APIs.

## What it does

- Lists channels by country using the public [Free-TV/IPTV](https://github.com/Free-TV/IPTV) playlists.
- Groups channels by category and provides channel search.
- Loads country-specific XMLTV data from EPGShare where a matching guide is available.
- Matches EPG programmes using `tvg-id`, display names, normalized names, and a conservative fuzzy fallback.
- Plays HLS, MPEG-DASH, and browser-supported direct media URLs.
- Shows detected video resolution and bitrate when the player exposes them.
- Provides play/pause, seek, volume, fullscreen, and an auto-hiding player overlay.
- Uses local copies of hls.js, dash.js, Font Awesome, Manrope, and other browser assets.
- Opens `http://localhost:8080` in the default browser after the server starts.

## Why the C# server exists

Many playlist and EPG providers do not allow browser requests from another origin. Some streams also redirect to HLS manifests whose child playlists, segments, or encryption keys have the same restriction.

The C# server exposes three same-origin APIs:

| Endpoint | Purpose |
| --- | --- |
| `/api/playlist?country=italy` | Downloads or serves a cached country playlist. |
| `/api/epg?feed=IT1` | Relays and caches a country XMLTV feed. |
| `/api/stream?url=...` | Relays approved HLS resources and rewrites nested manifest URLs. |

The stream endpoint is not an unrestricted public proxy. Initial URLs must come from a playlist loaded by the application, and destinations resolving to loopback or private network addresses are rejected.

## Stream fallback

For HLS channels, DVB first tries the same-origin stream relay. If that attempt ends with a fatal network or HTTP error, the player retries the original URL directly from the browser once.

If the direct attempt also fails, the interface reports that the channel is unavailable. This fallback cannot override browser CORS rules, geographic restrictions, expired provider tokens, DRM, or an upstream server returning `403`/`404`.

## Playlist cache

Country playlists are stored beside the executable:

```text
cache/playlist_italy.m3u8
cache/playlist_france.m3u8
...
```

At startup, DVB synchronizes all known country playlists in the background.

- A cached file younger than 24 hours is not downloaded again.
- A missing or older file is refreshed when the online provider is available.
- If the provider is unavailable, the existing local file is served, even when stale.
- Per-file locks prevent a background refresh and a UI request from downloading the same file simultaneously.
- Cache writes use a temporary file followed by an atomic replacement.
- `build.ps1` preserves the existing `publish/cache` directory across rebuilds.

EPG files use a separate one-hour cache in the operating system's temporary directory.

## Run the ready-to-use application

Open the `publish` directory and run:

```powershell
.\DvbServer.exe
```

The server listens on port `8080` and opens the application in the default browser.

The self-contained `win-x64` build does not require a separate .NET installation.

## Build

Development requires the .NET 10 SDK.

From PowerShell:

```powershell
.\build.ps1
```

The script creates a self-contained Windows x64 application in `publish`.

For Windows ARM64:

```powershell
.\build.ps1 -Runtime win-arm64
```

## Configuration

The default listen address is:

```text
http://0.0.0.0:8080
```

It can be changed with `DVB_URLS`:

```powershell
$env:DVB_URLS = "http://127.0.0.1:9000"
.\DvbServer.exe
```

Quirk: automatic browser launch currently always opens `http://localhost:8080`. When using another port, open the configured address manually.

Because the default binding accepts connections on every network interface, use `http://127.0.0.1:8080` in `DVB_URLS` if the player should be accessible only from the local computer.

## Automated releases

The GitHub Actions workflow runs on pushes but creates a release only when the latest commit message contains a semantic version such as:

```text
Prepare player update v1.2.3
```

For a matching commit, the workflow:

1. Builds a self-contained `win-x64` application on a Windows runner.
2. Creates `DvbServer-v1.2.3-win-x64.zip`.
3. Creates and pushes the `v1.2.3` tag when it does not exist.
4. Creates a GitHub Release and attaches the ZIP.

If the tag already exists, the workflow checks out that tagged commit, rebuilds it, and replaces the ZIP attached to its existing release. If the tag exists without a release, the workflow creates one. GitHub permits only one release for a given tag, so reruns update that release instead of creating a duplicate.

A commit without `vMAJOR.MINOR.PATCH` skips the release job.

## Project layout

```text
.
├── .github/workflows/release.yml
├── static/
│   ├── assets/
│   ├── index.html
│   ├── scripts.js
│   └── style.css
├── Program.cs
├── DvbServer.csproj
├── build.ps1
└── README.md
```

## Known quirks and limitations

- Channel availability is controlled by third parties and can change without notice.
- Some streams are geographically restricted or require provider-specific headers, cookies, or short-lived tokens.
- A direct-browser fallback commonly fails when the upstream server does not provide CORS headers; this is expected.
- DRM-protected streams are not supported.
- Browser autoplay policies may require the user to press Play.
- EPG coverage and `tvg-id` quality vary by country and channel. A channel can play correctly while having no matching guide.
- Not every country playlist has a corresponding EPGShare feed.
- DASH and native media URLs are not currently passed through the HLS relay.
- The server must be able to write to its `cache` directory. A read-only installation can play online data but cannot update persistent playlist files.
- The online-user counter uses a separate external service and is not required for channel or EPG playback.

## Third-party components and data

Channel URLs and guide data remain the responsibility of their respective providers. Locally bundled browser libraries retain their own licenses; details are available in `static/assets/vendor/THIRD_PARTY_NOTICES.md`.
