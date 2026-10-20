// Unit tests for trajectory.js (format detection and Claude Code -> ATIF conversion).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../trajectory.js');

const ex = f => fs.readFileSync(path.join(__dirname, '..', 'examples', f), 'utf8');

test('ATIF example is detected and passed through unchanged', () => {
  const { format, trajectory } = T.parse(ex('atif-example.json'));
  assert.equal(format, 'atif');
  assert.equal(trajectory.steps.length, 7);
  assert.equal(trajectory.subagent_trajectories[0].trajectory_id, 'reviewer-1');
});

test('Claude Code JSONL is converted to ATIF', () => {
  const { format, trajectory: t } = T.parse(ex('claude-code-example.jsonl'));
  assert.equal(format, 'claude-code');
  assert.equal(t.schema_version, 'ATIF-v1.7');
  assert.equal(t.session_id, 'cc-example-0001');
  assert.equal(t.agent.model_name, 'claude-opus-5-5');
  assert.deepEqual(t.steps.map(s => s.source), ['user', 'agent', 'agent', 'user', 'agent']);
  assert.deepEqual(t.steps.map(s => s.step_id), [1, 2, 3, 4, 5]);
  // split assistant lines of one API message are merged into a single step
  const s2 = t.steps[1];
  assert.equal(s2.reasoning_content, 'Run the tests to see what fails.');
  assert.equal(s2.tool_calls[0].function_name, 'Bash');
  // tool_result is attached to the step that issued the call
  assert.equal(s2.observation.results[0].source_call_id, 'toolu_01');
  assert.equal(s2.observation.results[0].extra.is_error, true);
  assert.equal(s2.metrics.prompt_tokens, 1510);
  assert.equal(s2.metrics.cached_tokens, 1000);
  assert.equal(t.steps[2].message, '`add` uses `-`. Fixing.');
  assert.equal(t.steps[2].observation.results[0].content, 'The file /home/dev/calc/calc.py has been updated.');
  // images become ATIF ContentParts with data URIs
  const m = t.steps[3].message;
  assert.ok(Array.isArray(m));
  assert.equal(m[1].type, 'image');
  assert.match(m[1].source.path, /^data:image\/png;base64,/);
  assert.equal(t.final_metrics.total_cost_usd, 0.0123);
  assert.equal(t.final_metrics.total_completion_tokens, 42 + 60 + 15);
});

test('ATIF pretty-printed over several lines is not mistaken for JSONL', () => {
  const { format } = T.parse(JSON.stringify({ schema_version: 'ATIF-v1.2', agent: { name: 'a', version: '1' }, steps: [] }, null, 2));
  assert.equal(format, 'atif');
});

test('Claude Code JSONL tolerates truncated last line', () => {
  const text = ex('claude-code-example.jsonl') + '{"type":"assistant","mess';
  assert.equal(T.parse(text).format, 'claude-code');
});

test('garbage is rejected with a clear error', () => {
  assert.throws(() => T.parse('hello world'), /Unrecognized trajectory format/);
  assert.throws(() => T.parse('{"foo": 1}'), /Unrecognized trajectory format/);
});

test('GitHub blob URLs are rewritten to raw URLs', () => {
  assert.equal(T.rawUrl('https://github.com/o/r/blob/main/a/b.json'), 'https://raw.githubusercontent.com/o/r/main/a/b.json');
  assert.equal(T.rawUrl('https://example.com/x.json'), 'https://example.com/x.json');
});

test('textOf flattens ContentPart arrays', () => {
  assert.equal(T.textOf([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }]), 'a\n\nb');
});
