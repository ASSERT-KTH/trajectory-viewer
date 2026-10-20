/* Trajectory parsing: detects the input format and normalizes it to ATIF.
 * Supported inputs: ATIF JSON (any v1.x) and Claude Code session JSONL.
 * Works in the browser (window.Trajectory) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Trajectory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isAtif(obj) {
    return obj && typeof obj === 'object' && !Array.isArray(obj) && Array.isArray(obj.steps) &&
      (typeof obj.schema_version === 'string' && /^ATIF/i.test(obj.schema_version) || obj.agent);
  }

  function isClaudeCodeEntry(obj) {
    return obj && typeof obj === 'object' && typeof obj.type === 'string' &&
      ('sessionId' in obj || 'uuid' in obj || 'message' in obj || obj.type === 'summary');
  }

  /* Returns { format: 'atif' | 'claude-code', trajectory: <ATIF object> } or throws. */
  function parse(text) {
    text = text.replace(/^﻿/, '');
    let whole;
    try { whole = JSON.parse(text); } catch (e) { whole = undefined; }
    if (whole !== undefined) {
      if (isAtif(whole)) return { format: 'atif', trajectory: whole };
      if (Array.isArray(whole) && whole.some(isClaudeCodeEntry)) {
        return { format: 'claude-code', trajectory: claudeCodeToAtif(whole) };
      }
      if (isClaudeCodeEntry(whole)) return { format: 'claude-code', trajectory: claudeCodeToAtif([whole]) };
    }
    const entries = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch (e) { bad++; }
    }
    if (entries.length && entries.some(isClaudeCodeEntry)) {
      return { format: 'claude-code', trajectory: claudeCodeToAtif(entries) };
    }
    if (entries.length === 1 && isAtif(entries[0])) return { format: 'atif', trajectory: entries[0] };
    throw new Error('Unrecognized trajectory format: expected ATIF JSON or Claude Code JSONL' +
      (bad ? ' (' + bad + ' unparsable lines)' : ''));
  }

  /* ---- Claude Code JSONL -> ATIF ---- */

  function blocksOf(content) {
    if (content == null) return [];
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (Array.isArray(content)) return content;
    return [content];
  }

  // Claude Code content blocks -> ATIF message (string, or ContentPart array when images are present)
  function toMessage(blocks) {
    const parts = [];
    for (const b of blocks) {
      if (!b) continue;
      if (typeof b === 'string') parts.push({ type: 'text', text: b });
      else if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const src = b.source;
        const path = src.type === 'base64' ? 'data:' + src.media_type + ';base64,' + src.data : (src.url || src.path || '');
        parts.push({ type: 'image', source: { media_type: src.media_type || 'image/png', path: path } });
      } else if (b.type === 'document') {
        parts.push({ type: 'text', text: '[document' + (b.title ? ': ' + b.title : '') + ']' });
      } else if (b.type === 'tool_reference') {
        parts.push({ type: 'text', text: '[tool loaded: ' + b.tool_name + ']' });
      }
    }
    if (parts.every(p => p.type === 'text')) return parts.map(p => p.text).join('\n\n');
    return parts;
  }

  function usageToMetrics(u) {
    if (!u) return undefined;
    const cached = (u.cache_read_input_tokens || 0);
    const prompt = (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0);
    const m = { prompt_tokens: prompt, completion_tokens: u.output_tokens || 0, cached_tokens: cached };
    if (u.cache_creation_input_tokens) m.extra = { cache_creation_input_tokens: u.cache_creation_input_tokens };
    return m;
  }

  function claudeCodeToAtif(entries) {
    const steps = [];
    const callIndex = {};      // tool_use id -> step
    const meta = { sessionId: null, version: null, model: null, cwd: null, gitBranch: null, cost: null };
    let lastAgent = null;      // last agent step (to merge split assistant lines of the same message id)
    let lastAgentMsgId = null;
    const seenUuid = new Set();

    function push(step) {
      step.step_id = steps.length + 1;
      steps.push(step);
      return step;
    }

    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      if (e.uuid) { if (seenUuid.has(e.uuid)) continue; seenUuid.add(e.uuid); }
      meta.sessionId = meta.sessionId || e.sessionId || null;
      meta.version = meta.version || e.version || null;
      meta.cwd = meta.cwd || e.cwd || null;
      meta.gitBranch = meta.gitBranch || e.gitBranch || null;
      if (e.type === 'cost-state' && typeof e.totalCostUSD === 'number') meta.cost = e.totalCostUSD;

      const extra = {};
      if (e.isSidechain) extra.sidechain = true;
      if (e.isMeta) extra.meta = true;

      if (e.type === 'summary') {
        push({ source: 'system', message: '**Summary:** ' + (e.summary || ''), extra: { kind: 'summary' } });
        lastAgent = null;
        continue;
      }

      if (e.type === 'system') {
        let txt = typeof e.content === 'string' ? e.content : '';
        if (!txt && e.subtype === 'api_error' && e.error) {
          txt = 'API error: ' + (e.error.formatted || e.error.message || JSON.stringify(e.error));
        }
        if (e.subtype === 'compact_boundary' || txt) {
          push({
            timestamp: e.timestamp, source: 'system',
            message: e.subtype === 'compact_boundary' ? '— context compacted —' : txt,
            extra: Object.assign({ kind: e.subtype || 'system' }, extra,
              e.subtype === 'compact_boundary' ? { context_management: { type: 'compaction' } } : {}),
          });
          lastAgent = null;
        }
        continue;
      }

      if (e.type === 'assistant' && e.message) {
        const msg = e.message;
        const model = msg.model && msg.model !== '<synthetic>' ? msg.model : null;
        if (model) meta.model = meta.model || model;
        let step;
        if (lastAgent && msg.id && msg.id === lastAgentMsgId) {
          step = lastAgent;
        } else {
          step = push({ timestamp: e.timestamp, source: 'agent', message: '' });
          if (model) step.model_name = model;
          if (Object.keys(extra).length) step.extra = extra;
          lastAgent = step;
          lastAgentMsgId = msg.id || null;
        }
        const m = usageToMetrics(msg.usage);
        if (m) step.metrics = m;  // split lines repeat the usage of the same API call
        const texts = [];
        for (const b of blocksOf(msg.content)) {
          if (b.type === 'text') texts.push(b.text || '');
          else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            const t = b.thinking || (b.type === 'redacted_thinking' ? '[redacted thinking]' : '');
            if (t) step.reasoning_content = step.reasoning_content ? step.reasoning_content + '\n\n' + t : t;
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            step.tool_calls = step.tool_calls || [];
            const call = { tool_call_id: b.id, function_name: b.name, arguments: b.input || {} };
            step.tool_calls.push(call);
            callIndex[b.id] = step;
          } else if (b.type === 'web_search_tool_result' || /_tool_result$/.test(b.type || '')) {
            attachResult(step, b.tool_use_id, toMessage(blocksOf(b.content)), false);
          }
        }
        if (texts.length) step.message = step.message ? step.message + '\n\n' + texts.join('\n\n') : texts.join('\n\n');
        if (msg.stop_reason === 'max_tokens') step.extra = Object.assign(step.extra || {}, { stop_reason: 'max_tokens' });
        continue;
      }

      if (e.type === 'user' && e.message) {
        const blocks = blocksOf(e.message.content);
        const other = [];
        for (const b of blocks) {
          if (b && b.type === 'tool_result') {
            const owner = callIndex[b.tool_use_id];
            const content = toMessage(blocksOf(b.content));
            if (owner) attachResult(owner, b.tool_use_id, content, !!b.is_error);
            else push({ timestamp: e.timestamp, source: 'system', message: '',
              observation: { results: [resultObj(b.tool_use_id, content, !!b.is_error)] } });
          } else other.push(b);
        }
        if (other.length) {
          const message = toMessage(other);
          if (message !== '' || Array.isArray(message)) {
            push(Object.assign({ timestamp: e.timestamp, source: 'user', message: message },
              Object.keys(extra).length ? { extra: extra } : {}));
            lastAgent = null;
          }
        }
        continue;
      }
      // attachment, queue-operation, file-history-snapshot, etc. are bookkeeping: skipped
    }

    function resultObj(id, content, isError) {
      const r = { source_call_id: id || null, content: content };
      if (isError) r.extra = { is_error: true };
      return r;
    }
    function attachResult(step, id, content, isError) {
      step.observation = step.observation || { results: [] };
      step.observation.results.push(resultObj(id, content, isError));
    }

    const agentSteps = steps.filter(s => s.source === 'agent');
    const sum = k => agentSteps.reduce((a, s) => a + ((s.metrics && s.metrics[k]) || 0), 0);
    const finalMetrics = {
      total_prompt_tokens: sum('prompt_tokens'),
      total_completion_tokens: sum('completion_tokens'),
      total_cached_tokens: sum('cached_tokens'),
      total_steps: steps.length,
    };
    if (meta.cost != null) finalMetrics.total_cost_usd = meta.cost;
    const agentExtra = {};
    if (meta.cwd) agentExtra.cwd = meta.cwd;
    if (meta.gitBranch) agentExtra.git_branch = meta.gitBranch;
    return {
      schema_version: 'ATIF-v1.7',
      session_id: meta.sessionId || undefined,
      agent: { name: 'claude-code', version: meta.version || 'unknown', model_name: meta.model || undefined, extra: agentExtra },
      steps: steps,
      final_metrics: finalMetrics,
      extra: { converted_from: 'claude-code-jsonl' },
    };
  }

  /* ---- helpers shared with the renderer ---- */

  // Text of an ATIF message/content (string or ContentPart array).
  function textOf(m) {
    if (m == null) return '';
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n\n');
    return JSON.stringify(m);
  }

  // GitHub blob/gist page URLs -> raw URLs, so users can paste what is in their address bar.
  function rawUrl(url) {
    let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
    if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
    m = /^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/.exec(url);
    if (m) return 'https://gist.githubusercontent.com/' + m[1] + '/' + m[2] + '/raw';
    return url;
  }

  return { parse: parse, claudeCodeToAtif: claudeCodeToAtif, textOf: textOf, rawUrl: rawUrl };
});
