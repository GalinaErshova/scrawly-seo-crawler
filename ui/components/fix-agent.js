import { t } from '../i18n.js';
// fix-agent.js — the autonomous "Fix" agent controller.
//
// Clicking Fix dispatches an agent that fixes EVERY affected page for an issue.
// There is no form and no page selector. The button itself becomes the status
// surface (Analyzing → Fixing 3/6 → ✓ Fixed 6). When a decision is needed (e.g.
// writing to N live pages), the agent asks through the chat assistant with
// quick-reply options and waits for the answer before proceeding.

const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.8L18.7 9.6l-4.8 1.9L12 16.3l-1.9-4.8L5.3 9.6l4.8-1.9L12 3z"></path></svg>';
const pathOf = (u) => { try { return new URL(u).pathname || '/'; } catch { return u; } };

export class FixAgent {
  /**
   * @param {object} o
   * @param {string} o.apiBase
   * @param {import('./ai-assistant.js').AiAssistant} o.assistant
   * @param {(msg:string,type?:string)=>void} [o.toast]
   * @param {(issue:object, ev:object)=>void} [o.onDone] refresh hook
   */
  constructor({ apiBase, assistant, toast, onDone, onOverview }) {
    this.api = apiBase;
    this.assistant = assistant;
    this.toast = toast || (() => {});
    this.onDone = onDone;
    this.onOverview = onOverview;   // persisted overview with Undo (main.js)
    // Issues with a run in flight. Tracked here (not on the button) because the
    // Issues view rebuilds its buttons on every filter change, so a button flag
    // alone could let the same live WordPress write start twice.
    this._running = new Set();
  }

  /** Initial label for a fresh Fix button. */
  static buttonHtml() {
    return `${SPARK}<span>${t("Fix")}</span>`;
  }

  async run(issue, btn) {
    // Already fixed → clicking the "Fixed" chip shows an overview instead.
    if (btn.classList.contains('fx-done') && btn._fix) { this._overview(btn); return; }
    if (btn.dataset.busy === '1') return;
    if (this._running.has(issue.id)) {
      this.toast(t("Already working on this issue."), 'info');
      return;
    }
    this._running.add(issue.id);
    try {
      await this._run(issue, btn);
    } finally {
      this._running.delete(issue.id);
    }
  }

