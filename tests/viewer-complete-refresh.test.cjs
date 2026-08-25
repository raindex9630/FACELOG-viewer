const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repositoryRoot = path.resolve(__dirname, "..");
const appPath = path.join(repositoryRoot, "viewer", "app.js");
const indexPath = path.join(repositoryRoot, "viewer", "index.html");
const manifestPath = path.join(repositoryRoot, "viewer", "manifest.webmanifest");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "deploy-viewer.yml");
const appSource = fs.readFileSync(appPath, "utf8");
const indexSource = fs.readFileSync(indexPath, "utf8");
const workflowSource = fs.readFileSync(workflowPath, "utf8");

function loadViewerEnvironment(options = {}) {
  const window = { FACELOG_VIEWER_CONFIG: {}, ...options.window };
  const location = options.location || new URL("https://example.test/FACELOG-viewer/?cloud=sample#top");
  const sandbox = {
    URL,
    URLSearchParams,
    console,
    document: { addEventListener() {} },
    fetch: options.fetch,
    history: options.history || { replaceState() {}, state: null },
    location,
    navigator: { onLine: true, ...options.navigator },
    window,
  };
  vm.runInNewContext(appSource, sandbox, { filename: appPath });
  return { helpers: window.FaceLogViewer, sandbox, window };
}

function loadViewerHelpers() {
  return loadViewerEnvironment().helpers;
}

test("static assets and web manifest use the deployment build version", () => {
  for (const asset of ["manifest.webmanifest", "styles.css", "config.js", "app.js"]) {
    assert.match(indexSource, new RegExp(`${asset.replace(".", "\\.")}\\?v=__BUILD_VERSION__`));
  }
  assert.match(indexSource, /id="refreshButton"[^>]+aria-label="Viewerと最新データを完全更新"/);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(manifestPath, "utf8")));
});

test("complete refresh preserves existing query parameters and replaces only _refresh", () => {
  const helpers = loadViewerHelpers();
  const refreshed = new URL(helpers.buildRefreshUrl(
    "https://example.test/FACELOG-viewer/?cloud=sample&manifest=https%3A%2F%2Fcdn.test%2Froot.json&_refresh=old#sets",
    "123456"
  ));
  assert.equal(refreshed.searchParams.get("cloud"), "sample");
  assert.equal(refreshed.searchParams.get("manifest"), "https://cdn.test/root.json");
  assert.equal(refreshed.searchParams.get("_refresh"), "123456");
  assert.equal(refreshed.hash, "#sets");
});

test("temporary _refresh is removed without removing persistent query settings", () => {
  const replacements = [];
  const { helpers } = loadViewerEnvironment({
    history: {
      state: { viewer: true },
      replaceState(state, title, url) { replacements.push({ state, title, url }); },
    },
    location: new URL("https://example.test/FACELOG-viewer/?cloud=sample&_refresh=123#sets"),
  });
  helpers.removeRefreshParameter();
  assert.deepEqual(replacements, [{
    state: { viewer: true },
    title: "",
    url: "/FACELOG-viewer/?cloud=sample#sets",
  }]);
});

test("failure to clean the temporary URL does not stop Viewer startup", () => {
  const { helpers } = loadViewerEnvironment({
    history: {
      state: null,
      replaceState() { throw new Error("history-unavailable"); },
    },
    location: new URL("https://example.test/FACELOG-viewer/?_refresh=123"),
  });
  assert.doesNotThrow(() => helpers.removeRefreshParameter());
});

test("manifest cache buster preserves the manifest URL and adds refresh token", () => {
  const helpers = loadViewerHelpers();
  const refreshed = new URL(helpers.withRefreshToken("https://cdn.test/root.json?version=7", "987"));
  assert.equal(refreshed.searchParams.get("version"), "7");
  assert.equal(refreshed.searchParams.get("refresh"), "987");
});

test("Cache Storage deletion is limited to FACELOG Viewer cache names", async () => {
  const deleted = [];
  const { helpers } = loadViewerEnvironment({
    window: {
      caches: {
        async delete(cacheName) { deleted.push(cacheName); return true; },
        async keys() { return ["facelog-viewer-v1", "another-app-v1", "facelog-viewer-assets-abc"]; },
      },
    },
  });
  assert.equal(helpers.VIEWER_CACHE_PREFIX, "facelog-viewer-");
  assert.equal(helpers.isViewerCacheName("facelog-viewer-v1"), true);
  assert.equal(helpers.isViewerCacheName("facelog-viewer-assets-abc"), true);
  assert.equal(helpers.isViewerCacheName("another-app-v1"), false);
  assert.equal(helpers.isViewerCacheName("facelog-viewer"), false);
  await helpers.deleteViewerCaches();
  assert.deepEqual(deleted, ["facelog-viewer-v1", "facelog-viewer-assets-abc"]);
});

