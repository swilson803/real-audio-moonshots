// The "music in this video: <link>" line and its one-tap COPY button, shared
// by the upload page and the result page.

const copyText = (link) => `music in this video: ${link}`;

export function showCopyLine(lineEl, button, link) {
  const a = document.createElement('a');
  a.href = link;
  a.textContent = link;
  lineEl.replaceChildren('music in this video: ', a);
  button.onclick = async () => {
    const text = copyText(link);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Older iOS / no clipboard permission: copy from a selected textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      ta.remove();
    }
    button.textContent = ok ? 'COPIED' : 'COPY FAILED';
    button.classList.toggle('is-copied', ok);
    setTimeout(() => {
      button.textContent = 'COPY';
      button.classList.remove('is-copied');
    }, 2500);
  };
}
