# dsh-live-speed：本轮实时输出速度

在输入框下方的统计行里增加一个读数，显示当前正在生成的这条回复的实时速度（tok/s）。

## 与内置「会话统计」的区别

| | 内置「会话统计」 | 本插件 |
|---|---|---|
| 口径 | 整段会话累计：总输出 token ÷ 总解码时长 | 当前一轮：最近 3 秒的字符速率 |
| 刷新 | 每条回复完成后更新一次 | 生成过程中每秒更新 |
| 空闲时 | 保持整段平均值 | 显示上一轮回复的实际速度 |
| 准确度 | 精确（使用模型上报的 outputTokens） | 估算（字符数 × 校准比例） |

两个读数并存：内置胶囊仍然是整段平均，本插件胶囊是本轮实时。

一条回复结束时读数不会消失：最后一步缺少用量或时间戳时继续往前找，拿最近一条算得出来的回复；节点还没结算的瞬间沿用上一次读数（最长 10 秒）。

## 估算方法

模型只在回复结束时上报 outputTokens，生成过程中拿不到真实 token 数，因此实时值按字符数换算：

1. 采样当前 step 的正文与思考文本字符数（工具调用参数不计入）。
2. 取最近 3 秒窗口，计算字符速率。
3. 乘以校准比例：最近 5 条已完成回复的 `outputTokens / 字符数` 加权平均。
4. 没有历史可校准时使用 0.45 token/字符。

比例会随内容类型漂移（中文、英文、代码的比值不同），实时读数是趋势参考，跨轮比较请用上一轮或整段会话的精确值。

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半侧，无逻辑 |
| `lib/client.js` | 浏览器半侧：注册 `conversation.composer.dock` 条目 |
| `cordis.patch.yml` | bundle 补丁，挂载 `live-speed` 行 |

客户端通过 slot 属性里的 `useChat` 读取 `legacy.partial`（当前 step 的流式内容块）与 `legacy.nodes`（已完成节点），不读取其他插件的 DOM。

## 安装

从 DSH 插件市场安装：在「发现」里添加市场索引

```text
https://shutongX.github.io/dsh-plugins-index/index.json
```

找到 `dsh-live-speed` 点安装，按提示重启 DSH。

也可以直接装 GitHub 版本：

```sh
dsh plugin --profile desktop add https://github.com/shutongX/dsh-live-speed
```

本地开发：在 profile 的 `package.json` 里把依赖指向本地目录，再执行 `pnpm install`：

```json
{
  "dependencies": {
    "dsh-live-speed": "link:C:\\path\\to\\dsh-live-speed"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-live-speed"]
    }
  }
}
```

在 profile 目录执行 `pnpm install`，重启 DSH。