test("an open set can be matched against the refreshed root manifest", () => {
  const helpers = loadViewerHelpers();
  const sets = [
    { id: "set-1", name: "Alice", manifestPublicId: "sets/alice.json" },
    { id: "set-2", name: "Bob", manifestPublicId: "sets/bob-v2.json" },
  ];
  assert.equal(helpers.findMatchingSet(sets, { id: "set-2" }).name, "Bob");
  assert.equal(helpers.findMatchingSet(sets, { name: "Alice" }).id, "set-1");
  assert.equal(helpers.findMatchingSet(sets, { id: "missing" }), null);
});

test("complete refresh runs update, scoped cache deletion, manifest preflight, then HTML navigation", () => {
  const start = appSource.indexOf("async function completeRefresh()");
  const end = appSource.indexOf("function setRefreshButtonBusy", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = appSource.slice(start, end);
  const expectedOrder = [
    "setRefreshButtonBusy(true)",
    "await updateViewerServiceWorker()",
    "await deleteViewerCaches()",
    "await preflightLatestManifests(refreshToken)",
    "location.replace(buildRefreshUrl(location.href, refreshToken))",
  ];
  let previous = -1;
  for (const marker of expectedOrder) {
    const position = implementation.indexOf(marker);
    assert.ok(position > previous, `${marker} must appear in refresh order`);
    previous = position;
  }
  assert.match(implementation, /setRefreshButtonBusy\(false\)/);
  assert.doesNotMatch(appSource, /location\.reload\s*\(/);
});

test("manifest fetches bypass browser cache and service worker update is conditional", () => {
  assert.match(appSource, /fetch\(requestUrl, \{ cache: "no-store"/);
  assert.match(appSource, /navigator\.serviceWorker\.getRegistration\(\)/);
  assert.match(appSource, /registration\.update\(\)/);
  assert.match(appSource, /localStorage\.getItem\("facelog\.cloudName"\)/);
  assert.doesNotMatch(appSource, /localStorage\.removeItem\("facelog\.cloudName"\)/);
});

test("complete refresh preflights the newest root and current set manifests", async () => {
  const requests = [];
  const root = {
    schemaVersion: 3,
    cloudName: "fixture",
    sets: [{ id: "set-1", name: "Alice", manifestUrl: "character-v2.json" }],
  };
  const setDocument = {
    schemaVersion: 3,
    set: { id: "set-1", name: "Alice" },
    variantOrder: ["normal"],
    variantLabels: { normal: "通常" },
    expressions: [],
  };
  const { helpers } = loadViewerEnvironment({
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      const body = requests.length === 1 ? root : setDocument;
      return { ok: true, async json() { return body; } };
    },
  });
  helpers.state.rootUrl = "https://cdn.test/root.json";
  helpers.state.cloudName = "fixture";
  helpers.state.currentSet = { id: "set-1", name: "Alice", manifestUrl: "character-v1.json" };
  helpers.state.selectedVariant = "normal";
  helpers.state.frequentOnly = true;

  const resumeState = await helpers.preflightLatestManifests("123456");

  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get("refresh"), "123456");
  assert.equal(new URL(requests[1].url).pathname, "/character-v2.json");
  assert.equal(new URL(requests[1].url).searchParams.get("refresh"), "123456");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(requests[1].options.cache, "no-store");
  assert.equal(resumeState.set.id, "set-1");
  assert.equal(resumeState.selectedVariant, "normal");
  assert.equal(resumeState.frequentOnly, true);
});

test("an existing service worker registration receives an update check", async () => {
  let updateCount = 0;
  const { helpers } = loadViewerEnvironment({
    navigator: {
      serviceWorker: {
        async getRegistration() {
          return { async update() { updateCount += 1; } };
        },
      },
    },
  });
  await helpers.updateViewerServiceWorker();
  assert.equal(updateCount, 1);
});

test("image loading remains lazy and batched instead of prefetching the full library", () => {
  assert.match(indexSource, /<img alt="" loading="lazy" decoding="async"/);
  assert.match(appSource, /const BATCH_SIZE = 60/);
  assert.match(appSource, /new IntersectionObserver\(loadVisibleImages/);
  assert.match(appSource, /Math\.min\(state\.renderedCount \+ BATCH_SIZE/);
});

test("deployment workflow tests source and versions only the Pages artifact", () => {
  assert.match(workflowSource, /node --test tests\/viewer-complete-refresh\.test\.cjs/);
  assert.match(workflowSource, /BUILD_VERSION: \$\{\{ github\.sha \}\}/);
  assert.match(workflowSource, /cp -R viewer\/\. _site\//);
  assert.match(workflowSource, /sed -i "s\/__BUILD_VERSION__\/\$\{BUILD_VERSION\}\/g" _site\/index\.html/);
  assert.match(workflowSource, /path: "\.\/_site"/);
  assert.doesNotMatch(workflowSource, /sed -i[^\n]+viewer\/index\.html/);
});
