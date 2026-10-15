/** A JSON call to an admin endpoint. Errors carry the HTTP status and the server's message. */
export async function adminFetch(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Upload-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 401 ? 'Phiên đăng nhập đã hết hạn.' : 'Máy chủ báo lỗi.';
    throw Object.assign(new Error(data.detail || fallback), { status: res.status });
  }
  return data;
}

/** The token stopped working (or uploads were switched off): sign out rather than retry. */
export const signedOut = (e) => e.status === 401 || e.status === 503;
