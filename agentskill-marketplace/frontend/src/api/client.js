// Thin fetch wrapper for the backend API.
// - prefixes every path with '/api' (Vite proxies '/api' -> http://localhost:4000)
// - attaches Authorization: Bearer <token> when a token is in localStorage
// - sets JSON content-type when sending a (non-FormData) body
// - parses the JSON response, throwing Error(message) on a non-ok status

export async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };

  const token = localStorage.getItem('token');
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let { body } = opts;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && body !== null && !isFormData && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, { ...opts, headers, body });

  // Some endpoints (e.g. download) may not return JSON; guard the parse.
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      (data && data.error) ||
      (data && data.message) ||
      (typeof data === 'string' && data) ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}
