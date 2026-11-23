# AMO listing: paste-ready text (Foxhand 0.5.7)

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
• Read a page in parts: an accessibility snapshot, text, HTML, links only, or a screenshot of one element or the whole page
• Click, type, fill forms, choose from dropdowns, hover, drag, upload files, scroll, press keys, and wait for content (or for a spinner to go)
• Run its own JavaScript on a page, with your logins
• Read iframes from other sites, such as cookie banners
• Search bookmarks and history, download files, read and set cookies, keep notes between tasks, restore closed tabs

While it works, a cursor glides to whatever it's clicking, with an orange bubble saying what it's doing. It works in background tabs and doesn't switch what you're looking at unless you ask. Press Ctrl+Shift+. (or the toolbar button) to pause every command at once, including JavaScript on pages.

How it works: Firefox add-ons can't open network ports, so the add-on starts a small companion helper app through Firefox native messaging. The helper serves MCP only on localhost (this computer), and every request needs a random secret token that the add-on generates. Browsing data is not sent to the developer or any third party by the add-on. Your AI tool talks to the helper, and the helper talks to this add-on.

Setup (about a minute): a setup page opens when you install it.
1. Paste one line to install the helper. macOS and Linux: curl -fsSL https://foxhand.pages.dev/download/sh | sh. Windows (PowerShell): irm https://foxhand.pages.dev/download/ps | iex
2. Copy the config for your AI (Claude Code, Codex, Gemini CLI, opencode, the Claude app, or any MCP client).
3. Ask your AI to do something in Firefox.

Safety:
• Local only by default; token-protected
• Text from web pages is marked untrusted, so a site can't give the AI orders
• Closing tabs or windows and deleting bookmarks or cookies need explicit confirmation
• No access to saved passwords
• Page pop-ups (alert, confirm) are answered "Cancel" unless the AI explicitly accepts

Available in English, Spanish, French, German and Simplified Chinese.

Source code for the add-on and the helper (MPL 2.0): https://github.com/hamb1y/foxhand

---

## Español (es)

### Resumen

Deja que tu agente de IA (Claude Code, Codex, Gemini CLI, cualquier cliente MCP) use este Firefox: tus pestañas y sesiones. Un cursor muestra lo que hace. Corre en tu computadora. Requiere una pequeña app auxiliar gratuita. Antes WebMCP Controller.

### Descripción

Foxhand conecta el Firefox que ya usas (tus pestañas, sesiones iniciadas y marcadores) con un agente de IA que se ejecuta en tu propia computadora, a través del Model Context Protocol (MCP). Hasta la versión 0.5 se llamaba WebMCP Controller.

Lo que puede hacer el agente:
• Listar, abrir, cambiar y cerrar pestañas y ventanas
• Leer una página por partes: instantánea de accesibilidad, texto, HTML, solo enlaces, o una captura de pantalla de un elemento o de toda la página
• Hacer clic, escribir, llenar formularios, elegir en listas desplegables, pasar el cursor, arrastrar, subir archivos, desplazarse, presionar teclas y esperar contenido (o a que desaparezca un indicador de carga)
• Ejecutar su propio JavaScript en una página, con tus sesiones
• Leer iframes de otros sitios, como los banners de cookies
• Buscar en marcadores e historial, descargar archivos, leer y definir cookies, conservar notas entre tareas, restaurar pestañas cerradas

Mientras trabaja, un cursor se desliza hasta lo que está haciendo clic, con una burbuja naranja que dice lo que hace. Funciona en pestañas en segundo plano y no cambia lo que estás viendo, a menos que lo pidas. Presiona Ctrl+Mayús+. (o el botón de la barra de herramientas) para pausar todos los comandos a la vez, incluido el JavaScript de las páginas.

Cómo funciona: los complementos de Firefox no pueden abrir puertos de red, así que el complemento inicia una pequeña app auxiliar mediante la mensajería nativa de Firefox. La app auxiliar sirve MCP solo en localhost (esta computadora) y cada solicitud necesita un token secreto aleatorio que genera el complemento. El complemento no envía datos de navegación al desarrollador ni a terceros. Tu herramienta de IA se comunica con la app auxiliar, y esta se comunica con el complemento.

