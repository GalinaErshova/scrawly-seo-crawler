import { t } from '../i18n.js';
// Public audit window — the anonymous, URL-only front door. Enter any URL, we
// fingerprint the stack, auto-apply the matching preset, let the user tweak a
// few knobs, then run the same deep read-only audit the connected app runs
// (minus the fix/agentic layer). Competes with Screaming Frog / Sitebulb, but
// zero install and zero config.

import { authorizeCrawl, isFree } from '../edition.js';
import { formatCrawlProgress, isPartialCrawl } from './crawl-console.js';

const STACK_META = {
  wordpress: { icon: '🅆', color: '#21759b', label: 'WordPress' },
  shopify: { icon: '🛍', color: '#95bf47', label: 'Shopify' },
  wix: { icon: '◆', color: '#0c6efc', label: 'Wix' },
  squarespace: { icon: '⬛', color: '#111111', label: 'Squarespace' },
  webflow: { icon: '▶', color: '#4353ff', label: 'Webflow' },
  framer: { icon: '✦', color: '#0055ff', label: 'Framer' },
  nextjs: { icon: '▲', color: '#000000', label: 'Next.js' },
  react: { icon: '⚛', color: '#61dafb', label: 'React' },
  laravel: { icon: '⛑', color: '#ff2d20', label: 'Laravel' },
  drupal: { icon: '💧', color: '#0678be', label: 'Drupal' },
  joomla: { icon: 'J', color: '#f44321', label: 'Joomla' },
  magento: { icon: 'M', color: '#ee672f', label: 'Magento' },
  ghost: { icon: '👻', color: '#15171a', label: 'Ghost' },
  generic: { icon: '🌐', color: '#6b7280', label: t("Custom / Unknown") },
};

const meta = (s) => STACK_META[s] || STACK_META.generic;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Unwrap a FastAPI error body so the user sees the real reason: `detail` may be a
// plain string or a {code, message} object. Without this, an object detail
// stringifies to a useless "[object Object]".
const errMsg = (body, fallback) => {
  const d = body && body.detail;
  if (typeof d === 'string') return t(d);
  if (d && typeof d.message === 'string') return t(d.message);
  return fallback;
};

// Map a 0-100 health score to a label + theme-aware colour var, mirroring the
// dashboard's grade bands. Null when there's no score (still running).
const gradeInfo = (score) => {
  if (score == null) return null;
  if (score >= 75) return { label: score >= 90 ? t("Excellent") : t("Good"), v: '--color-passed' };
  if (score >= 50) return { label: t("Needs work"), v: '--color-warning' };
  return { label: score >= 25 ? t("Poor") : t("Critical"), v: '--color-critical' };
};

export class PublicAudit {
  constructor(container, apiBase, { onAuditStarted, onOpenLatest, onResume } = {}) {
    this.el = container;
    this.api = apiBase;
    this.onAuditStarted = onAuditStarted || (() => {});
    // Re-open the persisted latest audit (survives navigating away / restart).
    this.onOpenLatest = onOpenLatest || (() => {});
    this.onResume = onResume || (() => {});
    this.detection = null;
    this.preset = null;
    this._shell();
  }

