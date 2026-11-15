const path = require('path');
const { readJson, writeJson } = require('./util');

/**
 * API list prices in USD per million tokens, matched by model-name pattern
 * (first match wins). These are estimates by model family: subscription plans
 * are not billed per token. Edit pricing.json in the app data folder to
 * correct or add models; models with no match simply show no cost.
 */
const DEFAULTS = [
  { match: 'claude-opus-4-1|claude-opus-4-0|claude-opus-4-2025|claude-3-opus', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: 'claude.*opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: 'claude.*sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'claude.*haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: 'gpt-5.*(mini)', input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  { match: 'gpt-5|codex', input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { match: 'grok.*fast', input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
  { match: 'grok', input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 },
];

function loadPricing(dir) {
  const file = path.join(dir, 'pricing.json');
  let table = readJson(file);
  if (!Array.isArray(table)) {
    table = DEFAULTS;
    try { writeJson(file, table); } catch { /* read-only location */ }
  }
  const rules = table.map((r) => ({ ...r, re: new RegExp(r.match, 'i') }));
  const memo = new Map();
  return (model) => {
    if (!memo.has(model)) memo.set(model, rules.find((r) => r.re.test(model)) || null);
    return memo.get(model);
  };
}

function costOf(rule, u) {
  if (!rule) return null;
  return (u.input * rule.input + u.output * rule.output + u.cacheRead * rule.cacheRead + u.cacheWrite * rule.cacheWrite) / 1e6;
}

module.exports = { loadPricing, costOf };