Configuración (alrededor de un minuto): al instalarlo se abre una página de configuración.
1. Pega una línea para instalar la app auxiliar. macOS y Linux: curl -fsSL https://foxhand.pages.dev/download/sh | sh. Windows (PowerShell): irm https://foxhand.pages.dev/download/ps | iex
2. Copia la configuración para tu IA (Claude Code, Codex, Gemini CLI, opencode, la app de Claude o cualquier cliente MCP).
3. Pídele a tu IA que haga algo en Firefox.

Seguridad:
• Solo local de forma predeterminada; protegido con token
• El texto de las páginas web se marca como no confiable, así que un sitio no puede dar órdenes a la IA
• Cerrar pestañas o ventanas y borrar marcadores o cookies requieren confirmación explícita
• Sin acceso a contraseñas guardadas
• Las ventanas emergentes de la página (alert, confirm) se responden con «Cancelar», salvo que la IA las acepte explícitamente

Disponible en inglés, español, francés, alemán y chino simplificado.

Código fuente (MPL 2.0): https://github.com/hamb1y/foxhand

---

## Français (fr)

### Résumé

Laissez un agent IA (Claude Code, Codex, Gemini CLI, tout client MCP) utiliser ce Firefox : vos onglets et sessions. Un curseur montre son action. Tourne sur votre ordinateur. Nécessite une petite app d’aide gratuite. Ex-WebMCP Controller.

### Description

Foxhand relie le Firefox que vous utilisez déjà (vos onglets, sessions ouvertes et marque-pages) à un agent IA qui tourne sur votre propre ordinateur, via le Model Context Protocol (MCP). Jusqu’à la version 0.5, il s’appelait WebMCP Controller.

Ce que l’agent peut faire :
• Lister, ouvrir, changer et fermer des onglets et des fenêtres
• Lire une page par parties : instantané d’accessibilité, texte, HTML, seulement les liens, ou une capture d’écran d’un élément ou de toute la page
• Cliquer, saisir du texte, remplir des formulaires, choisir dans les listes déroulantes, survoler, glisser-déposer, envoyer des fichiers, faire défiler, appuyer sur des touches et attendre du contenu (ou la disparition d’un indicateur de chargement)
• Exécuter son propre JavaScript sur une page, avec vos sessions
• Lire les iframes d’autres sites, comme les bandeaux de cookies
• Chercher dans les marque-pages et l’historique, télécharger des fichiers, lire et définir des cookies, conserver des notes entre les tâches, rouvrir des onglets fermés

Pendant qu’il travaille, un curseur glisse vers ce qu’il clique, avec une bulle orange qui indique ce qu’il fait. Il travaille dans les onglets en arrière-plan et ne change pas ce que vous regardez, sauf si vous le demandez. Appuyez sur Ctrl+Maj+. (ou sur le bouton de la barre d’outils) pour mettre toutes les commandes en pause d’un coup, y compris le JavaScript des pages.

Fonctionnement : les extensions Firefox ne peuvent pas ouvrir de ports réseau ; l’extension lance donc une petite application d’assistance via la messagerie native de Firefox. L’assistant sert MCP uniquement sur localhost (cet ordinateur) et chaque requête exige un jeton secret aléatoire généré par l’extension. L’extension n’envoie pas les données de navigation au développeur ni à un tiers. Votre outil d’IA parle à l’assistant, et l’assistant parle à cette extension.

Installation (environ une minute) : une page de configuration s’ouvre à l’installation.
1. Collez une ligne pour installer l’assistant. macOS et Linux : curl -fsSL https://foxhand.pages.dev/download/sh | sh. Windows (PowerShell) : irm https://foxhand.pages.dev/download/ps | iex
2. Copiez la configuration pour votre IA (Claude Code, Codex, Gemini CLI, opencode, l’application Claude ou tout client MCP).
3. Demandez à votre IA de faire quelque chose dans Firefox.

Sécurité :
• Local uniquement par défaut ; protégé par jeton
• Le texte des pages web est marqué comme non fiable, si bien qu’un site ne peut pas donner d’ordres à l’IA
• Fermer des onglets ou des fenêtres et supprimer des marque-pages ou des cookies exige une confirmation explicite
• Aucun accès aux mots de passe enregistrés
• Les fenêtres pop-up de la page (alert, confirm) reçoivent la réponse « Annuler », sauf si l’IA les accepte explicitement

Disponible en anglais, espagnol, français, allemand et chinois simplifié.

Code source (MPL 2.0) : https://github.com/hamb1y/foxhand

---

## Deutsch (de)

### Zusammenfassung

