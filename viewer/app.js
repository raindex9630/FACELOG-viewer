(() => {
  "use strict";

  const config = window.FACELOG_VIEWER_CONFIG || {};
  const BATCH_SIZE = 60;
  const VIEWER_CACHE_PREFIX = "facelog-viewer-";
  const REFRESH_STATE_KEY = "facelog.refreshState";
  const state = {
    root: null,
    rootUrl: "",
    cloudName: "",
    sets: [],
    currentSet: null,
    currentDocument: null,
    baseExpressions: [],
    gridItems: [],
    previewItems: [],
    renderedCount: 0,
    activeExpression: -1,
    selectedVariant: null,
    frequentOnly: false,
    touchStart: null,
    isRefreshing: false,
  };

  const elements = {};
  let imageObserver = null;
  let gridObserver = null;

  document.addEventListener("DOMContentLoaded", initialize);

  function initialize() {
    for (const id of [
      "backButton", "refreshButton", "pageTitle", "pageSubtitle", "statusPanel",
      "statusMessage", "characterView", "characterSearch", "updatedAt", "characterList",
      "favoriteSetSection", "favoriteSetList", "favoriteSetCount", "characterEmpty",
      "expressionView", "variantSwitcher", "frequentOnly", "expressionGrid", "gridSentinel",
      "expressionEmpty", "setupDialog", "setupForm", "cloudNameInput", "setupError",
      "lightbox", "closeLightbox", "previousExpression", "nextExpression", "fullImage",
      "fullImageLoading", "lightboxName", "lightboxCounter", "characterCardTemplate",
      "expressionCardTemplate",
    ]) elements[id] = document.getElementById(id);

    elements.characterSearch.addEventListener("input", renderSets);
    elements.backButton.addEventListener("click", showSetView);
    elements.refreshButton.addEventListener("click", completeRefresh);
    elements.frequentOnly.addEventListener("change", () => {
      state.frequentOnly = elements.frequentOnly.checked;
      resetExpressionGrid();
    });
    elements.setupForm.addEventListener("submit", saveViewerSetup);
    elements.closeLightbox.addEventListener("click", closeLightbox);
    elements.previousExpression.addEventListener("click", () => moveExpression(-1));
    elements.nextExpression.addEventListener("click", () => moveExpression(1));
    elements.lightbox.addEventListener("click", (event) => {
      if (event.target === elements.lightbox) closeLightbox();
    });
    elements.lightbox.addEventListener("touchstart", rememberTouchStart, { passive: true });
    elements.lightbox.addEventListener("touchend", handleSwipe, { passive: true });
    window.addEventListener("keydown", handleKeyboard);
    window.addEventListener("online", () => setNetworkHint("オンラインに戻りました。再読み込みできます。"));
    window.addEventListener("offline", () => setNetworkHint("オフラインです。ネット接続を確認してください。"));

    imageObserver = "IntersectionObserver" in window
      ? new IntersectionObserver(loadVisibleImages, { rootMargin: "240px 0px" })
      : null;
    gridObserver = "IntersectionObserver" in window
      ? new IntersectionObserver(loadNextBatch, { rootMargin: "500px 0px" })
      : null;

    const query = new URLSearchParams(location.search);
    const refreshToken = query.get("_refresh") || "";
    const refreshResumeState = refreshToken ? takeRefreshResumeState() : null;
    removeRefreshParameter();
    const suppliedManifest = query.get("manifest");
    const suppliedCloud = query.get("cloud");
    state.cloudName = suppliedCloud || config.cloudName || localStorage.getItem("facelog.cloudName") || "";
    if (suppliedManifest) {
      state.rootUrl = new URL(suppliedManifest, location.href).href;
      loadRootManifest({ refreshToken, resumeState: refreshResumeState });
    } else if (state.cloudName) {
      state.rootUrl = rawUrl(state.cloudName, config.rootManifestPublicId || "expression-viewer/manifests/root.json");
      loadRootManifest({ refreshToken, resumeState: refreshResumeState });
    } else {
      elements.statusPanel.hidden = true;
      elements.setupDialog.hidden = false;
      elements.cloudNameInput.focus();
    }
  }

  function saveViewerSetup(event) {
    event.preventDefault();
    const cloudName = elements.cloudNameInput.value.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(cloudName)) {
      elements.setupError.textContent = "Cloud nameの形式を確認してください。";
      return;
    }
    localStorage.setItem("facelog.cloudName", cloudName);
    state.cloudName = cloudName;
    state.rootUrl = rawUrl(cloudName, config.rootManifestPublicId || "expression-viewer/manifests/root.json");
    elements.setupDialog.hidden = true;
    loadRootManifest();
  }

  async function loadRootManifest(options = {}) {
    showLoading("同期済みデータを読み込んでいます…");
    try {
      const root = await fetchJson(state.rootUrl, { refreshToken: options.refreshToken });
      validateRootManifest(root);
      state.root = root;
      state.cloudName = root.cloudName || state.cloudName;
      state.sets = root.sets;
      const resumeSet = options.resumeState
        ? findMatchingSet(state.sets, options.resumeState.set)
        : null;
      if (resumeSet) {
        state.frequentOnly = Boolean(options.resumeState.frequentOnly);
        await openSet(resumeSet, {
          preferredVariant: options.resumeState.selectedVariant,
          refreshToken: options.refreshToken,
        });
      } else {
        showSetView();
      }
    } catch (error) {
      showError(friendlyFetchError(error, "セット一覧を取得できませんでした。"));
    }
  }

  async function openSet(set, options = {}) {
    const previousVariant = options.preferredVariant || state.selectedVariant;
    state.currentSet = set;
    elements.characterView.hidden = true;
    elements.expressionView.hidden = true;
    elements.backButton.hidden = false;
    elements.pageTitle.textContent = set.name;
    elements.pageSubtitle.textContent = `${set.expressionCount || 0}件`;
    elements.pageSubtitle.hidden = false;
    showLoading("表情差分を読み込んでいます…");
    try {
      const document = await fetchJson(resolveSetManifestUrl(set), { refreshToken: options.refreshToken });
      validateSetManifest(document);
      state.currentDocument = document;
      state.baseExpressions = document.expressions
        .map((expression, sourceIndex) => ({ expression, sourceIndex }))
        .sort((left, right) => Number(left.expression.order) - Number(right.expression.order))
        .map((item) => item.expression);
      state.selectedVariant = (
        previousVariant && (options.preserveVariant || options.preferredVariant) && document.variantOrder.includes(previousVariant)
          ? previousVariant
          : document.variantOrder.includes("normal")
            ? "normal"
            : document.variantOrder[0]
      );
      elements.pageTitle.textContent = document.set.name;
      elements.pageSubtitle.textContent = document.set.isFavorite
        ? `★ 現行　${state.baseExpressions.length}件`
        : `${state.baseExpressions.length}件`;
      elements.frequentOnly.checked = state.frequentOnly;
      renderVariantSwitcher();
      elements.statusPanel.hidden = true;
      elements.expressionView.hidden = false;
      resetExpressionGrid();
    } catch (error) {
      showError(friendlyFetchError(error, "表情一覧を取得できませんでした。"));
    }
  }

  function showSetView() {
    if (gridObserver) gridObserver.unobserve(elements.gridSentinel);
    if (imageObserver) imageObserver.disconnect();
    state.currentSet = null;
    state.currentDocument = null;
    state.baseExpressions = [];
    state.gridItems = [];
    state.previewItems = [];
    state.renderedCount = 0;
    state.selectedVariant = null;
    elements.expressionGrid.replaceChildren();
    elements.statusPanel.hidden = true;
    elements.expressionView.hidden = true;
    elements.characterView.hidden = false;
    elements.backButton.hidden = true;
    elements.pageTitle.textContent = "FACELOG";
    elements.pageSubtitle.hidden = true;
    elements.updatedAt.textContent = state.root?.updatedAt ? `最終更新 ${formatDate(state.root.updatedAt)}` : "";
    renderSets();
  }

  function renderSets() {
    if (imageObserver) imageObserver.disconnect();
    const query = elements.characterSearch.value.trim().toLocaleLowerCase("ja");
    const visible = state.sets.filter((set) =>
      `${set.name || ""} ${set.characterName || ""} ${set.scenarioName || ""}`
        .toLocaleLowerCase("ja")
        .includes(query)
    );
    const favorites = visible.filter((set) => set.isFavorite);
    renderSetCards(elements.favoriteSetList, favorites);
    elements.favoriteSetSection.hidden = favorites.length === 0;
    elements.favoriteSetCount.textContent = `${favorites.length}件`;
    renderSetCards(elements.characterList, visible);
    elements.characterEmpty.hidden = visible.length !== 0;
  }

  function renderSetCards(container, sets) {
    const fragment = document.createDocumentFragment();
    for (const set of sets) {
      const card = elements.characterCardTemplate.content.firstElementChild.cloneNode(true);
      const monogram = card.querySelector(".character-monogram");
      monogram.textContent = firstGlyph(set.name);
      if (set.thumbnail) {
        const image = document.createElement("img");
        image.className = "character-thumbnail";
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.dataset.src = setThumbnailUrl(set.thumbnail);
        image.addEventListener("error", () => image.remove(), { once: true });
        monogram.append(image);
        if (imageObserver) imageObserver.observe(image); else image.src = image.dataset.src;
      }
      card.querySelector("strong").textContent = set.name || "名称未設定";
      const subtitle = card.querySelector(".character-subtitle");
      subtitle.textContent = set.isFavorite ? "★ 現行" : "";
      subtitle.hidden = !set.isFavorite;
      card.querySelector(".expression-count").textContent = `${set.expressionCount || 0}件`;
      card.addEventListener("click", () => openSet(set));
      fragment.append(card);
    }
    container.replaceChildren(fragment);
  }

  function renderVariantSwitcher() {
    const fragment = document.createDocumentFragment();
    for (const variantKey of state.currentDocument.variantOrder) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "variant-button";
      button.dataset.variantKey = variantKey;
      button.textContent = state.currentDocument.variantLabels[variantKey];
      button.setAttribute("aria-pressed", String(variantKey === state.selectedVariant));
      button.addEventListener("click", () => selectVariant(variantKey));
      fragment.append(button);
    }
    elements.variantSwitcher.replaceChildren(fragment);
  }

  function selectVariant(variantKey) {
    if (!state.currentDocument.variantOrder.includes(variantKey) || variantKey === state.selectedVariant) return;
    state.selectedVariant = variantKey;
    renderVariantSwitcher();
    resetExpressionGrid();
  }

  function buildCurrentItems() {
    const gridItems = [];
    const previewItems = [];
    for (const expression of state.baseExpressions) {
      const variant = expression.variants[state.selectedVariant] || null;
      if (state.frequentOnly && (!expression.frequent || !variant)) continue;
      const item = {
        baseExpressionId: expression.id,
        displayLabel: expression.displayLabels[state.selectedVariant],
        order: expression.order,
        variant,
        previewIndex: -1,
      };
      if (variant) {
        item.previewIndex = previewItems.length;
        previewItems.push(item);
      }
      gridItems.push(item);
    }
    state.gridItems = gridItems;
    state.previewItems = previewItems;
  }

  function resetExpressionGrid() {
    if (gridObserver) gridObserver.unobserve(elements.gridSentinel);
    if (imageObserver) imageObserver.disconnect();
    state.renderedCount = 0;
    state.activeExpression = -1;
    elements.expressionGrid.replaceChildren();
    buildCurrentItems();
    elements.expressionEmpty.hidden = state.gridItems.length !== 0;
    renderExpressionBatch();
    if (gridObserver && state.renderedCount < state.gridItems.length) {
      gridObserver.observe(elements.gridSentinel);
    }
  }

  function renderExpressionBatch() {
    const end = Math.min(state.renderedCount + BATCH_SIZE, state.gridItems.length);
    const fragment = document.createDocumentFragment();
    for (let index = state.renderedCount; index < end; index += 1) {
      const item = state.gridItems[index];
      const card = elements.expressionCardTemplate.content.firstElementChild.cloneNode(true);
      const image = card.querySelector("img");
      const frame = card.querySelector(".thumbnail-frame");
      const placeholder = card.querySelector(".thumbnail-placeholder");
      card.dataset.baseExpressionId = item.baseExpressionId;
      card.dataset.order = String(item.order);
      card.dataset.variantKey = state.selectedVariant;
      card.querySelector("strong").textContent = item.displayLabel;
      if (!item.variant) {
        card.disabled = true;
        card.classList.add("missing-variant");
        card.setAttribute("aria-label", `${item.displayLabel}（画像なし）`);
        placeholder.textContent = "画像なし";
        image.remove();
      } else {
        image.alt = `${item.displayLabel}のサムネイル`;
        image.dataset.src = thumbnailUrl(item.variant);
        image.addEventListener("load", () => { placeholder.hidden = true; });
        image.addEventListener("error", () => {
          image.remove();
          placeholder.textContent = "画像を表示できません";
          frame.classList.add("image-error");
        }, { once: true });
        card.addEventListener("click", () => openLightbox(item.previewIndex));
        if (imageObserver) imageObserver.observe(image); else image.src = image.dataset.src;
      }
      fragment.append(card);
    }
    elements.expressionGrid.append(fragment);
    state.renderedCount = end;
    elements.gridSentinel.hidden = state.renderedCount >= state.gridItems.length;
  }

  function loadVisibleImages(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      imageObserver.unobserve(image);
      image.src = image.dataset.src;
      delete image.dataset.src;
    }
  }

  function loadNextBatch(entries) {
    if (entries.some((entry) => entry.isIntersecting) && state.renderedCount < state.gridItems.length) renderExpressionBatch();
  }

  function openLightbox(index) {
    if (!state.previewItems[index]) return;
    state.activeExpression = index;
    elements.lightbox.hidden = false;
    document.body.style.overflow = "hidden";
    updateLightbox();
    elements.closeLightbox.focus();
  }

  function closeLightbox() {
    elements.lightbox.hidden = true;
    elements.fullImage.removeAttribute("src");
    document.body.style.overflow = "";
    state.activeExpression = -1;
  }

  function updateLightbox() {
    const item = state.previewItems[state.activeExpression];
    if (!item?.variant) return;
    elements.fullImage.hidden = true;
    elements.fullImageLoading.textContent = "画像を読み込んでいます…";
    elements.fullImageLoading.hidden = false;
    elements.fullImage.alt = `${item.displayLabel}の拡大画像`;
    elements.fullImage.onload = () => {
      elements.fullImage.hidden = false;
      elements.fullImageLoading.hidden = true;
    };
    elements.fullImage.onerror = () => {
      elements.fullImage.hidden = true;
      elements.fullImageLoading.hidden = false;
      elements.fullImageLoading.textContent = "画像を表示できません";
    };
    elements.fullImage.src = fullImageUrl(item.variant);
    elements.lightboxName.textContent = item.displayLabel;
    elements.lightboxCounter.textContent = `${state.activeExpression + 1} / ${state.previewItems.length}`;
    elements.previousExpression.disabled = state.activeExpression <= 0;
    elements.nextExpression.disabled = state.activeExpression >= state.previewItems.length - 1;
    preloadAdjacent();
  }

  function moveExpression(delta) {
    const next = state.activeExpression + delta;
    if (next < 0 || next >= state.previewItems.length) return;
    state.activeExpression = next;
    updateLightbox();
  }

  function preloadAdjacent() {
    for (const index of [state.activeExpression - 1, state.activeExpression + 1]) {
      const item = state.previewItems[index];
      if (!item?.variant) continue;
      const image = new Image();
      image.src = fullImageUrl(item.variant);
    }
  }

  function rememberTouchStart(event) {
    if (event.touches.length !== 1) { state.touchStart = null; return; }
    state.touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  function handleSwipe(event) {
    if (!state.touchStart || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - state.touchStart.x;
    const dy = event.changedTouches[0].clientY - state.touchStart.y;
    state.touchStart = null;
    if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy) * 1.35) moveExpression(dx < 0 ? 1 : -1);
  }

  function handleKeyboard(event) {
    if (elements.lightbox.hidden) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") moveExpression(-1);
    if (event.key === "ArrowRight") moveExpression(1);
  }

  async function completeRefresh() {
    if (state.isRefreshing) return;
    setRefreshButtonBusy(true);
    showLoading("Viewerと最新データを完全更新しています…");
    try {
      await updateViewerServiceWorker();
      await deleteViewerCaches();
      const refreshToken = Date.now().toString();
      const resumeState = await preflightLatestManifests(refreshToken);
      saveRefreshResumeState(resumeState);
      location.replace(buildRefreshUrl(location.href, refreshToken));
    } catch (error) {
      setRefreshButtonBusy(false);
      showError(friendlyFetchError(error, "最新データを取得できませんでした。"));
    }
  }

  function setRefreshButtonBusy(isBusy) {
    state.isRefreshing = isBusy;
    elements.refreshButton.disabled = isBusy;
    elements.refreshButton.classList.toggle("is-refreshing", isBusy);
    elements.refreshButton.setAttribute("aria-busy", String(isBusy));
  }

  async function updateViewerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.update();
  }

  async function deleteViewerCaches() {
    if (!("caches" in window)) return;
    const cacheNames = await window.caches.keys();
    const viewerCacheNames = cacheNames.filter(isViewerCacheName);
    await Promise.all(viewerCacheNames.map((cacheName) => window.caches.delete(cacheName)));
  }

  function isViewerCacheName(cacheName) {
    return typeof cacheName === "string" && cacheName.startsWith(VIEWER_CACHE_PREFIX);
  }

  async function preflightLatestManifests(refreshToken) {
    if (!state.rootUrl) return null;
    const root = await fetchJson(state.rootUrl, { refreshToken });
    validateRootManifest(root);
    if (!state.currentSet) return null;

    const resumeState = createRefreshResumeState();
    const currentSet = findMatchingSet(root.sets, resumeState.set);
    if (!currentSet) return null;
    const cloudName = root.cloudName || state.cloudName;
    const document = await fetchJson(
      resolveSetManifestUrl(currentSet, state.rootUrl, cloudName),
      { refreshToken }
    );
    validateSetManifest(document);
    return resumeState;
  }

  function createRefreshResumeState() {
    return {
      set: createSetIdentity(state.currentSet),
      selectedVariant: state.selectedVariant,
      frequentOnly: state.frequentOnly,
    };
  }

  function createSetIdentity(set) {
    const identity = {};
    for (const key of ["id", "setId", "manifestPublicId", "manifestUrl", "name"]) {
      if (set?.[key] !== undefined && set[key] !== null && set[key] !== "") identity[key] = set[key];
    }
    return identity;
  }

  function findMatchingSet(sets, identity) {
    if (!Array.isArray(sets) || !identity) return null;
    for (const key of ["id", "setId", "manifestPublicId", "manifestUrl", "name"]) {
      if (identity[key] === undefined || identity[key] === null || identity[key] === "") continue;
      const match = sets.find((set) => String(set?.[key]) === String(identity[key]));
      if (match) return match;
    }
    return null;
  }

  function saveRefreshResumeState(resumeState) {
    try {
      if (resumeState) sessionStorage.setItem(REFRESH_STATE_KEY, JSON.stringify(resumeState));
      else sessionStorage.removeItem(REFRESH_STATE_KEY);
    } catch (_) {
      // sessionStorageを利用できない環境でも、完全更新そのものは続行する。
    }
  }

  function takeRefreshResumeState() {
    try {
      const value = sessionStorage.getItem(REFRESH_STATE_KEY);
      sessionStorage.removeItem(REFRESH_STATE_KEY);
      return value ? JSON.parse(value) : null;
    } catch (_) {
      return null;
    }
  }

  function removeRefreshParameter() {
    const url = new URL(location.href);
    if (!url.searchParams.has("_refresh")) return;
    url.searchParams.delete("_refresh");
    try {
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {
      // URLを整理できない環境でも、manifestの再取得とViewer起動は続行する。
    }
  }

  function buildRefreshUrl(url, refreshToken) {
    const value = new URL(url);
    value.searchParams.set("_refresh", refreshToken);
    return value.href;
  }

  function resolveSetManifestUrl(set, rootUrl = state.rootUrl, cloudName = state.cloudName) {
    if (set.manifestUrl) return new URL(set.manifestUrl, rootUrl).href;
    return rawUrl(cloudName, set.manifestPublicId, set.manifestVersion);
  }

  function thumbnailUrl(variant) {
    if (variant.iconUrl) return new URL(variant.iconUrl, state.rootUrl).href;
    return imageUrl(variant, "f_auto,q_auto");
  }

  function setThumbnailUrl(thumbnail) {
    if (thumbnail.iconUrl) return new URL(thumbnail.iconUrl, state.rootUrl).href;
    return imageUrl(thumbnail, "f_auto,q_auto,c_limit,w_192");
  }

  function fullImageUrl(variant) {
    if (variant.iconUrl) return new URL(variant.iconUrl, state.rootUrl).href;
    return imageUrl(variant, "");
  }

  function imageUrl(variant, transformation) {
    const publicId = encodePublicId(variant.publicId);
    const version = variant.version ? `v${variant.version}/` : "";
    const transform = transformation ? `${transformation}/` : "";
    const format = variant.format ? `.${encodeURIComponent(variant.format)}` : "";
    return `https://res.cloudinary.com/${encodeURIComponent(state.cloudName)}/image/upload/${transform}${version}${publicId}${format}`;
  }

  function rawUrl(cloudName, publicId, version) {
    const versionPath = version ? `v${version}/` : "";
    return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/raw/upload/${versionPath}${encodePublicId(publicId)}`;
  }

  function encodePublicId(publicId) {
    return String(publicId || "").split("/").map(encodeURIComponent).join("/");
  }

  async function fetchJson(url, options = {}) {
    const requestUrl = options.refreshToken ? withRefreshToken(url, options.refreshToken) : url;
    const response = await fetch(requestUrl, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`http-${response.status}`);
    return response.json();
  }

  function withRefreshToken(url, refreshToken) {
    const value = new URL(url, location.href);
    value.searchParams.set("refresh", refreshToken);
    return value.href;
  }

  function validateRootManifest(root) {
    if (!root || root.schemaVersion !== 3 || !Array.isArray(root.sets)) throw new Error("invalid-root-manifest");
  }

  function validateSetManifest(document) {
    if (
      !document
      || document.schemaVersion !== 3
      || !document.set
      || !Array.isArray(document.variantOrder)
      || !document.variantLabels
      || !Array.isArray(document.expressions)
      || document.variantOrder.some((key) => !document.variantLabels[key])
      || document.expressions.some((expression) => (
        typeof expression.order !== "number"
        || !expression.displayLabels
        || document.variantOrder.some((key) => !expression.displayLabels[key])
        || !expression.variants
      ))
    ) throw new Error("invalid-set-manifest");
  }

  function friendlyFetchError(error, fallback) {
    if (!navigator.onLine) return "オフラインです。ネット接続を確認して再読み込みしてください。";
    if (String(error?.message).includes("404")) return `${fallback} Cloudinaryへの初回同期を確認してください。`;
    return fallback;
  }

  function showLoading(message) {
    elements.statusPanel.classList.remove("error");
    elements.statusMessage.textContent = message;
    elements.statusPanel.hidden = false;
  }

  function showError(message) {
    elements.statusPanel.classList.add("error");
    elements.statusMessage.textContent = message;
    elements.statusPanel.hidden = false;
  }

  function setNetworkHint(message) {
    if (!elements.statusPanel.hidden) elements.statusMessage.textContent = message;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function firstGlyph(value) {
    return Array.from(String(value || "?").trim())[0] || "?";
  }

  window.FaceLogViewer = {
    BATCH_SIZE,
    VIEWER_CACHE_PREFIX,
    buildRefreshUrl,
    deleteViewerCaches,
    encodePublicId,
    findMatchingSet,
    imageUrl,
    isViewerCacheName,
    preflightLatestManifests,
    rawUrl,
    removeRefreshParameter,
    selectVariant,
    state,
    updateViewerServiceWorker,
    withRefreshToken,
  };
})();
