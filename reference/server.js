// rolling-summary reference implementation (MIT)
// 最小可跑示例: 滞回裁剪 + 缝份摘要 + 缓存断点拼装
// 依赖: npm i express better-sqlite3 | 运行: node server.js | 对话: POST /chat {"text":"..."}
// LLM: 环境变量 API_BASE(OpenAI兼容)/API_KEY/MODEL; 不配key则进入mock模式(回声), 便于先跑通流程

const express = require('express');
const Database = require('better-sqlite3');

const LOW = parseInt(process.env.LOW || 20);     // 裁剪后保留条数
const HIGH = parseInt(process.env.HIGH || 40);   // 触发裁剪的上限
const API_BASE = process.env.API_BASE || '';     // 如 https://api.xxx.com/v1
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || MODEL;
const PROFILE = process.env.PROFILE || '你是一个自建前端里的AI助手。';   // 断点1: 换成你的人格设定
const STYLE_TAG = process.env.STYLE || '';       // 放报文最末的style文本, 不落库
const SUMMARY_PROMPT = `请以第一人称把下面的对话写成"前情提要"式摘要, 约800字。
保留: 事件、情绪转折、约定、重要原话。叙述使用绝对日期, 禁止"今天/昨天"。
材料含[旧摘要]时, 按"近的清晰、远的模糊"与新对话合写成一份。只输出摘要正文。`;  // 三明治的"面包", 结尾会再贴一次

const db = new Database(process.env.DB || 'demo.db');
db.exec(`
CREATE TABLE IF NOT EXISTS convs (id TEXT PRIMARY KEY, anchor_id INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conv_id TEXT, role TEXT, content TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY, conv_id TEXT, content TEXT,
  seam_tail TEXT, material TEXT, anchor_id INTEGER, created_at TEXT DEFAULT (datetime('now')));`);

const anchorOf = c => (db.prepare('SELECT anchor_id a FROM convs WHERE id=?').get(c) || { a: 0 }).a;
const latestSummary = c => db.prepare('SELECT * FROM summaries WHERE conv_id=? ORDER BY id DESC LIMIT 1').get(c);
const renderTs = rows => rows.map(r => `[${r.created_at}] ${r.role}: ${r.content}`).join('\n');

async function llm(model, system, messages) {
  if (!API_KEY) return '(mock) ' + messages[messages.length - 1].content.slice(0, 60);
  const r = await fetch(API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages] })
  });
  const d = await r.json();
  if (!d.choices) throw new Error(JSON.stringify(d).slice(0, 200));
  return d.choices[0].message.content;
}

// 摘要岗: 异步, 不阻塞对话。材料落库 → 支持重roll; 摘要只增不覆盖 = 自带摘要库
async function summaryJob(convId, trimmedRows, newAnchor) {
  const prev = latestSummary(convId);
  const material =
    (prev ? '[旧摘要]\n' + prev.content + '\n\n[缝份·上次裁剪的最后2条]\n' + prev.seam_tail + '\n\n' : '') +
    '[新裁剪的对话原文]\n' + renderTs(trimmedRows);
  try {
    const text = await llm(SUMMARY_MODEL, SUMMARY_PROMPT,
      [{ role: 'user', content: material + '\n\n---\n' + SUMMARY_PROMPT }]); // 三明治: 指令首尾各一次
    db.prepare('INSERT INTO summaries (conv_id, content, seam_tail, material, anchor_id) VALUES (?,?,?,?,?)')
      .run(convId, text, renderTs(trimmedRows.slice(-2)), material, newAnchor);
    db.prepare('UPDATE convs SET anchor_id=? WHERE id=?').run(newAnchor, convId);
    console.log(`[summary] ${convId} 新摘要 ${text.length} 字, 锚点→${newAnchor}`);
  } catch (e) { console.error('[summary] 失败(锚点未动, 下轮可重试):', e.message); }
}

function maybeTrim(convId) {
  const a = anchorOf(convId);
  const n = db.prepare('SELECT COUNT(*) c FROM messages WHERE conv_id=? AND id > ?').get(convId, a).c;
  if (n < HIGH) return;
  const rows = db.prepare('SELECT * FROM messages WHERE conv_id=? AND id > ? ORDER BY id LIMIT ?')
    .all(convId, a, n - LOW);
  summaryJob(convId, rows, rows[rows.length - 1].id);  // 摘要成功才移锚点, 失败不丢上下文
}

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const convId = req.body.conv_id || 'default';
  db.prepare('INSERT OR IGNORE INTO convs (id) VALUES (?)').run(convId);
  db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)').run(convId, 'user', req.body.text);

  const sum = latestSummary(convId);                                  // 断点3
  const system = PROFILE + (sum ? '\n\n[前情提要]\n' + sum.content : ''); // 断点1+3(demo合并为一段system)
  const history = db.prepare('SELECT role, content FROM messages WHERE conv_id=? AND id > ? ORDER BY id')
    .all(convId, anchorOf(convId));                                   // 断点4: 锚点不动则前缀稳定
  const last = history[history.length - 1];
  last.content += `\n\n[现在是 ${new Date().toISOString()}]` + (STYLE_TAG ? '\n' + STYLE_TAG : ''); // 只进报文不落库

  try {
    const reply = await llm(MODEL, system, history);
    db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?,?,?)').run(convId, 'assistant', reply);
    maybeTrim(convId);                                                // 裁剪异步, 不拖慢本轮
    res.json({ reply, window: history.length + 1 });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/state/:conv', (req, res) => {                               // 摘要可见: 排障与信任的基础
  const c = req.params.conv;
  res.json({
    anchor: anchorOf(c),
    window: db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id=? AND id > ?').get(c, anchorOf(c)).n,
    summary: latestSummary(c) || null,
    summary_versions: db.prepare('SELECT id, length(content) len, created_at FROM summaries WHERE conv_id=? ORDER BY id DESC').all(c)
  });
});

app.post('/reroll/:conv', async (req, res) => {                       // 用存档材料重写最新一份摘要
  const cur = latestSummary(req.params.conv);
  if (!cur) return res.status(404).json({ error: 'no summary yet' });
  try {
    const text = await llm(SUMMARY_MODEL, SUMMARY_PROMPT,
      [{ role: 'user', content: cur.material + '\n\n---\n' + SUMMARY_PROMPT }]);
    db.prepare('INSERT INTO summaries (conv_id, content, seam_tail, material, anchor_id) VALUES (?,?,?,?,?)')
      .run(cur.conv_id, text, cur.seam_tail, cur.material, cur.anchor_id);
    res.json({ ok: true, length: text.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('rolling-summary demo on :' + (process.env.PORT || 3000)));
