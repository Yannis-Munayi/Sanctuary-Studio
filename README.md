# Sanctuary Studio

A church livestream studio (OBS/XSplit-style) with an EasyWorship-style lyrics & scripture presenter built in.

- **Left half — Presenter:** schedule, preview/live slides, songs, scriptures (verse by verse), media, custom slides, themes. It sends to your projector monitors, to the network, and optionally onto the livestream.
- **Right half — Studio:** scenes, sources, audio mixer, and simultaneous streaming to YouTube, Facebook, TikTok and Instagram (plus Twitch/custom), with recording.

## Starting it

Double-click **`Start Sanctuary Studio.bat`**, or run `npm start` in this folder. The first run installs the components.

Your data (songs, scenes, themes, settings) is saved automatically in `%APPDATA%\Sanctuary Studio\data`. **Settings › Advanced › Back up everything** exports it all to one file.

## Presenter (left)

| Area | What it does |
|---|---|
| **Output** menu | **Secondary monitors** = every monitor except the laptop (your 2 screens). **Primary** = laptop only. Or pick one display. **Identify** shows each monitor's number. |
| **Schedule** | Order of service. Drag items in, drag to reorder, right-click for theme/rename/remove. ☰ saves/opens schedules (`.ssched` files, songs included). |
| **Preview → Go Live** | Click a slide to preview it; **Go Live** (or Enter / double-click) sends it to the screens. |
| **Live** | Click any slide to jump to it. ← → / Space / PageUp/Down step through. **Black** (B), **Clear** text (C), **Logo** (L). |
| **📡 On stream** | Puts the live scripture/lyrics on the livestream as a lower third (S). ⚙ sets its style (lower third, text only, or full screen). |
| **Scriptures** | Type `jn 3 16`, `1 cor 13:4-7`, `ps 23` or `gen 1:1-2:3`. Every verse is its own slide. With "Continue to end of chapter", one verse keeps going verse by verse. Shift-click selects a range. Ctrl+Enter goes live. |
| **Songs** | Create, edit or import. Separate slides with a blank line; put `Verse 1`, `Chorus`, `Bridge`… on their own line. |
| **Import** | EasyWorship 6/7 (`Songs.db` in `Documents\Softouch\EasyWorship\Default\Databases\Data`, or `.ewsx`), SongSelect `.usr`/`.txt`, OpenLyrics `.xml`, ChordPro, plain text. |
| **Bibles** | KJV, ASV, BBE, YLT built in (public domain). Import others (Zefania/OSIS/OpenSong XML or JSON) from the translation menu. |
| **Media / Presentations / Themes** | Images and videos for the screens, custom text slides (announcements), and backgrounds/fonts (motion video backgrounds supported). |
| **Network** | Serves the projector output at `http://localhost:5155` for a browser source or NDI Tools capture on another PC (enable LAN access in Settings › Presenter). |

## Studio (right)

- **Two canvases.** **EDITING** is the scene you're working on and is never streamed. **● LIVE** is what viewers see. Build or change a scene on the left, then press **Go Live ▶** (Ctrl+Enter) or click the scene tile. If you edit the scene that's live, a red **LIVE** tag warns you.
- **Scenes.** Click a tile to send it live; ✎ edits it without touching the stream. You can swap these in Settings › General. Right-click to rename, duplicate or delete; drag to reorder. Ctrl+1…9 switches scenes.
- **Sources.** Any mix in any scene: camera, microphone, video file, image, slideshow, display capture (any monitor), window/game capture, text/ticker, countdown/clock, colour/gradient, scripture & lyrics, nested scene, desktop audio. Drag files onto the canvas to add them.
  - Canvas editing: drag to move, handles to resize (Shift = free ratio), **Alt+drag a handle to crop**, arrow keys to nudge, Delete to remove, double-click for properties, right-click for transform (fit, mirror, rotate, picture-in-picture) and order.
  - **Video options:** play when scene goes live, remember playback position (survives restarts), pause when leaving, loop, hide when finished, speed, start/stop points.
  - **Filters:** chroma key (green screen), colour correction, blur, rounded corners/border/shadow. Audio: EQ, compressor, limiter, noise gate, gain, low-cut.
- **Mixer.** A green dot means the source is in the stream mix. Sources only in the scene you're editing are **not** heard on stream. ⋮ opens filters, monitoring (headphones) and sync offset. Microphone and desktop audio are "all scenes" devices.
- **Going live.** Click the platform chips (YouTube / Facebook / TikTok / Instagram) to choose destinations, then **GO LIVE**. Paste stream keys once in Settings › Stream (stored encrypted). TikTok and Instagram give a new server URL + key each session and are sent a 9:16 centre crop. If one platform drops, only that one reconnects. While live, click a chip to reconnect or stop just that platform.
- **Recording** (● REC) saves MKV by default (crash-safe). The folder and format are in Settings › Output.
- **Encoder.** A hardware encoder is picked automatically when available (NVENC on this laptop), so the CPU stays free.

## Known limits (honest list)

- **Game capture** uses Windows window capture (like OBS "Window Capture"). Run games borderless/windowed; exclusive-fullscreen games may appear black.
- **Native NDI output** needs the NDI SDK and isn't built in. Use the Network output page with NDI Tools instead.
- **Vertical platforms** get a centre crop of the live scene, not a separately designed vertical layout.
- **Browser sources** (web-page overlays) and a virtual camera aren't included.

## Troubleshooting

- **Nothing on the monitors:** check the Output menu and press **Identify**. Esc on an output window turns outputs off.
- **Encoder speed below 1.0×** in the status bar: pick a hardware encoder, or lower Output resolution/bitrate.
- **F12** opens developer tools. **Ctrl+Shift+R** reloads the interface.
