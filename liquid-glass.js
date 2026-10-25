// Presentation-only pointer highlight. One passive listener and at most one update per frame.
(() => {
  'use strict';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const finePointer = matchMedia('(pointer: fine)');
  const surfaceSelector = '.app-header,.stat-card,.glass-switch-row,#cxPanel,.modal-content,.template-card';
  let frame = 0, active = null, x = 0, y = 0;
  const enabled = () => !reducedMotion.matches && !reducedTransparency.matches && finePointer.matches;
  function clearSurface(surface) {
    if (!surface) return;
    surface.style.removeProperty('--glass-x');
    surface.style.removeProperty('--glass-y');
  }
  function reset() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearSurface(active);
    active = null;
  }
  function paint() {
    frame = 0;
    if (!active || !enabled() || !active.isConnected) return reset();
    const rect = active.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = Math.max(0,Math.min(100,(x-rect.left)*100/rect.width));
    const py = Math.max(0,Math.min(100,(y-rect.top)*100/rect.height));
    active.style.setProperty('--glass-x', px.toFixed(1)+'%');
    active.style.setProperty('--glass-y', py.toFixed(1)+'%');
  }
  document.addEventListener('pointermove', event => {
    if (!enabled() || event.pointerType === 'touch') return;
    const next = event.target instanceof Element ? event.target.closest(surfaceSelector) : null;
    if (next !== active) { clearSurface(active); active = next; }
    if (!active) return;
    x = event.clientX; y = event.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  }, {passive:true});
  document.documentElement.addEventListener('pointerleave', reset, {passive:true});
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if(document.hidden) reset(); });
  for (const query of [reducedMotion,reducedTransparency,finePointer]) query.addEventListener('change', reset);
})();
