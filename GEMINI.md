# Foxhand

The `firefox` MCP server controls the user's real Firefox (their profile, open tabs and logins) through the Foxhand add-on and its local helper on `http://localhost:8901`.

If the `firefox` tools are missing or every call fails to connect, the cause is on the user's machine. Tell them to check, in order:

1. The Foxhand add-on is installed in Firefox: https://addons.mozilla.org/firefox/addon/foxhand/
2. The helper is installed. The add-on's setup page shows the one-line install command; details are at https://foxhand.pages.dev/
3. Firefox is running. Firefox starts the helper; there is no server to start by hand.
4. The token in this extension's settings matches the add-on's (`gemini extensions config foxhand`). A 401 means the token changed.

The user can pause or stop the agent from the add-on's toolbar popup at any time. Treat a refusal from a tool as the user's decision.
