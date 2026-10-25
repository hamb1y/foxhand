# AMO listing: paste-ready text (Foxhand 0.5.2)

AMO keeps a name, summary and description per language: Developer Hub →
Edit Product Page, then switch the language at the top of the form. English is
the default; the others are below.

## Name
Foxhand

## Add-on URL (slug)
`foxhand` (currently `webmcp-controller`; changing it is optional, and the old
link keeps working only if AMO redirects it, so check before announcing the new one)

## Categories
Firefox: "Tabs"

## Support
Website: https://github.com/hamb1y/foxhand/issues

## License
Mozilla Public License 2.0

---

## English (default)

### Summary (max 250 chars)
Let your own AI agent (Claude Code, Codex, Gemini CLI, any MCP client) use this Firefox: your tabs, your logins. A cursor shows what it's doing. Runs on your computer. Needs a small free helper app. Formerly WebMCP Controller.

### Description
Foxhand connects the Firefox you already use (your tabs, logins and bookmarks) to an AI agent running on your own computer, through the Model Context Protocol (MCP). It was called WebMCP Controller until version 0.5.

What the agent can do:
• List, open, switch and close tabs and windows
• Read pages (accessibility snapshot, text, HTML, screenshots), including same-origin frames
• Click, type, fill forms, choose from dropdowns, drag, upload files, scroll, press keys and wait for content
• Search bookmarks and history, download files, read and set cookies, keep notes between tasks, restore closed tabs

While it works, a cursor glides to whatever it's clicking, with an orange bubble saying what it's doing. Press Ctrl+Shift+. (or the toolbar button) to pause every command at once.

How it works: Firefox add-ons can't open network ports, so the add-on starts a small companion helper app through Firefox native messaging. The helper serves MCP only on localhost (this computer), and every request needs a random secret token that the add-on generates. Nothing is sent to the developer or any third party. Your AI tool talks to the helper, and the helper talks to this add-on.

Setup (about a minute): a setup page opens when you install it.
1. Paste one line to install the helper. macOS and Linux: curl -fsSL https://hamb1y.github.io/foxhand/sh | sh. Windows (PowerShell): irm https://hamb1y.github.io/foxhand/ps | iex
2. Copy the config for your AI (Claude Code, Codex, Gemini CLI, opencode, the Claude app, or any MCP client).
3. Ask your AI to do something in Firefox.

Safety:
• Local only by default; token-protected
• Closing tabs or windows and deleting bookmarks or cookies need explicit confirmation
• No access to saved passwords
• Page pop-ups (alert, confirm) are answered "Cancel" unless the AI explicitly accepts

Available in English, Spanish, French, German and Simplified Chinese.

Source code for the add-on and the helper (MPL 2.0): https://github.com/hamb1y/foxhand

---

## Español (es)

### Resumen
Deja que tu propio agente de IA (Claude Code, Codex, Gemini CLI, cualquier cliente MCP) use este Firefox: tus pestañas, tus sesiones. Un cursor muestra lo que hace. Funciona en tu computadora. Requiere una pequeña app auxiliar gratuita.

### Descripción
Foxhand conecta el Firefox que ya usas (tus pestañas, sesiones iniciadas y marcadores) con un agente de IA que se ejecuta en tu propia computadora, a través del Model Context Protocol (MCP). Hasta la versión 0.5 se llamaba WebMCP Controller.

Lo que puede hacer el agente:
• Listar, abrir, cambiar y cerrar pestañas y ventanas
• Leer páginas (instantánea de accesibilidad, texto, HTML, capturas de pantalla), incluidos los marcos del mismo origen
• Hacer clic, escribir, llenar formularios, elegir en listas desplegables, arrastrar, subir archivos, desplazarse, presionar teclas y esperar contenido
• Buscar en marcadores e historial, descargar archivos, leer y definir cookies, conservar notas entre tareas, restaurar pestañas cerradas

Mientras trabaja, un cursor se desliza hasta lo que está tocando, con una burbuja naranja que dice lo que hace. Presiona Ctrl+Mayús+. (o el botón de la barra de herramientas) para pausar todos los comandos a la vez.

Cómo funciona: los complementos de Firefox no pueden abrir puertos de red, así que el complemento inicia una pequeña app auxiliar mediante la mensajería nativa de Firefox. La app auxiliar sirve MCP solo en localhost (esta computadora) y cada solicitud necesita un token secreto aleatorio que genera el complemento. No se envía nada al desarrollador ni a terceros.

Configuración (alrededor de un minuto): al instalarlo se abre una página de configuración.
1. Pega una línea para instalar la app auxiliar. macOS y Linux: curl -fsSL https://hamb1y.github.io/foxhand/sh | sh. Windows (PowerShell): irm https://hamb1y.github.io/foxhand/ps | iex
2. Copia la configuración para tu IA.
3. Pídele a tu IA que haga algo en Firefox.

Seguridad:
• Solo local de forma predeterminada; protegido con token
• Cerrar pestañas o ventanas y borrar marcadores o cookies requieren confirmación explícita
• Sin acceso a contraseñas guardadas

