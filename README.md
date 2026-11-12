# Spotify Overlay

A small, see-through, always-on-top widget for Windows that shows what Spotify is playing, with synced lyrics and a visualizer that reacts to Spotify's real audio.

**[Download the installer](https://github.com/bv8dpwfzrj-sudo/spotify-overlay/releases/latest/download/Spotify-Overlay-Setup.exe)** · [Download page](https://bv8dpwfzrj-sudo.github.io/spotify-overlay/)

> Unofficial. Not affiliated with or endorsed by Spotify.

## Features

- Song title, artist, album art, progress bar (click or drag to seek), clock
- Playback buttons (previous / play-pause / next) and a vertical volume slider, plus mouse-wheel volume — all control the Spotify app only
- Visualizer that listens to **only Spotify's audio** (Windows per-app capture), with 8 styles: bars, mirror, spectrum, sound wave, radial, circle wave, LED dots, dual wave
- Flip horizontally/vertically, mirror, bar count, sensitivity, colors (album art / rainbow / white / custom)
- Beat pulse and a glow around the album art based on its edge colors
- Synced lyrics (from [LRCLIB](https://lrclib.net)) with font, size, color, alignment, animation (incl. karaoke fill), glow and sync offset
- Layouts: full, compact strip, visualizer only; optional fade when idle
- Remembers position and settings; optional start with Windows; tray menu

## Install

1. Download **Spotify-Overlay-Setup.exe** from the link above and run it.
2. Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.
3. Open the Spotify desktop app and play something.

**Requirements:** Windows 10 (version 2004+) or Windows 11, and the Spotify desktop app. On older Windows the visualizer falls back to all system audio.

## Using it

- Drag the card to move it. Hover it for the playback buttons and volume slider.
- Double-click the card to switch visualizer style.
- **⚙** (top right on hover) opens settings. The tray icon has layout, click-through lock, start with Windows and Quit.

## Privacy

- Everything runs on your PC. The only network request is the lyrics lookup, which sends the song title, artist, album and length to LRCLIB. Turn off **Show lyrics** in settings to stop it.

## Build from source

Requirements: [Node.js](https://nodejs.org) and the [.NET SDK](https://dotnet.microsoft.com/download).

```bash
npm install

# Spotify-only audio helper (self-contained)
cd tap
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o bin
cd ..

npm start          # run it
npm run dist       # build the installer into dist/
```

## How it works

- `main.js` — Electron main process: transparent window, tray, drag/layouts, lyrics lookup, starts the helpers
- `index.html` — the whole UI and visualizer
- `smtc.ps1` — reads Windows' media session (title, art, position) and sends playback/volume commands to Spotify
- `tap/` — small C# helper that captures only Spotify's audio via Windows process loopback and streams PCM to the app
