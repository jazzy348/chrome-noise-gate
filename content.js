(function () {
  'use strict';

  if (!window.isSecureContext) return;

  function isExtensionValid() {
    try { return !!chrome.runtime?.id; } catch(e) { return false; }
  }

  let audioCtx = null;
  let workletReady = false;
  const processedElements = new WeakMap();
  const pendingElements = new WeakSet();

  let settings = {
    enabled: true,
    threshold: 0.025,
    ratio: 12,
    attack: 0.003,
    release: 0.15,
    hold: 0.08
  };

  const activeGraphs = [];

  if (isExtensionValid()) {
    chrome.storage.sync.get(['noiseGateSettings'], (result) => {
      if (result.noiseGateSettings) settings = { ...settings, ...result.noiseGateSettings };
    });
  }

  if (isExtensionValid()) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'UPDATE_SETTINGS') {
        const prev = settings.enabled;
        settings = { ...settings, ...msg.settings };

        activeGraphs.forEach(({ gateNode, sourceNode, gainNode }) => {
          if (gateNode.port) {
            gateNode.port.postMessage({ type: 'settings', value: settings });
          }
          if (prev !== settings.enabled) {
            try {
              if (settings.enabled) {
                sourceNode.disconnect(gainNode);
                sourceNode.connect(gateNode);
                gateNode.connect(gainNode);
              } else {
                sourceNode.disconnect(gateNode);
                gateNode.disconnect(gainNode);
                sourceNode.connect(gainNode);
              }
            } catch(e) {}
          }
        });
      }
    });
  }

  let audioCtxReady = false;

  async function loadWorklet() {
    if (!isExtensionValid()) return false;
    try {
      const workletUrl = chrome.runtime.getURL('noise-gate-processor.js');
      await audioCtx.audioWorklet.addModule(workletUrl);
      return true;
    } catch (err) {
      if (isExtensionValid()) console.warn('[NoiseGate] AudioWorklet failed, using fallback:', err);
      return false;
    }
  }

  async function bootstrap() {
    if (audioCtxReady) return true;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    try {
      await audioCtx.resume();
    } catch(e) {
      return false;
    }

    if (audioCtx.state !== 'running') return false;

    workletReady = await loadWorklet();
    audioCtxReady = true;
    return true;
  }

  // Keep context alive if tab is backgrounded then foregrounded
  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }, { capture: true, passive: true });

  // Volume mirroring, createMediaElementSource bypasses el.volume/el.muted
  function createVolumeSync(el, gainNode) {
    function syncGain() {
      gainNode.gain.value = el.muted ? 0 : el.volume;
    }
    syncGain();
    el.addEventListener('volumechange', syncGain);
    let lastMuted = el.muted, lastVolume = el.volume;
    const interval = setInterval(() => {
      if (el.muted !== lastMuted || el.volume !== lastVolume) {
        lastMuted = el.muted; lastVolume = el.volume;
        syncGain();
      }
    }, 100);
    return () => { el.removeEventListener('volumechange', syncGain); clearInterval(interval); };
  }

  async function hookElement(el) {
    if (processedElements.has(el)) return;
    // Mark immediately, before any await, so concurrent calls are blocked
    // even while bootstrap() is in progress.
    processedElements.set(el, true);

    if (!audioCtxReady) {
      const isAudible = !el.muted && el.volume > 0;

      if (isAudible) {
        // Path A: try to bootstrap immediately
        const ok = await bootstrap();
        if (!ok) {
          // Autoplay blocked, clear the mark so deferral can re-hook later
          processedElements.delete(el);
          deferToElementEvents(el);
          return;
        }
      } else {
        // Path B: muted/silent, clear mark and defer to element-level events
        processedElements.delete(el);
        deferToElementEvents(el);
        return;
      }
    }

    try {
      let sourceNode;
      let usingCaptureStream = false;

      try {
        sourceNode = audioCtx.createMediaElementSource(el);
      } catch (e) {
        if (typeof el.captureStream === 'function') {
          try {
            const stream = el.captureStream();
            if (stream.getAudioTracks().length === 0) return;
            sourceNode = audioCtx.createMediaStreamSource(stream);
            el.muted = true;
            usingCaptureStream = true;
          } catch (e2) {
            console.warn('[NoiseGate] captureStream failed:', e2);
            return;
          }
        } else {
          console.warn('[NoiseGate] Cannot hook element:', e);
          return;
        }
      }

      const gainNode = audioCtx.createGain();
      createVolumeSync(el, gainNode);

      let gateNode;
      if (workletReady) {
        gateNode = new AudioWorkletNode(audioCtx, 'noise-gate-processor', {
          processorOptions: {
            threshold:   settings.threshold,
            ratio:       settings.ratio,
            attackTime:  settings.attack,
            releaseTime: settings.release,
            holdTime:    settings.hold,
            bypass:      !settings.enabled
          },
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
      } else {
        gateNode = audioCtx.createDynamicsCompressor();
        gateNode.threshold.value = 20 * Math.log10(settings.threshold + 0.001) - 20;
        gateNode.knee.value = 0;
        gateNode.ratio.value = 20;
        gateNode.attack.value = settings.attack;
        gateNode.release.value = settings.release;
      }

      if (settings.enabled) {
        sourceNode.connect(gateNode);
        gateNode.connect(gainNode);
      } else {
        sourceNode.connect(gainNode);
      }
      gainNode.connect(audioCtx.destination);

      activeGraphs.push({ sourceNode, gateNode, gainNode, el, usingCaptureStream });
      console.log('[NoiseGate] Hooked:', el.tagName, workletReady ? '(worklet)' : '(fallback)');

    } catch (err) {
      console.warn('[NoiseGate] Hook failed:', err);
    }
  }

  function deferToElementEvents(el) {
    if (pendingElements.has(el)) return;
    pendingElements.add(el);

    async function tryHook() {
      if (el.muted || el.volume === 0) return;
      el.removeEventListener('volumechange', tryHook);
      el.removeEventListener('play', tryHook);
      const ok = await bootstrap();
      if (ok) hookElement(el);
    }

    el.addEventListener('volumechange', tryHook);
    el.addEventListener('play', tryHook);
  }

  function scanForMediaElements() {
    document.querySelectorAll('video, audio').forEach(el => {
      if (processedElements.has(el) || pendingElements.has(el)) return;
      el.addEventListener('play', () => hookElement(el), { once: true });
      if (!el.paused) hookElement(el);
    });
  }

  scanForMediaElements();
  new MutationObserver(scanForMediaElements).observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(scanForMediaElements, 1500);
    }
  }).observe(document, { subtree: true, childList: true });

})();