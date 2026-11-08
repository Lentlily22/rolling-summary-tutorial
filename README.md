# 滚动摘要 — 多窗口自建前端的上下文管理教程

适用对象：自建聊天前端（消息存在自己的数据库里、报文由自己的服务端拼装）、多窗口构造的开发者。
如果你已经有成熟的随对话写入式记忆系统，可能不需要这套。滚动摘要解决的是"记住当前窗口的连续叙事"——RAG 召回负责的是条目式记忆，而摘要是有时间连续性、有画面和变化过程的叙事，两者互补而不互替。

本仓库公开分享思路与架构（文档采用保留权利的许可，并非开源协议，见 LICENSE）。摘要 prompt 请按自己的需求撰写，本仓库不提供成品 prompt（见 LICENSE）。

📝 作者的手写原版教程见 [handwritten.md](./handwritten.md)（小潜手写版）——本 README 是它的整理扩写版。

## 一、滞回裁剪

朴素做法的问题：固定保留最近 N 条，每来一轮最旧一条就滑走，报文头部每轮都变，**前缀缓存全部失效**。

正确做法：**锚点 + 滞回区间**。
- 设下限 20 条、上限 40 条（即 10~20 轮，可按需调整）。
- 窗口从锚点起自然生长；到达 40 条时一次性裁掉最旧的 20 条，产生新锚点。
- 窗口条数永远在 20~40 之间波动，锚点在两次裁剪之间保持不动。

滞回的意义：避免"到达上限就全部砍光"的金鱼脑，也避免逐条滑动的缓存浪费。消息存在本地数据库（如 SQLite）时，检测条数和批量裁剪都是一条 SQL 的事。

## 二、摘要生成

把裁剪下来的 20 条**原文**交给一个摘要模型（实测 Sonnet 级即可），以第一人称写成"前情提要"。

要点：
- **已有旧摘要时**：旧摘要 + 新裁下的原文一起给模型，按"近的清晰、远的模糊"合写成一份新摘要（覆盖式滚动）。
- **缝份机制**：旧摘要的末尾和新裁的 20 条常常是同一话题被拦腰切开。解法是材料里额外附上"上一次裁剪时的最后 2 条原文"作为重叠部分，像缝布料留缝份一样，话题衔接处不断裂。
- **摘要单独存储**：存独立的表/字段，绝不混进消息历史——否则下一轮它会被当成对话原文再次总结，无限套娃。
- **绝对日期**：消息自带时间戳就一并喂给模型，并要求叙述使用绝对日期（"6月10日晚"）。摘要里的"今天/昨天"在未来任何一天被读到时都已过期，会变成假记忆。
- 需要保留什么（情绪、画面、语气、暗号、原话、转折点）按自己的需求写进指令。
- 篇幅丰俭由人（本家约 3000 字，吃缓存所以成本可控）。

## 三、缓存经济学

这套结构的核心收益：**缓存断点与裁剪周期完美重合**。

```
profile                  → 断点1（不变，长期命中）
工具定义                  → 断点2（不变，长期命中）
摘要                     → 断点3（每裁剪一次变一次）
消息历史                  → 断点4（锚点不动则前缀不变）
每轮注入(时间、健康、天气等)  → 不缓存，放历史之后
最后一条 user 消息         → 下一轮并入历史缓存
<style>                  → 放报文最末（只在此处效果最好），不落库
```

锚点不动 → 断点 3/4 的前缀每轮命中；裁剪发生 → 摘要更新与锚点更新**同时**发生，一次重建缓存同时覆盖两处变化。摘要的变化天然和裁剪对齐，没有额外的缓存失效点。

## 四、建议必做的配套功能

