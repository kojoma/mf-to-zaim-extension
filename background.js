// background.js - Money Forward to Zaim Syncer Background Service Worker

// Helper: RFC 3986 compliant encoding
function rfc3986Encode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Helper: Generate random 32-char nonce
function generateNonce() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

// Helper: Generate timestamp in seconds
function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

// Helper: Sign base string using Web Crypto API
async function calculateHmacSha1(key, message) {
  const encoder = new TextEncoder();
  const keyBuffer = encoder.encode(key);
  const messageBuffer = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    messageBuffer
  );

  // Convert signature Buffer to Base64
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

// Core OAuth 1.0a request signer & fetcher
async function zaimApiRequest(method, endpoint, requestParams = {}) {
  // Retrieve Zaim credentials from chrome.storage.local
  const data = await chrome.storage.local.get(['credentials']);
  if (!data.credentials || !data.credentials.consumerKey || !data.credentials.consumerSecret || !data.credentials.accessToken || !data.credentials.accessTokenSecret) {
    throw new Error('Zaim APIの認証情報が設定されていません。拡張機能のオプション画面で設定してください。');
  }

  const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = data.credentials;
  const baseUrl = `https://api.zaim.net/v2/${endpoint}`;

  // 1. Gather OAuth parameters
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: generateTimestamp(),
    oauth_token: accessToken,
    oauth_version: '1.0'
  };

  // 2. Combine OAuth parameters with request parameters for signature calculation
  // (In OAuth 1.0a, GET query params or POST x-www-form-urlencoded params are part of the signature)
  const allParams = { ...oauthParams, ...requestParams };

  // 3. Sort parameters alphabetically by key and percent-encode keys/values
  const sortedKeys = Object.keys(allParams).sort();
  const paramPairStrings = sortedKeys.map(key => {
    return `${rfc3986Encode(key)}=${rfc3986Encode(allParams[key].toString())}`;
  });
  const normalizedParamString = paramPairStrings.join('&');

  // 4. Construct Signature Base String
  const signatureBaseString = [
    method.toUpperCase(),
    rfc3986Encode(baseUrl),
    rfc3986Encode(normalizedParamString)
  ].join('&');

  // 5. Construct Signing Key
  const signingKey = [
    rfc3986Encode(consumerSecret),
    rfc3986Encode(accessTokenSecret)
  ].join('&');

  // 6. Calculate OAuth signature
  const oauthSignature = await calculateHmacSha1(signingKey, signatureBaseString);

  // 7. Add signature to OAuth parameters
  oauthParams.oauth_signature = oauthSignature;

  // 8. Build Authorization Header
  const authHeaderComponents = Object.keys(oauthParams).sort().map(key => {
    return `${rfc3986Encode(key)}="${rfc3986Encode(oauthParams[key])}"`;
  });
  const authorizationHeader = `OAuth ${authHeaderComponents.join(', ')}`;

  // 9. Prepare request options
  const headers = {
    'Authorization': authorizationHeader,
  };

  let fetchUrl = baseUrl;
  const fetchOptions = {
    method: method.toUpperCase(),
    headers: headers
  };

  if (method.toUpperCase() === 'GET') {
    // For GET, request parameters go to the URL query string
    const queryComponents = Object.keys(requestParams).map(key => {
      return `${rfc3986Encode(key)}=${rfc3986Encode(requestParams[key].toString())}`;
    });
    if (queryComponents.length > 0) {
      fetchUrl += `?${queryComponents.join('&')}`;
    }
  } else if (method.toUpperCase() === 'POST') {
    // For POST, request parameters go to the request body as x-www-form-urlencoded
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const bodyComponents = Object.keys(requestParams).map(key => {
      return `${rfc3986Encode(key)}=${rfc3986Encode(requestParams[key].toString())}`;
    });
    fetchOptions.body = bodyComponents.join('&');
  }

  // 10. Perform the fetch request
  const response = await fetch(fetchUrl, fetchOptions);
  const responseText = await response.text();

  if (!response.ok) {
    let errorMessage = `Zaim APIエラー (${response.status}): ${responseText}`;
    try {
      const errorJson = JSON.parse(responseText);
      if (errorJson.error) errorMessage = errorJson.error;
      else if (errorJson.errors && errorJson.errors.message) errorMessage = errorJson.errors.message;
    } catch (e) {
      // Ignored
    }
    throw new Error(errorMessage);
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    return { success: true, raw: responseText };
  }
}

// Temporarily save request token secrets in memory
let tempOAuthSecrets = {};

