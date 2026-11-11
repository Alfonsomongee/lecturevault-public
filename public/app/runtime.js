// Where the app is running. The dashboard talks to its local server; the friends' web (docs/, on Vercel) is
// the same app, read-only, built by `npm run export:web` with <html data-mode="static">: it reads JSON files
// (static-api.js) and never shows a control that would change data on the student's machine.
export const READ_ONLY = document.documentElement.dataset.mode === 'static';
