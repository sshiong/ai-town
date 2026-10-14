export const coreMessages: Record<string, string> = {
  'AI Town': 'AI 小镇',
  'View original text': '查看英文原文',
  'Translation unavailable. Original text shown.': '翻译暂不可用，当前显示原文。',
  'Translating… Original text shown.': '正在翻译…当前显示原文。',
  'A virtual town where AI characters live, chat and socialize.':
    '一个让 AI 居民生活、聊天和交朋友的虚拟小镇。',
  Help: '帮助',
  'Help modal': '帮助说明',
  Star: '收藏项目',
  'Town admin': '小镇管理',
  Settings: '设置',
  Language: '界面语言',
  'Close settings': '关闭设置',
  'Language changes apply immediately and are saved in this browser.':
    '切换立即生效，语言偏好保存在此浏览器中。',
  'Interface language does not change residents’ conversations or model settings.':
    '界面语言不会改变居民的对话内容或模型设置。',
  'Welcome to AI town. AI town supports both anonymous spectators and logged in interactivity.':
    '欢迎来到 AI 小镇。你可以匿名观看，也可以登录后参与互动。',
  Spectating: '观看小镇',
  'Click and drag to move around the town, and scroll in and out to zoom. You can click on an individual character to view its chat history.':
    '拖动地图可以移动视角，滚动鼠标可以缩放。点击居民即可查看其聊天记录。',
  Interactivity: '参与互动',
  'If you log in, you can join the simulation and directly talk to different agents! After logging in, click the "Interact" button, and your character will appear somewhere on the map with a highlighted circle underneath you.':
    '登录后，你可以加入小镇，与不同的 AI 居民直接交流。点击“参与互动”，你的角色就会出现在地图上，脚下会显示醒目的圆圈。',
  'Controls:': '操作说明：',
  'Click to navigate around.': '点击地图即可移动。',
  'To talk to an agent, click on them and then click "Start conversation," which will ask them to start walking towards you. Once they\'re nearby, the conversation will start, and you can speak to each other. You can leave at any time by closing the conversation pane or moving away. They may propose a conversation to you - you\'ll see a button to accept in the messages panel.':
    '点击居民，再点击“开始对话”，居民就会走向你。靠近后即可聊天。关闭对话面板或走开可以结束对话。居民也可能主动邀请你，你可以在消息面板中接受邀请。',
  "AI town only supports {count} humans at a time. If you're idle for five minutes, you'll be automatically removed from the simulation.":
    '小镇最多同时容纳 {count} 位玩家。闲置五分钟后，你会自动离开小镇。',
  'Town administration': '小镇管理',
  'Close town administration': '关闭小镇管理',
  'AI Town · Direct federation': 'AI 小镇 · 直连联邦',
  'Administrator access': '管理员登录',
  'Enter the token configured as FEDERATION_ADMIN_TOKEN on this server. Town simulation continues independently of this panel.':
    '输入服务器上配置的 FEDERATION_ADMIN_TOKEN。小镇模拟会独立于此面板继续运行。',
  'Checking administrator access': '正在验证管理员权限',
  'Session storage is unavailable. Uncheck remember and try again.':
    '会话存储不可用。请取消勾选记住令牌后重试。',
  'Admin token': '管理员令牌',
  "Remember in this browser tab's session": '在此浏览器标签页的会话中记住令牌',
  'By default, the token stays in memory. Close this tab or lock the panel to clear access.':
    '默认情况下，令牌只保存在内存中。关闭标签页或锁定面板即可清除访问权限。',
  'The town server is not connected. Access checks will become available after reconnection.':
    '尚未连接小镇服务器。重新连接后即可验证权限。',
  'Open administration': '进入管理',
  'Administration sections': '管理分类',
  Federation: '联邦设置',
  'Travel & visitors': '旅行与访客',
  'Models & memory': '模型与记忆',
  'Data & backups': '数据与备份',
  Lock: '锁定',
  'Connection interrupted. Displayed values may be stale; operations wait for the server.':
    '连接已中断。显示的数据可能过时，操作正在等待服务器响应。',
  'Saved.': '已保存。',
  'The request failed. Please try again.': '请求失败，请重试。',
  'Server error details': '服务器错误详情',
  'Loading the town…': '正在加载小镇…',
  'Town service unavailable': '小镇服务不可用',
  'The server could not load this view. Check the deployment and server logs, then retry.':
    '服务器无法加载此页面。请检查部署和服务器日志后重试。',
  'Retry view': '重新加载',
  'Connecting to the town server…': '正在连接小镇服务器…',
  'Connection interrupted. Check the deployment URL and network; pending operations are waiting for the server.':
    '连接中断。请检查部署地址和网络，待处理操作正在等待服务器。',
  'AI Town · Deployment setup': 'AI 小镇 · 部署设置',
  'Your town awaits': '你的小镇准备就绪',
  'Connect the town server': '连接小镇服务器',
  'Add the Convex deployment URL as VITE_CONVEX_URL in your frontend environment, then restart the frontend.':
    '在前端环境中将 Convex 部署地址配置为 VITE_CONVEX_URL，然后重启前端。',
  "Initialize the backend world before opening the map. Federation administration also requires the server's FEDERATION_ADMIN_TOKEN. No world data is loaded until a server is configured.":
    '打开地图前请初始化后端世界。联邦管理还需要服务器的 FEDERATION_ADMIN_TOKEN。配置服务器后才会加载世界数据。',
  'Read deployment instructions ↗': '阅读部署说明 ↗',
};
