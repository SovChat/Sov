# SOV Chat (front-end) README
## By [BCquqi](https://github.com/BCquqi)

> 
> 项目路径：`https://github.com/BKYJX/Sov`
> 预览访问地址：`none yet`
> 对接后端：`https://chat.bkyjx.top`（sov‑serverside Go后端）

## 项目文件结构

```
├─ index.html          # HTML 骨架：聊天界面 + 登录/注册浮层，不含 CSS、JS
├─ style.css           # 全部样式：主题、消息分组、登录卡片、Toast
├─ script.js           # 全部逻辑：登录对接、UI 渲染、轮询、主题
├─ preview.html        # 早期单文件预览稿（存档参考，不参与当前架构）
└─ README.md           # 本说明文档
```

## 当前已实现功能

### 账号与登录（新增）

1. **登录 / 注册浮层**
   - 未登录时聊天界面被模糊锁定（`body[data-auth="locked"]`），浮层覆盖在最上层
   - 登录、注册两个 Tab 切换；注册额外显示「显示名」「确认密码」
   - 登录卡片顶部展示后端探测结果：群名、成员数、入群规则（公开 / 私有）
2. **会话机制**
   - 登录/注册成功后，后端下发会话令牌；前端在 `Authorization: Bearer <token>` 中携带
   - 令牌与展示名保存在 `localStorage['sov-session']`，**密码永不落地**
   - 刷新页面自动恢复登录态（`GET /auth/me` 校验）；令牌失效自动清理并回到登录页
   - 顶栏显示当前用户（头像 + 显示名 + 管理员标记）与退出按钮
3. **入群规则（与后端一致）**
   - 公开频道：注册即入群，注册完成后可直接发言
   - 私有群组：注册仅创建账号，聊天区提示「等待管理员审批」，**且不轮询消息接口**（避免无意义的 403）
4. **前端前置校验**：用户名 `^[A-Za-z0-9_-]{1,64}$`、密码 ≥6 位、两次密码一致、显示名 ≤32 字符
5. **错误反馈**：后端错误文案内联展示在登录卡片；聊天中的失败通过 Toast 提示
6. **后端不可达时优雅降级**：明确提示「无法连接后端服务（http://<host>:8443）」，而不是静默失败

### UI 聊天功能

1. **黑白主题系统**：白天 / 黑夜 / 自适应（跟随系统）；`data-theme` 挂在 `<html>` 上；选择存 `localStorage`
2. **消息渲染规则（Discord 风格）**
   - 同一用户连续多条消息：仅第一条展示头像、用户名、时间；后续消息头像位置留白对齐
   - 分隔横线只出现在不同说话者的消息组之间；最后一条消息下方无多余横线
   - 消息操作按钮（回复、编辑）悬浮在消息块右上角，鼠标悬浮才显示
   - **优先显示 displayName**（由后端 `/members/list` 从 `accounts.txt` 关联得到），无则回退 userId
3. **输入框能力**：`textarea` 多行；`Shift+Enter` 换行、`Enter` 发送；聚焦高亮；全空格提交被拦截；XSS 转义
4. **其他 UI 组件**：@提及高亮、日期分隔条、频道列表（general 对接后端，开发/语音为本地频道）、成员列表（含显示名）、空状态提示、发送后自动滚动到底

### 后端对接模块

1. **认证方式**
   - 首选：`Authorization: Bearer <token>`（登录/注册接口下发的会话令牌）
   - 兼容：`X-User-Id` + `X-Password`（后端仍支持，前端默认不再使用）
2. **接口清单**

| 接口 | 方法 | 作用 |
| --- | --- | --- |
| `/health` | GET | 后端健康探测 + 群组概况（名称/人数/是否公开） |
| `/auth/register` | POST | 注册账号（公开频道注册即入群） |
| `/auth/login` | POST | 登录，返回会话令牌 |
| `/auth/logout` | POST | 登出，吊销当前令牌 |
| `/auth/me` | GET | 校验登录态并返回身份信息 |
| `/chat/messages` | GET | 拉取历史加密消息，支持 `since` 增量轮询 |
| `/chat/send` | POST | 发送加密消息 payload |
| `/members/list` | GET | 拉取成员列表（含 displayName） |

3. **消息发送逻辑**：乐观渲染 → 失败自动回滚 + Toast 提示
4. **增量轮询**：每 3 秒按 `since` 拉取，行级 id 去重；仅 `general` 频道且已入群时轮询
5. **消息解析规则**：后端原始行 `timestamp|senderId|ciphertext|encryptedKeysJson`
   - `ciphertext` 当前为 `base64(JSON({v:1, content:文本}))`，**属于传输占位，不是真正 E2EE**
   - `encryptedKeys` 前端暂未使用，真正端到端加密待后续实现

