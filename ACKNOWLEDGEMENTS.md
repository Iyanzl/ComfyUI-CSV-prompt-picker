# Acknowledgements / 致谢

特别感谢 **[vslinx](https://github.com/vslinx)**，以及作者的 **[ComfyUI-vslinx-nodes](https://github.com/vslinx/ComfyUI-vslinx-nodes)** 项目，在节点开发、界面交互和实现思路上提供的帮助。

本地原有代码已经包含对 vsLinx 控件保存方式的参考，并使用 `vslinx_csv_rows`、`vslinx_extra_prompts` 等工作流字段。本版本保留这些参考和字段，以兼容已有工作流。

本项目是独立维护的 CSV 节点，不代表 vslinx 官方发布，也不暗示作者对本项目的背书。没有在此声称当前上游项目提供同一个 CSV 编辑器。

Special thanks to **vslinx** and **ComfyUI-vslinx-nodes** for help and implementation ideas. The existing node references vsLinx widget serialization and retains the original `vslinx_*` persistence fields for workflow compatibility.

This standalone version adds the CSV editor, complete-row read/write, backups, conflict detection, live refresh and automated tests. These modifications are dated **2026-11-09** and maintained by **[Iyanzl](https://github.com/Iyanzl)**.

The referenced project distributes a GNU GPL v3 license. This repository includes that license text and is distributed under GPL v3 as well. See [LICENSE](LICENSE). Existing source acknowledgements are retained.