Código fuente (MPL 2.0): https://github.com/hamb1y/foxhand

---

## Français (fr)

### Résumé
Laissez votre propre agent IA (Claude Code, Codex, Gemini CLI, tout client MCP) utiliser ce Firefox : vos onglets, vos sessions. Un curseur montre ce qu’il fait. Fonctionne sur votre ordinateur. Nécessite une petite application d’assistance gratuite.

### Description
Foxhand relie le Firefox que vous utilisez déjà (vos onglets, sessions ouvertes et marque-pages) à un agent IA qui tourne sur votre propre ordinateur, via le Model Context Protocol (MCP). Jusqu’à la version 0.5, il s’appelait WebMCP Controller.

Ce que l’agent peut faire :
• Lister, ouvrir, changer et fermer des onglets et des fenêtres
• Lire des pages (instantané d’accessibilité, texte, HTML, captures d’écran), y compris les cadres de même origine
• Cliquer, saisir du texte, remplir des formulaires, choisir dans les listes déroulantes, glisser-déposer, envoyer des fichiers, faire défiler, appuyer sur des touches et attendre du contenu
• Chercher dans les marque-pages et l’historique, télécharger des fichiers, lire et définir des cookies, conserver des notes entre les tâches, rouvrir des onglets fermés

Pendant qu’il travaille, un curseur glisse vers ce qu’il touche, avec une bulle orange qui indique ce qu’il fait. Appuyez sur Ctrl+Maj+. (ou sur le bouton de la barre d’outils) pour mettre toutes les commandes en pause d’un coup.

Fonctionnement : les extensions Firefox ne peuvent pas ouvrir de ports réseau ; l’extension lance donc une petite application d’assistance via la messagerie native de Firefox. L’assistant sert MCP uniquement sur localhost (cet ordinateur) et chaque requête exige un jeton secret aléatoire généré par l’extension. Rien n’est envoyé au développeur ni à des tiers.

Installation (environ une minute) : une page de configuration s’ouvre à l’installation.
1. Collez une ligne pour installer l’assistant. macOS et Linux : curl -fsSL https://hamb1y.github.io/foxhand/sh | sh. Windows (PowerShell) : irm https://hamb1y.github.io/foxhand/ps | iex
2. Copiez la configuration pour votre IA.
3. Demandez à votre IA de faire quelque chose dans Firefox.

Sécurité :
• Local uniquement par défaut ; protégé par jeton
• Fermer des onglets ou des fenêtres et supprimer des marque-pages ou des cookies exige une confirmation explicite
• Aucun accès aux mots de passe enregistrés

Code source (MPL 2.0) : https://github.com/hamb1y/foxhand

---

## Deutsch (de)

### Zusammenfassung
Lassen Sie Ihren eigenen KI-Agenten (Claude Code, Codex, Gemini CLI, jeder MCP-Client) dieses Firefox nutzen: Ihre Tabs, Ihre Anmeldungen. Ein Cursor zeigt, was er tut. Läuft auf Ihrem Computer. Benötigt eine kleine kostenlose Hilfs-App.

### Beschreibung
Foxhand verbindet das Firefox, das Sie ohnehin nutzen (Ihre Tabs, Anmeldungen und Lesezeichen), über das Model Context Protocol (MCP) mit einem KI-Agenten auf Ihrem eigenen Computer. Bis Version 0.5 hieß es WebMCP Controller.

Was der Agent kann:
• Tabs und Fenster auflisten, öffnen, wechseln und schließen
• Seiten lesen (Barrierefreiheits-Schnappschuss, Text, HTML, Bildschirmfotos), auch Frames gleichen Ursprungs
• Klicken, tippen, Formulare ausfüllen, aus Auswahllisten wählen, ziehen, Dateien hochladen, scrollen, Tasten drücken und auf Inhalte warten
• Lesezeichen und Chronik durchsuchen, Dateien herunterladen, Cookies lesen und setzen, Notizen zwischen Aufgaben behalten, geschlossene Tabs wiederherstellen

Während er arbeitet, gleitet ein Cursor zu dem, was er gerade anklickt, mit einer orangen Sprechblase, die sagt, was er tut. Mit Strg+Umschalt+. (oder der Schaltfläche in der Symbolleiste) halten Sie alle Befehle auf einmal an.

So funktioniert es: Firefox-Add-ons können keine Netzwerk-Ports öffnen, deshalb startet das Add-on über das Native Messaging von Firefox eine kleine Hilfs-App. Die Hilfs-App stellt MCP nur auf localhost (diesem Computer) bereit, und jede Anfrage braucht ein zufälliges geheimes Token, das das Add-on erzeugt. Es wird nichts an den Entwickler oder Dritte gesendet.

Einrichtung (etwa eine Minute): Nach der Installation öffnet sich eine Einrichtungsseite.
1. Eine Zeile einfügen, um die Hilfs-App zu installieren. macOS und Linux: curl -fsSL https://hamb1y.github.io/foxhand/sh | sh. Windows (PowerShell): irm https://hamb1y.github.io/foxhand/ps | iex
2. Die Konfiguration für Ihre KI kopieren.
3. Ihre KI bitten, etwas in Firefox zu erledigen.