// Listen for messages from Content Script and Options Page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    try {
      let result;
      switch (message.type) {
        case 'startOAuth': {
          const { consumerKey, consumerSecret } = message.payload;
          const baseUrl = 'https://api.zaim.net/v2/auth/request';
          const oauthCallback = 'http://localhost/';
          
          const oauthParams = {
            oauth_callback: oauthCallback,
            oauth_consumer_key: consumerKey,
            oauth_nonce: generateNonce(),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: generateTimestamp(),
            oauth_version: '1.0'
          };
          
          const sortedKeys = Object.keys(oauthParams).sort();
          const paramPairStrings = sortedKeys.map(key => {
            return `${rfc3986Encode(key)}=${rfc3986Encode(oauthParams[key].toString())}`;
          });
          const normalizedParamString = paramPairStrings.join('&');
          
          const signatureBaseString = [
            'POST',
            rfc3986Encode(baseUrl),
            rfc3986Encode(normalizedParamString)
          ].join('&');
          
          const signingKey = rfc3986Encode(consumerSecret) + '&'; // empty token secret
          const oauthSignature = await calculateHmacSha1(signingKey, signatureBaseString);
          oauthParams.oauth_signature = oauthSignature;
          
          const authHeaderComponents = Object.keys(oauthParams).sort().map(key => {
            return `${rfc3986Encode(key)}="${rfc3986Encode(oauthParams[key])}"`;
          });
          const authorizationHeader = `OAuth ${authHeaderComponents.join(', ')}`;
          
          const response = await fetch(baseUrl, {
            method: 'POST',
            headers: {
              'Authorization': authorizationHeader,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          
          const text = await response.text();
          if (!response.ok) {
            throw new Error(`Zaim Request Token取得失敗 (${response.status}): ${text}`);
          }
          
          const params = new URLSearchParams(text);
          const requestToken = params.get('oauth_token');
          const requestTokenSecret = params.get('oauth_token_secret');
          
          if (!requestToken || !requestTokenSecret) {
            throw new Error(`レスポンスのパースに失敗しました: ${text}`);
          }
          
          // Save the request token secret temporarily
          tempOAuthSecrets[requestToken] = {
            consumerKey,
            consumerSecret,
            requestTokenSecret
          };
          
          return {
            success: true,
            requestToken,
            authUrl: `https://auth.zaim.net/users/auth?oauth_token=${requestToken}`
          };
        }

        case 'completeOAuth': {
          const { requestToken, verifier } = message.payload;
          const secretInfo = tempOAuthSecrets[requestToken];
          if (!secretInfo) {
            throw new Error('認証セッションの期限が切れているか、見つかりません。最初からやり直してください。');
          }
          
          const { consumerKey, consumerSecret, requestTokenSecret } = secretInfo;
          const baseUrl = 'https://api.zaim.net/v2/auth/access';
          
          const oauthParams = {
            oauth_consumer_key: consumerKey,
            oauth_nonce: generateNonce(),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: generateTimestamp(),
            oauth_token: requestToken,
            oauth_version: '1.0',
            oauth_verifier: verifier
          };
          
          const sortedKeys = Object.keys(oauthParams).sort();
          const paramPairStrings = sortedKeys.map(key => {
            return `${rfc3986Encode(key)}=${rfc3986Encode(oauthParams[key].toString())}`;
          });
          const normalizedParamString = paramPairStrings.join('&');
          
          const signatureBaseString = [
            'POST',
            rfc3986Encode(baseUrl),
            rfc3986Encode(normalizedParamString)
          ].join('&');
          
          const signingKey = [
            rfc3986Encode(consumerSecret),
            rfc3986Encode(requestTokenSecret)
          ].join('&');
          
          const oauthSignature = await calculateHmacSha1(signingKey, signatureBaseString);
          oauthParams.oauth_signature = oauthSignature;
          
          const authHeaderComponents = Object.keys(oauthParams).sort().map(key => {
            return `${rfc3986Encode(key)}="${rfc3986Encode(oauthParams[key])}"`;
          });
          const authorizationHeader = `OAuth ${authHeaderComponents.join(', ')}`;
          
          const response = await fetch(baseUrl, {
            method: 'POST',
            headers: {
              'Authorization': authorizationHeader,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          
          const text = await response.text();
          if (!response.ok) {
            throw new Error(`Zaim Access Token取得失敗 (${response.status}): ${text}`);
          }
          
          const params = new URLSearchParams(text);
          const accessToken = params.get('oauth_token');
          const accessTokenSecret = params.get('oauth_token_secret');
          
          if (!accessToken || !accessTokenSecret) {
            throw new Error(`アクセスキーの取得に失敗しました: ${text}`);
          }
          
          // Clean up temp session
          delete tempOAuthSecrets[requestToken];
          
          return {
            success: true,
            accessToken,
            accessTokenSecret
          };
        }

        case 'testCredentials':
          // Attempt to fetch categories to verify credentials
          result = await zaimApiRequest('GET', 'home/category', { limit: 1 });
          return { success: true, result };

        case 'fetchCategories':
          result = await zaimApiRequest('GET', 'home/category');
          return { success: true, categories: result.categories || [] };

        case 'fetchGenres':
          result = await zaimApiRequest('GET', 'home/genre');
          return { success: true, genres: result.genres || [] };

        case 'fetchAccounts':
          result = await zaimApiRequest('GET', 'home/account');
          return { success: true, accounts: result.accounts || [] };

        case 'registerExpense':
          // Expecting payment parameters: category_id, genre_id, amount, date, from_account_id, comment
          result = await zaimApiRequest('POST', 'home/money/payment', message.payload);
          return { success: true, result };

        case 'registerIncome':
          // Expecting income parameters: category_id, amount, date, to_account_id, comment
          result = await zaimApiRequest('POST', 'home/money/income', message.payload);
          return { success: true, result };

        default:
          throw new Error(`不明なメッセージタイプ: ${message.type}`);
      }
    } catch (error) {
      console.error('Zaim API Request Failed:', error);
      return { success: false, error: error.message };
    }
  };

  // Execute asynchronously and reply using sendResponse
  handleMessage().then(sendResponse);
  return true; // Keep message channel open for async response
});

