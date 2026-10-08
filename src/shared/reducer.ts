import { isBoardColumn, type BoardColumnId } from "./constants";
import { compareCardsInColumnOrder, type Card, type ClosingState, type Retro } from "./domain";
import type { PersistedBoardEvent } from "./events";

export type EventReduction =
  | { status: "applied"; retro: Retro }
  | { status: "ignored"; retro: Retro }
  | { status: "resync-required"; retro: Retro };

function resultAfterEvent(
  retro: Retro,
  event: PersistedBoardEvent,
  changes: Partial<Retro>
): Retro {
  return {
    ...retro,
    ...changes,
    revision: event.revision,
    updatedAt: event.occurredAt
  };
}

function withCardUpdate(
  card: Card,
  text: string,
  actionOwnerName: string | null,
  version: number,
  updatedAt: string
): Card {
  const updatedCard: Card = { ...card, text, version, updatedAt };
  if (actionOwnerName === null) {
    delete updatedCard.actionOwnerName;
  } else {
    updatedCard.actionOwnerName = actionOwnerName;
  }
  return updatedCard;
}

function removeCardAndReactions(retro: Retro, cardId: string): Pick<Retro, "cards" | "reactions"> {
  const cards = { ...retro.cards };
  delete cards[cardId];

  const reactions = Object.fromEntries(
    Object.entries(retro.reactions)
      .map(([actorId, entries]) => [actorId, entries.filter((entry) => entry.cardId !== cardId)] as const)
      .filter(([, entries]) => entries.length > 0)
  );
  return { cards, reactions };
}

function orderedCardsInColumn(cards: Record<string, Card>, columnId: BoardColumnId): Card[] {
  return Object.values(cards).filter((card) => card.columnId === columnId).sort(compareCardsInColumnOrder);
}

function withColumnOrder(cards: Record<string, Card>, columnId: BoardColumnId, cardIds: string[]): void {
  for (const [sortOrder, cardId] of cardIds.entries()) {
    cards[cardId] = { ...cards[cardId]!, columnId, sortOrder };
  }
}

function closingForEvent(
  retro: Retro,
  generation: string
): ClosingState | undefined {
  if (retro.status !== "closing" || retro.closing?.generation !== generation) return undefined;
  return retro.closing;
}

