// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const video = /** @type {HTMLVideoElement} */ ($('video'));
  const player = $('player');
  const stage = $('stage');
  const controls = $('controls');
  const notice = $('notice');
  const speed = /** @type {HTMLSelectElement} */ ($('speed'));
  const loop = $('loop');
  const volume = /** @type {HTMLInputElement} */ ($('volume'));
  const seek = $('seek');
  const subMenu = $('subMenu');

  const saved = vscode.getState() || {};
  let sections = [];
  let hasAudio = false;
  let hasVideo = false;
  /** Frames per second from the media info; 0 until it is known. */
  let frameRate = 0;
  /** Whether the time display shows the timecode and frame number instead of plain time. */
  let showFrames = !!saved.showFrames;
  /** The marks of the A–B loop in seconds; null for a mark that isn't set. */
  let markA = typeof saved.a === 'number' ? saved.a : null;
  let markB = typeof saved.b === 'number' ? saved.b : null;
  /** Whether the loop button is on. With A–B marks set, the range repeats instead of the whole video. */
  let loopOn = !!saved.loop;
  /** The subtitle track the user chose: its id, 'off', or undefined while the provider's suggestion stands. */
  let subChoice = /** @type {string | undefined} */ (saved.subtitle);
  /** The track that was on last, which is what C turns back on. */
  let lastTrack = /** @type {string | undefined} */ (saved.lastSubtitle);

  // ---- Playback -----------------------------------------------------------

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }

  /** A short confirmation that goes away by itself, unlike the notice, which states a lasting problem. */
  let toastTimer;
  function toast(text) {
    const box = $('toast');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), 3500);
  }

  function saveState() {
    vscode.setState({
      time: video.currentTime,
      speed: speed.value,
      loop: loopOn,
      volume: video.volume,
      muted: video.muted,
      infoOpen: document.body.classList.contains('info-open'),
      showFrames,
      a: markA,
      b: markB,
      subtitle: subChoice,
      lastSubtitle: lastTrack,
    });
  }

  const togglePlay = () => (video.paused ? video.play() : video.pause());

  function formatTime(seconds) {
    const total = Math.floor(seconds || 0);
    const s = String(total % 60).padStart(2, '0');
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** The time to the millisecond, for a mark: "1:02.500". */
  const formatExact = (seconds) => `${formatTime(seconds)}.${String(Math.floor((seconds % 1) * 1000)).padStart(3, '0')}`;

  /** Frames are counted from 0, like the timecode. The small offset keeps a time that sits exactly on a frame boundary from rounding down. */
  const frameAt = (seconds) => Math.floor(seconds * frameRate + 0.001);

  /** Hours, minutes, seconds and the frame within the second: "0:01:23:07". */
  function formatTimecode(seconds) {
    const frame = frameAt(seconds);
    const perSecond = Math.round(frameRate);
    const total = Math.floor(frame / perSecond);
    const pad = (n) => String(n).padStart(2, '0');
    return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frame % perSecond)}`;
  }

  /** Brings the controls in line with the state of the video element. */
  function updateControls() {
    const duration = video.duration || 0;
    stage.classList.toggle('playing', !video.paused && !video.ended);
    stage.classList.toggle('muted', video.muted || video.volume === 0);
    loop.setAttribute('aria-pressed', String(loopOn));
    volume.value = String(video.muted ? 0 : video.volume);
    $('time').textContent =
      showFrames && frameRate
        ? `${formatTimecode(video.currentTime)} · frame ${frameAt(video.currentTime)} / ${Math.max(0, frameAt(duration) - 1)}`
        : `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
    $('seekPlayed').style.width = duration ? `${(video.currentTime / duration) * 100}%` : '0';
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    $('seekBuffered').style.width = duration ? `${(buffered / duration) * 100}%` : '0';
  }

  if (saved.speed) {
    speed.value = saved.speed;
  }
  video.loop = loopOn;
  video.volume = saved.volume ?? 1;
  video.muted = !!saved.muted;

  video.addEventListener('loadedmetadata', () => {
    video.playbackRate = Number(speed.value);
    if (saved.time && saved.time < video.duration - 1) {
      video.currentTime = saved.time;
      saved.time = 0;
    }
    // Marks made on an earlier version of the file may lie beyond the end of this one.
    if (markA !== null && markA >= video.duration) {
      markA = null;
    }
    if (markB !== null && markB > video.duration) {
      markB = null;
    }
    updateMarks();
    checkDecoding();
  });

  video.addEventListener('error', () => {
    // Saving a frame needs the file loaded with cross-origin permission. Should VS Code refuse
    // that, the video is loaded the plain way: playback matters more than the snapshot.
    if (video.crossOrigin !== null && video.src) {
      video.removeAttribute('crossorigin');
      video.load();
      return;
    }
    showNotice(
      "VS Code can't play this file: its container or codec isn't supported by the built-in player. " +
        'The media info is still available.',
    );
  });

  let lastSave = 0;
  video.addEventListener('timeupdate', () => {
    if (Date.now() - lastSave > 1000) {
      lastSave = Date.now();
      saveState();
    }
    checkDecoding();
  });

  for (const event of ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'progress', 'seeking', 'volumechange']) {
    video.addEventListener(event, updateControls);
  }

  /** How much of the video has actually been played. A position that was only restored or sought to has decoded no sound yet. */
  function playedSeconds() {
    let total = 0;
    for (let i = 0; i < video.played.length; i++) {
      total += video.played.end(i) - video.played.start(i);
    }
    return total;
  }

  // VS Code ships without some decoders (notably AAC), in which case a track silently produces nothing.
  function checkDecoding() {
    if (video.error || video.readyState < 1) {
      return;
    }
    if (hasVideo && video.videoWidth === 0) {
      showNotice("The video track can't be decoded by VS Code, only audio will play.");
    } else if (hasAudio && playedSeconds() > 1 && /** @type {any} */ (video).webkitAudioDecodedByteCount === 0) {
      showNotice("The audio track can't be decoded by VS Code (it doesn't include some codecs such as AAC), so playback is silent.");
    }
  }

  // ---- Controls -----------------------------------------------------------

  video.addEventListener('click', togglePlay);
  $('play').addEventListener('click', togglePlay);

  speed.addEventListener('change', () => {
    video.playbackRate = Number(speed.value);
    saveState();
  });

  loop.addEventListener('click', () => {
    loopOn = !loopOn;
    updateMarks();
    updateControls();
    saveState();
  });

  $('mute').addEventListener('click', () => {
    video.muted = !(video.muted || video.volume === 0);
    if (!video.muted && video.volume === 0) {
      video.volume = 0.5;
    }
    saveState();
  });

  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    saveState();
  });

  $('time').addEventListener('click', () => {
    showFrames = !showFrames;
    updateControls();
    saveState();
  });

  /** Moves one frame back or forward and stays paused there. Lands in the middle of the frame, where rounding can't pick its neighbour. */
  function stepFrame(direction) {
    video.pause();
    // Without a known frame rate a 30 fps step is the best guess.
    const rate = frameRate || 30;
    const frame = Math.floor(video.currentTime * rate + 0.001) + direction;
    video.currentTime = Math.min(video.duration || 0, Math.max(0, (frame + 0.5) / rate));
    showFrames = true;
    updateControls();
    saveState();
  }
  $('prevFrame').addEventListener('click', () => stepFrame(-1));
  $('nextFrame').addEventListener('click', () => stepFrame(1));

  /** Sends the picture on screen to the extension as a PNG in the video's own resolution. */
  function saveFrame() {
    if (!video.videoWidth) {
      showNotice('There is no picture to save.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(video, 0, 0);
    try {
      const data = canvas.toDataURL('image/png');
      const label = frameRate ? `frame ${frameAt(video.currentTime)}` : formatTime(video.currentTime).replace(/:/g, '.');
      vscode.postMessage({ type: 'saveFrame', label, data: data.slice(data.indexOf(',') + 1) });
    } catch {
      // The canvas is locked when the video was loaded without cross-origin permission.
      showNotice("VS Code didn't allow reading the frame of this video.");
    }
  }
  $('snapshot').addEventListener('click', saveFrame);

  /** Where on the timeline the pointer is, as a share of the seek bar from 0 to 1. */
  function seekFraction(e) {
    const rect = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function seekFromPointer(e) {
    if (video.duration) {
      video.currentTime = seekFraction(e) * video.duration;
      updateControls();
    }
  }
  seek.addEventListener('pointerdown', (e) => {
    seek.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  seek.addEventListener('pointermove', (e) => {
    if (seek.hasPointerCapture(e.pointerId)) {
      seekFromPointer(e);
    }
    showPeek(e);
  });
  seek.addEventListener('pointerleave', (e) => {
    // A drag that leaves the bar still seeks, so its label stays until the button is released.
    if (!seek.hasPointerCapture(e.pointerId)) {
      hidePeek();
    }
  });
  seek.addEventListener('lostpointercapture', () => {
    if (!seek.matches(':hover')) {
      hidePeek();
    }
  });

  // The controls fade out during playback once the pointer has rested for a moment,
  // unless it rests on the controls themselves or a menu of theirs is open.
  let idleTimer;
  function wake() {
    stage.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !controls.matches(':hover') && subMenu.hidden) {
        stage.classList.add('idle');
      }
    }, 2500);
  }
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  video.addEventListener('play', wake);
  video.addEventListener('pause', wake);

  // ---- Seek preview -------------------------------------------------------

  // Hovering the seek bar shows the time under the pointer and the frame at that time. The frames
  // come from a second video element that only ever seeks, so the player itself is left alone.
  // To keep that cheap on a large file, the timeline is cut into slots that share one picture,
  // pictures are kept once made, a seek starts only when the pointer has rested, and only one
  // runs at a time.
  const SLOTS = 240;
  const MAX_THUMBS = 120;
  const peek = $('peek');
  const peekFrame = /** @type {HTMLCanvasElement} */ ($('peekFrame'));
  /** Pictures by slot, the least recently used first. */
  const thumbs = /** @type {Map<number, HTMLCanvasElement>} */ (new Map());
  /** @type {HTMLVideoElement | undefined} */
  let peekVideo;
  /** Set when the second element can't produce a picture; the label then appears alone. */
  let peekFailed = false;
  /** The slot under the pointer, and the one being decoded (-1 for none). */
  let peekSlot = -1;
  let peekSeeking = -1;
  let peekTimer;
  let peekRelease;

  function peekSource() {
    // A picture the player itself can't decode won't appear here either.
    if (peekFailed || !video.videoWidth || !video.currentSrc) {
      return undefined;
    }
    if (!peekVideo) {
      const source = document.createElement('video');
      source.muted = true;
      source.preload = 'metadata';
      source.addEventListener('loadedmetadata', () => {
        if (source.videoWidth) {
          decodeThumb();
        } else {
          peekFailed = true;
        }
      });
      source.addEventListener('seeked', () => {
        if (source !== peekVideo) {
          return;
        }
        const slot = peekSeeking;
        peekSeeking = -1;
        if (slot >= 0 && source.videoWidth) {
          keepThumb(slot, source);
        }
        if (slot === peekSlot) {
          drawThumb();
        } else {
          decodeThumb(); // the pointer has moved on meanwhile
        }
      });
      source.addEventListener('error', () => {
        peekFailed = true;
        peekSeeking = -1;
      });
      source.src = video.currentSrc;
      peekVideo = source;
    }
    return peekVideo;
  }

  /** Lets go of the second element and its decoder; the pictures made so far stay. */
  function releasePeek() {
    if (peekVideo) {
      peekVideo.removeAttribute('src');
      peekVideo.load();
      peekVideo = undefined;
    }
    peekSeeking = -1;
  }

  function keepThumb(slot, source) {
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const thumb = document.createElement('canvas');
    thumb.height = Math.round(90 * scale);
    thumb.width = Math.round(Math.min(220, Math.max(50, (90 * source.videoWidth) / source.videoHeight)) * scale);
    /** @type {CanvasRenderingContext2D} */ (thumb.getContext('2d')).drawImage(source, 0, 0, thumb.width, thumb.height);
    thumbs.set(slot, thumb);
    if (thumbs.size > MAX_THUMBS) {
      thumbs.delete(/** @type {number} */ (thumbs.keys().next().value));
    }
  }

  /** Puts the picture of the slot under the pointer into the preview. Until there is one, the previous picture stays, dimmed. */
  function drawThumb() {
    const thumb = thumbs.get(peekSlot);
    peekFrame.classList.toggle('stale', !thumb);
    if (!thumb) {
      return;
    }
    thumbs.delete(peekSlot);
    thumbs.set(peekSlot, thumb);
    peekFrame.width = thumb.width;
    peekFrame.height = thumb.height;
    /** @type {CanvasRenderingContext2D} */ (peekFrame.getContext('2d')).drawImage(thumb, 0, 0);
    peekFrame.hidden = false;
    placePeek();
  }

  function decodeThumb() {
    if (peek.hidden || peekSeeking >= 0 || peekSlot < 0 || thumbs.has(peekSlot)) {
      return;
    }
    const source = peekSource();
    // Before the metadata is in there is nothing to seek in; loadedmetadata comes back here.
    if (!source || source.readyState < 1 || !Number.isFinite(source.duration)) {
      return;
    }
    peekSeeking = peekSlot;
    source.currentTime = ((peekSlot + 0.5) / SLOTS) * source.duration;
  }

  let peekX = 0;
  /** Centers the preview on the pointer, as far as the edges of the player allow. */
  function placePeek() {
    const half = peek.offsetWidth / 2;
    const bar = seek.offsetLeft;
    peek.style.left = `${Math.min(controls.clientWidth - half - 4, Math.max(half + 4, bar + peekX))}px`;
  }

  function showPeek(e) {
    const duration = video.duration;
    if (!duration || !Number.isFinite(duration)) {
      return;
    }
    const fraction = seekFraction(e);
    $('peekTime').textContent = showFrames && frameRate ? formatTimecode(fraction * duration) : formatTime(fraction * duration);
    peek.hidden = false;
    peekX = fraction * seek.clientWidth;
    peekSlot = Math.min(SLOTS - 1, Math.floor(fraction * SLOTS));
    clearTimeout(peekRelease);
    clearTimeout(peekTimer);
    drawThumb();
    placePeek();
    if (!thumbs.has(peekSlot)) {
      peekTimer = setTimeout(decodeThumb, 90);
    }
  }

  function hidePeek() {
    peek.hidden = true;
    clearTimeout(peekTimer);
    clearTimeout(peekRelease);
    peekRelease = setTimeout(releasePeek, 20000);
  }

  /** A new file, or a new version of it: nothing made from the old one holds. */
  function resetPeek() {
    releasePeek();
    thumbs.clear();
    peekFailed = false;
    peekFrame.hidden = true;
  }

  // ---- A–B loop and clip --------------------------------------------------

  // Playback repeats between the two marks. One mark alone stands with that end of the video:
  // only A loops from A to the end, only B from the beginning to B. "Save clip" takes the same range.
  const loopRange = () => (markA === null && markB === null ? undefined : { from: markA ?? 0, to: markB ?? video.duration });

  function updateMarks() {
    const duration = video.duration || 0;
    const range = duration ? loopRange() : undefined;
    const place = (/** @type {HTMLElement} */ element, /** @type {number | null} */ time) => {
      element.hidden = !duration || time === null;
      if (!element.hidden) {
        element.style.left = `${(/** @type {number} */ (time) / duration) * 100}%`;
      }
    };
    place($('markA'), markA);
    place($('markB'), markB);
    $('seekRange').hidden = !range;
    if (range) {
      $('seekRange').style.left = `${(range.from / duration) * 100}%`;
      $('seekRange').style.width = `${((range.to - range.from) / duration) * 100}%`;
    }
    $('setA').setAttribute('aria-pressed', String(markA !== null));
    $('setB').setAttribute('aria-pressed', String(markB !== null));
    $('setA').title = markA === null ? 'Mark the start of a loop or clip here (A)' : `Start mark at ${formatExact(markA)}. Click to move it here (A)`;
    $('setB').title = markB === null ? 'Mark the end of a loop or clip here (B)' : `End mark at ${formatExact(markB)}. Click to move it here (B)`;
    $('clearAB').hidden = markA === null && markB === null;
    // The element's own loop always goes back to the very beginning, so it steps aside for a marked range.
    video.loop = loopOn && !loopRange();
  }

  /** Puts a mark at the current position. A mark on the wrong side of the new one goes, since the newest is the one that was meant. */
  function setMark(end) {
    if (!video.duration) {
      return;
    }
    const time = video.currentTime;
    // The two marks may not meet: a range without length can't be played.
    const apart = 0.05;
    if (end === 'a') {
      markA = time;
      if (markB !== null && markB - time < apart) {
        markB = null;
      }
    } else {
      markB = time;
      if (markA !== null && time - markA < apart) {
        markA = null;
      }
    }
    toast(`${end === 'a' ? 'Start' : 'End'} mark at ${formatExact(time)}`);
    updateMarks();
    saveState();
  }

  function clearMarks() {
    if (markA !== null || markB !== null) {
      markA = markB = null;
      toast('A–B marks removed');
      updateMarks();
      saveState();
    }
  }

  $('setA').addEventListener('click', () => setMark('a'));
  $('setB').addEventListener('click', () => setMark('b'));
  $('clearAB').addEventListener('click', clearMarks);

  /** The position at the last look, which tells playing across the end mark from a jump past it. */
  let lastTime = 0;
  let loopFrame = 0;

  function checkLoop() {
    const time = video.currentTime;
    const range = loopRange();
    // Only playback that runs into the end mark goes back. After a seek beyond it, the video plays on from there.
    if (range && markB !== null && !video.seeking && lastTime < range.to && time >= range.to) {
      video.currentTime = range.from;
      lastTime = range.from;
      return;
    }
    lastTime = time;
  }

  // "timeupdate" comes only a few times a second, which would let the video run well past the end mark.
  function watchLoop() {
    cancelAnimationFrame(loopFrame);
    if (!video.paused && !video.ended) {
      checkLoop();
      loopFrame = requestAnimationFrame(watchLoop);
    }
  }
  video.addEventListener('play', watchLoop);
  // Animation frames stop while the window is covered; the events keep the loop closed then, less exactly.
  video.addEventListener('timeupdate', checkLoop);
  video.addEventListener('seeking', () => (lastTime = video.currentTime));
  video.addEventListener('ended', () => {
    const range = loopRange();
    // The end of the video closes a range that has no end mark, or one on the last frames. Past an
    // end mark, the video only starts over when the loop button says so.
    if (range && (loopOn || markB === null || markB > video.duration - 0.25) && range.from < video.duration - 0.05) {
      video.currentTime = range.from;
      void video.play();
    }
  });

  function saveClip() {
    if ($('clip').hidden || !video.duration) {
      return;
    }
    if (markA === null && markB === null) {
      toast('Mark the start (A) and the end (B) of the clip first.');
      return;
    }
    vscode.postMessage({ type: 'saveClip', start: markA, end: markB, duration: video.duration });
  }
  $('clip').addEventListener('click', saveClip);

  // ---- Subtitles ----------------------------------------------------------

  /** The tracks on offer, from the provider: {id, label, detail, rev}. */
  let offers = [];
  /** The provider's pick for a video whose subtitles were never switched on or off by hand. */
  let suggested;
  /** The track whose cues are loaded: its id and rev, the <track> element and the blob URL behind it. */
  let shown;
  /** The id of the track that was asked for and hasn't arrived. */
  let awaited;
  /** The choice before the last one, to go back to when the new track can't be read. */
  let formerChoice;

  const wantedTrack = () => (subChoice === undefined ? suggested : subChoice === 'off' ? undefined : subChoice);

  /** Draws the cues that are due now. The track itself is hidden, so that the cues can stay clear of the controls, which the browser's own rendering can't. */
  function renderCues() {
    const cues = shown ? shown.element.track.activeCues : null;
    const top = document.createDocumentFragment();
    const bottom = document.createDocumentFragment();
    for (const cue of /** @type {VTTCue[]} */ (cues ? Array.from(cues) : [])) {
      if (!cue.text.trim()) {
        continue;
      }
      const line = document.createElement('div');
      line.className = 'cue';
      const text = document.createElement('span');
      // The browser's parser has turned the cue's markup into elements; no HTML of the file gets through.
      text.append(cue.getCueAsHTML());
      line.append(text);
      // `line:0` and the like ask for the top of the picture; every other position is drawn at the bottom.
      const high = typeof cue.line === 'number' && (cue.snapToLines ? cue.line >= 0 && cue.line < 6 : cue.line < 40);
      (high ? top : bottom).append(line);
    }
    $('subsTop').replaceChildren(top);
    $('subs').replaceChildren(bottom);
  }

  function dropCues() {
    if (shown) {
      shown.element.remove();
      URL.revokeObjectURL(shown.url);
      shown = undefined;
    }
    renderCues();
  }

  function showCues(msg) {
    dropCues();
    const url = URL.createObjectURL(new Blob([msg.vtt], { type: 'text/vtt' }));
    const element = document.createElement('track');
    element.kind = 'subtitles';
    if (msg.language) {
      element.srclang = msg.language;
    }
    element.src = url;
    video.append(element);
    element.track.mode = 'hidden';
    element.track.addEventListener('cuechange', renderCues);
    element.addEventListener('load', () => {
      if (!element.track.cues || !element.track.cues.length) {
        toast('No subtitles were found in this file.');
      }
      renderCues();
    });
    element.addEventListener('error', () => toast("These subtitles can't be read."));
    $('subs').lang = $('subsTop').lang = msg.language || '';
    shown = { id: msg.id, rev: msg.rev, element, url };
  }

  /** Brings what is loaded in line with the choice and the list: asks for the wanted track, or drops the one that is no longer wanted. */
  function syncSubtitles() {
    const wanted = wantedTrack();
    const offer = offers.find((o) => o.id === wanted);
    if (!offer) {
      awaited = undefined;
      dropCues();
    } else if (!shown || shown.id !== offer.id || shown.rev !== offer.rev) {
      if (shown && shown.id !== offer.id) {
        dropCues();
      }
      awaited = offer.id;
      vscode.postMessage({ type: 'subtitle', id: offer.id });
      if (offer.id.startsWith('stream:')) {
        // ffmpeg may have to read through the whole file for a track that is stored inside it.
        toast('Reading the subtitle track from the video…');
      }
    }
    $('cc').setAttribute('aria-pressed', String(!!offer));
    $('cc').classList.toggle('busy', !!awaited);
    buildMenu();
  }

  function chooseSubtitles(id) {
    formerChoice = subChoice === id ? formerChoice : subChoice;
    subChoice = id;
    if (id !== 'off') {
      lastTrack = id;
    }
    saveState();
    syncSubtitles();
  }

  function toggleSubtitles() {
    if (wantedTrack() && offers.some((o) => o.id === wantedTrack())) {
      lastTrack = wantedTrack();
      chooseSubtitles('off');
      toast('Subtitles off');
      return;
    }
    const offer = offers.find((o) => o.id === lastTrack) || offers.find((o) => o.id === suggested) || offers[0];
    if (offer) {
      chooseSubtitles(offer.id);
      toast(`Subtitles: ${offer.label}`);
    } else {
      toast('No subtitles were found for this video. "Load subtitles…" in the subtitles menu opens any file.');
    }
  }

  function buildMenu() {
    const wanted = wantedTrack();
    const item = (/** @type {string} */ label, /** @type {string} */ detail, /** @type {boolean | undefined} */ checked, /** @type {() => void} */ action) => {
      const button = document.createElement('button');
      button.className = 'item';
      if (checked === undefined) {
        button.setAttribute('role', 'menuitem');
      } else {
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(checked));
      }
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = label;
      button.append(name);
      if (detail) {
        const more = document.createElement('span');
        more.className = 'detail';
        more.textContent = detail;
        button.append(more);
      }
      button.addEventListener('click', () => {
        closeMenu();
        action();
      });
      return button;
    };
    const on = offers.some((o) => o.id === wanted);
    const items = [item('Off', '', !on, () => chooseSubtitles('off'))];
    for (const offer of offers) {
      items.push(item(offer.label, offer.id === awaited ? 'loading…' : offer.detail, offer.id === wanted, () => chooseSubtitles(offer.id)));
    }
    const rule = document.createElement('hr');
    subMenu.replaceChildren(...items, rule, item('Load subtitles…', '', undefined, () => vscode.postMessage({ type: 'pickSubtitles' })));
  }

  function closeMenu() {
    subMenu.hidden = true;
    $('cc').setAttribute('aria-expanded', 'false');
  }

  $('cc').addEventListener('click', () => {
    const button = $('cc');
    subMenu.hidden = !subMenu.hidden;
    button.setAttribute('aria-expanded', String(!subMenu.hidden));
    // Just above its button, in whichever row of the controls that is at this width.
    subMenu.style.bottom = `${controls.offsetHeight - button.offsetTop + 4}px`;
    subMenu.style.right = `${Math.max(8, controls.clientWidth - button.offsetLeft - button.offsetWidth)}px`;
    wake();
  });
  document.addEventListener('pointerdown', (e) => {
    const target = /** @type {Node} */ (e.target);
    if (!subMenu.hidden && !subMenu.contains(target) && !$('cc').contains(target)) {
      closeMenu();
    }
  });

  // The cues sit just above the controls while those are visible, whatever height the controls have at this width.
  new ResizeObserver(() => stage.style.setProperty('--controls', `${controls.offsetHeight}px`)).observe(controls);

  // ---- Fullscreen ---------------------------------------------------------

  // Webviews normally can't use the Fullscreen API, so the extension emulates it
  // with Zen Mode. Whether that mode is still active is inferred from the viewport
  // height, because the user can also leave it with VS Code's own shortcuts.
  let zen = false;
  let zenGrown = false;
  let baseHeight = 0;

  const inZen = () => zen && window.innerHeight > baseHeight + 20;

  function leaveZen(notify) {
    zen = false;
    zenGrown = false;
    document.body.classList.remove('fs');
    if (notify) {
      vscode.postMessage({ type: 'fullscreen', enter: false });
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (zen) {
      leaveZen(inZen());
      return;
    }
    if (document.fullscreenEnabled) {
      try {
        await player.requestFullscreen();
        return;
      } catch {
        // Not permitted inside the webview, fall back to Zen Mode.
      }
    }
    baseHeight = window.innerHeight;
    zen = true;
    document.body.classList.add('fs');
    vscode.postMessage({ type: 'fullscreen', enter: true });
  }

  window.addEventListener('resize', () => {
    if (!zen) {
      return;
    }
    if (inZen()) {
      zenGrown = true;
    } else if (zenGrown) {
      leaveZen(false);
    }
  });

  $('fullscreen').addEventListener('click', toggleFullscreen);
  video.addEventListener('dblclick', toggleFullscreen);

  /**
   * The key a shortcut is named after. A layout without Latin letters (Cyrillic, Greek) reports
   * its own letter for the key, so there the position of the key decides.
   */
  function shortcutKey(e) {
    const key = e.key.toLowerCase();
    if (key.length !== 1 || key <= '\u007f') {
      return key;
    }
    const letter = /^Key([A-Z])$/.exec(e.code);
    return letter ? letter[1].toLowerCase() : e.code === 'Comma' ? ',' : e.code === 'Period' ? '.' : key;
  }

  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    switch (shortcutKey(e)) {
      case 'f':
        toggleFullscreen();
        break;
      case 'i':
        toggleInfo();
        break;
      case 'm':
        $('mute').click();
        break;
      case ',':
        stepFrame(-1);
        break;
      case '.':
        stepFrame(1);
        break;
      case 's':
        saveFrame();
        break;
      case 'a':
        setMark('a');
        break;
      case 'b':
        setMark('b');
        break;
      case 'x':
        clearMarks();
        break;
      case 'c':
        toggleSubtitles();
        break;
      case 'escape':
        if (!subMenu.hidden) {
          closeMenu();
        } else if (zen) {
          leaveZen(inZen());
        }
        break;
      case ' ':
        // A focused button would also be "clicked" by the space bar.
        e.preventDefault();
        togglePlay();
        break;
      case 'arrowleft':
      case 'arrowright':
        e.preventDefault();
        video.currentTime += e.key === 'ArrowLeft' ? -5 : 5;
        break;
      case 'arrowup':
      case 'arrowdown':
        e.preventDefault();
        video.muted = false;
        video.volume = Math.min(1, Math.max(0, video.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)));
        saveState();
        break;
      default:
        return;
    }
    wake();
  });

  // ---- Media info ---------------------------------------------------------

  function setInfoOpen(open) {
    document.body.classList.toggle('info-open', open);
    $('bar').setAttribute('aria-expanded', String(open));
  }

  setInfoOpen(!!saved.infoOpen);
  function toggleInfo() {
    setInfoOpen(!document.body.classList.contains('info-open'));
    saveState();
  }
  $('bar').addEventListener('click', toggleInfo);
  $('closeInfo').addEventListener('click', toggleInfo);

  function renderInfo() {
    const root = $('sections');
    root.textContent = '';
    for (const section of sections) {
      const title = document.createElement('h3');
      title.textContent = section.title;
      const list = document.createElement('dl');
      for (const [label, value] of section.rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
      }
      root.append(title, list);
    }
  }

  $('copy').addEventListener('click', () => {
    const text = sections
      .map((s) => `${s.title}\n${s.rows.map(([label, value]) => `  ${label}: ${value}`).join('\n')}`)
      .join('\n\n');
    vscode.postMessage({ type: 'copy', text });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'missing') {
      // Nothing is left to play; the source comes again if the file reappears.
      video.removeAttribute('src');
      video.load();
      resetPeek();
      updateControls();
    } else if (msg.type === 'source') {
      showNotice('');
      resetPeek();
      video.src = msg.src;
      updateControls();
    } else if (msg.type === 'info') {
      sections = msg.sections;
      hasAudio = !!msg.hasAudio;
      hasVideo = !!msg.hasVideo;
      frameRate = msg.frameRate || 0;
      updateControls();
      $('summary').textContent = msg.summary || 'Media info';
      renderInfo();
      checkDecoding();
    } else if (msg.type === 'tools') {
      $('clip').hidden = !msg.clip;
    } else if (msg.type === 'subtitles') {
      offers = msg.tracks;
      suggested = msg.suggested;
      if (msg.select) {
        chooseSubtitles(msg.select);
      } else {
        syncSubtitles();
      }
    } else if (msg.type === 'cues') {
      // An answer for a track that is no longer the wanted one has come too late.
      if (msg.id !== awaited) {
        return;
      }
      awaited = undefined;
      if (msg.error) {
        toast(msg.error);
        // A track that can't be read doesn't stay switched on: back to what was on before it, once.
        subChoice = formerChoice !== msg.id && offers.some((o) => o.id === formerChoice) ? formerChoice : 'off';
        formerChoice = 'off';
        saveState();
      } else {
        showCues(msg);
      }
      syncSubtitles();
    }
  });

  updateControls();
  updateMarks();
  buildMenu();
  vscode.postMessage({ type: 'ready' });
})();
