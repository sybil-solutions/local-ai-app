// How numbers, sizes and times are written.
export const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n || 0)));
export const count = (n) => n.toLocaleString('en-US');
export const ctxOf = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)}M` : n ? `${Math.round(n / 1024)}K` : '—');
export const gb = (mib) => Math.round(mib / 1024);
export const mins = (seconds) => Math.max(1, Math.round(seconds / 60));
export const ago = (when) => { const m = Math.round((Date.now() - new Date(when)) / 60000); return m < 1 ? 'Now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
// "Sep 2026" from a release date such as 2026-09-01.
export const monthOf = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