export function reduceRetroEvent(retro: Retro, event: PersistedBoardEvent): EventReduction {
  if (event.retroId !== retro.id) return { status: "resync-required", retro };
  if (event.revision <= retro.revision) return { status: "ignored", retro };
  if (event.revision !== retro.revision + 1) {
    return { status: "resync-required", retro };
  }

  switch (event.type) {
    case "card.created": {
      if (retro.cards[event.card.id]) return { status: "resync-required", retro };
      const cards = { ...retro.cards, [event.card.id]: event.card };
      if (isBoardColumn(event.card.columnId)) {
        const columnId = event.card.columnId;
        const existing = orderedCardsInColumn(retro.cards, columnId);
        if (existing.some((card) => card.sortOrder !== undefined)) {
          withColumnOrder(cards, columnId, [...existing.map((card) => card.id), event.card.id]);
        }
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, { cards })
      };
    }
    case "card.updated": {
      const card = retro.cards[event.cardId];
      if (!card || event.version !== card.version + 1) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          cards: {
            ...retro.cards,
            [event.cardId]: withCardUpdate(
              card,
              event.text,
              event.actionOwnerName,
              event.version,
              event.updatedAt
            )
          }
        })
      };
    }
    case "card.deleted": {
      const card = retro.cards[event.cardId];
      if (!card || card.version !== event.deletedVersion) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, removeCardAndReactions(retro, event.cardId))
      };
    }
    case "card.moved": {
      const card = retro.cards[event.cardId];
      if (
        !card ||
        card.version + 1 !== event.version ||
        card.columnId !== event.fromColumnId ||
        (event.columnId !== "actions" && event.actionOwnerName !== null)
      ) {
        return { status: "resync-required", retro };
      }
      const cards = { ...retro.cards };
      const movedCard: Card = {
        ...card,
        columnId: event.columnId,
        version: event.version,
        updatedAt: event.updatedAt
      };
      if (event.actionOwnerName === null) {
        delete movedCard.actionOwnerName;
      } else {
        movedCard.actionOwnerName = event.actionOwnerName;
      }
      cards[event.cardId] = movedCard;
      if (isBoardColumn(event.columnId)) {
        const columnId = event.columnId;
        const destination = orderedCardsInColumn(retro.cards, columnId);
        if (destination.some((candidate) => candidate.sortOrder !== undefined)) {
          withColumnOrder(cards, columnId, [...destination.map((candidate) => candidate.id), event.cardId]);
        } else {
          delete cards[event.cardId]!.sortOrder;
        }
      } else {
        delete cards[event.cardId]!.sortOrder;
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          cards
        })
      };
    }
    case "card.reordered": {
      const card = retro.cards[event.cardId];
      const columnCards = orderedCardsInColumn(retro.cards, event.columnId);
      const expectedIds = new Set(columnCards.map((candidate) => candidate.id));
      if (
        !card ||
        card.columnId !== event.columnId ||
        event.orderedCardIds.length !== columnCards.length ||
        new Set(event.orderedCardIds).size !== expectedIds.size ||
        !event.orderedCardIds.every((cardId) => expectedIds.has(cardId)) ||
        columnCards.filter((candidate) => candidate.id !== event.cardId).some((candidate, index) =>
          candidate.id !== event.orderedCardIds.filter((cardId) => cardId !== event.cardId)[index]
        )
      ) {
        return { status: "resync-required", retro };
      }
      const cards = { ...retro.cards };
      withColumnOrder(cards, event.columnId, event.orderedCardIds);
      return { status: "applied", retro: resultAfterEvent(retro, event, { cards }) };
    }
    case "reaction.changed": {
      const matches = (entry: { cardId: string; emoji: string }) => entry.cardId === event.cardId && entry.emoji === event.emoji;
      const prior = retro.reactions[event.actorId] ?? [];
      const count = Object.values(retro.reactions).filter((entries) => entries.some(matches)).length;
      if (!retro.participants[event.actorId] || !retro.cards[event.cardId] ||
        prior.some(matches) === event.reacted || count + (event.reacted ? 1 : -1) !== event.reactionCount) {
        return { status: "resync-required", retro };
      }
      const next = event.reacted ? [...prior, { cardId: event.cardId, emoji: event.emoji }] : prior.filter((entry) => !matches(entry));
      const reactions = { ...retro.reactions };
      if (next.length) reactions[event.actorId] = next;
      else delete reactions[event.actorId];
      return { status: "applied", retro: resultAfterEvent(retro, event, { reactions }) };
    }
    case "participant.upserted": {
      const participant = retro.participants[event.participant.actorId];
      if (participant && participant.joinedAt !== event.participant.joinedAt) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          participants: {
            ...retro.participants,
            [event.participant.actorId]: event.participant
          }
        })
      };
    }
    case "captain.transferred": {
      if (
        retro.captainId !== event.audit.previousCaptainId ||
        event.captainId !== event.audit.newCaptainId ||
        !retro.participants[event.captainId]
      ) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          captainId: event.captainId,
          lifecycleAudit: [...retro.lifecycleAudit, event.audit]
        })
      };
    }
    case "captain.recovered": {
      if (
        retro.captainId !== event.audit.previousCaptainId ||
        event.captainId !== event.audit.recoveredCaptainId ||
        !retro.participants[event.captainId]
      ) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          captainId: event.captainId,
          lifecycleAudit: [...retro.lifecycleAudit, event.audit]
        })
      };
    }
    case "retro.closing.started": {
      if (retro.status !== "open") return { status: "resync-required", retro };
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          status: "closing",
          closing: event.closing
        })
      };
    }
    case "retro.closing.ready": {
      const closing = closingForEvent(retro, event.generation);
      if (!closing) return { status: "resync-required", retro };
      const captured = closing.requiredClients.find(
        (client) =>
          client.clientId === event.client.clientId && client.actorId === event.client.actorId
      );
      if (
        !captured ||
        closing.readyClients.some((client) => client.clientId === event.client.clientId) ||
        event.requiredCount !== closing.requiredClients.length ||
        event.readyCount !== closing.readyClients.length + 1
      ) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          closing: { ...closing, readyClients: [...closing.readyClients, event.client] }
        })
      };
    }
    case "retro.closing.cancelled": {
      if (!closingForEvent(retro, event.generation)) {
        return { status: "resync-required", retro };
      }
      const openRetro = { ...retro, status: "open" as const };
      delete openRetro.closing;
      return { status: "applied", retro: resultAfterEvent(openRetro, event, {}) };
    }
    case "retro.closing.deadline-reached": {
      const closing = closingForEvent(retro, event.generation);
      if (!closing || closing.deadline !== event.deadline || closing.deadlineReached) {
        return { status: "resync-required", retro };
      }
      return {
        status: "applied",
        retro: resultAfterEvent(retro, event, {
          closing: { ...closing, deadlineReached: true }
        })
      };
    }
    case "retro.closed": {
      if (!closingForEvent(retro, event.generation)) {
        return { status: "resync-required", retro };
      }
      const cards = { ...retro.cards };
      for (const cardId of event.removedEmptyCardIds) {
        if (!cards[cardId] || cards[cardId].text !== "") {
          return { status: "resync-required", retro };
        }
        delete cards[cardId];
      }
      const retainedReactions = Object.fromEntries(
        Object.entries(retro.reactions)
          .map(([actorId, entries]) => [actorId, entries.filter((entry) => !event.removedEmptyCardIds.includes(entry.cardId))] as const)
          .filter(([, entries]) => entries.length > 0)
      );
      const closedRetro = {
        ...retro,
        status: "closed" as const,
        closedAt: event.closedAt,
        cards,
        reactions: retainedReactions
      };
      delete closedRetro.closing;
      return {
        status: "applied",
        retro: resultAfterEvent(closedRetro, event, {
          lifecycleAudit: event.audit
            ? [...retro.lifecycleAudit, event.audit]
            : retro.lifecycleAudit
        })
      };
    }
  }
}