Lassen Sie Ihren KI-Agenten (Claude Code, Codex, Gemini CLI, jeder MCP-Client) dieses Firefox nutzen: Ihre Tabs und Anmeldungen. Ein Cursor zeigt sein Tun. Läuft auf Ihrem Computer. Benötigt eine kleine kostenlose Hilfs-App. Früher WebMCP Controller.

### Beschreibung

Foxhand verbindet das Firefox, das Sie ohnehin nutzen (Ihre Tabs, Anmeldungen und Lesezeichen), über das Model Context Protocol (MCP) mit einem KI-Agenten auf Ihrem eigenen Computer. Bis Version 0.5 hieß es WebMCP Controller.

Was der Agent kann:
• Tabs und Fenster auflisten, öffnen, wechseln und schließen
• Seiten in Teilen lesen: Barrierefreiheits-Schnappschuss, Text, HTML, nur Links oder ein Bildschirmfoto eines Elements oder der ganzen Seite
• Klicken, tippen, Formulare ausfüllen, aus Auswahllisten wählen, mit der Maus darüberfahren, ziehen, Dateien hochladen, scrollen, Tasten drücken und auf Inhalte warten (oder darauf, dass ein Ladesymbol verschwindet)
• Eigenes JavaScript auf einer Seite ausführen, mit Ihren Anmeldungen
• iFrames anderer Websites lesen, etwa Cookie-Banner
• Lesezeichen und Chronik durchsuchen, Dateien herunterladen, Cookies lesen und setzen, Notizen zwischen Aufgaben behalten, geschlossene Tabs wiederherstellen

Während er arbeitet, gleitet ein Cursor zu dem, was er gerade anklickt, mit einer orangen Sprechblase, die sagt, was er tut. Er arbeitet in Hintergrund-Tabs und wechselt nicht, was Sie gerade sehen, außer Sie bitten darum. Mit Strg+Umschalt+. (oder der Schaltfläche in der Symbolleiste) halten Sie alle Befehle auf einmal an, auch JavaScript auf Seiten.

So funktioniert es: Firefox-Add-ons können keine Netzwerk-Ports öffnen, deshalb startet das Add-on über das Native Messaging von Firefox eine kleine Hilfs-App. Die Hilfs-App stellt MCP nur auf localhost (diesem Computer) bereit, und jede Anfrage braucht ein zufälliges geheimes Token, das das Add-on erzeugt. Das Add-on sendet keine Browsing-Daten an den Entwickler oder an Dritte. Ihr KI-Tool spricht mit der Hilfs-App, und die Hilfs-App spricht mit diesem Add-on.

Einrichtung (etwa eine Minute): Nach der Installation öffnet sich eine Einrichtungsseite.
1. Eine Zeile einfügen, um die Hilfs-App zu installieren. macOS und Linux: curl -fsSL https://foxhand.pages.dev/download/sh | sh. Windows (PowerShell): irm https://foxhand.pages.dev/download/ps | iex
2. Kopieren Sie die Konfiguration für Ihre KI (Claude Code, Codex, Gemini CLI, opencode, die Claude-App oder jeden MCP-Client).
3. Bitten Sie Ihre KI, etwas in Firefox zu erledigen.

Sicherheit:
• Standardmäßig nur lokal; durch Token geschützt
• Text von Webseiten wird als nicht vertrauenswürdig markiert, sodass eine Website der KI keine Befehle geben kann
• Tabs oder Fenster schließen und Lesezeichen oder Cookies löschen erfordert eine ausdrückliche Bestätigung
• Kein Zugriff auf gespeicherte Passwörter
• Pop-ups der Seite (alert, confirm) werden mit „Abbrechen“ beantwortet, sofern die KI sie nicht ausdrücklich akzeptiert

Verfügbar auf Englisch, Spanisch, Französisch, Deutsch und vereinfachtem Chinesisch.

Quellcode (MPL 2.0): https://github.com/hamb1y/foxhand

---

## 简体中文 (zh-CN)

### 摘要

让你自己的 AI 智能体（Claude Code、Codex、Gemini CLI 或任何 MCP 客户端）使用这个 Firefox：你的标签页和登录状态。光标会显示它在做什么。在你的电脑上本地运行。需要一个免费的小型辅助程序。原名 WebMCP Controller。

### 描述

