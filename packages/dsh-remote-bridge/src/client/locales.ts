/**
 * `remote-bridge` namespace dictionaries: the protocol v1 pairing panel copy and
 * the header of an interactive card (§35.11).
 *
 * The panel has one job — put the live one-shot code in front of the operator as
 * a QR symbol — so its copy carries what to do with the symbol, how long it
 * lives, what kind of address the phone will dial, why the code is single-use,
 * and that the app is still in testing: the reader is told what they are joining
 * and where to ask about it. No key renders the public origin: the symbol
 * already carries it, and a durable public hostname printed as text would
 * outlive every screenshot it appears in. A LAN literal is not that fact — it
 * answers only inside the network this page is already on — so the LAN line
 * keeps naming it. No key states how the host finds either address, and no key
 * names the wire protocol: both are implementation facts the reader cannot act
 * on.
 *
 * The card's keys say only what the transcript row can act on: whether the page
 * is still waiting for the operator, that it is over, that this desktop renders
 * without answering, and that a page carrying nothing or too much draws a
 * sentence instead of a frame.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  "mode.label": "配对方式",
  "mode.local": "本机配对",
  "mode.remote": "远程配对",
  "remote.subtitle": "在已验证的所有者会话中，为服务器信任的 HTTPS 地址生成一次性配对码。",
  "remote.loading": "正在验证所有者身份和远程配对配置…",
  "remote.addressLabel": "远程 HTTPS 地址",
  "remote.trusted": "服务器信任的地址：{origin}",
  "remote.ownerVerified": "所有者身份已验证；地址须在服务器允许列表中。",
  "remote.ready": "准备就绪。点击生成配对码，不会自动取码。",
  "remote.generate": "生成配对码",
  "remote.disabled": "服务器未启用远程配对，或尚未配置可信 HTTPS 地址。请在服务器配置后重试。",
  "remote.unauthorized": "需要所有者登录。请先登录此 Web UI，再重试。",
  "remote.forbidden": "服务器拒绝远程配对。请检查所有者权限和服务器的远程配对配置。",
  "remote.unknownOrigin": "此地址不在服务器允许列表中。请选择已配置的 HTTPS 地址；此处不能添加信任。",
  "remote.failed": "远程配对请求失败或响应无效，请重试并检查服务器配置。",
  "remote.unreachable": "无法连接服务器，请检查网络后重试。",

  'entry.label': '配对 iPhone',
  'title': 'iOS App 配对',
  'subtitle': '用 iOS App（内测）扫描二维码，把 iPhone 连到这台电脑上。配对码只在本机显示。',
  'state.reading': '正在取配对码…',
  'pair.qrLabel': '配对二维码',
  'pair.countdown': '剩余 {s} 秒',
  'pair.expired': '配对码已过期',
  'pair.refresh': '重新取码',
  'pair.usedHint': '配对码一次性有效：iPhone 一开始配对就作废，重新取码也会作废上一张。',
  'origin.public': '二维码已包含公网地址，扫码后 iPhone 自动连上这台电脑',
  'origin.lan': '二维码指向局域网地址 {origin}，iPhone 需与本机在同一网络',
  'origin.missing': '没有找到公网地址：先在 App 里把连接地址填成你的公网中继，再扫码。本页的 {host} 只有本机能连。',
  'community.invite': 'iOS App 还在内测，欢迎来 Discord 交流',
  'forbidden.title': '这个页面不是从本机打开的',
  'forbidden.body': '配对码只能在本机 Web UI 上取。请在本机浏览器打开 http://127.0.0.1:<端口> 后重试。',
  'failed.title': '取配对码失败',
  'failed.body': '宿主返回了 HTTP {status}，请刷新页面后重试。',
  'unreachable.title': '无法连接本机宿主',
  'unreachable.body': '请求没有到达宿主，请确认 dsh web 仍在运行后重试。',
  'action.close': '关闭',
  'action.copy': '复制配对码',
  'action.copied': '已复制',
  'action.copyFailed': '复制失败',
  'action.retry': '重试',
  'card.waiting': '等你操作',
  'card.settled': '已结算',
  'card.answerOnPhone': '在手机上作答',
  'card.interacted': '已收到页面上的操作，但桌面端不作答：在手机上作答',
  'card.frameLabel': '整页卡片',
  'card.empty': '这次调用没有可渲染的页面',
  'card.oversize': '页面超出大小上限，未渲染',
} as const

/** English dictionary, key-for-key with the zh source. */
export const en: Record<RemoteBridgeKey, string> = {
  "mode.label": "Pairing mode",
  "mode.local": "Local pairing",
  "mode.remote": "Remote pairing",
  "remote.subtitle": "Generate a one-time code for a server-approved HTTPS address in an authenticated owner session.",
  "remote.loading": "Checking owner access and remote pairing configuration…",
  "remote.addressLabel": "Remote HTTPS address",
  "remote.trusted": "Server-approved address: {origin}",
  "remote.ownerVerified": "Owner access verified; the address must be on the server allowlist.",
  "remote.ready": "Ready. Click Generate code; no code is issued automatically.",
  "remote.generate": "Generate code",
  "remote.disabled": "Remote pairing is disabled or no trusted HTTPS address is configured. Configure it on the server and retry.",
  "remote.unauthorized": "Owner sign-in required. Sign in to this Web UI and retry.",
  "remote.forbidden": "The server refused remote pairing. Check owner permissions and the server remote pairing configuration.",
  "remote.unknownOrigin": "This address is not on the server allowlist. Choose a configured HTTPS address; trust cannot be added here.",
  "remote.failed": "Remote pairing failed or returned an invalid response. Retry and check server configuration.",
  "remote.unreachable": "Cannot reach the server. Check your connection and retry.",

  'entry.label': 'Pair an iPhone',
  'title': 'iOS app pairing',
  'subtitle': 'Scan the QR code with the iOS app (beta) to connect an iPhone to this computer. The code is shown only on this machine.',
  'state.reading': 'Requesting a pairing code…',
  'pair.qrLabel': 'Pairing QR code',
  'pair.countdown': '{s} s left',
  'pair.expired': 'The pairing code expired',
  'pair.refresh': 'New code',
  'pair.usedHint': 'The code is single-use: pairing spends it, and a new code voids the previous one.',
  'origin.public': 'The QR code carries the public address: the iPhone connects to this computer as soon as it scans',
  'origin.lan': 'The QR code points at the LAN address {origin}: the iPhone must be on the same network',
  'origin.missing': 'No public address found: set the connection address in the app to your public relay first, then scan. {host} (this page) is reachable only from this machine.',
  'community.invite': 'The iOS app is in beta. Come talk to us on Discord',
  'forbidden.title': 'This page is not open on this machine',
  'forbidden.body': 'Pairing codes can only be read from the machine itself. Open http://127.0.0.1:<port> in a browser on this machine and retry.',
  'failed.title': 'Could not read a pairing code',
  'failed.body': 'The host answered HTTP {status}. Reload the page and retry.',
  'unreachable.title': 'Cannot reach the local host',
  'unreachable.body': 'The request never reached the host. Check that dsh web is still running and retry.',
  'action.close': 'Close',
  'action.copy': 'Copy pairing code',
  'action.copied': 'Copied',
  'action.copyFailed': 'Copy failed',
  'action.retry': 'Retry',
  'card.waiting': 'Waiting for you',
  'card.settled': 'Settled',
  'card.answerOnPhone': 'Answer on the phone',
  'card.interacted': 'The page sent an action, but this desktop does not answer: answer on the phone',
  'card.frameLabel': 'Page card',
  'card.empty': 'This call carried no page to render',
  'card.oversize': 'The page is over the size limit and was not rendered',
}

