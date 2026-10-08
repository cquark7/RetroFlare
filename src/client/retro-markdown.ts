import { BOARD_COLUMN_IDS } from "../shared/constants";
import { compareCardsInColumnOrder, type Card, type Retro } from "../shared/domain";

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\x5B\x5D()#+.!|~>]/g, "\\$&");
}

function singleLine(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]+/g, " "));
}

function messageCell(card: Card | undefined): string {
  if (!card) return "—";
  const author = singleLine(card.authorDisplayName);
  const text = card.text
    ? escapeMarkdown(card.text).replace(/\r\n|\r|\n/g, "<br>")
    : "(empty note)";
  return `**${author}:** ${text}`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(value));
}

export function retroToMarkdown(retro: Retro): string {
  const cards = Object.values(retro.cards).sort(compareCardsInColumnOrder);
  const cardsByColumn = {
    "went-well": cards.filter((card) => card.columnId === "went-well"),
    "could-improve": cards.filter((card) => card.columnId === "could-improve"),
    shoutouts: cards.filter((card) => card.columnId === "shoutouts")
  };
  const rowCount = Math.max(1, ...BOARD_COLUMN_IDS.map((columnId) => cardsByColumn[columnId].length));
  const rows = Array.from({ length: rowCount }, (_, index) =>
    `| ${messageCell(cardsByColumn["went-well"][index])} | ${messageCell(cardsByColumn["could-improve"][index])} | ${messageCell(cardsByColumn.shoutouts[index])} |`
  );

  const participants = Object.values(retro.participants)
    .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt) || left.displayName.localeCompare(right.displayName))
    .map((participant) => singleLine(participant.displayName))
    .join(", ");
  const team = singleLine(retro.participants[retro.captainId]?.displayName ?? "Unknown");
  const actionItems = cards.filter((card) => card.columnId === "actions");
  const actionLines = actionItems.length > 0
    ? actionItems.map((card) => {
      const text = card.text
        ? escapeMarkdown(card.text).replace(/\r\n|\r|\n/g, "<br>")
        : "(empty action item)";
      const owner = card.actionOwnerName ? ` — **Owner:** ${singleLine(card.actionOwnerName)}` : "";
      return `- ${text}${owner}`;
    })
    : ["- No action items were recorded."];

  return `${[
    `# ${singleLine(retro.title)}`,
    "",
    "## Overview",
    "",
    `- **Date:** ${dateLabel(retro.createdAt)}`,
    `- **Team:** ${team}`,
    `- **Participants:** ${participants}`,
    "",
    "## Retrospective",
    "",
    "| Went well | Could improve | Shoutouts |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "### Action Items",
    "",
    ...actionLines
  ].join("\n")}\n`;
}
