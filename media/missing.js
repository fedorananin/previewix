// @ts-check
// Shared by every Previewix page: covers it with a placeholder while the file is gone from disk.
(function () {
  /** @type {HTMLElement | undefined} */
  let cover;

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'missing') {
      for (const media of document.querySelectorAll('video, audio')) {
        /** @type {HTMLMediaElement} */ (media).pause();
      }
      if (!cover) {
        cover = document.createElement('div');
        cover.id = 'missing';
        const title = document.createElement('strong');
        title.textContent = 'This file no longer exists';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = msg.name;
        const hint = document.createElement('span');
        hint.textContent = 'It was deleted or moved. The preview comes back if the file reappears.';
        cover.append(title, name, hint);
        document.body.append(cover);
      }
    } else if (msg.type === 'restored') {
      cover?.remove();
      cover = undefined;
    }
  });
})();
