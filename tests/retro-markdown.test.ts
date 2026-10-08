import { describe, expect, it } from "vitest";
import { retroToMarkdown } from "../src/client/retro-markdown";
import { cardId, makeRetro, timestamp } from "./fixtures";

const secondActorId = "actor:engineering-user-2";
const improveCardId = "00000000-0000-4000-8000-000000000005";
const actionCardId = "00000000-0000-4000-8000-000000000006";

describe("retroToMarkdown", () => {
  it("creates an attributed Confluence-friendly summary with action owners", () => {
    const retro = makeRetro({
      title: "Sprint | Retrospective",
      participants: {
        "actor:engineering-user-1": {
          actorId: "actor:engineering-user-1",
          displayName: "Avery",
          joinedAt: timestamp
        },
        [secondActorId]: {
          actorId: secondActorId,
          displayName: "Sam Patel",
          joinedAt: "2026-10-07T12:01:00.000Z"
        }
      },
      cards: {
        [cardId]: {
          ...makeRetro().cards[cardId]!,
          text: "Kept pages quiet | all week\nand shipped."
        },
        [improveCardId]: {
          ...makeRetro().cards[cardId]!,
          id: improveCardId,
          columnId: "could-improve",
          text: "Add rollout checks",
          authorId: secondActorId,
          authorDisplayName: "Sam Patel",
          createdAt: "2026-10-07T12:02:00.000Z"
        },
        [actionCardId]: {
          ...makeRetro().cards[cardId]!,
          id: actionCardId,
          columnId: "actions",
          text: "Document the handoff",
          actionOwnerName: "Sam Patel",
          createdAt: "2026-10-07T12:03:00.000Z"
        }
      }
    });

    const markdown = retroToMarkdown(retro);

    expect(markdown).toContain("# Sprint \\| Retrospective");
    expect(markdown).toContain("- **Date:** October 7, 2026");
    expect(markdown).toContain("- **Team:** Avery");
    expect(markdown).toContain("- **Participants:** Avery, Sam Patel");
    expect(markdown).toContain("| Went well | Could improve | Shoutouts |");
    expect(markdown).toContain("| **Avery:** Kept pages quiet \\| all week<br>and shipped\\. | **Sam Patel:** Add rollout checks | — |");
    expect(markdown).toContain("### Action Items\n\n- Document the handoff — **Owner:** Sam Patel");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("keeps empty reflection categories and action items clear", () => {
    const retro = makeRetro({ cards: {} });
    const markdown = retroToMarkdown(retro);

    expect(markdown).toContain("| — | — | — |");
    expect(markdown).toContain("- No action items were recorded.");
  });

  it("exports reflection messages in their saved card order", () => {
    const retro = makeRetro();
    const reorderedCardId = "00000000-0000-4000-8000-000000000007";
    retro.cards[cardId] = { ...retro.cards[cardId]!, sortOrder: 1 };
    retro.cards[reorderedCardId] = {
      ...retro.cards[cardId]!,
      id: reorderedCardId,
      text: "This note was moved to the top.",
      sortOrder: 0
    };

    const markdown = retroToMarkdown(retro);

    expect(markdown).toContain("| **Avery:** This note was moved to the top\\. | — | — |");
    expect(markdown).toContain("| **Avery:** Deploys were calm | — | — |");
  });
});
