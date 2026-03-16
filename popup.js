const PRESETS = {
  light:   { threshold: 0.01,  ratio: 5,  attack: 0.005, release: 0.2,  hold: 0.05 },
  eating:  { threshold: 0.025, ratio: 12, attack: 0.003, release: 0.15, hold: 0.08 },
  heavy:   { threshold: 0.05,  ratio: 20, attack: 0.002, release: 0.1,  hold: 0.06 },
  podcast: { threshold: 0.015, ratio: 8,  attack: 0.008, release: 0.3,  hold: 0.12 }
};

const DEFAULT_SETTINGS = {
  enabled: true,
  threshold: 0.025,
  ratio: 12,
  attack: 0.003,
  release: 0.15,
  hold: 0.08,
  activePreset: 'eating',
  customPreset: null
};

function linToDb(linear) {
  if (linear <= 0) return '-∞';
  return (20 * Math.log10(linear)).toFixed(0);
}

function sliderToThreshold(val) {
  return Math.pow(10, (val - 80) / 40);
}

function thresholdToSlider(val) {
  return Math.round(40 * Math.log10(val) + 80);
}

let currentSettings = { ...DEFAULT_SETTINGS };

function updateDisplay() {
  const tSlider = document.getElementById('threshold');
  const thresh = sliderToThreshold(parseInt(tSlider.value));
  document.getElementById('thresholdVal').textContent = linToDb(thresh) + ' dB';
  document.getElementById('ratioVal').textContent = document.getElementById('ratio').value + ' : 1';
  document.getElementById('holdVal').textContent = document.getElementById('hold').value + ' ms';
  document.getElementById('releaseVal').textContent = document.getElementById('release').value + ' ms';
}

function settingsFromSliders() {
  return {
    enabled: currentSettings.enabled,
    threshold: sliderToThreshold(parseInt(document.getElementById('threshold').value)),
    ratio: parseInt(document.getElementById('ratio').value),
    attack: 0.003,
    release: parseInt(document.getElementById('release').value) / 1000,
    hold: parseInt(document.getElementById('hold').value) / 1000,
    activePreset: currentSettings.activePreset,
    customPreset: currentSettings.customPreset
  };
}

function sendSettingsToTab(settings) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'UPDATE_SETTINGS',
        settings
      }).catch(() => {});
    }
  });
  chrome.storage.sync.set({ noiseGateSettings: settings });
}

function settingsToSliders(s) {
  document.getElementById('threshold').value = thresholdToSlider(s.threshold);
  document.getElementById('ratio').value = s.ratio;
  document.getElementById('hold').value = Math.round(s.hold * 1000);
  document.getElementById('release').value = Math.round(s.release * 1000);
}

function setActivePresetUI(name) {
  // Always clear all first
  document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
  if (name) {
    const btn = document.querySelector(`[data-preset="${name}"]`);
    if (btn) btn.classList.add('active');
  }
}

function applyPreset(name) {
  const preset = name === 'custom'
    ? currentSettings.customPreset
    : PRESETS[name];
  if (!preset) return;

  settingsToSliders(preset);
  currentSettings = { ...settingsFromSliders(), activePreset: name };
  setActivePresetUI(name);
  updateDisplay();
  sendSettingsToTab(currentSettings);
}

function saveCustomPreset() {
  const sliderValues = {
    threshold: sliderToThreshold(parseInt(document.getElementById('threshold').value)),
    ratio: parseInt(document.getElementById('ratio').value),
    attack: 0.003,
    release: parseInt(document.getElementById('release').value) / 1000,
    hold: parseInt(document.getElementById('hold').value) / 1000
  };

  currentSettings = {
    ...currentSettings,
    ...sliderValues,
    customPreset: sliderValues,
    activePreset: 'custom'
  };

  updateCustomBtn();
  setActivePresetUI('custom');
  sendSettingsToTab(currentSettings);
}

function updateCustomBtn() {
  const btn = document.querySelector('[data-preset="custom"]');
  if (!btn) return;
  const hasCustom = !!currentSettings.customPreset;
  btn.textContent = hasCustom ? 'Custom' : '+ Save';
  btn.title = hasCustom ? 'Click to apply your saved custom preset' : 'Save current sliders as custom preset';
}

function setEnabled(enabled) {
  currentSettings.enabled = enabled;
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');

  if (enabled) {
    document.body.classList.remove('disabled');
    statusBar.classList.remove('off');
    statusText.textContent = 'ACTIVE, filtering audio';
  } else {
    document.body.classList.add('disabled');
    statusBar.classList.add('off');
    statusText.textContent = 'PAUSED, bypass mode';
  }

  sendSettingsToTab(currentSettings);
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['noiseGateSettings'], (result) => {
    if (result.noiseGateSettings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...result.noiseGateSettings };
    }

    settingsToSliders(currentSettings);
    document.getElementById('enableToggle').checked = currentSettings.enabled;

    setActivePresetUI(currentSettings.activePreset);
    updateCustomBtn();

    if (!currentSettings.enabled) setEnabled(false);
    updateDisplay();
  });

  // Slider events
  ['threshold', 'ratio', 'hold', 'release'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      updateDisplay();
      currentSettings.activePreset = null;
      setActivePresetUI(null);
    });
    el.addEventListener('change', () => {
      currentSettings = settingsFromSliders();
      sendSettingsToTab(currentSettings);
    });
  });

  // Toggle
  document.getElementById('enableToggle').addEventListener('change', (e) => {
    setEnabled(e.target.checked);
  });

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.preset;
      if (name === 'custom') {
        if (currentSettings.customPreset) {
          // Apply saved custom preset
          applyPreset('custom');
        } else {
          // No custom preset yet, save current sliders
          saveCustomPreset();
        }
      } else {
        applyPreset(name);
      }
    });
  });

  // Long-press custom button to overwrite it
  const customBtn = document.querySelector('[data-preset="custom"]');
  let longPressTimer = null;
  customBtn.addEventListener('pointerdown', () => {
    longPressTimer = setTimeout(() => {
      saveCustomPreset();
      customBtn.textContent = 'Saved!';
      setTimeout(updateCustomBtn, 800);
    }, 600);
  });
  customBtn.addEventListener('pointerup', () => clearTimeout(longPressTimer));
  customBtn.addEventListener('pointerleave', () => clearTimeout(longPressTimer));

  // Reset
  document.getElementById('resetBtn').addEventListener('click', () => {
    applyPreset('eating');
    document.getElementById('enableToggle').checked = true;
    setEnabled(true);
  });
});