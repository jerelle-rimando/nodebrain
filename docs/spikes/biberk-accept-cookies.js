// Playwright init script for the biBerk spike: accepts biBerk's own cookie banner
// so the agent never spends steps on it. Runs in every frame before page scripts.
(() => {
  if (!/(^|\.)biberk\.com$/.test(location.hostname)) return;
  let done = false;
  const tryAccept = () => {
    if (done) return;
    const heading = [...document.querySelectorAll('h1,h2,h3')]
      .find(h => h.textContent.trim() === 'biBerk uses cookies.');
    if (!heading) return;
    // The banner's "Accept all" button sits beside, not inside, the heading's container.
    let scope = heading.parentElement;
    for (let i = 0; i < 4 && scope; i++, scope = scope.parentElement) {
      const btn = [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === 'Accept all');
      if (btn) {
        done = true;
        observer.disconnect();
        btn.click();
        console.info('[spike-init] accepted biBerk cookie banner');
        return;
      }
    }
  };
  const observer = new MutationObserver(tryAccept);
  observer.observe(document, { childList: true, subtree: true });
})();
