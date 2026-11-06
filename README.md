<p align="center">
  <img src="icon.png" width="128" height="128" alt="Previewix icon">
</p>

<h1 align="center">Previewix</h1>

<p align="center">
  <b>One VS Code extension that opens media, documents, tables, archives and more, right where you click them.</b>
</p>

<p align="center">
  <a href="https://github.com/fedorananin/previewix/releases/latest"><img src="https://img.shields.io/github/v/release/fedorananin/previewix?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/fedorananin/previewix" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC?logo=visualstudiocode" alt="VS Code 1.90 or newer">
</p>

Previews for video, audio, image, SVG, 3D model, Markdown, HTML, PDF, Word, Excel, Numbers, CSV, JSON Lines, Parquet, dBase and font files, certificates, archives and SQLite databases in VS Code. Click a file in the Explorer and it opens in Previewix instead of the built-in viewer or the text editor. Previewix works offline and collects no data; the only thing that goes to the network is what an HTML page you preview loads from the web itself, as in a browser.

## Installation

Previewix is distributed as a `.vsix` file through [GitHub Releases](https://github.com/fedorananin/previewix/releases/latest).

1. Download `previewix-<version>.vsix` from the [latest release](https://github.com/fedorananin/previewix/releases/latest).
2. In VS Code, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`), click **⋯** at the top and choose **Install from VSIX…**, then pick the file.

   Or from a terminal:

   ```sh
   code --install-extension previewix-0.14.1.vsix
   ```

3. Click any supported file in the Explorer.

To update, install the newer `.vsix` the same way; VS Code replaces the old version. A `.vsix` from GitHub is not updated automatically, so **Watch → Custom → Releases** on this repository to hear about new versions.

### Requirements

- VS Code 1.90 or newer (or a compatible editor such as Cursor or VSCodium). The SQLite browser needs VS Code 1.103 or newer, because it uses the SQLite built into that version's runtime.
- Optional: [ffmpeg](https://ffmpeg.org) on the `PATH` (or set `previewix.ffmpegPath`). It adds the audio waveform, tag editing for Ogg, Opus and AIFF, saving video clips without re-encoding, and subtitle tracks stored inside a video. Everything else works without it.

## What it opens

| Files | What you get |
| --- | --- |
| [Video](#video) | Player with frame stepping and timecode, frame preview on the seek bar, subtitles, A–B loop, lossless clips, frame as PNG, media info |
| [Audio](#audio) | Player with waveform, stream details, tag and cover editor |
| [Images](#images) | Zoom and pan, folder browsing, crop, rotate, arrows, shapes, text, highlighter, blur and pixelate, color picker, metadata, export. HEIC, TIFF, PSD and ICNS too, and a comparison of two images (also against Git) |
| [Animated GIF, WebP, APNG](#animated-images) | Frame-by-frame player with a frame strip, speed, zoom, frame as PNG |
| [SVG](#svg) | Rendered view with zoom, backgrounds, live update from the source, export to PNG |
| [3D models](#3d-models) | glTF, GLB, STL, OBJ and PLY with orbit, standard views, wireframe, animations, details, view as PNG |
| [Markdown](#markdown) | Rendered view where every block is editable as source; math, Mermaid, footnotes, alerts, outline |
| [HTML](#html) | The page as a browser shows it, with live reload and width presets |
| [PDF](#pdf) | Find, outline, thumbnails, dark pages; highlights, notes, drawing, pictures and form filling saved into the file; export to Markdown |
| [Word](#word) | Rendered `.docx`, export to Markdown |
| [Fonts](#fonts) | Specimen, `@font-face` snippet, variable axes, OpenType features, character grid, details |
| [SQLite](#sqlite) | Table browser with editing, foreign keys, SQL prompt with completion and history, CSV/JSON export, CSV import |
| [CSV and TSV](#csv-and-tsv) | Sortable, filterable table with statistics, copy as Markdown/JSON/CSV, and editing with undo that keeps untouched fields byte for byte |
| [Excel, Numbers](#excel), [JSON Lines](#json-lines), [Parquet](#parquet), [dBase](#dbase) | The same table, per sheet or with column types |
| [Archives](#archives) | ZIP, 7z, RAR and tar (gz, bz2, xz, zst): tree view, open a file from inside, extract, passwords; **Compress to ZIP** in the Explorer |
| [Certificates and keys](#certificates-and-keys) | Subject, issuer, validity, extensions, fingerprints, chain order; keys described without being shown |

Don't want Previewix for some file type? See [Choosing what opens in Previewix](#choosing-what-opens-in-previewix).

---

An open preview follows its file. When the file changes on disk the preview reloads, when it is renamed (in VS Code or outside it, within the same folder) the tab moves over to the new name, and when it is deleted the tab shows that the file no longer exists, until a file with that name appears again.

## Video

- Player controls over the picture: play, seek bar, time, speed, loop, subtitles, volume and fullscreen. They fade out during playback and come back when the pointer moves.
- Click the picture or press `Space` to play or pause; `←` / `→` skip 5 seconds, `↑` / `↓` change the volume, `M` mutes.
- Point at the seek bar to see the frame at that time, with the time under it.
- Frame by frame: `,` and `.` (or the two buttons in the player) step one frame back and forward. Click the time to switch it to a timecode with the frame number, such as `0:01:23:07 · frame 2082 / 5400`.
- **Save frame** (the camera button, or `S`) writes the picture on screen as a PNG in the video's own resolution.
- **Subtitles**: files next to the video that carry its name are found by themselves, such as `movie.srt`, `movie.en.srt` or `movie.pt-BR.forced.vtt` for `movie.mp4`. The subtitles button opens the list, where you pick a track, turn subtitles off, or open any other file with **Load subtitles…**; `C` turns them on and off. SubRip (`.srt`), WebVTT (`.vtt`) and the text of ASS/SSA (`.ass`, `.ssa`, without its styling) are read, in UTF-8, UTF-16 or an older code page (Windows-1251 and Windows-1252 are told apart by the text, others by the language in the file name). When there is a file named exactly like the video it is shown without asking, otherwise one in VS Code's display language, otherwise the first.
- **A–B loop**: `A` marks the start and `B` the end at the current position (or the two bracket buttons), and playback repeats between the marks, which are shown on the seek bar. With only one mark the range runs from the beginning or to the end of the video. `X`, or the × button next to the brackets, removes the marks. Step frame by frame to place a mark exactly.
- **Save clip** (the scissors button, needs [ffmpeg](https://ffmpeg.org)) writes the marked range into a new file without re-encoding: picture, every audio track and the subtitles are copied as they are, so it takes seconds and loses no quality. See "Clips" below for what that means for the start of the clip.
- Fullscreen: the button in the player, `F`, or a double-click on the picture. `Esc` or `F` leaves it.
- A one-line summary in the bar under the player (size, codec, resolution, frame rate, bitrate). Click anywhere on the bar, or press `I`, to open the detailed media info panel: container, duration, overall bitrate, and per-track details (codec, profile, resolution, frame rate, bitrate, bit depth, chroma, audio channels, sample rate, subtitles). **Copy** puts the whole report on the clipboard; the **×** button, the bar or `I` closes the panel.
- The position, speed, loop, volume, the A–B marks and the subtitle choice are restored when you come back to the tab.

Shortcuts work by key position too, so they are the same keys on a Cyrillic or Greek keyboard layout.

Supported extensions: mp4, m4v, mov, webm, mkv, avi, ogv, wmv, flv, ts, mts, m2ts, mpg, mpeg, 3gp.

Media info works for every file. Playback depends on the codecs VS Code ships with: H.264, VP8 and VP9 video normally play, while HEVC video may not, and Previewix tells you when a track can't be decoded.

VS Code can't decode some audio codecs, most notably AAC; such a video plays without sound, and Previewix says so.

Fullscreen uses VS Code's Zen Mode, because webviews can't use the browser fullscreen API.

### Clips

A clip is a copy of the video's data between the marks, not a new encoding. A copied picture can only begin with a keyframe, and keyframes are usually a few seconds apart. So when the start mark is not on one, Previewix asks before it saves: start at the keyframe in front of the mark (the clip is longer than marked) or at the next one (nothing from before the mark gets in, and the beginning of the marked range is missing), with the exact times of both. The end is cut at the mark; it may run a few frames past it. The message at the end states what the clip covers.

- The clip gets the video's own format by default; Matroska (`.mkv`) is offered as well, since it holds nearly any kind of stream. If the format you pick can't hold a stream (subtitles in most cases), the clip is saved without it and the message says which streams were left out.
- The video itself is never changed and can't be chosen as the target. The clip is written under a temporary name next to its target and renamed when it is complete; **Cancel** in the progress notification leaves nothing behind.
- A timecode track is carried over as it is and still states the timecode of the original's beginning.

ffmpeg is optional. Without it the scissors button is not shown, and subtitle tracks stored inside the video (in an MKV or MP4) are not offered; with it, text tracks from inside the file appear in the subtitles list and are read out when you pick one. Picture-based tracks (Blu-ray and DVD subtitles) can't be shown. ffmpeg is never used to play a video.

## Audio

- Player with a waveform you can click or drag to seek, playback speed and loop. `Space` plays and pauses, the arrow keys skip 5 seconds.
- Cover art, title, artist and album at the top; codec, bitrate, sample rate and the rest under **File and stream details**.
- A tag editor: title, artist, album, album artist, composer, genre, year, track, disc, comment and lyrics, plus changing or removing the cover (JPEG or PNG). **Save tags** or `Ctrl/Cmd+S` writes them into the file; **Revert** drops unsaved edits.

Supported extensions: mp3, wav, flac, m4a, m4b, aac, ogg, oga, opus, aiff, aif, wma, ape, ac3, mka.

| Format | Tags |
| --- | --- |
| MP3 | ID3v2.3 and v2.4, edited in place: frames that aren't shown in the form (ratings, replay gain, extra pictures…) are kept as they are |
| FLAC | Vorbis comments and picture blocks, edited in place |
| WAV | Written both as an embedded ID3 tag, which holds every field and the cover, and as the classic `LIST INFO` chunk for software that only reads that |
| M4A, M4B | iTunes-style tags, edited in place: everything that isn't shown in the form (sort names, volume and gapless data, purchase details, further pictures…) is kept byte for byte, and chapters and other tracks are left alone. Track and disc are numbers in this format (`3` or `3/12`). A file with an unusual layout (fragmented, or tagged the QuickTime way) is edited through [ffmpeg](https://ffmpeg.org) when it is installed, which keeps only the tags ffmpeg knows, and is read-only without it. A damaged or incomplete file is always read-only |
| Ogg, Opus, AIFF | Through [ffmpeg](https://ffmpeg.org). Without it the tag editor is not shown for these formats. AIFF has no cover support. In Ogg and Opus a `COMMENT` tag is written back as `DESCRIPTION` |
| AAC, WMA, APE and others | Shown (with ffmpeg) but not editable |

Saving never re-encodes: only the tag part of the file is rewritten and the audio data is carried over unchanged. The new file is built next to the original and replaces it in one step, so an interrupted save can't leave a broken file. For MP3, an old ID3v1 tag at the end of the file is dropped on save so that it can't contradict the new values. For M4A, a change that fits into the padding of the file moves nothing; a larger one moves the audio data as it is, and the result is read back and compared with the original before it takes its place.

Playback depends on the codecs VS Code ships with: MP3, WAV, FLAC, Ogg Vorbis and Opus play, while AAC and ALAC (most `.m4a` files) and WMA don't. The tags and details of such files are still shown and editable. 

ffmpeg is optional. Without it the waveform is not drawn and the tag editor is hidden for the formats that depend on it (Ogg, Opus, AIFF and the read-only ones); everything else, the tags of MP3, FLAC, WAV and M4A included, works as usual.

## Images

| Action | How |
| --- | --- |
| Zoom | Mouse wheel (zooms toward the cursor), `+` / `-`, `0` to fit, `1` for 100% |
| Pan | Drag with the Select tool, or hold `Space` / the middle button with any tool |
| Browse the folder | `←` / `→` or the arrows at the left of the toolbar open the previous / next image in the same tab; the counter shows the position (`3 / 17`). Unexported edits are confirmed first |
| Sizes and pages | A file that holds several pictures (the sizes of an `.ico` or `.icns`, the pages of a TIFF) gets a list next to the arrows; pick from it, or press `Page Up` / `Page Down`. An icon opens on its largest size, a TIFF on its first page. Each picture is edited and exported on its own; unexported edits are confirmed before another one is shown |
| Crop | `C`, drag a rectangle, adjust the handles, then `Enter`. **Ratio** in the crop bar locks the frame to a preset (1:1, 4:3, 3:2, 16:9, 9:16, 4:5…), the original proportions, or a custom ratio |
| Rotate / flip | `Shift+L` / `Shift+R` rotate 90° left / right, `Shift+H` / `Shift+V` flip horizontally / vertically. Annotations and the crop frame follow |
| Arrow | `A`, then drag. Hold `Shift` to snap to 45° |
| Rectangle / ellipse | `R` / `E`, then drag. Hold `Shift` for a square or a circle |
| Highlighter | `H`, then draw. A wide translucent stroke that keeps the text under it readable; hold `Shift` for a straight line |
| Text | `T`, click, type, then `Enter` (`Shift+Enter` adds a line) |
| Blur / pixelate | `B` / `P`, then drag over the area to hide. **Strength** sets the block size; even the lowest setting is coarse enough that the hidden text can't be recovered |
| Pick a color | `D`, then click: the color is copied as hex and becomes the annotation color |
| Edit annotations | `V`, then drag to move, drag an arrow's end or a shape's handles to reshape it, double-click a text to edit it, arrow keys to nudge (`Shift` for 10 px), `Delete` to remove. Color and line width apply to the selection |
| Image info | `I` or the **ⓘ** button: format, dimensions, bit depth, DPI, camera, lens, exposure, dates, GPS (with a link to the map), color profile, description, author and copyright |
| Compare | The button with two panes, next to **ⓘ**: asks for a second image and opens both in the comparison view (see "Comparing two images") |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Export | **Export…** or `Ctrl/Cmd+S`: choose PNG, JPEG or WebP, quality and output size, then **Save as…** |

The status bar shows the cursor position in image pixels with the color under it (hex, RGB and alpha, including annotations), and the size of the crop frame or the shape being drawn.

**Copy** puts the edited image on the clipboard. Edits are never written to the original file unless you pick it in the save dialog. Exported and copied images contain only pixels: EXIF, GPS and other metadata are not carried over.

Supported extensions: png, apng, jpg, jpeg, jpe, webp, bmp, avif, ico, gif, heic, heif, tif, tiff, psd, psb, icns. Animated GIF, WebP and PNG files open in the animation player below; SVG has a viewer of its own.

### HEIC, TIFF, Photoshop and icon files

These open in the same editor, with every tool and the export. The format is told from the content of the file, not from its name.

| Format | What is shown | What is not |
| --- | --- | --- |
| HEIC / HEIF | iPhone photos and other HEVC pictures: tiled pictures, rotation and mirroring stored in the file, transparency, 10- and 12-bit pictures (shown with 8 bits). A file with several pictures lists them | Image sequences without a still picture; pictures in a codec the decoder doesn't have. An HDR picture (PQ, HLG) is shown without tone mapping, and the editor says so |
| TIFF | All pages. Uncompressed, LZW, Deflate, PackBits, JPEG and fax (CCITT Group 3 and 4) compression; strips and tiles; 1 to 16 bits per channel; grayscale, palette, RGB, CMYK and Lab; transparency; the orientation tag | BigTIFF, floating-point samples, and the LZMA, Zstandard, WebP, JPEG 2000 and old-style JPEG compressions |
| PSD / PSB | The flattened picture Photoshop stores next to the layers, in RGB, grayscale, indexed, bitmap, duotone, CMYK and Lab, with 8, 16 or 32 bits per channel and with transparency | Layers are not rendered. A file saved with **Maximize Compatibility** off has no flattened picture and can't be shown; multichannel files can't either |
| ICNS | Every size, including the dark, template and selected variants and the packed 16 to 128 px pictures of older icons | Sizes stored as JPEG 2000 (the large sizes of some older icons) are listed but can't be shown; the black-and-white and 16- or 256-color pictures of classic Mac icons are skipped |
| ICO | Every size, in every color depth | |

A file that can't be shown says why (cut short, a kind of compression that isn't supported, no flattened picture) instead of showing a broken picture. A HEIC or TIFF file whose data is damaged in places is shown as far as it can be decoded, with a warning. A decoder that does not finish in reasonable time is stopped, and the editor says so.

Large files take a moment: a 12-megapixel iPhone photo decodes in under half a second, a 48-megapixel HEIC in 2 to 3 seconds, with about 700 MB of memory in use while it does. The editor shows that it is decoding and stays responsive meanwhile, so you can move on to the next file without waiting.

**Color.** The editor works in sRGB with 8 bits per channel, and exports are sRGB. A picture with a color profile (the Display P3 of iPhone photos, Adobe RGB, and so on) is converted to sRGB when it is opened, the same way for HEIC, TIFF and PSD as for a PNG or JPEG with a profile; colors outside sRGB are clipped. CMYK pictures are converted with a generic press profile rather than their own, so their colors are approximate, and the editor says so. The **Image info** panel states under **On screen** what was done to the picture you are looking at.

The HEIC decoder is [libheif](https://github.com/strukturag/libheif) with libde265, both under the GNU Lesser General Public License version 3. They are shipped unmodified as separate files (`dist/libheif/`, with the license text) and loaded only when a HEIC file is opened.

### Comparing two images

A view of its own for two pictures: a screenshot before and after, an asset and its committed version, two exports of one design. It names them **A** and **B**, counts the pixels that differ, and shows where they are.

How to open it:

| From | How |
| --- | --- |
| Explorer, two images selected | Right-click → **Compare Images** |
| Explorer, one image | Right-click → **Compare Image with…**, then pick the other: the committed version (when the file is in a Git repository), an image that is open in another tab, or **Choose a file…** |
| Image editor | The compare button in the toolbar, which asks the same question |
| Git | **Previewix: Compare Image with Committed Version** in the Command Palette compares the last commit (HEAD) with the file on disk, and so does "The committed version" in the list above. A changed image clicked in the Source Control view opens VS Code's own diff editor, with one image editor per version: there each editor folds its tools away and shows **Compare**, which opens both versions here (**Tools** brings the toolbar back). The diff editor's title bar has the same button |
| Command Palette | **Previewix: Compare Images**: with an image open it asks for the other, otherwise for both |

| Mode | What it shows |
| --- | --- |
| Side by side (`S`) | A and B next to each other, or above each other when that shows them larger. Zoom and pan move both; a cross marks, in the other picture, the point under the pointer |
| Blink (`B`) | One picture in place of the other. `Space` flips between A and B, from any mode; **Auto** flips twice a second. Whatever jumps is what changed |
| Swipe (`W`) | A on the left of a divider, B on the right. Drag the divider across |
| Onion skin (`O`) | B over A, as see-through as the slider says |
| Difference (`D`) | A, faded, with every pixel that differs marked in magenta. Zoomed out, a mark stands for all the pixels under it, so a single changed pixel in a large photograph is still on screen |

| Action | How |
| --- | --- |
| Zoom, pan | Mouse wheel, `+` / `-`, `0` to fit, `1` for 100%, double-click to switch between the two; drag or the arrow keys to move (`Shift` for larger steps) |
| Tolerance | The slider, the number next to it, or `[` / `]` (`Shift` for steps of 10) |
| Go to the change | `J`, the target button, or a click on the changed area in the result line |
| Frame around the change | `F` or the frame button |
| Swap A and B | `X` or the swap button |
| Move B over A | `Alt+arrows` by one pixel, `Alt+Shift+arrows` by ten |
| Save the difference | **Save difference…** or `Ctrl/Cmd+S`: the picture of the Difference mode at full size, on white, as PNG |
| Open a picture | Click its name |

Above the pictures: the name, size in pixels, format and file size of each, then the result. "1,204 of 2,073,600 pixels differ (0.06%) · largest difference 187 of 255 · changed area 240 × 36 px at 512, 88" reads: that many pixels are not the same, the worst of them is that far off, and all of them lie inside that rectangle of A. The status bar shows the position of the pointer and the color of A and of B there, and how far apart the two are.

**Tolerance.** Two pixels are measured by the channel in which they differ most: red, green, blue or alpha, from 0 to 255. With a tolerance of 0 every difference counts. A JPEG that was saved again differs from its source almost everywhere, by a few levels; raise the tolerance until that noise is gone, and what is left is the real change. The result says how many pixels differ within the tolerance, so nothing is hidden. Colors are weighted by their alpha, as they are on screen: what lies behind full transparency doesn't count, and an opaque pixel against a see-through one does.

**Different sizes.** Nothing is stretched unless you ask for it. B is laid on A corner to corner at the top left, pixel for pixel, the part that both cover is compared, and a line above the pictures says so. **Align** moves B to another corner or the middle, `Alt+arrows` move it by hand (for a crop taken from anywhere), and **B scaled to the size of A** is for the same picture at another scale, a 2× screenshot against a 1× one. Scaling softens edges, so expect small differences along them; the page says that too.

Every format the image editor opens works here, PNG against HEIC or TIFF included: both are decoded to pixels first. An animated GIF, WebP or PNG is compared by its first frame, an icon by its largest size, a TIFF by its first page. SVG files are not compared; the SVG preview exports them to PNG.

Both files are watched: when either changes on disk the comparison is worked out again, with the view where it was, and a commit updates the committed side. A file that is deleted leaves its side empty until it comes back. The tab is restored when the window is reloaded.

Two 48-megapixel photographs take about a second to load and compare as JPEG, about five as HEIC, and zooming and flipping stay smooth afterwards; the page holds roughly 0.8 GB for them. The pixels are counted in the background, so the pictures can be looked at meanwhile.

## Animated images

GIF, animated WebP and animated PNG files open in a frame-by-frame player instead of the image editor. A `.webp`, `.png` or `.gif` with a single frame opens in the editor as usual.

| Action | How |
| --- | --- |
| Play / pause | `Space`, or the button in the toolbar |
| Step | `,` and `.` or `←` / `→` for the previous and next frame, `Home` / `End` for the first and last |
| Scrub | Drag the slider under the picture. The counter next to it shows the frame, its delay and the elapsed time |
| Speed and loop | **Speed** from 0.25× to 4×; **Loop** (`L`) starts over after the last frame |
| Frame strip | Thumbnails of every frame; click one to jump to it. **Frames** or `F` hides the strip |
| Zoom and pan | Mouse wheel (zooms toward the cursor), `+` / `-`, `0` to fit, `1` for 100%; drag to pan |
| Save a frame | **Save frame as PNG…** or `Ctrl/Cmd+S` saves the frame on screen; **Copy frame** puts it on the clipboard |

The bar at the bottom shows the format, dimensions, frame count, total duration, how many times the file asks to be played, and its size. The frame, speed, loop and zoom are restored when you come back to the tab.

Each frame is shown for its own delay; as in browsers, a delay of 10 ms or less counts as 100 ms. Frames are never skipped, so a fast animation at 4× can't go faster than the screen refreshes. The file is not edited.

## SVG

`.svg` files open as a picture rather than as text.

- Zoom with the mouse wheel (toward the cursor), `+` / `-`, `0` to fit, `1` for 100%, and drag to pan. The picture is redrawn at every zoom level and stays sharp.
- **Background** switches between a checkerboard, white and dark, to check transparent and light-on-dark pictures.
- **Open source** switches to the text editor in the same editor group; the preview button in the text editor's title bar goes back. `Alt`+click opens the text to the side instead, and the preview then follows what you type, before you save.
- **Export PNG…** or `Ctrl/Cmd+S`: 1×, 2×, 4× or an exact width, then **Save as…**. **Copy SVG** puts the source on the clipboard.
- The bar at the bottom shows the size, the viewBox, the number of elements and the file size.

A file that sets neither a size nor a viewBox is shown fitted to its drawing. A file that isn't valid XML shows the error with its line and column, over the last picture that worked.

The SVG is drawn as an image: scripts in it don't run, and images, fonts and stylesheets it links to from outside are not loaded (embedded `data:` ones are).

## 3D models

`.glb`, `.gltf`, `.stl`, `.obj` and `.ply` files open as a model you can turn around, instead of binary noise or a wall of numbers.

- Drag to orbit, right-drag (or `Shift`+drag) to pan, and zoom with the mouse wheel or a pinch, toward the cursor. A model is framed when it opens, whatever its size and units. `0` or a double-click resets the view; **Front**, **Side** and **Top** (`1`, `2`, `3`) look straight at the model, and with `Shift` from the opposite side.
- Models look right without any setup: physically based materials reflect a neutral studio environment, so nothing comes up black. Files without materials (most STL, many OBJ and PLY) get a matt grey one, missing normals are computed, vertex colors are shown, and a PLY without faces is drawn as a point cloud.
- Wireframe (`W`), a grid on the ground (`G`) whose cell size is shown in the status bar, and the axes at the origin (`A`: X red, Y green, Z blue). **Background** switches between the editor's color, white, dark and a checkerboard.
- **Up** says which axis of the file points up. It is Y, as glTF defines it, and Z for STL, which is what CAD programs and slicers write; switch it when a model lies on its side. The choice is remembered for the file.
- glTF animations get a player over the bottom of the view: play and pause (`Space`), the list of clips, and a seek bar.
- A `.gltf` loads its `.bin` and textures, an `.obj` its `.mtl` and textures, from the model's folder or from anywhere inside the workspace folder. What can't be found is named in a notice and the rest is shown.
- Compressed glTF: Draco and meshopt geometry, quantized meshes, WebP and AVIF textures. KTX2 (Basis Universal) textures are not supported: such a model is shown without them, and the notice says so.
- **Model details** (the ⓘ button, or `I`): format, generator, extensions, triangles, vertices, meshes, the bounding box, materials, textures, animations and whatever was wrong with the file. **Copy** puts it all on the clipboard. The bar at the bottom has the short version.
- **Save PNG…** or `Ctrl/Cmd+S` saves the current view at 1×, 2× or 4× the size on screen, with the grid and axes if they are shown. On the checkerboard the background is saved as transparency.
- **Open source** (`.gltf` and `.obj`) switches to the text editor in the same editor group, `Alt`+click opens it to the side; the preview button in the text editor's title bar goes back. The view reloads when the file is saved and keeps the camera.

Nothing is drawn while a model stands still, so an open tab costs no GPU time; a tab in the background gives up its graphics memory and loads the file again when you return. A damaged file says what is wrong with it (a binary STL that was cut short still shows the triangles that are there). A model never makes Previewix fetch anything from the network.

Files of up to 512 MB open, and up to 128 MB for the text formats (`.gltf`, `.obj`, text STL and PLY), which need many times their size in memory. The viewer needs WebGL, and says so when VS Code runs without hardware acceleration and has none.

## Markdown

`.md` and `.markdown` files open rendered, and every block (heading, paragraph, list, table, code block…) can be edited in place:

- Double-click a block, or use the pencil that appears to its left, to edit its Markdown source. A live preview of the block is shown underneath.
- `Esc`, `Ctrl/Cmd+Enter`, **Done**, or a click elsewhere finishes the edit. Emptying a block deletes it.
- **+ Add block** at the bottom writes a new block at the end of the file.
- Clicking a task-list checkbox toggles `[ ]` / `[x]` in the file.
- In the editor, `Enter` continues a list, and the **B**, *I*, `</>` and **Link** buttons wrap the selection.
- **Open source** switches to the plain text editor in the same editor group. The preview icon in that editor's title bar (or the **Previewix: Open Previewix Preview** command) brings the rendered view back.
- **Outline** opens a table of contents built from the headings, to the left of the document. Click an entry to go to its heading; the entry of the section you are in is marked. Whether it is open is remembered for the documents you open next. In a narrow editor the outline lies over the document and closes once you pick an entry.

Only the lines of the block you edit are rewritten, so the rest of the file keeps its exact formatting. Changes go into the regular VS Code document: the tab shows the unsaved dot, and saving, auto save and hot exit work as usual.

Also rendered: GitHub-style tables, strikethrough, autolinks, front matter, syntax-highlighted code, relative images, and links (other files open in VS Code, web links in the browser). Headings get the ids GitHub gives them, so a link like `[see below](#some-heading)` jumps inside the document.

### Math, diagrams, footnotes and alerts

- **Math** is drawn with KaTeX: `$…$` inside a line, and `$$…$$` (on one line or around several) or a ` ```math ` block for a formula on its own. A formula KaTeX can't read shows its source and the error in its place. A single `$` only starts a formula when the formula begins right after it, ends right before the next `$`, and no letter or digit touches the pair from outside, so `$5 and $10` stays text. For a formula that touches a word, write ``$`…`$``.
- **Diagrams**: a ` ```mermaid ` block is drawn with Mermaid in the colors of the current theme (light, dark or high contrast) and redrawn when the theme changes. A diagram with a mistake shows Mermaid's message under its source. Mermaid is only loaded for documents that have a diagram. It runs in its strict mode: HTML in labels is cleaned and click actions are off. The ELK layouts are not included; a diagram that asks for one is laid out the default way.
- **Footnotes**: `[^1]` in the text and `[^1]: the note` on a line of its own. Notes are numbered in the order the text first refers to them; the number leads to the note and ↩ leads back. A note stays where it is written in the file, as a block you can edit like any other, instead of moving to the end of the page. One that nothing refers to is shown dimmed.
- **Alerts**: a quote that begins with a line `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]` or `> [!CAUTION]`.

All of this shows in the live preview of the block you are editing as well. While the source of a diagram is wrong, the last picture that worked stays there, dimmed, with the message under it.

## HTML

`.html` and `.htm` files open as the page they describe, the way a browser shows the file from disk: with the stylesheets, scripts, pictures and fonts it names, from its own folder or from anywhere inside the workspace folder.

- **Open source** switches to the text editor in the same editor group; the preview button in the text editor's title bar goes back. `Alt`+click opens the text to the side instead, and the preview then follows what you type, before you save. A changed page takes the place of the one on screen once it has loaded, at the same scroll position, so typing doesn't make it flicker.
- The page also loads again when a file it uses changes on disk: a stylesheet, a script, a picture.
- **Width** lays the page out as wide as the tab, or as wide as a phone (390 px), a tablet (768), a laptop (1280) or a desktop screen (1920). A width that doesn't fit the tab is shown whole and scaled down; the bar at the bottom has the size and the scale.
- **Scripts** switches the scripts of the page off and on, for every HTML preview. Without them a page shows what it keeps in `<noscript>`.
- Links work as you would expect in an editor: a link to a place on the page scrolls there, a link to another file opens that file in VS Code (a page as a preview, a picture or a PDF in its viewer), and a web link opens in the browser. A page that sends the browser on by itself, with a redirect in its head or from a script, stays where it is, says where it leads, and the file it leads to is opened.
- **Reload** starts the page afresh. **Open in browser** hands the file to your default browser.
- VS Code's own shortcuts keep working while the page has the focus, and copy, cut, paste, select all and undo act inside the page.
- The bar at the bottom shows the title of the page and the size of the file.

The page behaves like a file opened from disk, not like a site on a server: an address that begins with `/` leads nowhere, forms are not submitted, and a frame inside the page can't show another local page. `alert()` and the other dialogs, new windows and fullscreen are not available inside VS Code.

Scripts run as they do in a browser, and a page can reach the network and read the files of its folder and of the workspace folder. Switch **Scripts** off before you look at a page you don't trust. Files of up to 32 MB open.

## PDF

- Continuous scrolling with selectable, copyable text and clickable links.
- Page navigation, zoom (buttons, presets, or `Ctrl/Cmd` + wheel / pinch), rotation.
- Find in document: `Ctrl/Cmd+F`, then `Enter` / `Shift+Enter` for the next and previous match.
- **Pages** opens a sidebar of page thumbnails: the current page is marked, a click goes to a page. Thumbnails are drawn as they scroll into view, so a document of a thousand pages opens as fast as a short one.
- **Outline** opens the table of contents when the PDF has one.
- **Dark** shows the pages with light text on a dark page, for reading at night. Colors keep their hue (a blue link stays blue), and photographs are left as they are; charts, scans and other pictures that are mostly white are turned dark with the page. The switch is remembered and applies to every PDF.
- Password-protected files ask for the password.

The page, zoom, rotation and the open sidebar are kept while the tab is open. Rendering is done by [pdf.js](https://mozilla.github.io/pdf.js/).

### Annotating and filling in forms

- **Highlight**: select text to mark it, or drag where there is no text to draw a highlight by hand. Without the tool, selecting text shows a small highlight button next to the selection.
- **Text**: click on the page and type a note. `Esc` or a click elsewhere finishes it; a double click opens it again.
- **Draw**: draw freehand.
- **Image**: **Add Image…** places a picture on the page, where it can be moved and resized.
- A bar under the toolbar holds the options of the tool in use: color, size, thickness, opacity. With an annotation selected, it changes that annotation.
- A click selects an annotation; drag it to move it, use its handles to resize it. `Delete` or the bin next to it removes it, `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (or **Undo** and **Redo**) step back and forth, the arrow keys nudge it.
- Highlights, notes, drawings and pictures that are already in the file can be changed and removed the same way; a double click on one switches to its tool.
- Form fields (text, check boxes, radio buttons, lists) are filled in right on the page while no tool is on.

Changes are kept in the tab until you save. The tab shows the unsaved mark, `Ctrl/Cmd+S` or **Save** writes them into the PDF, **File > Save As…** writes a copy and leaves the original alone, **File > Revert File** drops them, and closing the tab asks first. Auto save and hot exit work as for any other file.

- The saved file is the original with the changes added at its end, which is how PDF expects to be updated: nothing that was there before is rewritten. It is built next to the original and then swapped in, so a failure midway can't damage the document.
- A file that changes on disk while you have unsaved changes isn't reloaded. A notice offers to discard and reload, and saving asks before it replaces the newer file.
- A digitally signed PDF asks before the first save: the signed content stays untouched, but PDF readers will say the document was changed after signing. Use **Save As…** to keep the signed file as it is.
- A password-protected PDF stays protected with the same password.
- Not supported: scripts inside PDF forms (fields that calculate or format themselves stay as typed), XFA forms, drawing a signature, comments attached to annotations.

## Word

`.docx`, `.docm` and `.dotx` files open as pages with their text, styles, tables, lists, images, headers and footers. Zoom with the toolbar or `Ctrl/Cmd` + wheel; `Ctrl/Cmd+F` searches the text.

The layout is an approximation made by [docx-preview](https://github.com/VolodymyrBaydalka/docxjs): page breaks and complex formatting can differ from Word. The old binary `.doc` format isn't supported. Both viewers are read-only.

### Converting to Markdown

**To Markdown** in the PDF and Word toolbars saves the document as a `.md` file and opens it next to the original.

- Word: headings, bold and italic, lists, tables, links and footnotes are kept. Pictures are saved into a `<name>_images` folder next to the Markdown file. The first row of a table becomes its header.
- PDF: only the text is recovered. Headings are guessed from the type size, paragraphs from spacing, list items from bullet characters and numbers. Tables come out as plain text, and images, bold and italic are lost. A scanned PDF has no text to convert.

## Fonts

Font files open as a specimen of the font:

- **Sample**: a text set in the font at any size from 8 to 240 px. Pick one of the ready texts (pangram, alphabet, paragraph, numerals, and Cyrillic or Greek when the font has them), or click the sample and type your own.
- **Variable axes**: a slider for every axis of a variable font (weight, width, optical size…) and a list of its named instances. **Reset** returns to the default.
- **OpenType features**: switches for ligatures, small capitals, figure styles, fractions, stylistic sets and the like, with the names the font gives its sets. Everything on the page follows the axes and features you set.
- **Sizes**: the first line of the sample from 12 to 96 px.
- **Characters**: every character the font covers, filtered by Unicode block. Click one to see it large with its code point, and to copy the character or the code.
- **CSS**: a ready `@font-face` rule for the file (family, format, weight, style and width, as ranges for a variable font) and a usage example that carries the axes and features set on the page. **Copy** puts it on the clipboard.
- **Font details**: names, version, designer, copyright and license, glyph and character counts, units per em, metrics, embedding permission, the full feature list and the tables of the file. **Copy** puts all of it on the clipboard.

A collection (`.ttc`, `.otc`) lists its fonts in a selector at the top.

Supported extensions: ttf, otf, ttc, otc, woff, woff2. The character grid shows the characters that have a code point; glyphs reachable only through features (ligatures, alternates) appear when you type them in the sample. A character the font lacks is drawn by VS Code in another font. Fonts are not edited.

## SQLite

Database files open as a browser with the tables and views on the left and the rows of the selected one on the right.

| Action | How |
| --- | --- |
| Browse | Click a table or view. Rows come in pages of 100 to 1000; click a column header to sort, and type in **Filter rows** to keep the rows that contain the text in any column |
| Edit a cell | Double-click it, or select it and press `Enter` / `F2`, or just start typing. `Enter` confirms (`Shift+Enter` adds a line), `Tab` confirms and moves on, `Esc` cancels |
| Set NULL | **Set NULL**, or `Delete` on the selected cell |
| Add a row | **Add row**, then fill in the cells you need; the rest get their default values |
| Delete rows | Select a cell, or pick rows by their numbers (`Shift` and `Ctrl/Cmd` select several), then **Delete row**. Pressing it again on rows marked for deletion restores them |
| Save | **Save changes** or `Ctrl/Cmd+S`. **Revert** drops everything that isn't saved |
| Follow a foreign key | Columns with a foreign key have an arrow in the header. Select a cell in one and the bar under the grid names the row it refers to: click it there, or `Ctrl/Cmd+click` the cell, or press `Ctrl/Cmd+Enter`. The other table opens on that row. A plain click still selects and a double-click still edits |
| See what refers to a row | Select a cell of the row and pick a table under **Referred to by** in the same bar: that table opens with the rows that point here |
| Go back | The **← table** button above the grid, or `Ctrl/Cmd+[`, returns to where the key was followed from, with its page, sort, filter and selected cell. **Show all rows** stays in the table and drops the narrowing |
| Table definition | **Structure** shows the columns, the foreign keys of the table and the keys of other tables that refer to it (a table name there opens that table), and the `CREATE` statements of the table, its indexes and triggers |
| Run SQL | **SQL query**, then **Run** or `Ctrl/Cmd+Enter`. One statement or several, separated by semicolons; the first 1000 rows of the last result are shown |
| Complete a name | Start a word in the SQL prompt and a list offers tables, views, columns of the tables the statement names (all of a table's columns after `table.` or `alias.`), keywords and functions. `Tab` takes the highlighted name, `↑` / `↓` choose, `Esc` closes. `Ctrl+Space` (or `Alt+Esc`) brings the list up without typing |
| Earlier statements | `Alt+↑` and `Alt+↓` in the SQL prompt step through what was run on this database before; **History** lists it, with **Clear history…** at the end |
| Export | **Export…** → **CSV…** or **JSON…** writes every row of the table, sorted and filtered as on screen, or the whole result that **SQL query** shows (of a statement that only reads). Progress and **Cancel** are in the notification |
| Import CSV | **Import CSV…**, pick a file, then check the preview: the delimiter and whether the first row is a header are detected and can be changed. Import into an existing table (each column of the file goes to the table column with its name; change or skip any) or into a new one (name, column names and the inferred types INTEGER, REAL, TEXT can be edited) |
| Blobs | Pictures (PNG, JPEG, GIF, WebP, BMP) are marked in the grid. Select a blob cell to see the picture with its dimensions, or the first 4 KB in hex for any other blob; click the picture, double-click the cell or press `Enter` to see it full size. **Save blob to file…** writes the blob as it is |

Edits are collected first: changed cells and new rows are highlighted, deleted rows are struck through, and nothing touches the file until you save. A save is one transaction, so if any change is refused (a constraint, a wrong type in a `STRICT` table, a row that is gone) none of them is written and the message says why. Foreign keys are enforced.

What you type is stored the way SQLite itself would store it in that column: a number in a numeric column becomes a number, and an empty value there becomes NULL. Blobs can't be edited, only set to NULL. Views, virtual tables and generated columns are read-only. Statements run from **SQL query** are executed right away, including the ones that change data.

Foreign keys are followed by value, so a key leads to its row whether it refers to the primary key, to another unique column or to several columns at once, and a value you have typed but not saved is followed as typed. A NULL refers to nothing and a reference to a row that doesn't exist says so; in both cases you stay where you are. Unsaved edits stay staged while you move between tables. A blob longer than 16 bytes can't be followed.

A script runs statement by statement and stops at the first one that fails. The list under the prompt says what each statement did (rows returned or rows changed, counting what its triggers and cascades changed, and the time), and the grid shows the last result set. SQLite itself decides where a statement ends, so semicolons in strings, in comments and inside `CREATE TRIGGER … BEGIN … END` are fine. There is no transaction around a script: each statement is committed as it finishes, so when statement 5 fails, what statements 1 to 4 changed stays, and the message says so. To get all or nothing, write `BEGIN;` first and `COMMIT;` last: a transaction that is still open when the script stops, because of an error or because the `COMMIT` is missing, is rolled back. A statement is only checked when its turn comes, since it may use a table that an earlier one creates. An export of a result runs its statement again without write access; after a script that changed the database only that one statement is run again, so a result that needs a temporary table from the same script can't be exported then.

In the completion list `Enter` takes a name only after you have moved in the list with the arrow keys or asked for the list yourself; in a list that came up while typing, `Enter` is a line break as always. Names that need quotes are written with them.

The history keeps the last 200 statements or scripts per database, each one once, failed ones marked. It is stored by the extension on your computer, outside the database and its folder, and survives closing the tab and restarting VS Code. It belongs to the file's path, so a renamed or moved database starts a new one. Scripts over 100,000 characters are not kept.

An export writes what the database holds; unsaved edits aren't in it. CSV files are UTF-8 with a header row: NULL is an empty field, an empty text is `""`, integers are written in full (also beyond 2^53), reals always read back as reals (`5.0`), and blobs are written in hex as `X'89504E47…'`. JSON is an array of objects, one per row: integers beyond ±2^53 are strings so no reader rounds them, blobs are base64 strings, and infinity is written as `9e999`. Columns of a query that share a name get a number in JSON (`id`, `id_2`).

An import converts each value the way typed input is converted: a number in a numeric column becomes a number, text stays text in a text column. An empty field becomes NULL, unless **Empty fields as empty text** is on; a quoted `""` is always an empty text. In a column without a type or of type BLOB, an `X'…'` value becomes a blob, so exported blobs come back. Numbers with leading zeros (ZIP codes, phone numbers) are inferred as TEXT, and the types of a new table are inferred from the first 4 MB of the file. The import is one transaction and is written right away, like **SQL query**: if any row is refused (a constraint, a wrong type in a `STRICT` table, a row with more fields than the first one), nothing is imported and the message names the row and its line in the file. Unsaved edits are not affected; the page asks before it imports while there are any. Pictures over 16 MB aren't shown in the page, but can be saved.

The view follows the file: when another program changes the database, the page is read again and your unsaved edits are kept.

Supported extensions: sqlite, sqlite3, db, db3, sdb, s3db. Needs VS Code 1.103 or later, and works for files on the computer VS Code runs on.

## CSV and TSV

Delimited text files open as a table, and the table can be edited.

| Action | How |
| --- | --- |
| Sort | Click a column header: ascending, descending, then back to the order of the file. Numbers sort as numbers, and empty cells go last |
| Filter | Type in **Filter rows** (`Ctrl/Cmd+F`) to keep the rows that contain the text in any column. The matches are highlighted and counted; `Esc` clears the filter |
| Filter a column | Point at a column header and click the funnel, or press `Alt+↓` in a cell of the column. Text: **contains**, **does not contain**, **equals**, **starts with**, **ends with** (upper and lower case are the same). Number: **=**, **≠**, **>**, **≥**, **<**, **≤**. Cell: **is empty**, **is not empty**. A filtered column is underlined and keeps its funnel. Right-click a cell and choose **Keep the rows with this value** to filter by it. Column filters add up, with each other and with **Filter rows**; **Clear filters** removes all of them |
| Select | Click a cell, drag or `Shift`+click for a range, click a row number for the row or the corner for everything. Arrow keys, `Tab`, `Home` / `End`, `Page Up` / `Page Down` move; `Ctrl/Cmd` with an arrow jumps to the edge, `Shift` extends, `Ctrl/Cmd+A` selects all |
| Copy | `Ctrl/Cmd+C` copies the selected cells, tab-separated, ready to paste into a spreadsheet. **Copy as…** (also on right-click) copies them as a **Markdown table**, as **JSON** or as **CSV** |
| Column width | Drag the right edge of a header; double-click it to fit the content |
| Header | **First row is header** turns the first row into the column names, or back into data |
| Delimiter | Detected from the first lines (comma, semicolon, tab or pipe); **Delimiter** overrides it |
| Edit a cell | Double-click it, press `Enter` or `F2`, or just start typing (which replaces what is there). `Enter` confirms and moves down, `Tab` confirms and moves right, `Shift` reverses both, `Esc` cancels; clicking elsewhere confirms too. `Alt+Enter` (or `Ctrl/Cmd+Enter`) starts a new line inside the cell |
| Clear cells | `Delete` or `Backspace` empties the selected cells |
| Cut and paste | `Ctrl/Cmd+X` and `Ctrl/Cmd+V`, also on right-click. A block copied in a spreadsheet (or here) is pasted from the selected cell on; one copied cell fills the whole selection. A block that reaches below the last row adds rows at the end of the file, and one that reaches beyond the last column makes the rows longer |
| Add a row | `Ctrl/Cmd+Enter` adds an empty row below the selection, `Ctrl/Cmd+Shift+Enter` above it; **Add row** in the toolbar and the right-click menu do the same. Without a selection the row goes to the end of the file |
| Delete rows | `Ctrl/Cmd+Shift+K`, or **Delete rows** on right-click, removes the rows of the selection |
| Columns | Right-click a column header: **Rename column** (when the first row is the header), **Insert column left** / **right**, **Delete column** |
| Undo, redo, save | VS Code's own: `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`), `Ctrl/Cmd+S`, **Save As…**, **Revert File**. The tab shows the dot of an unsaved file, VS Code asks before it closes one, and unsaved edits survive a restart (hot exit) |

A cell whose text doesn't fit, or has several lines, is shown in full under the table when you select it. The status line shows the number of rows and columns, the delimiter, the encoding (UTF-8, UTF-16, or Windows-1252 for files that aren't valid UTF-8) and the file size.

With more than one cell selected, the status line counts the cells that hold something and, for the numbers among them, shows how many there are, their sum, average, minimum and maximum. A cell is a number when it reads as one (`12`, `-3.5`, `1e6`, also `007`), which is the same rule that sorts it as a number and aligns it to the right; `1,234`, `12%` and `$5` are text. A whole column of a large file is counted at once, and everything in it within a moment.

What **Copy as…** writes:

- **Markdown table**: the column names are the header and columns of numbers are aligned to the right. Pipes, line breaks (`<br>`) and Markdown markup in the cells are escaped, so the table shows the text of the cells.
- **JSON**: an array with one object per row, keyed by the column names. A name that occurs twice gets a number (`name`, `name_2`), and a column without a name is called `Column 3`. A number is written with exactly the digits it has in the cell, an empty cell is `null`, and everything else is a string, including `007` and `+5`.
- **CSV**: comma-separated, with the column names as the first line when the table has a header row.

Up to 2,000,000 cells are copied at once; a larger selection is refused with a note in the status line.

**Open source** switches to the plain text editor in the same editor group; the preview button in the text editor's title bar brings the table back.

### Editing

Editing works the same while the table is sorted or filtered: a paste goes into the rows as they are shown, and a new row lies in the file next to the row it was added at. Rows stay where they are while you edit them, also when the new value would sort a row elsewhere or no longer passes the filter; **Sort and filter again** appears in the toolbar and puts them in order when you want that.

A save changes only what you changed. Every field you didn't touch keeps its exact bytes, including its quotes, and so do the delimiter, the encoding and its byte order mark, the line breaks (also in a file that mixes several kinds) and whether the file ends with a line break. A new value is put in quotes only when it has to be (it holds the delimiter, a quote or a line break), or when that is the way of the file: the field it replaces was quoted without need, or every field of the file is quoted. Before the file is replaced, the result is read back and compared with the table; if the two differ, nothing is written.

- **Text the encoding can't hold.** A file that isn't valid UTF-8 is read as Windows-1252, which has no Cyrillic, Greek or Asian characters and no arrows. Type one and a note above the table says so; on save you are asked whether to write the whole file as **UTF-8** or as **UTF-8 with BOM** (which Excel needs to recognise UTF-8), or to cancel. Nothing is ever written as a question mark.
- **The file changed on disk.** Without unsaved edits the table simply follows the file. With them, your edits are kept and a note appears; saving then asks before it overwrites the newer file, and **Load the file from disk** (or **Revert File**) takes the newer file instead.
- **The same file in a text editor.** The table and a text editor on the same file are two separate copies. The table tells you when the text editor has unsaved changes and asks before it saves over them; **Open source** with unsaved edits in the table offers to save them first.
- **Delimiter.** With unsaved edits the delimiter can't be changed, since it would make other rows and columns of the same file.
- Undo steps from before the file was reloaded from disk do nothing. In a second editor on the same file (a split) edits, undo and redo appear in both.
- `Ctrl/Cmd+Z` inside a cell that is being edited undoes the typing in that cell, not the last edit of the table.
- Text that arrives without a key press (an emoji picker, dictation) goes into a cell only while it is open for editing.
- Up to 2,000,000 cells are cleared or pasted over in one go, as with copying. Edited cells are not marked in the grid; the dot on the tab says that something is unsaved.
- A file opened from a place that can't be written to, such as the older side of a comparison, is shown without editing.

Supported extensions: csv, tsv, tab, psv. Files of up to 100 MB are opened; a table with hundreds of thousands of rows stays quick to scroll, sort, filter and edit. In a file of 200,000 rows and 30 columns an edit takes a few hundredths of a second and a save about one to three seconds.

## Excel

Workbooks open as tables, one sheet at a time, with the sheets as tabs at the bottom. Hidden sheets are listed too and marked as hidden.

- Cells show what Excel shows: dates, percentages, currencies and other number formats are applied, and formulas show their last calculated value. Numbers and dates are right-aligned and sort by their value, not by their text.
- Merged cells are drawn merged. While the rows are sorted or filtered, the value stays in the first cell of the merged range.
- Columns are named A, B, C… and rows keep their sheet numbers; **First row is header** uses the first row for the column names instead.
- Sorting, both kinds of filter, selecting, the statistics and **Copy as…** work as in the CSV viewer. The statistics and the number filters use the number behind a cell rather than its text: 0.25 for a cell that shows 25%, and the serial number of a date.
- **Export sheet to CSV…** saves the sheet on screen, with the values as displayed, and opens the result.
- Apple Numbers files open the same way, with every table of a sheet as a tab of its own. The number formats of Numbers are not read: a date is shown as `2001-11-15` (with its time when it has one), and percentages, currencies and durations as plain numbers.

Supported extensions: xlsx, xlsm, xls, xlsb, ods, numbers, up to 50 MB. Colors, fonts, column widths, charts and pictures are not shown, formulas are not recalculated, and password-protected files can't be opened. The viewer is read-only. Reading is done by [SheetJS](https://sheetjs.com).

## JSON Lines

`.jsonl` and `.ndjson` files open in the same table, one row per line.

- The columns are the keys of the objects, in the order in which they first appear in the file. A row whose object lacks a key has an empty cell there, and so has one where the value is `null`.
- Nested objects and arrays are shown as compact JSON; select the cell to read all of it under the table.
- A line that holds an array fills the columns `1`, `2`, …, and a line that holds a single value goes to a column called `value`.
- Integers too long for a floating-point number, such as 64-bit IDs, keep all their digits.
- Empty lines are skipped. A line that isn't valid JSON is left out and named above the table: point at its number for the reason, click it to open the source at that line. The numbers next to the rows are the line numbers of the file.
- Sorting, both kinds of filter, the statistics and **Copy as…** work as in the CSV viewer. **Open source** switches to the text editor, and the preview button in its title bar brings the table back.

Files of up to 100 MB are opened, in UTF-8, UTF-16 with a byte order mark, or Windows-1252.

## Parquet

`.parquet` files open in the same table.

- The header shows the type of each column next to its name (`int64`, `string`, `decimal(10, 2)`, `timestamp[us, UTC]`, `list`, `struct`…), and its tooltip the whole of it, such as `list<struct<x: int32, y: double>>`.
- Integers of any size and decimals are shown exactly. Dates read `2024-02-29` and timestamps `2024-02-29 12:34:56.789`, in UTC as they are stored. Lists, structs and maps are shown as compact JSON, binary values as text when they are text and in hex otherwise, and a null is an empty cell.
- Columns of numbers are aligned to the right, sort by value and take part in the statistics and the number filters; the other columns sort as text.
- Compression: none, Snappy, gzip, Brotli, Zstandard (needs VS Code 1.101 or later) and LZ4. LZO and encrypted files are not supported.
- The status line shows the rows and columns, the compression, the number of row groups and the file size.
- A column that can't be decoded is left empty and named above the table, and the rest of the file is shown. A damaged file is checked before it is decoded: it ends in what can be read of it or in a message that says what is wrong, not in a viewer that hangs.

A file on disk can be of any size, because only the part that is shown is read: the first 1,000,000 rows, or fewer when they would make more than 10 million cells or 128 MB of text. A note above the table says how many of the rows are shown. A file on another file system is loaded whole, up to 256 MB. The viewer is read-only. Reading is done by [hyparquet](https://github.com/hyparam/hyparquet).

## dBase

`.dbf` files (dBase III, IV and 7, FoxPro, Visual FoxPro) open in the same table, read-only.

- The field names are the column names, with the type of each field next to it (`C(20)`, `N(10,2)`, `D`, `L`, `M`…); point at a header for the type written out.
- Text is read with the code page the file names: in its header, or in a `.cpg` file next to it. When neither says anything, the code page is guessed from the text (UTF-8, DOS or Windows Cyrillic, DOS or Windows Western European), and the status line says that it was guessed. **Encoding** in the toolbar overrides it with any of 47 code pages; **Auto** goes back.
- Dates are shown as `1987-03-01`, date and time as `1987-03-01 14:30:00`, logical values as `true` and `false`. Numbers are shown with the digits that are stored, however long, and currency exactly, with four decimals.
- Memo fields show their text when the memo file (`.dbt`, or `.fpt` for FoxPro) lies next to the table. Without it they show `(memo)`, and a note says what is missing. Pictures and other binary fields show `(binary)`.
- Deleted records are left out and counted in the status line.
- A file that was cut off shows the records that are whole, with a note. Up to 1,000,000 records (10 million cells) of a larger table are shown.
- Sorting, both kinds of filter, the statistics and **Copy as…** work as in the CSV viewer.

Files of up to 256 MB are opened. dBase II files, encrypted tables and the memo files of Clipper's SIx driver (`.smt`) are not read.

## Archives

Archive files open as a tree of their folders and files, with the size, the packed size and the modification time of each. A folder shows the total of what is inside it, and the header shows the format, the number of files and folders, the full size and how much the archive packs it. ZIP, 7z, RAR and tar archives are read, the tar ones also packed with gzip, bzip2, xz or Zstandard. What a file is, is told from its content, not from its name.

| Action | How |
| --- | --- |
| Browse | Click a folder to open or close it. `↑` / `↓` move, `→` opens a folder, `←` closes it or goes to its parent, `Home` / `End` / `Page Up` / `Page Down` jump |
| Find | Type in **Filter by name** (`Ctrl/Cmd+F`): the tree keeps the files and folders whose name contains the text. With a `/` in it, the whole path is searched |
| Open a file | Click it, or press `Enter`. The file is unpacked to a temporary folder and opens in a new tab, in Previewix when it is an image, a PDF or another supported type. Files over 100 MB ask first |
| Extract everything | **Extract all…**, then choose the folder |
| Extract a part | Select a file or a folder, then **Extract selected…**. A folder is extracted under its own name |
| Open a protected archive | Open or extract a file with a lock next to its name and type the password when asked. An archive that hides even its file names asks when it is opened, or on **Enter Password…** |
| Make a ZIP archive | In the Explorer, right-click a file or a folder, or several selected ones, and choose **Compress to ZIP** |

Extraction shows its progress and can be cancelled. When some of the files already exist in the folder, Previewix asks whether to replace them or to keep them and extract the rest. The message at the end counts what was written and offers to show it in the file manager.

A file opened from an archive is a read-only temporary copy; it is removed when the archive's tab closes. The archive itself is never changed.

### What is read

| Format | Details |
| --- | --- |
| ZIP | Stored, Deflate, Deflate64 (what Windows writes for files over 2 GB), bzip2, LZMA, XZ and Zstandard entries; ZIP64; passwords with the classic ZIP encryption and with WinZip AES (128, 192 and 256 bits) |
| 7z | LZMA, LZMA2, bzip2, Deflate and Deflate64, stored data, the BCJ, BCJ2, ARM, ARM64, PowerPC, SPARC and Delta filters; solid archives; passwords (AES-256), also when the file names are encrypted too |
| RAR | All versions from 1.5 to 5 through UnRAR, RARLAB's own decoder: solid archives, archives in several volumes (open the first; the others are found next to it), passwords, encrypted file names |
| tar | Plain, or packed with gzip, bzip2, xz or Zstandard |

Entries that can't be unpacked are still listed, with the reason next to the name: files packed with a method that isn't read (PPMd in ZIP and 7z, the IA-64 and RISC-V filters, Zstandard inside 7z, sparse files and devices in tar), and in RAR hard links and copies of other files. Symbolic and hard links are listed, with their target where the format tells it, and are not created on extraction. An entry whose name points outside the archive (`../…`) is never extracted, and an absolute name is extracted inside the chosen folder. Nothing is written beyond the size an archive declares for a file, and a file whose size or checksum doesn't match is not written at all.

ZIP, 7z and RAR keep a checksum for every file. A tar has none, so for a packed tar the check is the one of the packing. bzip2 is checked block by block before anything of a block is written. gzip and xz keep their checksum at the end, and Zstandard may have none: a damaged archive of these kinds says so in a note above the list when it is opened, and files extracted from it may be damaged.

File names in ZIP archives are read as UTF-8 when they are marked so or look so; otherwise as the DOS encodings, with Cyrillic names from Russian Windows archivers recognised.

### Passwords

The password is asked in a masked field, kept in memory for that tab only, and gone when the tab closes; it is never written anywhere. A wrong one is asked again before anything is extracted. ZIP with AES and RAR 5 can tell a wrong password from damaged data for certain. The classic ZIP encryption, 7z and older RAR archives can't: there a wrong password shows as data that doesn't unpack, which Previewix takes for a wrong password when it happens right at the start, and otherwise reports as "damaged, or the password is wrong", with **Try Another Password** when a single file was being opened. Passwords with characters outside ASCII are tried as UTF-8 in ZIP archives, which is not what every archiver used.

### Compress to ZIP

**Compress to ZIP** writes `<name>.zip` next to the item, or `Archive.zip` for several items, with a number added (`name 2.zip`) when the name is taken. Folders go in whole, under their own name. The archive uses Deflate, UTF-8 names, and ZIP64 only where a file is over 4 GB or there are more than 65,535 entries, without data descriptors: the form that Finder, Windows Explorer and `unzip` all read. Modification times and Unix permissions are kept. Progress is shown and the work can be cancelled; the archive appears under its name only when it is complete.

Symbolic links are stored as links and are not followed, as Finder and `zip -y` do: the archive holds only what was selected, wherever the links point. On Windows such an entry unpacks as a small file with the target's path in it. Files that can't be read, and devices, pipes and sockets, are left out and named in the message at the end. File names are stored with composed characters (NFC); names that Windows doesn't allow (`:`, `?`, a trailing dot) are stored as they are and are refused by Windows when it extracts.

### Extensions and limits

Supported extensions: zip, jar, war, ear, vsix, epub, apk, ipa, whl, nupkg, cbz, xpi, 7z, cb7, rar, cbr, tar, tar.gz, tgz, tar.bz2, tbz, tbz2, tar.xz, txz, tar.zst, tzst. A single packed file that isn't a tar (`.gz`, `.xz`) is not an archive and is not opened. Existing archives can't be changed, and only ZIP archives can be made. Zstandard needs a recent VS Code (1.101 or later). A dictionary of more than 1.5 GB (only the most extreme 7z and xz settings) is refused. Works for files on the computer VS Code runs on.

RAR archives are unpacked by UnRAR, compiled to WebAssembly in the [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) package and shipped unmodified as `dist/unrar.wasm`. It is used only to read archives, under RARLAB's license, which says: "UnRAR source code may be used in any software to handle RAR archives without limitations free of charge, but cannot be used to develop RAR (WinRAR) compatible archiver and to re-create RAR compression algorithm, which is proprietary. Distribution of modified UnRAR source code in separate form or as a part of other software is permitted, provided that full text of this paragraph, starting from "UnRAR source code" words, is included in license, or in documentation if license is not available, and in source code comments of resulting package." The 7z, xz, bzip2 and Deflate64 decoders are Previewix's own.

## Certificates and keys

Certificate files open as a description of what is in them instead of Base64 or binary noise: whose the certificate is, who issued it, whether it is still valid, which host names it covers, what key it has and what its fingerprints are.

- Every block of the file is a row: its number, what it is, the name, and for a certificate a status: **Valid · 89 days left**, **Expires in 12 days** (anything within 30 days), **Expired 5 years ago** or **Not valid yet**. Click a row to unfold it. A file with one block opens unfolded, and the status follows the clock while the tab is open.
- A certificate shows its subject and issuer (attribute by attribute, and as one DN line), the validity period and lifetime, the subject alternative names (DNS, IP, email, URI and the rest), the public key (algorithm, size or curve), the serial number, the signature algorithm, the SHA-256 and SHA-1 fingerprints, whether it is a CA and its path length, key usage and extended key usage, the subject and authority key identifiers, and the other extensions by name or OID, decoded where there is something readable in them (OCSP and CA issuer addresses, CRL distribution points, policies, name constraints, must-staple).
- **Copy** appears next to a fingerprint, the serial number, a key identifier, a DN or a list of names when you point at the row. **Copy PEM** gives one certificate alone, which also turns a DER file into PEM; requests, revocation lists and public keys have it too. It is offered only for a block that was recognised from its first byte to its last as one of these: a block that is cut short or damaged is still described, but not handed back. **Copy details** copies one block as text and **Copy report** the whole page.
- A file with several certificates says how they relate: a chain in the order of the file, a chain listed from the root down or in mixed order (with the right order spelled out), or a bundle that is no chain. A tree shows who issued whom, including an issuer that is not in the file; click a name to go to that certificate. A link is confirmed by checking the signature with the issuer's key, not only by comparing names. Above eight blocks the page starts folded and gets a filter by name, issuer or fingerprint.
- Certificate requests (CSR) are decoded too: subject, requested names and usage, the key, and whether the request is signed with its own key. A request that carries a challenge password says that it has one and does not show it; since the PEM of a request is the whole request, such a request has no **Copy PEM**, and neither has one with an attribute Previewix doesn't know, whose value is not shown. Revocation lists show their issuer, dates and the number of revoked certificates.
- Keys: a private key is described by its format, algorithm and size, and whether a password protects it (for an encrypted one, the cipher and the key derivation). **The key itself is never shown, and it does not leave the extension's own process**: the page receives only the description. The same goes for the challenge password of a request and for any text around the blocks. A key file that is cut short is shown as a damaged private key where enough of it is left to tell, and is never taken for something public. OpenSSH private keys show their type and SSH fingerprint even when encrypted.
- **Public key SHA-256** is the same for a certificate, its request and its private key, so it tells whether they belong together. Inside one file Previewix says so itself: a certificate names its private key and the other way round.
- **Open source** switches to the text editor in the same editor group (`Alt`+click opens it to the side); the preview button in the text editor's title bar goes back. A DER file is binary and has no such button.

Supported extensions: pem, crt, cer, cert, der, csr, p7b, p7c, ca-bundle. PEM and DER are told apart by the content, not the extension, and a PKCS #7 bundle (`.p7b`) is shown as the certificates inside it. PEM with Windows line endings, with text before and between the blocks, on a single line, with escaped `\n`, or saved as UTF-16 is read as well, and a block that is cut short or damaged still shows what could be read of it, with a note about what couldn't.

`.key` files are left to the text editor, because the extension is also used for things that aren't keys and because people open a key mostly to copy it; the preview button in the text editor's title bar opens one in Previewix when you want to know what kind of key it is. PKCS #12 files (`.p12`, `.pfx`) are not supported: they need a password to open. Certificates are not validated against a trust store, revocation is not checked, and nothing is edited or converted on disk.

A few signature checks depend on what VS Code's own crypto library supports. For certificates signed with Ed448, DSA, the secp256k1 and Brainpool curves or the post-quantum algorithms, the page says **signature not checked** and links certificates by their names and key identifiers instead.

## Choosing what opens in Previewix

Run **Previewix: Choose File Types…** from the Command Palette and uncheck the kinds of files you would rather open the usual way, for example Markdown or CSV as plain text. Unchecked types go back to VS Code's own viewer where it has one (common image, audio and video formats) and to the text editor otherwise; checking a type again returns it to Previewix. The choice is stored in the `workbench.editorAssociations` setting, in your user settings, or in the workspace's when the workspace has that setting of its own. Tabs that are already open stay as they are.

For a single file, right-click it in the Explorer, choose **Open With…**, and pick the built-in preview or **Text Editor**. **Configure default editor for…** in the same list makes that choice permanent for the file's extension.

## Development

Requires Node.js 22 or newer.

```sh
git clone https://github.com/fedorananin/previewix.git
cd previewix
npm install
npm run build      # bundle into dist/
npm test           # run the regression tests
npm run package    # build a .vsix
```

Press `F5` in VS Code to try the extension in a development window. [`AGENTS.md`](AGENTS.md) describes the architecture of every viewer in detail.

`npm test` needs no build and takes a few seconds. It covers the code that reads and writes files without VS Code's help: the audio tag writers, the saving of edited CSV files, the archive readers with extraction and "Compress to ZIP", the Markdown block editing, the preparation of an HTML page, SQLite, the table readers, certificates, subtitles, fonts and image formats. It does not open VS Code or a browser, so the viewers themselves, the PDF editor and the video tools are still tried by hand. Some checks compare against other programs (ffmpeg, ffprobe, Python with `mutagen` or `pyarrow`, `openssl`, `sips`, `unzip`) and are skipped where those are missing; `PREVIEWIX_TEST_PYTHON` names the Python to use. `node test/run.js tags` runs only the test files with "tags" in their name, and `AGENTS.md` has the rest.

## License

[MIT](LICENSE) © Fedor Ananin.

Previewix bundles third-party libraries under their own licenses, among them [pdf.js](https://github.com/mozilla/pdf.js), [three.js](https://github.com/mrdoob/three.js), [Mermaid](https://github.com/mermaid-js/mermaid), [KaTeX](https://github.com/KaTeX/KaTeX), [SheetJS](https://sheetjs.com), [MediaInfo](https://mediaarea.net/MediaInfo) and [UnRAR](https://www.rarlab.com) (via `node-unrar-js`). [libheif](https://github.com/strukturag/libheif) (LGPL-3.0), used for HEIC images, is shipped as a separate, unmodified file together with its license.
