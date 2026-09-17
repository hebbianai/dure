import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../paths.mjs";
import { compileActivationBundle } from "./activation-bundle.mjs";

// Synthetic claims exercise the compiler without importing private campaigns.
const catalog = {
  schemaVersion: 1,
  locale: "en",
  ctaPath: "/",
  assets: Array.from({ length: 8 }, (_, index) => ({
    id: `fixture-${index + 1}`,
    version: 1,
    title: `Fixture asset ${index + 1}`,
    claim: "Fixture-only claim.",
    proofPoints: ["Synthetic compiler input."],
    limitation: "Unit fixture; not evidence of product behavior.",
    scenarioId: "workspace-overview",
    sourceDocument: "quickstart",
  })),
};

describe("activation draft compiler", () => {
  it("projects eight evidence-bound atoms into five deterministic drafts", async () => {
    const first = compileActivationBundle(catalog);
    const second = compileActivationBundle(structuredClone(catalog));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      documentType: "activation_draft_bundle",
      locale: "en",
    });
    expect(first.assets).toHaveLength(8);

    const channelMedia = new Map([
      ["blog", "owned"],
      ["x", "social"],
      ["linkedin", "social"],
      ["youtube", "video"],
      ["email", "email"],
    ]);
    for (const asset of first.assets) {
      expect(asset.channels.map(({ channel }) => channel)).toEqual([
        "blog",
        "x",
        "linkedin",
        "youtube",
        "email",
      ]);
      expect(asset.evidence.sourceDocument).toMatch(
        /^docs\/public\/en\/[a-z0-9-]+\.mdx$/u,
      );
      expect(new URL(asset.evidence.sourceUrl)).toMatchObject({
        origin: "https://dureai.dev",
        search: "",
      });
      for (const evidencePath of [
        asset.evidence.sourceDocument,
        asset.evidence.poster,
        asset.evidence.video,
      ]) {
        expect((await lstat(resolve(repoRoot, evidencePath))).isFile()).toBe(
          true,
        );
      }
      for (const draft of asset.channels) {
        expect(draft.revision).toMatch(
          new RegExp(`^v${asset.version}-[a-f0-9]{64}$`, "u"),
        );
        expect(draft.cohortKey).toBe(
          `${asset.id}@${draft.revision}:${draft.channel}`,
        );
        expect(draft.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(draft.attribution).toMatchObject({
          campaign: asset.campaignId,
          content: draft.revision,
          medium: channelMedia.get(draft.channel),
          source: draft.channel,
        });
        const cta = new URL(draft.attribution.url);
        expect(cta.origin).toBe("https://dureai.dev");
        expect(cta.pathname).toBe("/");
        expect(cta.searchParams.get("utm_campaign")).toBe(
          `activation-${asset.id}`,
        );
        const content = JSON.stringify(draft.content);
        expect(content).toContain(asset.evidence.sourceUrl);
        expect(content).toContain(draft.attribution.url);
        expect(asset.evidence.sourceUrl).not.toBe(draft.attribution.url);
      }
    }

    const encoded = JSON.stringify(first);
    expect(encoded).not.toMatch(
      /review_required|\.beads|\/Users\/|marketing-labs\//u,
    );
  });

  it("binds exact channel copy and editorial versions to attribution", () => {
    const changedCopy = structuredClone(catalog);
    changedCopy.assets[0].claim += " Exact copy changed.";
    const revised = structuredClone(catalog);
    revised.assets[0].version += 1;
    const currentDraft = compileActivationBundle(catalog).assets[0].channels[0];
    const changedCopyDraft = compileActivationBundle(
      changedCopy,
    ).assets[0].channels[0];
    const revisedDraft = compileActivationBundle(revised).assets[0].channels[0];
    expect(changedCopyDraft.revision).not.toBe(currentDraft.revision);
    expect(changedCopyDraft.cohortKey).not.toBe(currentDraft.cohortKey);
    expect(changedCopyDraft.attribution.url).not.toBe(
      currentDraft.attribution.url,
    );
    expect(revisedDraft.cohortKey).not.toBe(currentDraft.cohortKey);
    expect(revisedDraft.attribution.url).not.toBe(currentDraft.attribution.url);
    expect(revisedDraft.attribution.campaign).toBe(
      currentDraft.attribution.campaign,
    );
  });

  it("binds campaign identity into otherwise identical channel copy", () => {
    const withCampaignVariant = structuredClone(catalog);
    const variant = structuredClone(withCampaignVariant.assets[0]);
    variant.id = `${variant.id}-variant`;
    withCampaignVariant.assets = [withCampaignVariant.assets[0], variant];
    const [original, changedCampaign] = compileActivationBundle(
      withCampaignVariant,
    ).assets.map((asset) => asset.channels[0]);
    expect(changedCampaign.attribution.campaign).not.toBe(
      original.attribution.campaign,
    );
    expect(changedCampaign.revision).not.toBe(original.revision);
  });

  it("parses unsafe catalog values once at the input boundary", () => {
    const unsafeDocument = structuredClone(catalog);
    unsafeDocument.assets[0].sourceDocument = "../private";
    expect(() => compileActivationBundle(unsafeDocument)).toThrow(
      "sourceDocument must be lowercase kebab-case",
    );

    const externalCta = structuredClone(catalog);
    externalCta.ctaPath = "https://example.com/";
    expect(() => compileActivationBundle(externalCta)).toThrow(
      "ctaPath must be an unparameterized dureai.dev path",
    );

    const unknownScenario = structuredClone(catalog);
    unknownScenario.assets[0].scenarioId = "not-a-scenario";
    expect(() => compileActivationBundle(unknownScenario)).toThrow(
      "is not in the media catalog",
    );
  });

  it("leaves platform-specific post admission to execution adapters", () => {
    const longDraft = structuredClone(catalog);
    longDraft.assets[0].claim = "x".repeat(281);
    const x = compileActivationBundle(longDraft).assets[0].channels.find(
      ({ channel }) => channel === "x",
    );
    expect(x.content.posts[0].length).toBe(281);
  });

});