  async _run(issue, btn) {
    btn.dataset.busy = '1';
    this._state(btn, 'run', t("Analyzing…"));

    let plan;
    try {
      plan = await (await fetch(`${this.api}/fix/agent/plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: issue.id }),
      })).json();
    } catch {
      this._state(btn, 'err', t("Retry")); btn.dataset.busy = ''; return;
    }

    if (!plan.ok) {
      // Surface why the agent can't act — connection / AI / manual-only.
      this.toast(t(plan.error || "This issue can’t be auto-fixed."), 'error');
      if (plan.reason === 'no_ai' || plan.reason === 'no_wp') this.assistant.say(t(plan.error));
      this._reset(btn); btn.dataset.busy = ''; return;
    }

    if (plan.mode === 'guidance') {
      this.assistant.say(`**${plan.title}** - ${plan.recommendation}\n\n${t("This one needs a hands-on change; I’ve summarised what to do.")}`);
      this._reset(btn); btn.dataset.busy = ''; return;
    }

    // Confirm scope through the chat assistant when writing to live pages.
    let scope = 'all';
    if (plan.needs_confirm) {
      this._state(btn, 'wait', t("Waiting…"));
      const pages = plan.count === 1 ? 'page' : 'pages';
      const confirmation = t("I can auto-fix the **{label}** on **{count} {pages}** and write the change straight to WordPress. A rollback snapshot is saved first. How should I proceed?", {
        label: t(plan.label), count: plan.count, pages,
      });
      const options = (plan.options || []).map((option) => ({
        ...option,
        label: option.value === 'all'
          ? t("Fix all {count} {pages}", { count: plan.count, pages })
          : t(option.label),
      }));
      const choice = await this.assistant.ask(confirmation, options);
      if (!choice || choice === 'cancel') {
        this.assistant.say(t("No problem - I’ll leave that one for now."));
        this._reset(btn); btn.dataset.busy = ''; return;
      }
      scope = choice;
    }

    // Stream the run and turn the button into a live progress meter.
    let total = 0, done = 0, ended = false;
    const verb = plan.mode === 'apply' ? t("Fixing") : t("Analyzing");
    this._state(btn, 'run', t("Starting…"));
    try {
      await this._stream(issue.id, scope, plan.mode === 'apply', (ev) => {
        if (ev.stage === 'done' || ev.stage === 'error') ended = true;
        if (ev.stage === 'start') {
          total = ev.total; this._state(btn, 'run', `${verb} 0/${total}`);
        } else if (ev.stage === 'progress' && ev.state !== 'working') {
          done += 1; this._state(btn, 'run', `${verb} ${done}/${total}`);
        } else if (ev.stage === 'done') {
          this._finish(btn, plan, ev, issue);
        } else if (ev.stage === 'error') {
          this._state(btn, 'err', t("Retry"));
          this.toast(t("The fix could not be completed. Please try again."), 'error');
          if (ev.detail) console.warn('[scrawly] fix agent:', ev.detail);
        }
      });
      if (!ended) {   // the stream closed without a result
        this._state(btn, 'err', t("Retry"));
        this.toast(t("The fix stopped before finishing. Please try again."), 'error');
      }
    } catch {
      this._state(btn, 'err', t("Retry"));
      this.toast(t("The fix could not be started. Please try again."), 'error');
    }
    btn.dataset.busy = '';
  }

  _finish(btn, plan, ev, issue) {
    // Remember what was fixed so clicking the chip can show the overview.
    btn._fix = { label: plan.label, mode: plan.mode, applied: ev.applied, suggested: ev.suggested, results: ev.results || [] };
    btn._issue = issue;
    if (plan.mode === 'apply') {
      const label = t("✓ Fixed {count}", { count: ev.applied });
      const failures = ev.failed ? t("{count} failed", { count: ev.failed }) : '';
      this._state(btn, 'done', failures ? `${label} · ${failures}` : label);
      this.assistant.say(t(
        "✅ Done. I fixed the **{label}** on **{count} {pages}**{failures} and wrote each change to WordPress. A rollback snapshot was saved for every page: click the **Fixed** button to undo.",
        { label: t(plan.label), count: ev.applied, pages: ev.applied === 1 ? 'page' : 'pages',
          failures: ev.failed ? t(" ({count} couldn’t be written)", { count: ev.failed }) : '' },
      ));
    } else {
      const single = ev.suggested === 1;
      this._state(btn, 'done', t("✓ {count} {suggestions}", {
        count: ev.suggested, suggestions: single ? 'suggestion' : 'suggestions',
      }));
      const lines = (ev.results || []).slice(0, 8)
        .map((r) => `• \`${pathOf(r.url)}\` → ${r.value}`).join('\n');
      const summary = t("Here {verb} **{count}** suggested **{label}** {values}. These are content edits, so apply them in WordPress:", {
        verb: single ? 'is' : 'are', count: ev.suggested,
        label: t(plan.label), values: single ? 'value' : 'values',
      });
      this.assistant.say(`${summary}\n${lines}`);
    }
    if (this.onDone) this.onDone(issue, ev);
  }

  async _stream(issueId, scope, confirm, onEvent) {
    const res = await fetch(`${this.api}/fix/agent/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // confirm: the person approved writing to the live site (asked above).
      body: JSON.stringify({ issue_id: issueId, scope, confirm: !!confirm }),
    });
    if (!res.ok || !res.body) throw new Error(t("run failed"));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
      }
    }
  }

  // Show what was fixed (in the assistant) when the "Fixed" chip is clicked.
  _overview(btn) {
    const f = btn._fix;
    if (!f) return;
    // Applied fixes: show the saved record, which also offers Undo.
    if (f.mode === 'apply' && this.onOverview && btn._issue) { this.onOverview(btn._issue); return; }
    const lines = (f.results || []).slice(0, 20)
      .map((r) => `• \`${pathOf(r.url)}\` → ${r.value}`).join('\n');
    const summary = f.mode === 'apply'
      ? t("**Fixed by agent - {label}** · {count} {pages} written to WordPress (each with a rollback snapshot):", {
        label: t(f.label), count: f.applied, pages: f.applied === 1 ? 'page' : 'pages',
      })
      : t("**Suggested - {label}** · {count}:", { label: t(f.label), count: f.suggested });
    this.assistant.say(`${summary}\n${lines}`);
  }

  // ---- button state ----
  _state(btn, state, text) {
    btn.classList.remove('fx-run', 'fx-wait', 'fx-done', 'fx-err');
    btn.classList.add(`fx-${state === 'wait' ? 'wait' : state}`);
    const busy = state === 'run' || state === 'wait';
    btn.disabled = busy;   // 'done' and 'err' stay clickable
    if (state === 'done') btn.title = t("Click to see what the agent fixed");
    const spin = busy ? '<span class="fx-spin"></span>' : '';
    btn.innerHTML = `${spin}<span>${text}</span>`;
  }

  _reset(btn) {
    btn.classList.remove('fx-run', 'fx-wait', 'fx-done', 'fx-err');
    btn.disabled = false;
    btn.innerHTML = FixAgent.buttonHtml();
  }
}
