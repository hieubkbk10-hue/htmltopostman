import { colors } from './utils.js';

export async function loginAdmin({
  baseUrl,
  email = 'admin@admin.com',
  password = 'admin',
  loginPath = '/v1/clients/web/login',
  timeout = 10000,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${loginPath}`;
  console.log(colors.cyan(`\n🔐 Authenticating at: ${url} with email: ${email}...`));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const errorMsg = (typeof data === 'object' && data !== null)
        ? (data.message || data.error || JSON.stringify(data))
        : String(data);
      console.warn(colors.yellow(`⚠️  Authentication failed (HTTP ${res.status}): ${errorMsg}`));
      return {
        success: false,
        status: res.status,
        error: errorMsg,
      };
    }

    // Extract Bearer token
    let token = '';
    if (typeof data === 'object' && data !== null) {
      token = data.access_token || data.token || data.data?.token || data.data?.access_token || '';
    }

    if (!token) {
      console.warn(colors.yellow('⚠️  Login succeeded but no access_token found in response body.'));
      return {
        success: false,
        status: res.status,
        error: 'No token in response',
        data,
      };
    }

    console.log(colors.green(`✅ Authentication successful! Token acquired.`));
    return {
      success: true,
      token,
      data,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err.name === 'AbortError' ? 'Request timed out' : err.message;
    console.warn(colors.yellow(`⚠️  Authentication network error: ${msg}`));
    return {
      success: false,
      error: msg,
    };
  }
}
