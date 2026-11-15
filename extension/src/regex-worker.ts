// Regex matching is isolated: a malicious pattern must never block Pause or the background page.

/** One tab as the background sends it for matching. */
interface RegexTab { url: string; title: string; }

/** A match request: the patterns (empty means "any") and the tabs to test. */
interface RegexRequest { urlPattern?: string; titlePattern?: string; tabs: RegexTab[]; }

self.onmessage = function (event: MessageEvent<RegexRequest>) {
  try {
    var data = event.data;
    var url = data.urlPattern ? new RegExp(data.urlPattern) : null;
    var title = data.titlePattern ? new RegExp(data.titlePattern) : null;
    self.postMessage({ matches: data.tabs.map(function (tab) {
      return (!url || url.test(tab.url)) && (!title || title.test(tab.title));
    }) });
  } catch (error) { self.postMessage({ error: String((error as Error).message || error) }); }
};

// (a module only so the two interfaces above stay local; the build emits nothing for this)
export {};
