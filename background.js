chrome.runtime.onInstalled.addListener(() => {
  // Set default settings on install
  chrome.storage.sync.get(['noiseGateSettings'], (result) => {
    if (!result.noiseGateSettings) {
      chrome.storage.sync.set({
        noiseGateSettings: {
          enabled: true,
          threshold: 0.025,
          ratio: 12,
          attack: 0.003,
          release: 0.15,
          hold: 0.08
        }
      });
    }
  });
});