## script.js 核心配置区

```js
const CONFIG = {
    channel: { name: 'general', tag: '动态测试' },
    api: {
        // 自动跟随页面 host，固定后端端口 8443
        get baseUrl() { return location.protocol + '//' + location.hostname + ':8443'; },
        endpoints: {
            health: '/health',
            list: '/chat/messages',
            send: '/chat/send',
            members: '/members/list',
            register: '/auth/register',
            login: '/auth/login',
            logout: '/auth/logout',
            me: '/auth/me',
        }
    },
    pollInterval: 3000,        // 轮询间隔（ms）
    sessionKey: 'sov-session', // 登录态在 localStorage 中的键名
};
```

> 登录态对象 `session` 与硬编码账号无关；**请勿再把账号密码写进前端代码**。

## 部署 & 联调关键注意事项

### 1. 后端地址约定（重要）

`baseUrl` 由当前页面的 `location.hostname` 推导，端口固定 `8443`：

- 页面在 `http://10.66.1.98/` → 后端地址为 `http://10.66.1.98:8443`
- 页面在 `http://127.0.0.1:8080/` → 后端地址为 `http://127.0.0.1:8443`

因此**前端页面与后端必须同机（同 host）+ 后端监听 8443**。若后端部署在别的域名/端口，
请修改 `CONFIG.api.baseUrl`。

⚠️ 直接以 `file://` 方式打开 `index.html` 不可用（`location.hostname` 为空），必须经 HTTP 服务访问。

### 2. CORS 跨域

前端在 80 端口、后端在 8443，属于跨域。后端 `main.go` 的 `corsMiddleware` 已放行：

- `Access-Control-Allow-Headers` 必须包含 **`Authorization`**（会话令牌需要），以及原有的 `Content-Type, X-User-Id, X-Password`
- `GET`/`POST`/`OPTIONS` 预检由后端返回 `204`

若后端前置于 Nginx，**Nginx 层同样需要放行上述请求头**，否则浏览器预检失败。

### 3. 后端未启动时的表现（预期行为）

登录卡片会显示「后端未连接」并给出可读的错误提示，界面停留在登录态；这是设计内的降级行为，
不是页面崩溃。启动后端后刷新页面即可正常登录。

### 4. 联调测试方式

打开浏览器 F12：

1. **Console**：查看报错（登录失败、发送失败、解析异常）
2. **Network**：确认请求头是否携带 `Authorization: Bearer ...`、返回内容与状态码
3. **Application → Local Storage**：确认 `sov-session` 中只有 token 与展示信息，**没有密码**

命令行快速验证（后端已启动时）：

```bash
# 注册（公开频道注册即入群）
curl -X POST http://127.0.0.1:8443/auth/register \
     -H "Content-Type: application/json" \
     -d '{"userId":"bob","password":"bobpass123","displayName":"鲍勃"}'

# 用返回的 token 调用受保护接口
curl http://127.0.0.1:8443/auth/me -H "Authorization: Bearer <token>"
```

## 当前待实现清单

1. 回复、编辑消息的完整业务逻辑（当前仅 UI，无后端提交）
2. 真正的 E2EE 解密实现（当前 `ciphertext` 只是 base64 占位）
3. 正在输入提示、在线状态（当前"在线人数"实为成员总数）
4. 附件、图片上传发送（后端 `/files/*` 已就绪，前端未接入）
5. 消息搜索
6. 多频道历史缓存与后端多群组支持
7. WebSocket / 断线重连（当前为 3 秒轮询）
8. 记住登录时长、「记住我」与多设备会话管理界面
9. 修改密码 / 忘记密码的前端入口（后端 `/members/set-password` 已支持）

## 自测指引

1. **未登录**：打开页面应收起聊天内容，出现登录卡片；断开后端时应显示「后端未连接」
2. **注册（公开频道）**：注册新账号 → 直接进入聊天 → 发送消息成功；顶栏与侧栏显示显示名
3. **注册（私有群组）**：注册后聊天区提示等待审批，且 Network 面板中**没有** `/chat/messages` 轮询
4. **刷新恢复**：刷新页面应自动恢复登录态并拉回历史消息，无需重新输密码
5. **登出**：点击顶栏退出按钮 → 回到登录卡片，`localStorage` 中 `sov-session` 被清除
6. **错误分支**：错误密码、重复注册、非法用户名、两次密码不一致均应给出可读提示
7. **主题**：切换白天/黑夜/自适应，检查登录卡片、聊天界面背景与组件样式均正常
8. **消息分组**：同一账号连续发送多条，确认分组、头像隐藏、分割线位置正确

## 更新记录

> 后续所有**工作任务模式**产出的变更，仅更新本文档，旧迭代历史不保留。
> 修改完成后同步更新此README：功能、配置、注意事项、待实现清单。