# 参考实现（可直接运行）

教程正文所述架构的最小实现：滞回裁剪、缝份摘要、摘要库与重roll、缓存友好的报文拼装。单文件约 120 行，MIT 许可，欢迎整段搬进你自己的项目。

## 运行

```bash
npm i express better-sqlite3
API_BASE=https://你的OpenAI兼容接口/v1 API_KEY=sk-xxx MODEL=模型名 node server.js
# 不配 API_KEY 也能启动(mock模式, 回声回复), 可先观察裁剪与摘要流程
```

## 试玩

```bash
curl -X POST localhost:3000/chat -H 'Content-Type: application/json' -d '{"text":"你好"}'
curl localhost:3000/state/default          # 看锚点/窗口条数/当前摘要/历史版本
curl -X POST localhost:3000/reroll/default # 用存档材料重写摘要
```

## 对应教程的要点

| 教程概念 | 代码位置 |
|---|---|
| 滞回裁剪(20↔40)与锚点 | `maybeTrim()` |
| 缝份(上次裁剪的最后2条) | `summaryJob()` 的 material 拼装 |
| 三明治指令 | 指令在材料前后各出现一次 |
| 摘要库(只增不覆盖)+重roll | `summaries` 表 + `/reroll` |
| 断点顺序/注入与style不落库 | `/chat` 的报文拼装段 |
| 摘要可见 | `/state/:conv` |

环境变量：`LOW` `HIGH` `PROFILE` `STYLE` `SUMMARY_MODEL` `PORT` `DB` 均可自定义。
