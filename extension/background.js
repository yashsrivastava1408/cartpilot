// CartPilot service worker: opens the side panel and keeps steady timers for store tabs.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "cartpilot-sleep") return false;
  const ms = Math.max(0, Math.min(10_000, Number(message.ms) || 0));
  setTimeout(() => sendResponse(true), ms);
  return true; // answer asynchronously
});
