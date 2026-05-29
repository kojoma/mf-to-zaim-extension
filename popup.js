// popup.js - Handles status indicator and settings page opening

document.addEventListener('DOMContentLoaded', async () => {
  const statusVal = document.getElementById('status-val');
  const openSettingsBtn = document.getElementById('open-settings');

  // Check if credentials exist in storage
  const data = await chrome.storage.local.get(['credentials']);
  if (data.credentials && data.credentials.consumerKey && data.credentials.accessToken) {
    statusVal.className = 'status-val connected';
    statusVal.innerHTML = '<span>●</span> 接続設定済み';
  } else {
    statusVal.className = 'status-val not-connected';
    statusVal.innerHTML = '<span>●</span> 未設定';
  }

  // Open settings/options page
  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