/** Every key the `remote-bridge` namespace carries. */
export type RemoteBridgeKey = keyof typeof zh

/** Russian uses the established English fallback for untranslated existing copy. */
export const ru: Record<RemoteBridgeKey, string> = { ...en,
  "mode.label": "Способ сопряжения",
  "mode.local": "Локальное сопряжение",
  "mode.remote": "Удалённое сопряжение",
  "remote.subtitle": "Создайте одноразовый код для разрешённого сервером HTTPS-адреса в сеансе владельца.",
  "remote.loading": "Проверка доступа владельца и настроек удалённого сопряжения…",
  "remote.addressLabel": "Удалённый HTTPS-адрес",
  "remote.trusted": "Разрешённый сервером адрес: {origin}",
  "remote.ownerVerified": "Доступ владельца подтверждён; адрес должен быть разрешён сервером.",
  "remote.ready": "Всё готово. Нажмите «Создать код»; автоматически код не создаётся.",
  "remote.generate": "Создать код",
  "remote.disabled": "Удалённое сопряжение отключено или доверенный HTTPS-адрес не настроен. Проверьте настройки сервера.",
  "remote.unauthorized": "Требуется вход владельца. Войдите в этот веб-интерфейс и повторите попытку.",
  "remote.forbidden": "Сервер отказал в удалённом сопряжении. Проверьте права владельца и настройки сервера.",
  "remote.unknownOrigin": "Адрес не разрешён сервером. Выберите настроенный HTTPS-адрес; добавить доверие здесь нельзя.",
  "remote.failed": "Ошибка удалённого сопряжения или неверный ответ. Повторите попытку и проверьте сервер.",
  "remote.unreachable": "Сервер недоступен. Проверьте подключение и повторите попытку.",
}
