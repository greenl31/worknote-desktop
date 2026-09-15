# 参与贡献

感谢你帮助改进工作日志 Worknote。

## 提交问题

- 请说明操作系统与版本、Worknote 版本、复现步骤和实际结果。
- 请先删除截图和日志中的私人任务内容。
- 安全问题请按照 [SECURITY.md](SECURITY.md) 提交，不要公开披露可利用细节。

## 提交代码

1. Fork 仓库并创建主题分支。
2. 保持改动聚焦，不提交数据库、导出文件、日志或构建产物。
3. 在 `src-tauri/` 运行：

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

4. 提交 Pull Request，并说明改动目的、验证结果和平台影响。

提交贡献即表示你同意按本项目的 MIT License 发布该贡献。