Sicherheit:
• Standardmäßig nur lokal; durch Token geschützt
• Tabs oder Fenster schließen und Lesezeichen oder Cookies löschen erfordert eine ausdrückliche Bestätigung
• Kein Zugriff auf gespeicherte Passwörter

Quellcode (MPL 2.0): https://github.com/hamb1y/foxhand

---

## 简体中文 (zh-CN)

### 摘要
让你自己的 AI 智能体（Claude Code、Codex、Gemini CLI 或任何 MCP 客户端）使用这个 Firefox：你的标签页和登录状态。光标会显示它在做什么。在你的电脑上本地运行。需要一个免费的小型辅助程序。

### 描述
Foxhand 通过 Model Context Protocol（MCP），把你正在使用的 Firefox（你的标签页、登录状态和书签）连接到在你自己电脑上运行的 AI 智能体。0.5 版本之前它叫 WebMCP Controller。

智能体可以：
• 列出、打开、切换和关闭标签页与窗口
• 阅读页面（无障碍快照、文本、HTML、截图），包括同源框架
• 点击、输入、填写表单、从下拉菜单中选择、拖动、上传文件、滚动、按键以及等待内容出现
• 搜索书签和历史记录、下载文件、读取和设置 Cookie、在任务之间保留笔记、恢复已关闭的标签页

工作时，光标会移动到它要点击的位置，旁边的橙色气泡会说明它在做什么。按 Ctrl+Shift+.（或点击工具栏按钮）可以一次暂停所有命令。

工作原理：Firefox 扩展无法打开网络端口，所以扩展会通过 Firefox 的原生消息机制启动一个小型辅助程序。辅助程序只在 localhost（本机）上提供 MCP 服务，每个请求都需要扩展生成的随机密钥令牌。不会向开发者或任何第三方发送数据。

设置（大约一分钟）：安装后会打开设置页面。
1. 粘贴一行命令安装辅助程序。macOS 和 Linux：curl -fsSL https://hamb1y.github.io/foxhand/sh | sh。Windows（PowerShell）：irm https://hamb1y.github.io/foxhand/ps | iex
2. 为你的 AI 复制配置。
3. 让你的 AI 在 Firefox 里做点事。

安全：
• 默认仅限本机；受令牌保护
• 关闭标签页或窗口、删除书签或 Cookie 都需要明确确认
• 无法访问已保存的密码

源代码（MPL 2.0）：https://github.com/hamb1y/foxhand

---

## Privacy policy
Foxhand does not collect, store or send any data to the developer or to any third party, and contains no analytics or tracking.

The add-on exchanges data only with the companion helper app on your own computer, through Firefox native messaging. The helper makes that data available only to programs you connect to it on your computer (by default it listens on localhost and requires a secret token that the add-on generates). That data can include tab URLs and titles, page content, screenshots, bookmarks, history, downloads, cookies for a tab, and notes the AI saves in the add-on. The helper sends data only when one of those programs asks for it.

Firefox's data-collection labels on this listing ("browsing activity", "website content" and so on) describe this exchange with programs on your computer, not collection by the developer.

If you connect an AI tool that uses a cloud service, that tool may send what it reads to its provider under that provider's own privacy policy. That's outside this add-on's control.

Settings (port, token, toggles) are stored locally in Firefox extension storage. Uninstalling the add-on removes them.

## Notes to reviewer
Foxhand is WebMCP Controller renamed (same add-on ID). This add-on uses native messaging with an open-source companion helper app, like KeePassXC-Browser or 1Password do. The add-on's JavaScript is not minified or bundled; no build step. `_locales/*/messages.json` are generated from `i18n/*.json` by `scripts/i18n.mjs` and committed as-is.

Helper source: https://github.com/hamb1y/foxhand/tree/main/mcp-server (TypeScript, compiled to single-file binaries with `bun build --compile`). Release binaries and SHA256SUMS are at https://github.com/hamb1y/foxhand/releases/latest

To test:
1. Install the add-on; a setup page opens. Install the helper:
   Linux/macOS: curl -fsSL https://hamb1y.github.io/foxhand/sh | sh
   Windows (PowerShell): irm https://hamb1y.github.io/foxhand/ps | iex
2. The setup page ticks off its first step. Copy the config in step 2 (contains URL + token).
3. From a terminal (replace TOKEN):
   curl -s http://localhost:8901/mcp -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tab_query","arguments":{"query":"*"}}}'
   The open tabs are returned.

Why each permission:
• tabs, <all_urls>, content scripts: read and interact with pages at the user's agent's request; draw the AI cursor
• nativeMessaging: talk to the local helper that serves MCP
• bookmarks, history, downloads, sessions: the corresponding agent tools
• cookies: the cookie_query, cookie_set and cookie_remove tools (cookie_remove needs confirm:true)
• storage: settings, token, and the agent's notebook (storage_get/storage_set/storage_remove)
