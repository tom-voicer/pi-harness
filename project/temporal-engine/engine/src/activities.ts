/**
 * Log a message (prints to worker stdout).
 */
export async function logActivity(message: string): Promise<string> {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
  console.log(line);
  return line;
}

/**
 * Make an HTTP request.
 */
export async function httpActivity(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; statusText: string; data: unknown }> {
  console.log(`[HTTP] ${method} ${url}`);

  const fetchHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: fetchHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    statusText: response.statusText,
    data,
  };
}
