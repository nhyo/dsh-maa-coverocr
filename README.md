# dsh-maa-coverocr

[dsh-maa-cli](https://github.com/nhyo/dsh-maa-cli) 的辅助插件：读取一个 B 站明日方舟作业视频，告诉 dsh-maa-cli 这个视频用了哪些干员。dsh-maa-cli 再拿结果和你的干员 Box 比较，推荐你能抄的视频，并给出视频链接，由你自己去看视频抄作业。

本插件不单独使用，也不会操作游戏。

## 安装

在 DSH 对话里输入：

```
/maa ext install coverocr
```

dsh-maa-cli 会安装本插件，并把它登记到当前 DSH 配置。安装前会先显示要执行的操作，要你确认。

也可以手动安装：

```
dsh plugin --profile <配置名> add dsh-maa-coverocr
```

## 读取哪些信息

| 来源 | 说明 |
|---|---|
| 标题、简介、标签 | 用 MAA 的干员名单精确匹配干员名，另带少量常用昵称（如 42 → 史尔特尔）。 |
| 评论 | 只读置顶评论和 UP 主自己的评论；其他观众的评论不读。 |
| 封面 | 用 MAA 运行时自带的 PaddleOCR 中文识别模型识别封面文字。识别出编队界面截图时，会排除底部的编队标签。 |
| `maa://` 作业码 | 如果标题、简介或 UP 主评论里有作业码，原样返回。 |

每个干员都会标明来源和把握程度：

| 把握程度 | 含义 |
|---|---|
| `certain` | 封面上读出的完整干员名，置信度高。 |
| `likely` | 在文字里找到，或者封面文字只有部分对上。 |
| `guess` | 封面文字和干员名差一个字。 |

## 限制

- **只能处理你给的视频链接，不支持按关卡搜索**。B 站的搜索接口会拒绝非浏览器的请求，本插件也不伪装成浏览器。
- **请求如实表明身份**。所有请求的 User-Agent 都是 `dsh-maa-coverocr`；B 站拒绝时，直接报告错误。
- **封面没有文字时，读不出干员**。比如只放了立绘的封面。
- **安装体积较大**。依赖 `onnxruntime-node`，安装后约 300 MB，因为它自带多平台的运行库。识别模型不随插件下载，直接用 MAA 运行时里已有的。

## 服务接口（API 版本 1）

本插件提供 cordis 服务 `maaCoverocr`：

```js
const service = ctx.get('maaCoverocr')
service.apiVersion // 1
await service.analyzeVideo({
  video: 'https://www.bilibili.com/video/BV…', // 也可以是 BV 号或 b23.tv 短链接
  operatorNames: [...],                        // 干员名单，来自 MAA battle_data.json
  resourceDir: 'C:/…/resource',                // MAA 资源目录，识别模型从这里加载
  signal,
})
// → { video, operators: [{ name, certainty, sources }], cover, text, maaCodes, warnings }
```

## 开发

```bash
npm install
npm test
```

用真实模型测试：

```bash
COVEROCR_RESOURCE_DIR=<MAA 资源目录> COVEROCR_SAMPLE=<封面.jpg> COVEROCR_EXPECT=干员A,干员B npm test
```

## 许可

MIT