  _shell() {
    this.el.innerHTML = `
      <div class="pa-wrap">
        <div class="pa-latest" hidden></div>
        <div class="pa-hero">
          <div class="scrawly-wordmark pa-wordmark">
            <svg class="scrawly-mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scrawly">
              <defs><linearGradient id="sgGradHero" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs>
              <rect class="sg-tile" x="1.75" y="1.75" width="28.5" height="28.5" rx="8.5" stroke="url(#sgGradHero)" stroke-width="1.5"/>
              <path class="sg-path" d="M22 8 L11 13 L21 19 L10 24" stroke="url(#sgGradHero)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
              <circle class="sg-node sg-n1" cx="22" cy="8" r="2.6"/><circle class="sg-node sg-n2" cx="11" cy="13" r="2.6"/>
              <circle class="sg-node sg-n3" cx="21" cy="19" r="2.6"/><circle class="sg-node sg-n4" cx="10" cy="24" r="2.6"/>
            </svg>
            <span class="wm-text">Scrawly</span>
          </div>
          <h1 class="pa-title">${t("Deep technical audit for")} <span class="pa-accent">${t("any website")}</span></h1>
          <p class="pa-sub">${t("Enter any web address. Scrawly finds your pages, checks each one for over 250 SEO and AI-readiness issues, and shows you what to fix. Free, with no sign-up and no page limits.")}</p>
          <form class="pa-form" autocomplete="off">
            <div class="pa-input-wrap">
              <span class="pa-input-ico">🔍</span>
              <input class="pa-input" type="text" name="url" placeholder="${t("yourwebsite.com")}" spellcheck="false" />
            </div>
            <button class="pa-go" type="submit">${t("Analyze")}</button>
          </form>
          <div class="pa-examples">
            ${t("Try:")} <button class="pa-ex" data-u="https://vercel.com">vercel.com</button>
            <button class="pa-ex" data-u="https://www.smashingmagazine.com">smashingmagazine.com</button>
          </div>
        </div>
        <div class="pa-result" hidden></div>
        <div class="pa-features-head">${t("What you get in one scan")}</div>
        <div class="pa-features">
          <div class="pa-feat"><span class="pa-feat-ico">🧭</span><b>${t("See your whole site")}</b><i>${t("We find your pages and map how they link together, so the structure is clear at a glance.")}</i></div>
          <div class="pa-feat"><span class="pa-feat-ico">🔍</span><b>${t("250+ checks per page")}</b><i>${t("We look at what shapes rankings: indexing, titles, links, speed, structured data and more.")}</i></div>
          <div class="pa-feat"><span class="pa-feat-ico">🤖</span><b>${t("Ready for AI search")}</b><i>${t("See how AI assistants and search bots read your site, so you show up when people ask them.")}</i></div>
          <div class="pa-feat"><span class="pa-feat-ico">⚡</span><b>${t("Nothing to set up")}</b><i>${t("Scrawly spots your platform and picks the right settings for you, automatically.")}</i></div>
        </div>
      </div>`;

    this.form = this.el.querySelector('.pa-form');
    this.input = this.el.querySelector('.pa-input');
    this.resultEl = this.el.querySelector('.pa-result');
    this.latestEl = this.el.querySelector('.pa-latest');
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this._analyze(); });
    this.el.querySelectorAll('.pa-ex').forEach((b) =>
      b.addEventListener('click', () => { this.input.value = b.dataset.u; this._analyze(); }));
    this.refresh();
  }

  // Show a persistent "your latest audit" card so the read-only audit is always
  // reachable after the user navigates to other parts of the app (or restarts).
  // Retention keeps exactly one, so this is always the newest run. Called on
  // mount, when the public window is opened, and after an audit completes.
  async refresh() {
    if (!this.latestEl) return;
    let latest = null;
    try {
      // no-store: the card must always reflect the current latest audit, never a
      // browser-cached earlier one.
      const r = await fetch(`${this.api}/public/latest`, { cache: 'no-store' });
      if (r.ok) latest = await r.json();
    } catch { /* offline → just hide the card */ }
    if (!latest || latest.crawl_id == null) { this.latestEl.hidden = true; return; }
    this._latest = latest;
    const host = esc(latest.host || latest.url || t("your last audit"));
    const partial = isPartialCrawl(latest) || latest.running;
    const pages = formatCrawlProgress(latest);
    const when = latest.started_at ? this._ago(latest.started_at) : '';
    const g = partial ? null : gradeInfo(latest.health_score);
    // Grade leads the meta line ("Good · 3 pages · 2 min ago") — the headline
    // result at a glance, before you even open the report.
    const meta = [g && g.label, pages, when].filter(Boolean).join(' · ');
    const badge = g
      ? `<div class="pa-latest-score" style="--g: var(${g.v})">${latest.health_score}</div>`
      : `<div class="pa-latest-ico">📄</div>`;
    this.latestEl.hidden = false;
    this.latestEl.innerHTML = latest.running
      ? `<div class="pa-latest-card pa-latest-live">
           <span class="pa-spin"></span>
           <div class="pa-latest-body"><b>${t("Auditing {host}…", { host })}</b>
             <span class="pa-latest-meta">${esc(pages)}</span></div>
           ${latest.url_count ? `<button class="pa-latest-open" type="button">${t("View saved pages")}</button>` : ''}
         </div>`
      : `<div class="pa-latest-card pa-latest-clickable"
              title="${partial ? t("Open saved pages") : t("Open this audit’s report")}">
           ${badge}
           <div class="pa-latest-body">
             <b>${partial ? t("Interrupted audit") : t("Your latest audit")} · ${host}</b>
             <span class="pa-latest-meta">${esc(meta) || t("Read-only report")}</span>
           </div>
           <button class="pa-latest-open" type="button">${partial ? t("View saved pages") : t("View report →")}</button>
           ${latest.resumable ? `<button class="btn btn-primary pa-latest-resume" type="button">${t("Resume audit")}</button>` : ''}
           <button class="pa-latest-del" type="button" title="${t("Delete this audit")}" aria-label="${t("Delete this audit")}">✕</button>
         </div>`;
    const openResult = () => this.onOpenLatest(latest.crawl_id, latest.url, partial);
    // The whole card is a big click target; the buttons inside still work.
    const card = this.latestEl.querySelector('.pa-latest-clickable');
    card?.addEventListener('click', (event) => {
      if (!event.target.closest('button')) openResult();
    });
    const open = this.latestEl.querySelector('.pa-latest-open');
    if (open) open.addEventListener('click', openResult);
    this.latestEl.querySelector('.pa-latest-resume')?.addEventListener('click', (event) =>
      this.onResume(latest.crawl_id, latest.url, event.currentTarget));
    const del = this.latestEl.querySelector('.pa-latest-del');
    if (del) del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteLatest(latest.crawl_id); });
  }

  async _deleteLatest(crawlId) {
    if (!confirm(t("Delete this audit and its report? This cannot be undone."))) return;
    try { await fetch(`${this.api}/crawls/${crawlId}`, { method: 'DELETE' }); }
    catch { /* best effort */ }
    this.refresh();
  }

  _ago(iso) {
    // The API emits naive UTC timestamps; without a zone marker Date.parse reads
    // them as local time and the "x ago" is off by the offset. Force UTC.
    if (iso && !/[Zz]|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z';
    const timestamp = Date.parse(iso);
    if (Number.isNaN(timestamp)) return '';
    const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (s < 60) return t("just now");
    if (s < 3600) return t("{count} min ago", { count: Math.floor(s / 60) });
    if (s < 86400) return t("{count} h ago", { count: Math.floor(s / 3600) });
    return t("{count} d ago", { count: Math.floor(s / 86400) });
  }

  // Pre-fill an address and check it (used by Re-crawl on a public audit).
  prefill(url) {
    this.input.value = url || '';
    if (url) this._analyze();
  }

  async _analyze() {
    const url = this.input.value.trim();
    if (!url) { this.input.focus(); return; }
    // Only the newest check may render: a slow earlier one must not win.
    const seq = (this._analyzeSeq = (this._analyzeSeq || 0) + 1);
    this.resultEl.hidden = false;
    this.resultEl.innerHTML = `<div class="pa-detecting">
      <span class="pa-spin"></span> ${t("Checking")} <b>${esc(url)}</b>…</div>`;
    this.resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const r = await fetch(`${this.api}/detect?url=${encodeURIComponent(url)}`);
      if (!r.ok) throw new Error(errMsg(await r.json().catch(() => ({})), ''));
      const data = await r.json();
      if (seq !== this._analyzeSeq) return;
      this.detection = data.detection;
      this.preset = data.preset;
      this.targetUrl = data.url;
      this._renderResult();
    } catch (e) {
      if (seq !== this._analyzeSeq) return;
      if (e && e.message) console.warn('[scrawly] site check failed:', e.message);
      this.resultEl.innerHTML = `<div class="pa-error">${t("Couldn't reach that address. Check that it's spelled correctly and the site is online, then try again.")}</div>`;
    }
  }

  _renderResult() {
    const d = this.detection, p = this.preset, m = meta(d.stack);
    const conf = Math.round((d.confidence || 0) * 100);
    const subLabel = p.subcategory_label ? ` · ${esc(t(p.subcategory_label))}` : '';
    const cfg = p.config || {};
    const facts = [
      d.generator && t("Generator: {value}", { value: esc(d.generator) }),
      d.server && t("Server: {value}", { value: esc(d.server) }),
      d.powered_by && t("Powered by: {value}", { value: esc(d.powered_by) }),
    ].filter(Boolean);

    this.resultEl.innerHTML = `
      <div class="pa-card">
        <div class="pa-det">
          <div class="pa-det-badge" style="--sc:${m.color}"><span>${m.icon}</span></div>
          <div class="pa-det-body">
            <div class="pa-det-top">
              <span class="pa-det-stack">${esc(t(p.label))}${subLabel}</span>
              <span class="pa-det-conf" title="${t("Detection confidence")}">${t("{count}% match", { count: conf })}</span>
            </div>
            <div class="pa-conf-bar"><i style="width:${conf}%;background:${m.color}"></i></div>
            <div class="pa-det-url mono">${esc(this.targetUrl)}</div>
            ${facts.length ? `<div class="pa-det-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
          </div>
        </div>

        <details class="pa-custom">
          <summary>${t("Settings")} <span class="pa-preset-note">${t("picked for you, change if you like")}</span></summary>
          <div class="pa-opts">
            <label class="pa-opt"><span>${t("Pages to check")}</span>
              <input type="number" data-k="max_pages" value="200" min="1" max="${isFree() ? 100000 : 500}"></label>
            <label class="pa-opt"><span>${t("Pages at a time")}</span>
              <input type="number" data-k="concurrency" value="8" min="1" max="20"></label>
            <label class="pa-opt pa-check"><input type="checkbox" data-k="js_render" ${cfg.js_render ? 'checked' : ''}>
              <span>${t("Load JavaScript")}</span></label>
            <label class="pa-opt pa-check"><input type="checkbox" data-k="respect_robots" checked>
              <span>${t("Follow robots.txt rules")}</span></label>
            <label class="pa-opt pa-check"><input type="checkbox" data-k="discover_sitemap" checked>
              <span>${t("Find pages from the sitemap")}</span></label>
            <label class="pa-opt pa-check"><input type="checkbox" data-k="sitemap_only">
              <span>${t("Only check sitemap pages")}</span></label>
            <label class="pa-opt pa-wide"><span>${t("Skip web addresses that contain")}</span>
              <input type="text" data-k="exclude_patterns" class="mono" value="${esc(cfg.exclude_patterns || '')}"></label>
          </div>
        </details>

        <div class="pa-actions">
          <button class="pa-start">${t("Start the audit")}</button>
          <span class="pa-actions-note">${t("We only read your pages. Nothing on your site is changed.")}</span>
        </div>
      </div>`;

    this.resultEl.querySelector('.pa-start').addEventListener('click', () => this._start());
  }

  _readConfig() {
    const cfg = { url: this.targetUrl, stack: this.detection.stack, subcategory: this.detection.subcategory };
    this.resultEl.querySelectorAll('[data-k]').forEach((n) => {
      const k = n.dataset.k;
      if (n.type === 'checkbox') cfg[k] = n.checked;
      else if (n.type === 'number') cfg[k] = Number(n.value);
      else cfg[k] = n.value;
    });
    return cfg;
  }

  async _start() {
    const btn = this.resultEl.querySelector('.pa-start');
    btn.disabled = true;
    btn.textContent = t("Starting…");
    try {
      const authz = await authorizeCrawl();
      if (authz.allowed === false) {
        throw new Error(authz.message ? t(authz.message) : t("This audit cannot start right now."));
      }
      const headers = { 'Content-Type': 'application/json' };
      if (authz.token) headers['X-Scrawly-Authz'] = authz.token;
      const r = await fetch(`${this.api}/public/audit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this._readConfig()),
      });
      if (!r.ok) throw new Error(errMsg(await r.json().catch(() => ({})), t("Could not start the audit.")));
      const { crawl_id } = await r.json();
      // Reset the detection panel so the window doesn't keep showing a stale
      // "Starting..." state after we hand off to the live audit and the card.
      this.resultEl.hidden = true;
      this.resultEl.innerHTML = '';
      this.input.value = '';
      this.detection = null;
      this.onAuditStarted(crawl_id, this.targetUrl);
      this.refresh();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t("Start the audit");
      const note = this.resultEl.querySelector('.pa-actions-note');
      if (note) { note.textContent = e.message; note.classList.add('pa-err-note'); }
    }
  }
}