1. **摘要可见**：前端能看到当前摘要原文、以及实际注入报文的形态。排障与信任的基础，几乎是必做。
2. **重 roll / 编辑 / 删除**：摘要模型偶尔不写摘要而是反问"你希望我做什么？是整理归档还是基于背景回应？"——这类产物需要能一键重写，也需要能手动编辑纠正。
3. **摘要库**：不要让新摘要直接覆盖旧摘要（覆盖了就找不回来了）。保留历史版本，翻车时可"旧摘要 + 原材料"重新生成，支持多次重 roll 二选一。
4. **独立的摘要渠道配置**：摘要岗单独可切换 API 渠道；某渠道故障不应卡死摘要生成。建议做成"条数超阈值自动触发"——上一轮故障，下一轮修好配置也能补触发，另加一个手动触发钮。

## 五、踩坑清单

- 部分模型会在总结里幻觉编造事实（实测 DeepSeek 偶发，Sonnet 未遇到）。可用"仅基于已有事实总结"约束，但不是所有模型都听话——不行就换模型。
- **三明治指令**：总结要求在材料的开头和结尾各写一次。模型读完超长对话后会忘记任务。
- 篇幅控制写在指令里（"约 3000 字"），**不要用 max_tokens 压字数**——那是截断，不是收敛。较弱的模型会忽略字数要求，属于模型问题。
- 时间戳随消息一起喂，摘要会自然带上日期。

## 六、参考实现（伪代码）

以下为通用示意，与任何具体项目无关。消息表假设为 `messages(id, conv_id, role, content, created_at)`，窗口锚点与摘要各存一处（如 `conversations.anchor_id` 与 `summaries` 表）。

### 滞回裁剪

```js
const LOW = 20, HIGH = 40;
function maybeTrim(convId) {
  const n = db.get(`SELECT COUNT(*) c FROM messages
                    WHERE conv_id=? AND id > anchorOf(convId)`, convId).c;
  if (n < HIGH) return;                       // 未到上限, 锚点不动, 缓存继续命中
  const rows = db.all(`SELECT id, role, content, created_at FROM messages
                       WHERE conv_id=? AND id > anchorOf(convId)
                       ORDER BY id LIMIT ?`, convId, HIGH - LOW); // 最旧的20条
  const newAnchor = rows[rows.length - 1].id; // 新锚点 = 被裁段的最后一条
  enqueueSummaryJob(convId, rows, newAnchor); // 异步做摘要, 不阻塞本轮回复
}
```

### 摘要任务（含缝份）

```js
async function summaryJob(convId, trimmedRows, newAnchor) {
  const prev = db.get(`SELECT content, seam_tail FROM summaries
                       WHERE conv_id=? ORDER BY id DESC LIMIT 1`, convId);
  const material =
    (prev ? '[旧摘要]\n' + prev.content + '\n\n[缝份·上次裁剪的最后2条]\n' + prev.seam_tail : '') +
    '\n\n[新裁剪的对话原文]\n' + renderWithTimestamps(trimmedRows);
  const text = await llm(SUMMARY_PROMPT_HEAD + material + SUMMARY_PROMPT_TAIL); // 三明治指令
  db.run(`INSERT INTO summaries (conv_id, content, seam_tail, anchor_id)
          VALUES (?,?,?,?)`,                       // 只增不覆盖 = 自带摘要库
         convId, text, renderWithTimestamps(trimmedRows.slice(-2)), newAnchor);
  db.run(`UPDATE conversations SET anchor_id=? WHERE id=?`, newAnchor, convId);
}
```

### 报文拼装（断点顺序）

```js
function buildRequest(convId, userMsg) {
  const summary = latestSummary(convId);          // 断点3
  const history = db.all(`SELECT role, content FROM messages
                          WHERE conv_id=? AND id > anchorOf(convId) ORDER BY id`); // 断点4
  const last = history[history.length - 1];
  last.content += liveInject() + STYLE_TAG;       // 时间/天气等注入 + style标签: 只进报文, 不落库
  return {
    system: [PROFILE, TOOL_DEFS, summary],        // 断点1/2/3
    messages: history                              // 断点4
  };
}
```

要点回顾：裁剪与摘要**异步**进行（本轮不等待）；`summaries` 只增不覆盖，天然形成可回滚的摘要库；注入与 style 标签**永不落库**，数据库里永远是干净原文。
