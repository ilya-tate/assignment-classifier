export function serverSettings(value = {}) {
  const url = new URL(value.url || 'http://localhost:8787');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter only the server origin, without a path or credentials.');
  const local = url.hostname === 'localhost' && url.port === '8787';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS for a hosted server.');
  const accessKey = (value.accessKey || '').trim();
  if (!local && accessKey.length < 32) throw new Error('Enter the server access key (at least 32 characters).');
  return {url: url.origin, accessKey};
}
