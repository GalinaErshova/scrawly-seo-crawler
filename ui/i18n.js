import config from './locales/ru-config.js';
import audit from './locales/ru-audit.js';
import explorer from './locales/ru-explorer.js';
import shell from './locales/ru-shell.js';
import main from './locales/ru-main.js';

const KEY = 'scrawly-language';
const translated = { ...config, ...audit, ...explorer, ...shell, ...main };
const excluded = 'script, style, code, pre, [data-no-translate], [data-i18n-ignore]';

function readLanguage() {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

export const language = readLanguage();
export const locale = language === 'ru' ? 'ru-RU' : 'en';

export function saveLanguage(value) {
  if (value !== 'en' && value !== 'ru') return false;
  try {
    localStorage.setItem(KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function t(key, params = {}) {
  if (typeof key !== 'string') return key;
  const text = language === 'ru' && Object.hasOwn(translated, key) ? translated[key] : key;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
    (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

function translateText(text) {
  const key = text.trim().replace(/\s+/g, ' ');
  return Object.hasOwn(translated, key) ? text.replace(text.trim(), () => translated[key]) : text;
}

// For author-controlled static markup only. User-entered text and audit data
// must be rendered separately, with their original content.
export function localize(root) {
  if (!root || language !== 'ru') return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode;
    if (!node.parentElement?.closest(excluded)) {
      node.nodeValue = translateText(node.nodeValue);
    }
  }
  const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
  const selector = attributes.map(name => `[${name}]`).join(', ');
  const elements = [...root.querySelectorAll(selector)];
  if (root.matches?.(selector)) elements.unshift(root);
  for (const element of elements) {
    if (element.closest(excluded)) continue;
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value) element.setAttribute(name, translateText(value));
    }
  }
}
