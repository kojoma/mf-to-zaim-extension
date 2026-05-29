// options.js - Handles credentials input, validation, and account settings fetching

document.addEventListener('DOMContentLoaded', async () => {
  const credentialsForm = document.getElementById('credentials-form');
  const consumerKeyInput = document.getElementById('consumer-key');
  const consumerSecretInput = document.getElementById('consumer-secret');
  const accessTokenInput = document.getElementById('access-token');
  const accessTokenSecretInput = document.getElementById('access-token-secret');
  
  const saveButton = document.getElementById('save-button');
  const saveButtonText = saveButton.querySelector('.btn-text');
  const saveSpinner = saveButton.querySelector('.spinner');

  const settingsCard = document.getElementById('settings-card');
  const defaultPaymentAccountSelect = document.getElementById('default-payment-account');
  const defaultIncomeAccountSelect = document.getElementById('default-income-account');
  const saveSettingsButton = document.getElementById('save-settings-button');

  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastMessage = document.getElementById('toast-message');

  let activeToastTimeout = null;

  // Show beautiful Toast Notification
  function showToast(message, type = 'success') {
    if (activeToastTimeout) {
      clearTimeout(activeToastTimeout);
    }
    
    toast.className = 'toast';
    toastMessage.textContent = message;
    
    if (type === 'success') {
      toast.classList.add('success');
      toastIcon.textContent = '✨';
    } else {
      toast.classList.add('error');
      toastIcon.textContent = '❌';
    }
    
    toast.classList.remove('hidden');
    
    activeToastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 4000);
  }

  // Load saved credentials & defaults on load
  const storedData = await chrome.storage.local.get(['credentials', 'defaults', 'accounts']);
  
  if (storedData.credentials) {
    consumerKeyInput.value = storedData.credentials.consumerKey || '';
    consumerSecretInput.value = storedData.credentials.consumerSecret || '';
    accessTokenInput.value = storedData.credentials.accessToken || '';
    accessTokenSecretInput.value = storedData.credentials.accessTokenSecret || '';
  }

  if (storedData.accounts && storedData.accounts.length > 0) {
    populateAccountSelects(storedData.accounts);
    enableSettingsForm();
  }

  if (storedData.defaults) {
    defaultPaymentAccountSelect.value = storedData.defaults.defaultPaymentAccountId || '';
    defaultIncomeAccountSelect.value = storedData.defaults.defaultIncomeAccountId || '';
  }

  // If credentials already exist, trigger a connection check automatically to refresh accounts
  if (storedData.credentials && storedData.credentials.consumerKey) {
    verifyAndFetchAccounts(true);
  }

  // Handle API credentials save & test connection
  credentialsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await verifyAndFetchAccounts(false);
  });

  // Handle default accounts save
  saveSettingsButton.addEventListener('click', async () => {
    const defaultPaymentAccountId = defaultPaymentAccountSelect.value;
    const defaultIncomeAccountId = defaultIncomeAccountSelect.value;

    await chrome.storage.local.set({
      defaults: {
        defaultPaymentAccountId,
        defaultIncomeAccountId
      }
    });

    showToast('デフォルト口座設定を保存しました！');
  });

  // --- OAuth Helper Assistant Logic ---
  const btnOauthStart = document.getElementById('btn-oauth-start');
  const btnOauthComplete = document.getElementById('btn-oauth-complete');
  const helperStep2 = document.getElementById('helper-step-2');
  const oauthVerifierInput = document.getElementById('oauth-verifier-input');
  let currentRequestToken = null;

  // Step 1: Start Zaim Authorization
  btnOauthStart.addEventListener('click', async () => {
    const consumerKey = consumerKeyInput.value.trim();
    const consumerSecret = consumerSecretInput.value.trim();

    if (!consumerKey || !consumerSecret) {
      showToast('上のフォームにコンシューマーIDとシークレットを入力してください。', 'error');
      return;
    }

    btnOauthStart.disabled = true;
    btnOauthStart.textContent = 'リクエストトークン取得中...';

    chrome.runtime.sendMessage({
      type: 'startOAuth',
      payload: { consumerKey, consumerSecret }
    }, (response) => {
      btnOauthStart.disabled = false;
      btnOauthStart.textContent = 'Zaim認証ページを開く';

      if (chrome.runtime.lastError) {
        console.error('chrome.runtime.lastError:', chrome.runtime.lastError);
        showToast('拡張機能のサービスワーカーとの通信に失敗しました。拡張機能管理画面(chrome://extensions/)で「再読み込み」ボタンをクリックしてください。', 'error');
        return;
      }

      if (response && response.success) {
        currentRequestToken = response.requestToken;
        
        // Open authorization page in a new tab
        window.open(response.authUrl, '_blank');
        
        // Enable Step 2
        helperStep2.classList.remove('disabled');
        oauthVerifierInput.disabled = false;
        btnOauthComplete.disabled = false;

        showToast('Zaim認証ページを別タブで開きました。アクセス許可をお願いします！');
      } else {
        const errorMsg = response ? response.error : '通信エラー';
        showToast('認証プロセスの開始に失敗しました: ' + errorMsg, 'error');
      }
    });
  });

  // Step 2: Complete OAuth and Exchange for Access Token
  btnOauthComplete.addEventListener('click', async () => {
    const verifierInputRaw = oauthVerifierInput.value.trim();

    if (!verifierInputRaw) {
      showToast('URLまたはPINコードを入力してください。', 'error');
      return;
    }

    // Parse oauth_verifier if the user pasted the entire redirect URL
    let verifier = verifierInputRaw;
    if (verifier.includes('oauth_verifier=')) {
      const match = verifier.match(/oauth_verifier=([^&]+)/);
      if (match) {
        verifier = match[1];
      }
    }

    btnOauthComplete.disabled = true;
    btnOauthComplete.textContent = 'アクセストークン取得中...';

    chrome.runtime.sendMessage({
      type: 'completeOAuth',
      payload: {
        requestToken: currentRequestToken,
        verifier: verifier
      }
    }, async (response) => {
      btnOauthComplete.disabled = false;
      btnOauthComplete.textContent = 'アクセストークンを取得・適用する';

      if (chrome.runtime.lastError) {
        console.error('chrome.runtime.lastError:', chrome.runtime.lastError);
        showToast('拡張機能との通信に失敗しました。再読み込みを行ってください。', 'error');
        return;
      }

      if (response && response.success) {
        // Automatically fill in options fields
        accessTokenInput.value = response.accessToken;
        accessTokenSecretInput.value = response.accessTokenSecret;

        showToast('アクセストークンの取得に成功しました！', 'success');

        // Automatically trigger connection check and save configurations
        await verifyAndFetchAccounts(false);

        // Lock step 2 back to disabled
        helperStep2.classList.add('disabled');
        oauthVerifierInput.value = '';
        oauthVerifierInput.disabled = true;
        btnOauthComplete.disabled = true;
      } else {
        const errorMsg = response ? response.error : '通信エラー';
        showToast('アクセストークンの取得に失敗しました: ' + errorMsg, 'error');
      }
    });
  });

  // Verify credentials and load accounts
  async function verifyAndFetchAccounts(isSilent = false) {
    const consumerKey = consumerKeyInput.value.trim();
    const consumerSecret = consumerSecretInput.value.trim();
    const accessToken = accessTokenInput.value.trim();
    const accessTokenSecret = accessTokenSecretInput.value.trim();

    if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
      if (!isSilent) showToast('すべてのキーを入力してください。', 'error');
      return;
    }

    if (!isSilent) {
      saveButton.disabled = true;
      saveButtonText.textContent = '接続検証中...';
      saveSpinner.classList.remove('hidden');
    }

    // Save temporary credentials for connection check
    await chrome.storage.local.set({
      credentials: {
        consumerKey,
        consumerSecret,
        accessToken,
        accessTokenSecret
      }
    });

    // Send connection check request to background script
    chrome.runtime.sendMessage({ type: 'testCredentials' }, async (response) => {
      if (!isSilent) {
        saveButton.disabled = false;
        saveButtonText.textContent = '保存して接続テスト';
        saveSpinner.classList.add('hidden');
      }

      if (response && response.success) {
        if (!isSilent) showToast('Zaim APIへの接続テストに成功しました！', 'success');
        
        // Fetch accounts list
        chrome.runtime.sendMessage({ type: 'fetchAccounts' }, async (accountsResponse) => {
          if (accountsResponse && accountsResponse.success) {
            const accounts = accountsResponse.accounts || [];
            
            // Save accounts in storage for Content Script
            await chrome.storage.local.set({ accounts });
            
            // Populate account dropdowns
            populateAccountSelects(accounts);
            enableSettingsForm();

            // Load saved defaults again in case they match newly fetched IDs
            const currentDefaults = await chrome.storage.local.get(['defaults']);
            if (currentDefaults.defaults) {
              defaultPaymentAccountSelect.value = currentDefaults.defaults.defaultPaymentAccountId || '';
              defaultIncomeAccountSelect.value = currentDefaults.defaults.defaultIncomeAccountId || '';
            }
          } else {
            console.error('Failed to fetch Zaim accounts:', accountsResponse.error);
            if (!isSilent) showToast('口座一覧の取得に失敗しました: ' + accountsResponse.error, 'error');
          }
        });
      } else {
        const errorMsg = response ? response.error : '不明なエラー';
        console.error('Zaim API Test Failed:', errorMsg);
        if (!isSilent) showToast('接続テストに失敗しました。認証キーを確認してください。\nエラー: ' + errorMsg, 'error');
        disableSettingsForm();
      }
    });
  }

  // Populate account dropdowns
  function populateAccountSelects(accounts) {
    // Clear selects
    defaultPaymentAccountSelect.innerHTML = '<option value="">選択してください (現金など)</option>';
    defaultIncomeAccountSelect.innerHTML = '<option value="">選択してください (現金など)</option>';

    // Filter and add accounts
    accounts.forEach(account => {
      if (account.active === 1) {
        const opt1 = document.createElement('option');
        opt1.value = account.id;
        opt1.textContent = account.name;
        defaultPaymentAccountSelect.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = account.id;
        opt2.textContent = account.name;
        defaultIncomeAccountSelect.appendChild(opt2);
      }
    });
  }

  // Enable settings form
  function enableSettingsForm() {
    settingsCard.classList.remove('disabled');
    defaultPaymentAccountSelect.disabled = false;
    defaultIncomeAccountSelect.disabled = false;
    saveSettingsButton.disabled = false;
  }

  // Disable settings form
  function disableSettingsForm() {
    settingsCard.classList.add('disabled');
    defaultPaymentAccountSelect.disabled = true;
    defaultIncomeAccountSelect.disabled = true;
    saveSettingsButton.disabled = true;
    
    defaultPaymentAccountSelect.innerHTML = '<option value="">接続テストに成功すると口座一覧が表示されます</option>';
    defaultIncomeAccountSelect.innerHTML = '<option value="">接続テストに成功すると口座一覧が表示されます</option>';
  }
});
