// Icons. Each is drawn in the colour of the text around it.
import { html, raw } from '../html.js';

const LINE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const svg = (paths, size = 16, paint = LINE) => html`<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${raw(paint)} aria-hidden="true">${paths}</svg>`;
const PATHS = {
  menu: html`<path d="M4 7h16M4 12h16M4 17h16"/>`,
  close: html`<path d="M6 6l12 12M18 6L6 18"/>`,
  down: html`<path d="M6 9l6 6 6-6"/>`,
  right: html`<path d="M9 6l6 6-6 6"/>`,
  left: html`<path d="M15 6l-6 6 6 6"/>`,
  plus: html`<path d="M12 5v14M5 12h14"/>`,
  minus: html`<path d="M5 12h14"/>`,
  grow: html`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
  shrink: html`<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>`,
  vision: html`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
  think: html`<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>`,
  tools: html`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
  kv: html`<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>`,
  gpu: html`<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>`,
};
export const Icon = (name, size) => svg(PATHS[name], size);
export const Grip = svg(html`<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>`, 14, 'fill="currentColor"');
// The app's mark.
export const Dove = html`<svg class="dove" viewBox="0 0 75.7 100" aria-hidden="true"><path fill="currentColor" d="M48.7 71.9L48.2 71.5L45.5 71.7L41.0 73.4L35.8 76.1L32.9 78.0L30.5 80.2L26.6 85.8L23.9 88.2L19.9 89.6L13.8 90.5L11.1 91.5L9.9 92.9L9.9 94.2L10.4 95.1L11.9 96.9L13.2 97.8L17.1 99.5L19.3 99.9L21.9 99.9L24.0 99.5L25.6 98.8L27.4 97.5L30.0 94.5L35.0 85.6L38.2 81.0L41.4 78.1L48.3 73.2L48.8 72.5ZM14.8 28.7L14.0 29.3L13.4 31.2L13.4 33.5L14.0 36.8L16.5 43.7L18.5 47.7L20.1 50.2L23.6 53.7L29.4 58.0L35.1 60.9L36.8 61.2L37.9 61.0L38.6 59.4L37.6 57.8L29.4 53.2L28.5 52.1L28.5 50.9L29.3 50.1L30.1 49.8L36.4 49.8L37.6 49.3L37.6 48.3L30.3 43.4L26.4 39.7L24.2 37.1L20.4 30.8L19.4 29.6L17.7 28.5L16.0 28.3ZM23.2 0.0L21.7 0.3L19.5 2.4L17.7 5.3L16.0 9.8L15.3 13.2L15.3 18.0L16.0 21.1L17.2 24.2L20.3 28.7L22.9 31.2L26.1 33.5L32.9 36.9L42.1 39.8L45.1 41.5L47.1 43.1L50.5 46.8L53.1 51.1L54.2 54.9L54.0 57.8L52.9 60.4L51.0 62.5L49.1 63.8L46.7 65.0L43.1 66.0L16.7 71.7L10.7 73.7L6.6 75.6L3.0 78.1L1.5 79.8L0.0 82.2L0.0 84.0L0.4 84.7L2.2 86.0L4.2 86.8L8.5 87.4L13.3 87.4L17.0 87.0L20.1 86.1L21.9 85.2L22.6 84.3L22.6 83.6L22.2 82.9L20.3 81.1L20.1 79.5L21.4 78.0L23.6 76.6L28.2 74.7L33.1 73.2L50.8 69.3L55.7 67.5L60.3 65.3L64.0 62.8L67.8 59.1L70.5 54.7L71.4 52.8L72.5 48.7L72.7 39.8L73.5 36.1L75.6 32.7L73.2 33.3L71.7 32.4L69.8 32.2L67.1 33.2L65.3 34.6L61.3 40.7L60.4 41.6L59.1 42.3L58.5 43.1L58.9 44.3L60.8 47.5L61.2 49.6L60.9 51.9L59.8 55.5L58.8 57.5L58.0 58.0L57.8 56.6L58.3 54.6L58.0 49.1L57.0 44.9L55.0 40.5L52.9 37.4L49.9 34.5L47.1 32.7L42.9 30.5L38.7 26.2L34.4 19.8L25.8 3.0L24.5 1.1Z"/></svg>`;
