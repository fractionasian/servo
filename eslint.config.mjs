// Minimal lint gate — catches undefined-reference bugs (valid syntax, undefined
// at runtime, only throws on a specific code path). scripts/lint.sh concatenates
// the app's classic <script>s into one scope (as index.html loads them) and runs
// no-undef on the bundle, so cross-file globals resolve and only genuine
// undefined references are flagged. sw.js is linted separately in its
// service-worker scope. (Transplanted from legwork's gate — same vanilla-PWA
// hazard.)
function readonly(names) {
  const o = {};
  names.forEach((n) => { o[n] = "readonly"; });
  return o;
}

const browser = readonly([
  "window", "document", "navigator", "console", "fetch", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "localStorage", "indexedDB",
  "location", "history", "URL", "URLSearchParams", "Blob", "FileReader",
  "requestAnimationFrame", "cancelAnimationFrame", "performance", "screen",
  "matchMedia", "btoa", "atob", "alert", "confirm", "prompt", "Headers",
  "Response", "Request", "XMLHttpRequest", "CustomEvent", "Event", "MouseEvent",
  "getComputedStyle", "DOMParser", "AbortController", "createImageBitmap",
  "ImageData", "OffscreenCanvas", "TextEncoder", "TextDecoder",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "module",  // CommonJS test-export shim
  "L",       // Leaflet (CDN)
]);

const serviceWorker = readonly([
  "self", "caches", "clients", "registration", "skipWaiting", "importScripts",
  "addEventListener", "fetch", "Response", "Request", "Headers", "URL",
  "URLSearchParams", "location", "console", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Blob", "TextEncoder", "TextDecoder",
  "createImageBitmap", "atob", "btoa",
]);

export default [
  {
    files: [".eslint-bundle.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browser },
    rules: { "no-undef": "error" },
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: serviceWorker },
    rules: { "no-undef": "error" },
  },
];
