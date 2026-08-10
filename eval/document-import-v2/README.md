# PMBrain 结构化文档导入 V2 Benchmark

该评测在两套隔离的临时 PGLite 中分别运行兼容解析 V1 和结构化解析 V2，不会打开或修改用户正在使用的数据库。

真实文档和问题清单属于私有资料，放在已被 Git 忽略的 `eval/private/document-import-v2/`。清单至少包含 10 个 PDF、10 个 DOCX、10 个 PPTX、5 个 XLSX 和 50 个标注问题；建议扩展到 100 问。

```powershell
bun run eval:document-import-v2 eval/private/document-import-v2/manifest.json
```

默认模式会使用当前配置的 Embedding 与 Hybrid Search，文档内容可能发送给配置的 Embedding 服务并产生费用；两组数据均只写入隔离的内存 PGLite。若只想先检查完全本地的结构和关键词检索，可运行：

```powershell
bun run eval:document-import-v2 eval/private/document-import-v2/manifest.json --keyword-only
```

报告对比 Top1、Recall@5、MRR、实际命中 Chunk 的章节/页码定位正确率、平均延迟、Chunk 数量、Token 数量和纯导入耗时。定位指标不等同于最终 LLM 回答的引用正确率；若产品以后加入回答层评测，应单独记录。V2 通过真实文档评测后，才可把“结构化解析”作为稳定默认能力发布。

清单格式参考 `eval/templates/document-import-v2.manifest.example.json`。`expectedPath` 使用相对 `corpusRoot` 的路径；`expectedLocator` 填预期出现在检索 Chunk 上下文中的章节、页码、Slide、Sheet 或表格范围。
