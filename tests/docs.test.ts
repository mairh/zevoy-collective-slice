import { beforeAll, describe, expect, it } from "vitest";
import { TARGET_ROOT } from "../src/config";
import { chunkDocs, documentNodeId, incidentsFor, linkDocs, type ParsedDoc, parseDocs } from "../src/ingest/docs";
import { testEnv } from "./helpers";

const INCIDENT = "docs/incidents/2026-06-14-card-limit-rounding.md";
const PANEL = "component:src/ui/cards/CardSettingsPanel.tsx#CardSettingsPanel";

describe("institutional knowledge ingestion", () => {
  let docs: ParsedDoc[];

  beforeAll(async () => {
    docs = parseDocs(TARGET_ROOT);
    const { graph } = await testEnv();
    await linkDocs(docs, graph);
  });

  it("returns no docs for a repo without docs/", () => {
    expect(parseDocs(`${TARGET_ROOT}/src`)).toEqual([]);
  });

  it("reads front matter", () => {
    expect(docs.map((doc) => doc.path)).toContain(INCIDENT);
    const incident = docs.find((doc) => doc.path === INCIDENT);
    expect(incident).toMatchObject({
      title: "INC-2026-06-14 - Card monthly limit shown one cent low",
      kind: "incident",
      date: "2026-06-14",
      sensitivity: "internal",
    });
    const kinds = new Set(docs.map((doc) => doc.kind));
    expect(kinds).toEqual(new Set(["adr", "incident", "know-how"]));
  });

  it("chunks on ## heading boundaries, pinned to the document node", () => {
    const incident = docs.find((doc) => doc.path === INCIDENT);
    expect(incident?.sections.map((section) => section.heading)).toEqual([
      "INC-2026-06-14 - Card monthly limit shown one cent low",
      "Summary",
      "Timeline",
      "Root cause",
      "What broke last time this changed",
      "Follow-ups",
    ]);
    const chunks = chunkDocs(docs).filter((chunk) => chunk.sourceFile === INCIDENT);
    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) {
      expect(chunk.nodeId).toBe(documentNodeId(INCIDENT));
      expect(chunk.kind).toBe("incident");
    }
    expect(chunks.find((chunk) => chunk.symbol === "Root cause")?.text).toContain("## Root cause");
    expect(new Set(chunkDocs(docs).map((chunk) => chunk.id)).size).toBe(chunkDocs(docs).length);
  });

  it("links the incident to CardSettingsPanel, formatMoney, PATCH /cards/{id} and its owner", async () => {
    const { graph } = await testEnv();
    const node = await graph.getNode(documentNodeId(INCIDENT));
    expect(node).toMatchObject({ label: "Document", sourceFile: INCIDENT, props: { kind: "incident" } });
    const mentioned = (await graph.neighbors(documentNodeId(INCIDENT), { direction: "out", types: ["MENTIONS"] })).map(
      ({ node: target }) => target.id,
    );
    expect(mentioned).toEqual(
      expect.arrayContaining([
        PANEL,
        "function:src/lib/money.ts#formatMoney",
        "endpoint:PATCH /cards/{id}",
        "owner:@aino.virtanen",
      ]),
    );
    expect(mentioned).not.toContain("endpoint:GET /cards");
  });

  it("finds incidents and know-how for a node, newest first, excluding ADRs", async () => {
    const { graph } = await testEnv();
    const found = await incidentsFor(graph, PANEL);
    expect(found.map((doc) => doc.sourceFile)).toEqual(["docs/know-how/interview-aino-virtanen-cards.md", INCIDENT]);
    const forMoney = await incidentsFor(graph, "function:src/lib/money.ts#formatMoney");
    expect(forMoney.every((doc) => doc.props.kind !== "adr")).toBe(true);
  });
});
