import { createHash } from "node:crypto";
import { scenarioById } from "../scenarios.mjs";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PUBLIC_ORIGIN = "https://dureai.dev";
const REVISION_DIGEST_PLACEHOLDER = "0".repeat(64);

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be non-empty text`);
  }
  return value.trim();
}

function requiredSlug(value, label) {
  const slug = requiredText(value, label);
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`${label} must be lowercase kebab-case`);
  }
  return slug;
}

function normalizeAsset(value, index, lookupScenario) {
  const label = `assets[${index}]`;
  const id = requiredSlug(value?.id, `${label}.id`);
  const scenarioId = requiredSlug(value?.scenarioId, `${label}.scenarioId`);
  if (!lookupScenario(scenarioId)) {
    throw new Error(
      `${label}.scenarioId is not in the media catalog: ${scenarioId}`,
    );
  }
  if (!Number.isSafeInteger(value?.version) || value.version < 1) {
    throw new Error(`${label}.version must be a positive integer`);
  }
  if (!Array.isArray(value?.proofPoints) || value.proofPoints.length === 0) {
    throw new Error(`${label}.proofPoints must contain at least one item`);
  }
  return Object.freeze({
    id,
    version: value.version,
    title: requiredText(value.title, `${label}.title`),
    claim: requiredText(value.claim, `${label}.claim`),
    proofPoints: Object.freeze(
      value.proofPoints.map((point, pointIndex) =>
        requiredText(point, `${label}.proofPoints[${pointIndex}]`),
      ),
    ),
    limitation: requiredText(value.limitation, `${label}.limitation`),
    scenarioId,
    sourceDocument: requiredSlug(
      value.sourceDocument,
      `${label}.sourceDocument`,
    ),
  });
}

function normalizeCatalog(value, lookupScenario) {
  if (value?.schemaVersion !== 1) {
    throw new Error("activation catalog schemaVersion must be 1");
  }
  if (value?.locale !== "en") {
    throw new Error("activation catalog locale must be en");
  }
  const ctaPath = requiredText(value.ctaPath, "ctaPath");
  const parsedCta = new URL(ctaPath, PUBLIC_ORIGIN);
  if (
    !ctaPath.startsWith("/") ||
    ctaPath.startsWith("//") ||
    parsedCta.origin !== PUBLIC_ORIGIN ||
    parsedCta.username !== "" ||
    parsedCta.password !== "" ||
    parsedCta.search !== "" ||
    parsedCta.hash !== "" ||
    parsedCta.pathname !== ctaPath
  ) {
    throw new Error("ctaPath must be an unparameterized dureai.dev path");
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    throw new Error("activation catalog must contain assets");
  }
  const assets = value.assets.map((asset, index) =>
    normalizeAsset(asset, index, lookupScenario),
  );
  const uniqueIds = new Set(assets.map(({ id }) => id));
  if (uniqueIds.size !== assets.length) {
    throw new Error("activation asset ids must be unique");
  }
  return Object.freeze({
    ctaPath: parsedCta.pathname,
    locale: value.locale,
    assets: Object.freeze(assets),
  });
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function trackedUrl(asset, channel, medium, revision) {
  const url = new URL(asset.ctaUrl);
  url.search = new URLSearchParams({
    utm_source: channel,
    utm_medium: medium,
    utm_campaign: asset.campaignId,
    utm_content: revision,
  }).toString();
  return url.toString();
}

function channelDraft(asset, { channel, medium, render }) {
  const placeholderRevision = `v${asset.version}-${REVISION_DIGEST_PLACEHOLDER}`;
  const revisionDigest = sha256Json({
    schemaVersion: 1,
    editorialVersion: asset.version,
    channel,
    medium,
    campaign: asset.campaignId,
    content: render(
      asset,
      trackedUrl(asset, channel, medium, placeholderRevision),
    ),
  });
  const revision = `v${asset.version}-${revisionDigest}`;
  const ctaUrl = trackedUrl(asset, channel, medium, revision);
  const content = Object.freeze(render(asset, ctaUrl));
  return Object.freeze({
    channel,
    revision,
    cohortKey: `${asset.id}@${revision}:${channel}`,
    contentSha256: sha256Json(content),
    attribution: Object.freeze({
      campaign: asset.campaignId,
      content: revision,
      medium,
      source: channel,
      url: ctaUrl,
    }),
    content,
  });
}

function renderBlog(asset, ctaUrl) {
  return {
    title: asset.title,
    summary: asset.claim,
    markdown: [
      asset.claim,
      asset.proofPoints.map((point) => `- ${point}`).join("\n"),
      `Current boundary: ${asset.limitation}`,
      `[Read the evidence](${asset.evidence.sourceUrl})`,
      `[Explore Dure](${ctaUrl})`,
    ].join("\n\n"),
  };
}

function renderX(asset, ctaUrl) {
  return {
    posts: Object.freeze([
      asset.claim,
      `${asset.proofPoints[0]}\n\nBoundary: ${asset.limitation}`,
      `Evidence: ${asset.evidence.sourceUrl}`,
      `Explore Dure: ${ctaUrl}`,
    ]),
  };
}

function renderLongFormText(asset, ctaUrl, pointPrefix = "") {
  return [
    asset.claim,
    ...asset.proofPoints.map((point) => `${pointPrefix}${point}`),
    `Current boundary: ${asset.limitation}`,
    `Evidence: ${asset.evidence.sourceUrl}`,
    `Explore Dure: ${ctaUrl}`,
  ].join("\n\n");
}

function renderLinkedIn(asset, ctaUrl) {
  return { text: renderLongFormText(asset, ctaUrl, "• ") };
}

function renderYouTube(asset, ctaUrl) {
  return {
    title: asset.title,
    description: renderLongFormText(asset, ctaUrl),
  };
}

function renderEmail(asset, ctaUrl) {
  return {
    subject: asset.title,
    preheader: asset.claim,
    text: renderLongFormText(asset, ctaUrl),
  };
}

const CHANNEL_ADAPTERS = Object.freeze(
  [
    ["blog", "owned", renderBlog],
    ["x", "social", renderX],
    ["linkedin", "social", renderLinkedIn],
    ["youtube", "video", renderYouTube],
    ["email", "email", renderEmail],
  ].map(([channel, medium, render]) =>
    Object.freeze({ channel, medium, render }),
  ),
);

function assetContext(catalog, asset) {
  const campaignId = `activation-${asset.id}`;
  const evidence = Object.freeze({
    sourceDocument: `docs/public/${catalog.locale}/${asset.sourceDocument}.mdx`,
    sourceUrl: new URL(
      `/${catalog.locale}/${asset.sourceDocument}`,
      PUBLIC_ORIGIN,
    ).toString(),
    poster: `docs/public/images/${asset.scenarioId}.png`,
    video: `docs/public/videos/${asset.scenarioId}.webm`,
    scenarioId: asset.scenarioId,
  });
  return Object.freeze({
    ...asset,
    campaignId,
    ctaUrl: new URL(catalog.ctaPath, PUBLIC_ORIGIN).toString(),
    evidence,
  });
}

function compileAsset(catalog, sourceAsset) {
  const asset = assetContext(catalog, sourceAsset);
  return Object.freeze({
    id: asset.id,
    version: asset.version,
    campaignId: asset.campaignId,
    evidence: asset.evidence,
    channels: Object.freeze(
      CHANNEL_ADAPTERS.map((adapter) => channelDraft(asset, adapter)),
    ),
  });
}

/** Compiles reviewed source references into deterministic, unapproved drafts. */
export function compileActivationBundle(
  value,
  { lookupScenario = scenarioById } = {},
) {
  const catalog = normalizeCatalog(value, lookupScenario);
  return Object.freeze({
    schemaVersion: 1,
    documentType: "activation_draft_bundle",
    locale: catalog.locale,
    assets: Object.freeze(
      catalog.assets.map((asset) => compileAsset(catalog, asset)),
    ),
  });
}
