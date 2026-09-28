const IG_URLS = ['https://www.instagram.com/*', 'https://instagram.com/*'];

function inject(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// Chrome only runs content scripts on pages loaded after install, so cover tabs that were already open.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: IG_URLS });
  for (const tab of tabs) inject(tab.id).catch(() => {});
});

async function togglePanel(tab) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    return;
  } catch {}
  try {
    await inject(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    // Not an Instagram tab.
  }
}

chrome.action.onClicked.addListener(togglePanel);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  togglePanel(tab);
});
