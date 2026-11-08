document.addEventListener('DOMContentLoaded', () => {
  const cards = document.querySelectorAll('.mode-card');
  const btnPop = document.getElementById('btnPopCurrent');
  const btnRecall = document.getElementById('btnRecallAll');

  function updateActiveUI(mode) {
    cards.forEach((c) => {
      if (c.dataset.mode === mode) c.classList.add('active');
      else c.classList.remove('active');
    });
  }

  // Load saved mode
  chrome.storage.local.get(['multipip_mode'], (res) => {
    const cur = (res && res.multipip_mode) || 'dock';
    updateActiveUI(cur);
  });

  // Switch mode on card click
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      updateActiveUI(mode);
      chrome.storage.local.set({ multipip_mode: mode });
      // Notify active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'mp-set-mode', mode }, () => {
            void chrome.runtime.lastError;
          });
        }
      });
    });
  });

  // Pop out first video on current tab
  if (btnPop) {
    btnPop.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'mp-pop-first' }, () => {
            void chrome.runtime.lastError;
            window.close();
          });
        }
      });
    });
  }

  // Recall all videos on current tab
  if (btnRecall) {
    btnRecall.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'mp-recall-all' }, () => {
            void chrome.runtime.lastError;
            window.close();
          });
        }
      });
    });
  }
});
