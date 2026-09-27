# {{PROJECT_TITLE}} · 工程说明

工程 id：`{{PROJECT_ID}}`。

## 代码与资源

- `src/projects/{{PROJECT_ID}}/project.ts`：静态元数据与场景入口。
- `src/projects/{{PROJECT_ID}}/scene.ts`：公共 Scene 接口实现。
- `public/films/{{PROJECT_ID}}/`：本工程运行资源，初始化文件为 `poster.svg`。
- `production/{{PROJECT_ID}}/`：工程说明、处理参数及非运行源文件。
- `tests/e2e/{{PROJECT_ID}}.spec.ts`：直接定位、反向定位回归。

新增文件时更新此索引；不要把本工程私有实现作为其他工程的依赖。

## 依赖与执行命令

使用仓库统一的 pnpm 依赖与锁文件；当前没有额外的工程专属依赖。

```powershell
pnpm dev
pnpm project:check {{PROJECT_ID}}
pnpm project:check {{PROJECT_ID}} --strict
pnpm posters --project {{PROJECT_ID}}
```

`project:check` 只读；`posters` 写入本工程封面。公共环境要求见根 README。

## 处理脚本的输入输出

当前没有专属处理脚本。需要添加时，放入 `scripts/projects/{{PROJECT_ID}}/`，在此记录每个脚本的输入路径、输出路径、覆盖行为、外部命令与失败处理。缓存放 `.cache/`，生成结果放 `exports/{{PROJECT_ID}}/`，不要写到其他工程目录。

## 资源来源记录

初始化占位 SVG 由脚手架生成。引入第三方依赖或资源时，在本目录保留来源与许可证文件，并注明文件是否进入 Git、是否进入 public。

## 工程验证与公共改动

当前仅包含初始化浏览器回归。修改接口、路径、资源生命周期或文件写入逻辑时补对应测试，记录运行命令与结果。需要修改 engine、UI、公共脚本或共享索引时列明涉及文件和兼容性影响。
