// Lead capture. Interface + two implementations:
//  - FileLeadStore (default): appends JSONL to out/leads.jsonl. Works today,
//    no credentials, nothing external. The owner can import the file into a
//    Sheet at any time.
//  - WebhookLeadStore: POSTs each lead as JSON to LEADS_WEBHOOK_URL — the
//    cleanest Google Sheets wiring is a Google Apps Script "web app" bound to
//    the Sheet (doPost appends a row). Nothing is invented here: if the env
//    var is unset, the webhook store is not constructed.
// Every lead is ALSO written to the local file even when a webhook is set —
// a lost lead during launch week is unrecoverable, a duplicate is not.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileLeadStore {
  constructor({ path = 'out/leads.jsonl' } = {}) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  async append(lead) {
    appendFileSync(this.path, JSON.stringify(lead) + '\n');
    return { ok: true, store: 'file', path: this.path };
  }
}

export class WebhookLeadStore {
  constructor({ url, timeoutMs = 8000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
  async append(lead) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead) });
      return { ok: res.ok, store: 'webhook', status: res.status };
    } catch (err) {
      return { ok: false, store: 'webhook', error: String(err.message || err) };
    } finally { clearTimeout(timer); }
  }
}

export function createLeadStore(env = process.env) {
  const file = new FileLeadStore({});
  const webhook = env.LEADS_WEBHOOK_URL ? new WebhookLeadStore({ url: env.LEADS_WEBHOOK_URL }) : null;
  return {
    async append(lead) {
      const record = { ...lead, received_at: new Date().toISOString() };
      const fileRes = await file.append(record); // never lose a lead
      const hookRes = webhook ? await webhook.append(record) : { ok: false, store: 'webhook', skipped: 'LEADS_WEBHOOK_URL not set' };
      return { ok: fileRes.ok, file: fileRes, webhook: hookRes };
    },
  };
}