Foxhand 通过 Model Context Protocol（MCP），把你正在使用的 Firefox（你的标签页、登录状态和书签）连接到在你自己电脑上运行的 AI 智能体。0.5 版本之前它叫 WebMCP Controller。

智能体可以：
• 列出、打开、切换和关闭标签页与窗口
• 分部分阅读页面：无障碍快照、文本、HTML、仅链接，或某个元素或整页的截图
• 点击、输入、填写表单、从下拉菜单中选择、悬停、拖动、上传文件、滚动、按键，以及等待内容出现（或等待加载指示消失）
• 在页面上运行它自己的 JavaScript，使用你的登录状态
• 读取其他网站的 iframe，如 Cookie 横幅
• 搜索书签和历史记录、下载文件、读取和设置 Cookie、在任务之间保留笔记、恢复已关闭的标签页

工作时，光标会移动到它要点击的位置，旁边的橙色气泡会说明它在做什么。它在后台标签页中工作，除非你要求，否则不会切换你正在看的页面。按 Ctrl+Shift+.（或点击工具栏按钮）可以一次暂停所有命令，包括页面上的 JavaScript。

工作原理：Firefox 扩展无法打开网络端口，所以扩展会通过 Firefox 的原生消息机制启动一个小型辅助程序。辅助程序只在 localhost（本机）上提供 MCP 服务，每个请求都需要扩展生成的随机密钥令牌。扩展不会把浏览数据发送给开发者或任何第三方。你的 AI 工具与辅助程序通信，辅助程序再与这个扩展通信。

设置（大约一分钟）：安装后会打开设置页面。
1. 粘贴一行命令安装辅助程序。macOS 和 Linux：curl -fsSL https://foxhand.pages.dev/download/sh | sh。Windows（PowerShell）：irm https://foxhand.pages.dev/download/ps | iex
2. 为你的 AI 复制配置（Claude Code、Codex、Gemini CLI、opencode、Claude 应用或任何 MCP 客户端）。
3. 让你的 AI 在 Firefox 里做点事。

安全：
• 默认仅限本机；受令牌保护
• 网页文本会被标记为不可信，因此网站无法向 AI 下达指令
• 关闭标签页或窗口、删除书签或 Cookie 都需要明确确认
• 无法访问已保存的密码
• 页面弹窗（alert、confirm）默认选择“取消”，除非 AI 明确接受

提供以下语言：英语、西班牙语、法语、德语和简体中文。

源代码（MPL 2.0）：https://github.com/hamb1y/foxhand

---

## Privacy policy
Foxhand sends no data externally.
Your harness and model provider using Foxhand, such as Pi or Claude Code may do this however.

We collect anonymized usage analytics, using no third-parties. This data does exit your computer.

## Notes to reviewer
The domain transition changes installer links to https://foxhand.pages.dev/download/sh and /download/ps, direct downloads to /download/latest/, and announcements to https://foxhand.pages.dev/endpoint/announcement. Versioned downloads redirect to the original GitHub Release assets and installers verify their published checksums. The legacy GitHub Pages installers and announcement feed remain available. The extension ID, native host name, announcement content and seen IDs are unchanged.

Announcements contain JSON data only, with a 10-second timeout and 64 KiB limit. announcement.js recreates HTML using an allowlist and HTTPS links; scripts, handlers, styles, embeds and forms are discarded. Executable code and styling ship in the add-on. Each ID is shown once per profile; seen IDs remain local. The privacy policy discloses Cloudflare requests. The current community announcement asks for recommendations, honest reviews, GitHub stars and feedback; no rewards are offered.

Foxhand was renamed from WebMCP Controller; the add-on ID is unchanged. It uses native messaging with an open-source helper. Extension scripts are TypeScript (extension/src) bundled by esbuild, unminified and without a runtime, into build/extension. To rebuild: Node 22, "npm ci", then "bash scripts/pack-extension.sh" writes foxhand.zip with the submitted files. Locales are generated from i18n/*.json by scripts/i18n.mjs.

Helper source: https://github.com/hamb1y/foxhand/tree/main/mcp-server (TypeScript, compiled to single-file binaries with `bun build --compile`). Release binaries and SHA256SUMS are at https://github.com/hamb1y/foxhand/releases/latest

To test:
1. Install the add-on; a setup page opens. Install the helper:
   Linux/macOS: curl -fsSL https://foxhand.pages.dev/download/sh | sh
   Windows (PowerShell): irm https://foxhand.pages.dev/download/ps | iex
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
