// Local pages for the slice1 benchmark. The runner serves these; they are not product runtime.

export const DENSE_CONTROL_COUNT = 40;

function denseControls() {
  return Array.from({ length: DENSE_CONTROL_COUNT }, (_, index) => {
    const name = `Control ${String(index + 1).padStart(2, '0')}`;
    return `<button type="button" id="control-${index + 1}">${name}</button>`;
  }).join('\n');
}

const PAGES = {
  overlay: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>slice1 overlay</title>
  <style>
    html, body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
    #under { padding: 24px; }
    #cover {
      position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
      margin: 0; border: 0; padding: 24px; background: #111; color: #fff; z-index: 9999;
    }
    button { font: inherit; padding: 8px 12px; }
  </style>
</head>
<body>
  <div id="under">
    <p>UNDERPAGE_CLEAR_MARKER</p>
    <button type="button" id="under-btn">Hidden action</button>
  </div>
  <dialog id="cover" open aria-modal="true" aria-label="Slice1 consent dialog">
    <h1>Consent required</h1>
    <p id="dialog-body">SLICE1_DIALOG_BODY blocking the page</p>
    <button type="button" id="stay">Stay on dialog</button>
  </dialog>
</body>
</html>`,
  covered: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>slice1 covered</title>
  <style>
    html, body { margin: 0; font: 16px/1.4 system-ui, sans-serif; }
    #submit { position: fixed; left: 80px; top: 120px; width: 180px; height: 40px; z-index: 1; }
    #cover {
      position: fixed; left: 80px; top: 120px; width: 180px; height: 40px; z-index: 2;
      background: #111; color: #fff;
    }
    #status { margin: 180px 24px 24px; }
  </style>
</head>
<body>
  <button type="button" id="submit">Submit transfer</button>
  <div id="cover">Opaque cover</div>
  <p id="status">landed:none</p>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.getElementById('status').textContent = 'landed:submit';
    });
    document.getElementById('cover').addEventListener('click', () => {
      document.getElementById('status').textContent = 'landed:cover';
    });
  </script>
</body>
</html>`,
  dense: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>slice1 dense</title>
  <style>
    html, body { margin: 0; font: 16px/1.4 system-ui, sans-serif; padding: 16px; }
    button { display: inline-block; margin: 4px; padding: 6px 8px; }
  </style>
</head>
<body>
  <h1>Dense controls</h1>
  <p>Filler paragraph so the observation is not only a button list. The agent still has to see every named control.</p>
  <p>Second filler paragraph with ordinary words and no extra widgets.</p>
  ${denseControls()}
</body>
</html>`,
  stale: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>slice1 stale</title>
  <style>
    html, body { margin: 0; font: 16px/1.4 system-ui, sans-serif; padding: 24px; }
    button { font: inherit; padding: 8px 12px; }
  </style>
</head>
<body>
  <div id="root"><button type="button" id="save" data-gen="1">Save draft</button></div>
  <p id="status">saved:none</p>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      document.getElementById('status').textContent = 'saved:stale';
    });
    window.__slice1Rewrite = function () {
      const root = document.getElementById('root');
      root.replaceChildren();
      const button = document.createElement('button');
      button.id = 'save';
      button.type = 'button';
      button.dataset.gen = '2';
      button.textContent = 'Save draft';
      button.addEventListener('click', () => {
        document.getElementById('status').textContent = 'saved:fresh';
      });
      root.appendChild(button);
      return 'rewritten';
    };
  </script>
</body>
</html>`,
  session: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>slice1 session</title>
</head>
<body>
  <p id="cookie-marker">cookie-page-ready</p>
  <script>
    document.cookie = 'slice1_session=already-set; Path=/; SameSite=Lax';
  </script>
</body>
</html>`,
};

export function fixtureHtml(name) {
  const html = PAGES[name];
  if (!html) throw new Error(`unknown slice1 fixture: ${name}`);
  return html;
}

export const FIXTURE_NAMES = Object.freeze(Object.keys(PAGES));
