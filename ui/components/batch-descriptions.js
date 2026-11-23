import { t } from '../i18n.js';
import { esc } from './escape.js';

const errors = {
  ai_unconfigured: 'Set up an AI provider in Settings.',
  invalid_url: 'Enter a valid HTTP or HTTPS page URL.',
  page_unavailable: 'Could not open the page.',
  page_empty: 'The page has no readable HTML text.',
  description_failed: 'The AI provider could not generate a description.',
  description_empty: 'The AI provider returned an empty description.',
};

async function post(api, path, payload) {
  const response = await fetch(`${api}/serp/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const detail = data?.detail;
    const message = detail?.code === 'page_http_error'
      ? t('The page returned HTTP {status}.', { status: detail.status })
      : t(errors[detail?.code] || 'The request failed. Try again.');
    throw new Error(message, { cause: detail?.code });
  }
  return data;
}

export function mountBatchDescriptions(container, api) {
  container.innerHTML = `
    <h1>${t('Batch meta descriptions')}</h1>
    <div class="srp-card bmd-form">
      <div class="srp-field">
        <label for="batch-description-urls">${t('Page URLs (one per line)')}</label>
        <textarea id="batch-description-urls" class="srp-in" rows="6" spellcheck="false"></textarea>
      </div>
      <div class="srp-actions bmd-actions">
        <button class="btn btn-primary" type="button" data-action="generate" disabled>${t('Generate meta descriptions')}</button>
        <button class="btn btn-secondary" type="button" data-action="preview" disabled>${t('Preview snippets')}</button>
      </div>
      <p class="srp-note" role="status"></p>
    </div>
    <div class="bmd-drafts"></div>
    <div class="bmd-previews"></div>`;

  const urlsInput = container.querySelector('#batch-description-urls');
  const generate = container.querySelector('[data-action="generate"]');
  const preview = container.querySelector('[data-action="preview"]');
  const status = container.querySelector('[role="status"]');
  const drafts = container.querySelector('.bmd-drafts');
  const previews = container.querySelector('.bmd-previews');
  let busy = false;
  let results = [];

  const draftRows = () => results.filter(row => row.description?.trim());
  const updateControls = () => {
    generate.disabled = busy || !urlsInput.value.trim();
    preview.disabled = busy || !draftRows().length;
    urlsInput.disabled = busy;
    drafts.querySelectorAll('textarea').forEach(input => { input.disabled = busy; });
  };

  function renderDrafts() {
    drafts.innerHTML = results.map((row, index) => `
      <article class="srp-card">
        <div class="bmd-url mono">${esc(row.url)}</div>
        ${row.error ? `<p class="srp-note bad">${esc(row.error)}</p>` : `
          <div class="srp-field">
            <label for="batch-description-draft-${index}">${t('Description draft')}</label>
            <textarea class="srp-in" id="batch-description-draft-${index}" data-row="${index}" rows="3">${esc(row.description)}</textarea>
          </div>`}
      </article>`).join('');
  }

  urlsInput.addEventListener('input', updateControls);
  drafts.addEventListener('input', event => {
    const input = event.target;
    if (!input.matches('textarea[data-row]')) return;
    results[Number(input.dataset.row)].description = input.value;
    previews.replaceChildren();
    updateControls();
  });

  generate.addEventListener('click', async () => {
    const urls = [...new Set(urlsInput.value.split(/\r?\n/).map(url => url.trim()).filter(Boolean))];
    if (busy || !urls.length) return;
    busy = true;
    results = [];
    drafts.replaceChildren();
    previews.replaceChildren();
    updateControls();
    try {
      for (const [index, url] of urls.entries()) {
        status.textContent = t('Generating {current} of {total}…', { current: index + 1, total: urls.length });
        try {
          results.push(await post(api, 'description', { url }));
        } catch (error) {
          if (error.cause === 'ai_unconfigured') {
            status.textContent = error.message;
            return;
          }
          results.push({ url, error: error.message || t('The request failed. Try again.') });
        }
      }
      status.textContent = t('Drafts generated: {done} of {total}.', { done: draftRows().length, total: urls.length });
    } finally {
      renderDrafts();
      busy = false;
      updateControls();
    }
  });

  preview.addEventListener('click', async () => {
    const rows = draftRows();
    if (busy || !rows.length) return;
    busy = true;
    updateControls();
    status.textContent = '';
    try {
      const data = await post(api, 'preview', { rows });
      previews.innerHTML = `
        <h2>${t('Snippet preview')}</h2>
        ${data.rows.map(row => `
          <article class="srp-card">
            <div class="bmd-url mono">${esc(row.url)}</div>
            <div class="bmd-snippet">
              <div class="bmd-snippet-title">${esc(row.title || row.url)}</div>
              <div class="bmd-snippet-description">${esc(row.description)}</div>
            </div>
            <p class="srp-note${row.desc_truncated ? ' warn' : ''}">
              ${t('{count} characters', { count: row.desc_chars })} · ${row.desc_px}/${row.desc_limit_px} px
              ${row.desc_truncated ? ` · ${t('Google may shorten the description.')}` : ''}
            </p>
          </article>`).join('')}`;
      status.textContent = t('Previews ready: {count}.', { count: data.rows.length });
      previews.scrollIntoView({ block: 'start' });
    } catch (error) {
      status.textContent = error.message || t('Preview unavailable.');
    } finally {
      busy = false;
      updateControls();
    }
  });
}
