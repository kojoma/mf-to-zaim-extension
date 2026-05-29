// content.js - Money Forward injected content script with premium overlay UI and auto-matching logic

(function () {
  // Prevent duplicate injection
  if (window.hasOwnProperty('__zaimSyncerInjected')) return;
  window.__zaimSyncerInjected = true;

  let zaimCategories = [];
  let zaimGenres = [];
  let zaimAccounts = [];
  let customMappings = {};
  let defaultSettings = {};
  let parsedTransactions = [];

  // Helper: Get active year from page structure
  function getActiveYear() {
    // 1. Try URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('year')) {
      const y = parseInt(urlParams.get('year'), 10);
      if (!isNaN(y)) return y;
    }

    // 2. Try to find the calendar navigation text (e.g. "2026年05月")
    const headerText = document.querySelector('.fc-header-title, .active-month, .active_month_value, h2, h3')?.textContent || '';
    const match = headerText.match(/(\d{4})年/);
    if (match) {
      return parseInt(match[1], 10);
    }

    // 3. Fallback to current year
    return new Date().getFullYear();
  }

  // Helper: Format date strings into YYYY-MM-DD
  function parseDateString(dateStr) {
    const cleaned = dateStr.trim().replace(/\s+/g, ''); // E.g., "2026/05/29" or "05/29(金)"
    const year = getActiveYear();
    
    // Check if it already has a 4-digit year
    const fullDateMatch = cleaned.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (fullDateMatch) {
      const y = fullDateMatch[1];
      const m = fullDateMatch[2].padStart(2, '0');
      const d = fullDateMatch[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // Check if it's MM/DD format
    const shortDateMatch = cleaned.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (shortDateMatch) {
      const m = shortDateMatch[1].padStart(2, '0');
      const d = shortDateMatch[2].padStart(2, '0');
      return `${year}-${m}-${d}`;
    }

    // Fallback to today
    const today = new Date();
    return `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
  }

  // Parse Money Forward transaction table
  function parseMoneyForwardTransactions() {
    const table = document.getElementById('cf-detail-table');
    if (!table) return [];

    const rows = table.querySelectorAll('tbody tr');
    const transactions = [];

    rows.forEach((row, index) => {
      // Check if it's a valid transaction row
      const cells = row.cells || [];

      // Extract raw column data safely (using CSS classes first, cell indexes as fallback)
      const dateCell = row.querySelector('.date') || cells[1];
      const contentCell = row.querySelector('.content') || cells[2];
      const amountCell = row.querySelector('.amount, .number') || cells[3];
      const categoryCell = row.querySelector('.category') || cells[4];

      if (!dateCell || !contentCell || !amountCell) return;

      const rawDate = dateCell.textContent.trim();
      const rawContent = contentCell.textContent.trim();
      const rawAmount = amountCell.textContent.trim();
      const rawCategory = categoryCell ? categoryCell.textContent.trim() : '';

      // Skip empty or utility rows
      if (!rawDate || !rawAmount) return;

      // Skip Transfers (振替) as requested
      // (Only check category name or row classes; do not check content description to prevent accidentally skipping "transfer fees")
      const isTransfer = rawCategory.includes('振替') || row.classList.contains('transfer');
      if (isTransfer) return;

      // Determine payment type (Expense or Income) and parse numerical value
      // MF indicates expense with minus sign (-¥1,500) and income with plus sign (+¥3,000) or plain positive value
      const isExpense = rawAmount.includes('-') || (!rawAmount.includes('+') && !row.classList.contains('income'));
      const numericalAmount = parseInt(rawAmount.replace(/[^\d]/g, ''), 10);
      if (isNaN(numericalAmount) || numericalAmount === 0) return;

      // Parse Large & Sub categories
      // MF category is often represented like "食費" or "食費 > 食料品"
      let largeCategory = rawCategory;
      let middleCategory = '';

      if (rawCategory.includes('＞')) {
        const parts = rawCategory.split('＞');
        largeCategory = parts[0].trim();
        middleCategory = parts[1].trim();
      } else if (rawCategory.includes('>')) {
        const parts = rawCategory.split('>');
        largeCategory = parts[0].trim();
        middleCategory = parts[1].trim();
      }

      transactions.push({
        id: `tx_${index}_${Date.now()}`,
        date: parseDateString(rawDate),
        rawDate,
        content: rawContent,
        amount: numericalAmount,
        type: isExpense ? 'expense' : 'income',
        mfCategory: rawCategory,
        mfLargeCategory: largeCategory,
        mfMiddleCategory: middleCategory
      });
    });

    return transactions;
  }

  // Perform automatic matching against fetched Zaim categories/genres
  function matchZaimCategory(tx) {
    // 1. Check custom mappings saved in storage
    const mappingKey = `${tx.type}_${tx.mfLargeCategory}_${tx.mfMiddleCategory}`;
    if (customMappings[mappingKey]) {
      const saved = customMappings[mappingKey];
      return {
        categoryId: saved.categoryId,
        genreId: saved.genreId,
        isCustom: true
      };
    }

    const zaimMode = tx.type === 'expense' ? 'payment' : 'income';

    // 2. Try to match the Large Category by name
    const matchedCategory = zaimCategories.find(c => {
      return c.mode === zaimMode && c.active === 1 && 
             (c.name.includes(tx.mfLargeCategory) || tx.mfLargeCategory.includes(c.name));
    });

    if (!matchedCategory) {
      return { categoryId: '', genreId: '', isCustom: false };
    }

    // For Incomes, we only need a Category ID
    if (tx.type === 'income') {
      return {
        categoryId: matchedCategory.id,
        genreId: '',
        isCustom: false
      };
    }

    // For Payments, we also need a Genre ID (Subcategory)
    const genresInCat = zaimGenres.filter(g => g.category_id === matchedCategory.id && g.active === 1);
    
    // Try to match the middle category by name
    let matchedGenre = null;
    if (tx.mfMiddleCategory) {
      matchedGenre = genresInCat.find(g => {
        return g.name.includes(tx.mfMiddleCategory) || tx.mfMiddleCategory.includes(g.name);
      });
    }

    // Fallback to the first genre of the category if no subcategory matched
    if (!matchedGenre && genresInCat.length > 0) {
      matchedGenre = genresInCat[0];
    }

    return {
      categoryId: matchedCategory.id,
      genreId: matchedGenre ? matchedGenre.id : '',
      isCustom: false
    };
  }

  // Create and inject the floating sync button
  function injectFloatingButton() {
    if (document.querySelector('.zaim-floating-trigger')) return;

    const button = document.createElement('button');
    button.className = 'zaim-floating-trigger';
    button.innerHTML = `
      <img src="${chrome.runtime.getURL('icon.png')}" style="width: 20px; height: 20px; border-radius: 4px;">
      <span>Zaimへ同期</span>
    `;

    button.addEventListener('click', openSidebar);
    document.body.appendChild(button);
  }

  // Slide open the Sidebar Panel
  async function openSidebar() {
    const sidebar = document.querySelector('.zaim-sidebar-wrapper');
    if (!sidebar) return;

    sidebar.classList.add('open');

    // Parse transactions from the active screen
    parsedTransactions = parseMoneyForwardTransactions();

    // Render the initial UI
    await renderSidebarContent();
  }

  // Render Sidebar interior contents
  async function renderSidebarContent() {
    const sidebarBody = document.querySelector('.zaim-sidebar-body');
    const sidebarFooter = document.querySelector('.zaim-sidebar-footer');
    if (!sidebarBody) return;

    sidebarBody.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--zaim-text-secondary);">Zaimデータを取得中...</div>';
    sidebarFooter.style.display = 'none';

    // 1. Fetch credentials and mapping preferences from chrome.storage.local
    const storageData = await chrome.storage.local.get(['credentials', 'defaults', 'customMappings']);
    customMappings = storageData.customMappings || {};
    defaultSettings = storageData.defaults || {};

    if (!storageData.credentials || !storageData.credentials.consumerKey) {
      renderCredentialsError();
      return;
    }

    // 2. Fetch Zaim master data
    try {
      const [catRes, genRes, accRes] = await Promise.all([
        sendMessageAsync({ type: 'fetchCategories' }),
        sendMessageAsync({ type: 'fetchGenres' }),
        sendMessageAsync({ type: 'fetchAccounts' })
      ]);

      if (!catRes.success || !genRes.success || !accRes.success) {
        throw new Error(catRes.error || genRes.error || accRes.error || 'Zaimデータの取得に失敗しました。');
      }

      zaimCategories = catRes.categories;
      zaimGenres = genRes.genres;
      zaimAccounts = accRes.accounts;

      // 3. Render transactions list
      renderTransactionList();
      sidebarFooter.style.display = 'flex';
      updateFooterStats();

    } catch (e) {
      console.error(e);
      sidebarBody.innerHTML = `
        <div class="zaim-error-card">
          <p>⚠️ Zaimとの接続に失敗しました。<br>APIキーが正しいことを設定画面でご確認ください。</p>
          <p style="font-size: 12px; color: var(--zaim-text-muted);">${e.message}</p>
          <button class="btn-settings" id="open-settings-err">API設定を開く</button>
        </div>
      `;
      document.getElementById('open-settings-err')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'openSettings' }); // Fallback to background
        window.open(chrome.runtime.getURL('options.html'));
      });
    }
  }

  // Render credentials missing error card
  function renderCredentialsError() {
    const sidebarBody = document.querySelector('.zaim-sidebar-body');
    if (!sidebarBody) return;

    sidebarBody.innerHTML = `
      <div class="zaim-error-card">
        <p>🔑 Zaim APIの認証情報が設定されていません。<br>コピーを開始する前に設定を完了してください。</p>
        <button class="btn-settings" id="open-settings-err">API設定を開く</button>
      </div>
    `;
    document.getElementById('open-settings-err')?.addEventListener('click', () => {
      window.open(chrome.runtime.getURL('options.html'));
    });
  }

  // Render parsed transaction cards
  function renderTransactionList() {
    const sidebarBody = document.querySelector('.zaim-sidebar-body');
    if (!sidebarBody) return;

    sidebarBody.innerHTML = '';

    // B. Add Summary Header
    const summaryBar = document.createElement('div');
    summaryBar.className = 'zaim-summary-bar';
    sidebarBody.appendChild(summaryBar);

    // C. Add transactions
    if (parsedTransactions.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'text-align: center; padding: 40px; color: var(--zaim-text-secondary); font-size: 14px;';
      emptyMsg.textContent = '同期可能な収支明細が画面上に見つかりません。';
      sidebarBody.appendChild(emptyMsg);
      return;
    }

    const listContainer = document.createElement('div');
    listContainer.className = 'zaim-tx-list';

    parsedTransactions.forEach(tx => {
      const card = document.createElement('div');
      card.className = 'zaim-tx-card skipped'; // default to unchecked and visually skipped
      card.id = tx.id;

      // Match categories
      const matched = matchZaimCategory(tx);

      // Create Category options
      const activeCategories = zaimCategories.filter(c => c.active === 1 && c.mode === (tx.type === 'expense' ? 'payment' : 'income'));
      let catOptionsHtml = `<option value="">-- カテゴリを選択 --</option>`;
      activeCategories.forEach(cat => {
        catOptionsHtml += `<option value="${cat.id}" ${matched.categoryId == cat.id ? 'selected' : ''}>${cat.name}</option>`;
      });

      // Create Genre options if Expense
      let genreOptionsHtml = '';
      if (tx.type === 'expense') {
        genreOptionsHtml = `<option value="">-- 内訳を選択 --</option>`;
        if (matched.categoryId) {
          const activeGenres = zaimGenres.filter(g => g.active === 1 && g.category_id == matched.categoryId);
          activeGenres.forEach(genre => {
            genreOptionsHtml += `<option value="${genre.id}" ${matched.genreId == genre.id ? 'selected' : ''}>${genre.name}</option>`;
          });
        }
      }

      // Populate card HTML
      const isUnmapped = tx.type === 'expense' ? (!matched.categoryId || !matched.genreId) : !matched.categoryId;
      const formattedAmount = `${tx.type === 'expense' ? '-' : '+'}${tx.amount.toLocaleString()}円`;

      card.innerHTML = `
        <div class="zaim-tx-card-top">
          <div class="zaim-checkbox-container">
            <input type="checkbox" class="zaim-checkbox" data-id="${tx.id}">
          </div>
          <div class="zaim-tx-info">
            <div class="zaim-tx-date-category">
              <span>${tx.date}</span>
              <span class="zaim-tx-mf-cat" title="${tx.mfCategory}">${tx.mfCategory}</span>
            </div>
            <div class="zaim-tx-content">${tx.content}</div>
          </div>
          <div class="zaim-tx-amount-col ${tx.type}">${formattedAmount}</div>
        </div>

        <div class="zaim-mapping-section">
          <!-- Category Dropdown -->
          <div class="zaim-mapping-row">
            <span>カテゴリ</span>
            <select class="zaim-select-mapping zaim-card-category-select ${isUnmapped ? 'unmapped' : ''}" data-id="${tx.id}">
              ${catOptionsHtml}
            </select>
          </div>

          <!-- Genre Dropdown (Expense only) -->
          ${tx.type === 'expense' ? `
          <div class="zaim-mapping-row zaim-genre-row" id="genre-row-${tx.id}">
            <span>内訳</span>
            <select class="zaim-select-mapping zaim-card-genre-select ${isUnmapped ? 'unmapped' : ''}" data-id="${tx.id}">
              ${genreOptionsHtml}
            </select>
          </div>
          ` : ''}
        </div>

        <!-- Sync Status overlay -->
        <div class="zaim-sync-status hidden">
          <span class="status-icon">⏳</span>
          <span class="status-text">待機中</span>
        </div>
      `;

      listContainer.appendChild(card);
      sidebarBody.appendChild(listContainer);

      // Handle card selections
      const checkbox = card.querySelector('.zaim-checkbox');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          card.classList.remove('skipped');
        } else {
          card.classList.add('skipped');
        }
        updateFooterStats();
      });

      // Category change updates Genre options (Expense only)
      const categorySelect = card.querySelector('.zaim-card-category-select');
      categorySelect.addEventListener('change', () => {
        const catId = categorySelect.value;
        if (!catId) {
          categorySelect.classList.add('unmapped');
        } else {
          categorySelect.classList.remove('unmapped');
        }

        if (tx.type === 'expense') {
          const genreSelect = card.querySelector('.zaim-card-genre-select');
          const genreRow = card.querySelector(`#genre-row-${tx.id}`);
          
          if (!catId) {
            genreSelect.innerHTML = '<option value="">-- 内訳を選択 --</option>';
            genreSelect.classList.add('unmapped');
            return;
          }

          const filteredGenres = zaimGenres.filter(g => g.active === 1 && g.category_id == catId);
          let newGenreHtml = '<option value="">-- 内訳を選択 --</option>';
          filteredGenres.forEach(g => {
            newGenreHtml += `<option value="${g.id}">${g.name}</option>`;
          });
          
          genreSelect.innerHTML = newGenreHtml;
          genreSelect.classList.add('unmapped');

          // Auto-select first genre if available
          if (filteredGenres.length > 0) {
            genreSelect.value = filteredGenres[0].id;
            genreSelect.classList.remove('unmapped');
          }
        }

        // Save mapping choice dynamically
        saveCustomMappingChoice(tx, categorySelect.value, tx.type === 'expense' ? card.querySelector('.zaim-card-genre-select').value : '');
      });

      if (tx.type === 'expense') {
        const genreSelect = card.querySelector('.zaim-card-genre-select');
        genreSelect.addEventListener('change', () => {
          if (!genreSelect.value) {
            genreSelect.classList.add('unmapped');
          } else {
            genreSelect.classList.remove('unmapped');
          }

          // Save mapping choice dynamically
          saveCustomMappingChoice(tx, categorySelect.value, genreSelect.value);
        });
      }
    });
  }

  // Save custom mapping preference in chrome storage
  async function saveCustomMappingChoice(tx, categoryId, genreId) {
    if (!categoryId) return;
    
    const mappingKey = `${tx.type}_${tx.mfLargeCategory}_${tx.mfMiddleCategory}`;
    customMappings[mappingKey] = {
      categoryId: parseInt(categoryId, 10),
      genreId: genreId ? parseInt(genreId, 10) : null
    };

    await chrome.storage.local.set({ customMappings });
  }

  // Update transaction selection count & total amounts
  function updateFooterStats() {
    const checkedBoxes = document.querySelectorAll('.zaim-checkbox:checked');
    const summaryBar = document.querySelector('.zaim-summary-bar');
    const syncButton = document.getElementById('zaim-sync-btn');
    if (!summaryBar) return;

    let selectedCount = 0;
    let expenseTotal = 0;
    let incomeTotal = 0;

    checkedBoxes.forEach(box => {
      const txId = box.getAttribute('data-id');
      const tx = parsedTransactions.find(t => t.id === txId);
      if (tx) {
        selectedCount++;
        if (tx.type === 'expense') expenseTotal += tx.amount;
        else incomeTotal += tx.amount;
      }
    });

    summaryBar.innerHTML = `
      <span>選択中: <strong>${selectedCount}件</strong></span>
      <span>支出: <strong style="color: var(--zaim-expense)">${expenseTotal.toLocaleString()}円</strong></span>
      <span>収入: <strong style="color: var(--zaim-income)">${incomeTotal.toLocaleString()}円</strong></span>
    `;

    if (syncButton) {
      syncButton.disabled = selectedCount === 0;
    }
  }

  // Sequentially execute registration to Zaim API
  async function startZaimSynchronization() {
    const checkedBoxes = Array.from(document.querySelectorAll('.zaim-checkbox:checked'));
    if (checkedBoxes.length === 0) return;

    const syncButton = document.getElementById('zaim-sync-btn');
    const closeButton = document.querySelector('.zaim-sidebar-close');
    const progressBar = document.querySelector('.zaim-progress-bar');
    const progressText = document.getElementById('zaim-progress-text');
    const progressPercent = document.getElementById('zaim-progress-percent');
    const progressContainer = document.querySelector('.zaim-progress-container');

    // 1. Lock controls
    syncButton.disabled = true;
    syncButton.innerHTML = '<span class="spinner"></span> 登録処理中...';
    closeButton.style.pointerEvents = 'none';
    progressContainer.classList.remove('hidden');

    // Disable all selects/checkboxes during sync
    document.querySelectorAll('.zaim-select-mapping, .zaim-checkbox, .zaim-select-control').forEach(el => {
      el.disabled = true;
    });

    const total = checkedBoxes.length;
    let successCount = 0;
    let failCount = 0;

    // 2. Loop through each checked transaction
    for (let i = 0; i < total; i++) {
      const box = checkedBoxes[i];
      const txId = box.getAttribute('data-id');
      const tx = parsedTransactions.find(t => t.id === txId);
      const card = document.getElementById(txId);

      if (!tx || !card) continue;

      // Update UI to Syncing status
      const statusOverlay = card.querySelector('.zaim-sync-status');
      const statusIcon = statusOverlay.querySelector('.status-icon');
      const statusText = statusOverlay.querySelector('.status-text');
      
      statusOverlay.classList.remove('hidden');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      statusOverlay.className = 'zaim-sync-status syncing';
      statusIcon.textContent = '🔄';
      statusText.textContent = '同期中...';

      // Read current card dropdown configurations
      const categorySelect = card.querySelector('.zaim-card-category-select');
      const genreSelect = card.querySelector('.zaim-card-genre-select');

      const categoryId = categorySelect.value;
      const genreId = genreSelect ? genreSelect.value : null;

      // Retrieve default account ID from extension configurations
      const defaultPaymentAccId = defaultSettings.defaultPaymentAccountId;
      const defaultIncomeAccId = defaultSettings.defaultIncomeAccountId;
      const accountId = tx.type === 'expense'
        ? (defaultPaymentAccId ? parseInt(defaultPaymentAccId, 10) : 0)
        : (defaultIncomeAccId ? parseInt(defaultIncomeAccId, 10) : 0);

      // Validate mapping before submitting
      if (!categoryId || (tx.type === 'expense' && !genreId)) {
        statusOverlay.className = 'zaim-sync-status error';
        statusIcon.textContent = '❌';
        statusText.textContent = 'カテゴリ未設定';
        failCount++;
        updateProgressBar(i + 1, total);
        continue;
      }

      // Prepare request payload
      let messagePayload = {};
      let msgType = '';

      if (tx.type === 'expense') {
        msgType = 'registerExpense';
        messagePayload = {
          category_id: parseInt(categoryId, 10),
          genre_id: parseInt(genreId, 10),
          amount: tx.amount,
          date: tx.date,
          from_account_id: accountId ? parseInt(accountId, 10) : 0,
          comment: tx.content // Sync original MF description
        };
      } else {
        msgType = 'registerIncome';
        messagePayload = {
          category_id: parseInt(categoryId, 10),
          amount: tx.amount,
          date: tx.date,
          to_account_id: accountId ? parseInt(accountId, 10) : 0,
          comment: tx.content // Sync original MF description
        };
      }

      // Send registration request to background.js
      try {
        const response = await sendMessageAsync({
          type: msgType,
          payload: messagePayload
        });

        if (response && response.success) {
          statusOverlay.className = 'zaim-sync-status success';
          statusIcon.textContent = '✅';
          statusText.textContent = '完了';
          card.classList.add('skipped'); // Fade completed cards
          successCount++;
        } else {
          throw new Error(response ? response.error : 'API応答エラー');
        }
      } catch (error) {
        console.error('Registration Failed for', tx, error);
        statusOverlay.className = 'zaim-sync-status error';
        statusIcon.textContent = '❌';
        statusText.textContent = 'エラー';
        statusOverlay.title = error.message; // Show details on hover
        failCount++;
      }

      // Update progress bar
      updateProgressBar(i + 1, total);

      // Short delay for visual polish and API rate limits
      await new Promise(r => setTimeout(r, 400));
    }

    // 3. Sync Finished - restore controls
    syncButton.innerHTML = '同期完了';
    closeButton.style.pointerEvents = 'auto';
    
    // Alert summary results
    alert(`同期完了しました！\n成功: ${successCount}件\n失敗: ${failCount}件`);

    // Reset button after 3s
    setTimeout(() => {
      syncButton.disabled = false;
      syncButton.innerHTML = `
        <span>選択した明細をZaimに登録</span>
      `;
      progressContainer.classList.add('hidden');
      progressBar.style.width = '0%';
      
      // Re-enable remaining elements
      document.querySelectorAll('.zaim-select-mapping, .zaim-checkbox, .zaim-select-control').forEach(el => {
        el.disabled = false;
      });
      
      // Re-parse and update to clean completed rows
      openSidebar();
    }, 3000);
  }

  // Update progress bar UI values
  function updateProgressBar(current, total) {
    const progressBar = document.querySelector('.zaim-progress-bar');
    const progressText = document.getElementById('zaim-progress-text');
    const progressPercent = document.getElementById('zaim-progress-percent');
    
    const percentage = Math.round((current / total) * 100);
    progressBar.style.width = `${percentage}%`;
    progressText.textContent = `同期中: ${current} / ${total} 件`;
    progressPercent.textContent = `${percentage}%`;
  }

  // Helper: Async messaging wrapper for chrome.runtime.sendMessage
  function sendMessageAsync(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(response);
      });
    });
  }

  // Build and inject sidebar HTML frame on load
  function injectSidebarHTML() {
    if (document.querySelector('.zaim-sidebar-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'zaim-sidebar-wrapper';
    wrapper.innerHTML = `
      <div class="zaim-sidebar-header">
        <div class="zaim-header-title">
          <img src="${chrome.runtime.getURL('icon.png')}" alt="Logo">
          <h2>Zaim 同期ダッシュボード</h2>
        </div>
        <button class="zaim-sidebar-close" id="zaim-sidebar-close-btn">&times;</button>
      </div>
      
      <div class="zaim-sidebar-body">
        <!-- Content gets loaded dynamically inside openSidebar -->
      </div>
      
      <div class="zaim-sidebar-footer">
        <div class="zaim-progress-container hidden">
          <div class="zaim-progress-labels">
            <span id="zaim-progress-text">同期中: 0 / 0 件</span>
            <span id="zaim-progress-percent">0%</span>
          </div>
          <div class="zaim-progress-track">
            <div class="zaim-progress-bar"></div>
          </div>
        </div>

        <button class="zaim-btn-sync" id="zaim-sync-btn">
          <span>選択した明細をZaimに登録</span>
        </button>
      </div>
    `;

    document.body.appendChild(wrapper);

    // Close button event listener
    document.getElementById('zaim-sidebar-close-btn')?.addEventListener('click', () => {
      wrapper.classList.remove('open');
    });
  }

  // Initialize script
  function init() {
    // Only target moneyforward cf page
    if (!window.location.pathname.startsWith('/cf')) return;

    // Inject sidebar base DOM frame
    injectSidebarHTML();

    // Inject trigger button
    injectFloatingButton();

    // Bind registration execution button
    document.getElementById('zaim-sync-btn')?.addEventListener('click', startZaimSynchronization);

    // Watch for DOM changes (in case transactions are reloaded asynchronously via AJAX on month change)
    const observer = new MutationObserver(() => {
      injectFloatingButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Execute
  init();
})();
