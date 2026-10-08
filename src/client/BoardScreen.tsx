import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { api, userSafeError } from "./api";
import { BoardController, statusLabel } from "./sync/board";
import type { BoardView } from "./sync/board";
import { Modal } from "./Modal";
import { FocusMusicPlayer } from "./FocusMusicPlayer";
import { GiphyOverlay } from "./GiphyOverlay";
import { downloadText, safeFilename } from "./download";
import { Icon, type IconName } from "./icons";
import { retroToMarkdown } from "./retro-markdown";
import { preferredName, rememberName } from "./HomeScreen";
import type { MeData } from "../shared/api";
import { BOARD_COLUMN_IDS, isBoardColumn, REACTION_EMOJIS, LIMITS, type ColumnId, type ReactionEmoji } from "../shared/constants";
import { compareCardsInColumnOrder, type Card, type Retro } from "../shared/domain";
import type { AutosaveStatus } from "./sync/autosave";

const GiphyPicker = lazy(() => import("./GiphyExperience").then((module) => ({ default: module.GiphyPicker })));
const GIPHY_CONFIGURED = Boolean(import.meta.env.VITE_GIPHY_API_KEY?.trim());

const COLUMN_DETAILS: Record<ColumnId, { title: string; prompt: string; icon: IconName }> = {
  "went-well": { title: "Went Well", prompt: "What helped us move forward?", icon: "trendUp" },
  "could-improve": { title: "Could Improve", prompt: "What got in our way?", icon: "circle" },
  shoutouts: { title: "Shoutouts", prompt: "Who made a difference? Give them a little love.", icon: "star" },
  actions: { title: "Action items", prompt: "What will we try next? Add an owner if helpful.", icon: "squareCheck" }
};

type InsertionPosition = "before" | "after";
type DropCue =
  | { kind: "card"; columnId: typeof BOARD_COLUMN_IDS[number]; cardId: string; position: InsertionPosition }
  | { kind: "end" | "column"; columnId: typeof BOARD_COLUMN_IDS[number] };

const REACTION_NAMES: Record<ReactionEmoji, string> = { "👍": "Thumbs up", "🎉": "Celebrate", "❤️": "Love", "😂": "Laugh", "💡": "Idea", "👀": "Eyes", "🙌": "High five", "🚀": "Rocket" };
const columnCollisionDetection: CollisionDetection = (args) => {
  const isPointerTarget = (collision: { id: string | number }) => {
    const id = String(collision.id);
    return id.startsWith("card-slot:") || id.startsWith("column-end:");
  };
  if (args.pointerCoordinates) {
    const collisions = pointerWithin(args);
    const preciseTarget = collisions.find(isPointerTarget);
    return preciseTarget ? [preciseTarget] : collisions;
  }
  const keyboardTargets = args.droppableContainers.filter((container) => {
    const id = String(container.id);
    return !container.disabled && (id.startsWith("card-drop:") || id.startsWith("column-end:") || BOARD_COLUMN_IDS.some((columnId) => columnId === id));
  });
  return closestCenter({ ...args, droppableContainers: keyboardTargets });
};

const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) return;
  event.preventDefault();
  if (["ArrowUp", "ArrowDown"].includes(event.code)) {
    const activeId = String(context.active?.id ?? "");
    const activeCard = [...document.querySelectorAll<HTMLElement>(".column-cards > [data-card-sortable='true']")]
      .find((element) => element.dataset.cardId === activeId);
    if (!activeCard) return undefined;
    const column = activeCard?.closest(".board-column");
    const columnCards = column ? [...column.querySelectorAll<HTMLElement>(".column-cards > [data-card-sortable='true']")] : [];
    const index = columnCards.indexOf(activeCard);
    const target = columnCards[index + (event.code === "ArrowDown" ? 1 : -1)]?.getBoundingClientRect();
    const activeRect = context.collisionRect;
    if (target && activeRect) {
      return {
        x: target.left + (target.width - activeRect.width) / 2,
        y: target.top + (target.height - activeRect.height) / 2
      };
    }
    if (event.code === "ArrowDown") {
      const endTarget = column?.querySelector<HTMLElement>(".column-end-dropzone")?.getBoundingClientRect();
      if (endTarget && activeRect) {
        return {
          x: endTarget.left + (endTarget.width - activeRect.width) / 2,
          y: endTarget.top + (endTarget.height - activeRect.height) / 2
        };
      }
    }
    return undefined;
  }
  const overColumn = context.over?.data.current?.columnId;
  const activeColumn = context.active?.data.current?.columnId;
  const current = BOARD_COLUMN_IDS.find((columnId) => columnId === overColumn)
    ?? BOARD_COLUMN_IDS.find((columnId) => columnId === activeColumn);
  const index = current ? BOARD_COLUMN_IDS.indexOf(current) : -1;
  const nextColumnId = BOARD_COLUMN_IDS[index + (event.code === "ArrowRight" ? 1 : -1)];
  const nextColumn = nextColumnId ? document.querySelector<HTMLElement>(`.board-column--${nextColumnId}`) : null;
  const next = nextColumn?.getBoundingClientRect();
  const active = context.collisionRect;
  if (next && active) return { x: next.left + next.width / 2 - active.width / 2, y: next.top + 80 };
  return undefined;
};

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(value));
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function avatarTone(actorId: string): number {
  return [...actorId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5;
}

function isRecent(timestamp: string, now: number): boolean {
  return now - Date.parse(timestamp) <= LIMITS.editingPresenceLeaseMs;
}

function editingNamesByCard(presenceList: BoardView["presence"], now: number): Map<string, string[]> {
  const editorsByCard = new Map<string, Map<string, string>>();
  for (const presence of presenceList) {
    if (!presence.connected || !presence.editing || !presence.cardId || !isRecent(presence.updatedAt, now)) continue;
    const editors = editorsByCard.get(presence.cardId) ?? new Map<string, string>();
    editors.set(presence.actorId, presence.displayName);
    editorsByCard.set(presence.cardId, editors);
  }
  return new Map([...editorsByCard].map(([cardId, editors]) => [cardId, [...editors.values()]]));
}

function participantPresence(presenceList: BoardView["presence"]) {
  const mostRecent = new Map<string, (typeof presenceList)[number]>();
  for (const entry of presenceList) {
    if (!entry.connected) continue;
    const previous = mostRecent.get(entry.actorId);
    if (!previous || entry.updatedAt > previous.updatedAt) mostRecent.set(entry.actorId, entry);
  }
  return mostRecent;
}

export function BoardWorkspace({
  retro,
  me,
  onHome,
  onController
}: {
  retro: Retro;
  me: MeData;
  onHome: () => void;
  onController: (controller: BoardController | undefined) => void;
}) {
  const [controller, setController] = useState<BoardController>();
  const [view, setView] = useState<BoardView>();

  useEffect(() => {
    let active = true;
    let instance: BoardController | undefined;
    let unsubscribe: (() => void) | undefined;
    queueMicrotask(() => {
      if (!active) return;
      // StrictMode probes effects with setup/cleanup/setup. Do not start a
      // WebSocket upgrade for a workspace that was already cleaned up.
      instance = new BoardController({
        retro,
        actorId: me.actorId,
        sessionExpiresAt: me.sessionExpiresAt
      });
      const current = instance;
      unsubscribe = current.subscribe(() => setView(current.view()));
      onController(current);
      setController(instance);
      setView(instance.view());
    });
    return () => {
      active = false;
      unsubscribe?.();
      instance?.close();
      onController(undefined);
    };
  }, [retro, me, onController]);

  if (!controller || !view) return <main className="board-loading"><span className="spinner" /> Opening your board…</main>;
  return <BoardContent controller={controller} view={view} me={me} onHome={onHome} />;
}

function BoardContent({ controller, view, me, onHome }: {
  controller: BoardController;
  view: BoardView;
  me: MeData;
  onHome: () => void;
}) {
  const { retro } = view;
  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState(retro.participants[me.actorId]?.displayName ?? me.displayName);
  const [nameSaving, setNameSaving] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [deleteCard, setDeleteCard] = useState<Card>();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [recoverCaptainId, setRecoverCaptainId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [giphyOpen, setGiphyOpen] = useState(false);
  const [draggedCardId, setDraggedCardId] = useState<string>();
  const [dropCue, setDropCue] = useState<DropCue>();
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates }));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const saveShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void controller.retryAll().catch((error: unknown) => controller.setError(error));
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [controller]);

  const presenceList = view.presence;
  const active = useMemo(() => participantPresence(presenceList), [presenceList]);
  const editingByCard = useMemo(() => editingNamesByCard(presenceList, now), [presenceList, now]);
  const isCaptain = retro.captainId === me.actorId;
  const canRecoverCaptain = me.isAdministrator && !isCaptain && retro.status !== "closed";
  const cards = useMemo(() => {
    const combined = { ...retro.cards, ...view.localCards };
    return Object.values(combined).sort(compareCardsInColumnOrder);
  }, [retro.cards, view.localCards]);
  const actionCards = cards.filter((card) => card.columnId === "actions");
  const draggedCard = cards.find((card) => card.id === draggedCardId);
  const pendingDraftCount = Object.values(view.drafts).filter((draft) => draft.status !== "saved").length;
  const pendingCommands = view.pendingCommands.length;
  const saveLabel = view.socketStatus === "auth-required"
    ? "Sign in again"
    : view.socketStatus === "offline"
      ? "Offline · drafts kept here"
      : pendingDraftCount > 0 || pendingCommands > 0
        ? Object.values(view.drafts).some((draft) => draft.status === "saving") ? "Saving" : "Unsaved changes"
        : "Saved to this board";

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setNameSaving(true);
    try {
      await controller.updateDisplayName(name.trim());
      rememberName(me.actorId, name.trim());
      setNameOpen(false);
    } catch (error) {
      controller.setError(error);
    } finally {
      setNameSaving(false);
    }
  };

  const navigateHome = async () => {
    setLeaving(true);
    try {
      const flushed = await controller.flushBeforeNavigation();
      if (flushed) onHome();
      else setLeaveOpen(true);
    } catch {
      setLeaveOpen(true);
    } finally {
      setLeaving(false);
    }
  };

  const confirmSavedContent = async () => {
    try {
      await controller.finishSavedContent();
      setForceOpen(false);
    } catch (error) {
      controller.setError(error);
    }
  };

  const exportBoard = async () => {
    try {
      const backup = await api.exportRetro(retro.id);
      downloadText(`${safeFilename(retro.title)}.json`, JSON.stringify(backup, null, 2), "application/json");
    } catch (error) {
      controller.setError(error);
    }
  };

  const downloadMarkdown = () => {
    downloadText(`${safeFilename(retro.title)}.md`, retroToMarkdown(retro), "text/markdown;charset=utf-8");
  };

  const retrySave = async () => {
    try {
      await controller.retryAll();
    } catch (error) {
      controller.setError(error);
    }
  };

  const creator = retro.participants[retro.captainId]?.displayName ?? "Team";
  const closing = retro.closing;
  const required = closing?.requiredClients.length ?? 0;
  const ready = closing?.readyClients.length ?? 0;
  const currentProgress = view.progress?.generation === closing?.generation ? view.progress : undefined;
  const missingClients = currentProgress?.missingClients ?? closing?.requiredClients.filter(
    (client) => !closing.readyClients.some((done) => done.clientId === client.clientId)
  ) ?? [];
  const actorsById = Object.fromEntries(Object.values(retro.participants).map((participant) => [participant.actorId, participant.displayName]));

  const moveCardTo = async (cardId: string, columnId: ColumnId) => {
    try {
      await controller.moveCard(cardId, columnId);
      setMoveAnnouncement(`Card moved to ${COLUMN_DETAILS[columnId].title}.`);
      window.requestAnimationFrame(() => document.getElementById(`move-card-${cardId}`)?.focus({ preventScroll: true }));
    } catch (error) {
      controller.setError(error);
    }
  };

  const updateDropCue = (next: DropCue | undefined) => setDropCue((current) => {
    if (!current || !next) return current === next ? current : next;
    if (current.kind === next.kind && current.columnId === next.columnId
      && (current.kind !== "card" || (next.kind === "card" && current.cardId === next.cardId && current.position === next.position))) {
      return current;
    }
    return next;
  });

  const reorderCardWithinColumn = async (cardId: string, targetCardId?: string, insertAfter = false) => {
    const card = cards.find((candidate) => candidate.id === cardId);
    if (!card || !isBoardColumn(card.columnId)) return;
    const orderedCardIds = cards
      .filter((candidate) => candidate.columnId === card.columnId && retro.cards[candidate.id])
      .map((candidate) => candidate.id);
    if (cardId === targetCardId) return;
    const reordered = orderedCardIds.filter((id) => id !== cardId);
    if (targetCardId === undefined) {
      reordered.push(cardId);
    } else {
      const targetIndex = reordered.indexOf(targetCardId);
      if (targetIndex < 0) return;
      reordered.splice(targetIndex + (insertAfter ? 1 : 0), 0, cardId);
    }
    if (orderedCardIds.every((id, index) => id === reordered[index])) return;
    try {
      await controller.reorderCards(cardId, reordered);
      setMoveAnnouncement(`Card reordered in ${COLUMN_DETAILS[card.columnId].title}.`);
      window.requestAnimationFrame(() => document.getElementById(`move-card-${cardId}`)?.focus({ preventScroll: true }));
    } catch (error) {
      controller.setError(error);
    }
  };

  const renderCard = (card: Card) => <BoardCard
    key={card.id}
    card={card}
    isLocal={!retro.cards[card.id]}
    controller={controller}
    view={view}
    actorId={me.actorId}
    isCaptain={isCaptain}
    readOnly={retro.status !== "open"}
    dropPosition={dropCue?.kind === "card" && dropCue.cardId === card.id ? dropCue.position : undefined}
    typingNames={editingByCard.get(card.id) ?? []}
    onDelete={() => setDeleteCard(card)}
  />;
  const dropTargetCard = dropCue?.kind === "card" ? cards.find((card) => card.id === dropCue.cardId) : undefined;
  const dragDestinationLabel = dropCue?.kind === "card" && dropTargetCard
    ? `Drop ${dropCue.position} ${dropTargetCard.authorDisplayName}’s card · ${COLUMN_DETAILS[dropCue.columnId].title}`
    : dropCue?.kind === "end"
      ? `Drop at end of ${COLUMN_DETAILS[dropCue.columnId].title}`
      : dropCue?.kind === "column"
        ? `Move to ${COLUMN_DETAILS[dropCue.columnId].title}`
        : "Drag to a column or between cards";

  return (
    <DndContext sensors={sensors} collisionDetection={columnCollisionDetection}
      onDragStart={({ active }) => {
        setDraggedCardId(String(active.id));
        updateDropCue(undefined);
      }}
      onDragOver={({ active, over }) => {
        if (!over) {
          updateDropCue(undefined);
          return;
        }
        const activeCard = cards.find((card) => card.id === String(active.id));
        const target = over.data.current as { kind?: string; cardId?: unknown; columnId?: unknown; position?: unknown } | undefined;
        const targetColumnId = BOARD_COLUMN_IDS.find((columnId) => columnId === target?.columnId || columnId === over.id);
        if (!activeCard || !targetColumnId) {
          updateDropCue(undefined);
        } else if (target?.kind === "column-end") {
          updateDropCue({ kind: "end", columnId: targetColumnId });
        } else if ((target?.kind === "card" || target?.kind === "card-slot") && typeof target.cardId === "string" && activeCard.columnId === targetColumnId) {
          const currentOrder = cards
            .filter((card) => card.columnId === targetColumnId && retro.cards[card.id])
            .map((card) => card.id);
          const sourceIndex = currentOrder.indexOf(activeCard.id);
          const targetIndex = currentOrder.indexOf(target.cardId);
          const position = target.kind === "card-slot" && (target.position === "before" || target.position === "after")
            ? target.position
            : targetIndex > sourceIndex ? "after" : "before";
          updateDropCue({
            kind: "card",
            columnId: targetColumnId,
            cardId: target.cardId,
            position
          });
        } else {
          updateDropCue({ kind: "column", columnId: targetColumnId });
        }
      }}
      onDragCancel={() => {
        setDraggedCardId(undefined);
        updateDropCue(undefined);
      }}
      onDragEnd={({ active, over }) => {
        setDraggedCardId(undefined);
        updateDropCue(undefined);
        const activeCard = cards.find((card) => card.id === String(active.id));
        if (!over) return;
        const target = over.data.current as { kind?: string; cardId?: unknown; columnId?: unknown; position?: unknown } | undefined;
        const targetColumnId = BOARD_COLUMN_IDS.find((columnId) => columnId === target?.columnId || columnId === over.id);
        if (!activeCard || !targetColumnId) return;
        if (target?.kind === "column-end") {
          if (activeCard.columnId === targetColumnId) void reorderCardWithinColumn(activeCard.id);
          else void moveCardTo(activeCard.id, targetColumnId);
        } else if ((target?.kind === "card" || target?.kind === "card-slot") && typeof target.cardId === "string") {
          if (activeCard.columnId === targetColumnId) {
            const currentOrder = cards
              .filter((card) => card.columnId === targetColumnId && retro.cards[card.id])
              .map((card) => card.id);
            const sourceIndex = currentOrder.indexOf(activeCard.id);
            const targetIndex = currentOrder.indexOf(target.cardId);
            const position = target.kind === "card-slot" && (target.position === "before" || target.position === "after")
              ? target.position
              : targetIndex > sourceIndex ? "after" : "before";
            void reorderCardWithinColumn(activeCard.id, target.cardId, position === "after");
          } else {
            void moveCardTo(activeCard.id, targetColumnId);
          }
        } else if (activeCard.columnId === targetColumnId) {
          void reorderCardWithinColumn(activeCard.id);
        } else {
          void moveCardTo(activeCard.id, targetColumnId);
        }
      }}
      accessibility={{ screenReaderInstructions: { draggable: "Press Space to pick up a card. Use Left or Right to change columns, Up or Down to reorder within a column, Space to drop, or Escape to cancel." } }}>
    <main className="board-page">
      <header className="board-heading">
        <button className="back-link" type="button" onClick={() => void navigateHome()} disabled={leaving}>
          <Icon name="arrowLeft" size={15} /> All retros
        </button>
        <div className="board-heading__main">
          <h1>{retro.title}</h1>
          <div className="board-heading__detail">
            <span className={`status-tag ${retro.status === "closed" ? "status-tag--quiet" : retro.status === "closing" ? "status-tag--closing" : "status-tag--open"}`}>
              {retro.status === "open" ? "In progress" : retro.status === "closing" ? "Finishing together" : "Completed"}
            </span>
          </div>
        </div>
        <div className="board-heading__actions">
          <details className="participants-details">
            <summary className="people-summary" aria-label={`${Object.keys(retro.participants).length} participants, ${[...active.keys()].length} online. Expand participant list.`}>
              <span className="people-strip__faces" aria-hidden="true">
                {Object.values(retro.participants).slice(0, 5).map((person) => <span key={person.actorId} className={`avatar avatar--${avatarTone(person.actorId)} ${active.has(person.actorId) ? "avatar--online" : "avatar--away"}`} title={person.displayName}>{initials(person.displayName)}</span>)}
                {Object.keys(retro.participants).length > 5 && <span className="avatar avatar--extra">+{Object.keys(retro.participants).length - 5}</span>}
              </span>
              <span className="people-summary__text">{[...active.keys()].length} of {Object.keys(retro.participants).length} online</span>
              <span className="details-chevron" aria-hidden="true"><Icon name="chevronDown" size={14} /></span>
            </summary>
            <div className="people-details__content" role="group" aria-label="Participant presence">
              <p className="people-details__title">In this retro</p>
              {Object.values(retro.participants).map((person) => {
                const presence = active.get(person.actorId);
                const isCaptainParticipant = person.actorId === retro.captainId;
                const presenceDescription = [presence ? "online" : "offline", isCaptainParticipant ? "captain" : ""].filter(Boolean).join(", ");
                return <span className={`person-name ${presence ? "person-name--online" : ""}`} key={person.actorId} aria-label={`${person.displayName}, ${presenceDescription}`} title={presenceDescription}>
                  <span className={`avatar avatar--small avatar--${avatarTone(person.actorId)}`} aria-hidden="true">{initials(person.displayName)}</span>
                  <span className="person-name__label">{person.displayName}</span>
                  {isCaptainParticipant && <span className="captain-mark" title="Retro captain">captain</span>}
                  <span className="person-name__dot" aria-hidden="true" />
                </span>;
              })}
            </div>
          </details>
          <button className="button button--quiet" type="button" onClick={() => setActionsOpen(true)}><Icon name="squareCheck" size={16} /> Action items <span className="toolbar-count">{actionCards.length}</span></button>
          {isCaptain && retro.status === "open" && <button className="button button--primary" type="button" onClick={() => setFinishOpen(true)}>Finish retro</button>}
        </div>
      </header>

      <div className="board-utility" role="group" aria-label="Board status and controls">
        <details className="board-tools">
          <summary>Board menu <span className="details-chevron" aria-hidden="true"><Icon name="chevronDown" size={14} /></span></summary>
          <div className="captain-tools">
            <p className="board-menu-meta">{dateLabel(retro.createdAt)}<br />Hosted by {creator}</p>
            {retro.status === "open" && <button className="button button--quiet" type="button" onClick={() => { setName(retro.participants[me.actorId]?.displayName ?? me.displayName); setNameOpen(true); }}>Change display name</button>}
            <button className="button button--quiet" type="button" onClick={() => void exportBoard()}>Export board</button>
            <button className="button button--quiet" type="button" onClick={downloadMarkdown}>Download as Markdown</button>
            {isCaptain && retro.status === "open" && <label className="captain-tool">
              <span>Captain</span>
              <select aria-label="Transfer captain responsibility" value="" onChange={(event) => {
                const nextId = event.currentTarget.value;
                if (nextId) void controller.transferCaptain(nextId).catch((error: unknown) => controller.setError(error));
              }}>
                <option value="">Transfer responsibility…</option>
                {Object.values(retro.participants).filter((participant) => participant.actorId !== retro.captainId).map((participant) => <option key={participant.actorId} value={participant.actorId}>{participant.displayName}</option>)}
              </select>
            </label>}
            {canRecoverCaptain && <label className="captain-tool captain-tool--recovery">
              <span>Administrator recovery</span>
              <span className="captain-tool__inline">
                <select aria-label="Choose replacement captain" value={recoverCaptainId} onChange={(event) => setRecoverCaptainId(event.currentTarget.value)}>
                  <option value="">Choose a participant…</option>
                  {Object.values(retro.participants).filter((participant) => participant.actorId !== retro.captainId).map((participant) => <option key={participant.actorId} value={participant.actorId}>{participant.displayName}</option>)}
                </select>
                <button className="text-button" type="button" disabled={!recoverCaptainId} onClick={() => {
                  const selected = recoverCaptainId;
                  void controller.recoverCaptain(selected, "Administrator recovery").then(() => setRecoverCaptainId("")).catch((error: unknown) => controller.setError(error));
                }}>Recover</button>
              </span>
            </label>}
          </div>
        </details>
        {retro.status === "open" && GIPHY_CONFIGURED && <button
          className="button button--quiet giphy-share-trigger"
          type="button"
          aria-label="Send a GIF or sticker"
          onClick={() => setGiphyOpen(true)}
        ><Icon name="sparkles" size={15} /> GIFs</button>}
        {retro.status !== "closed" && <span className="board-utility__divider" aria-hidden="true" />}
        {retro.status !== "closed" && <FocusMusicPlayer key={me.actorId} actorId={me.actorId} />}
        <div className={`connection-note ${view.socketStatus === "connected" ? "connection-note--online" : view.socketStatus === "auth-required" ? "connection-note--warning" : "connection-note--offline"}`} aria-live="polite">
          <span className="connection-note__dot" /> {retro.status === "closed" ? "Read-only history" : saveLabel}
        </div>
      </div>

      {view.authExpiring && <div className="notice notice--warning" role="alert">
        <span>Your sign-in is ending soon. Changes are being saved where possible.</span>
        <button className="text-button" type="button" onClick={() => window.location.reload()}>Sign in again</button>
      </div>}
      {view.actionError && <div className="notice notice--error" role="alert">
        <span>{view.actionError}</span>
        <button className="icon-button" type="button" aria-label="Dismiss message" onClick={() => controller.dismissError()}><Icon name="x" size={15} /></button>
      </div>}

      {retro.status === "closing" && <section className={`closing-panel ${closing?.deadlineReached ? "closing-panel--late" : ""}`} aria-live="polite">
        <div className="closing-panel__symbol" aria-hidden="true"><Icon name="sparkles" size={16} /></div>
        <div className="closing-panel__copy">
          <h2>{closing?.deadlineReached ? "A few edits didn’t make it back" : "Gathering everyone’s last changes"}</h2>
          <p>{ready} of {required} connected {required === 1 ? "tab has" : "tabs have"} confirmed their saved changes. The board stays open until the captain chooses what to do.</p>
          {closing?.deadlineReached && missingClients.length > 0 && <p className="closing-panel__missing">
            Still waiting on: {missingClients.map((client) => actorsById[client.actorId] ?? "A participant").filter((name, index, all) => all.indexOf(name) === index).join(", ")}.
          </p>}
        </div>
        {isCaptain && closing?.deadlineReached && <div className="closing-panel__actions">
          <button className="button button--secondary" type="button" onClick={() => void controller.retryFinish().catch((error: unknown) => controller.setError(error))}>Retry sync</button>
          <button className="button button--quiet" type="button" onClick={() => void controller.cancelFinish().catch((error: unknown) => controller.setError(error))}>Cancel finish</button>
          <button className="button button--danger-quiet" type="button" onClick={() => setForceOpen(true)}>Finish with saved content</button>
        </div>}
      </section>}

      <section className={`board-columns ${retro.status === "closed" ? "board-columns--closed" : ""}`} aria-label="Retrospective columns">
        {BOARD_COLUMN_IDS.map((columnId) => {
          const columnCards = cards.filter((card) => card.columnId === columnId);
          return <ReflectionColumn key={columnId} columnId={columnId} disabled={retro.status !== "open"} isDropDestination={dropCue?.columnId === columnId}>
            <header className="column-heading">
              <div className="column-heading__top">
                <span className="column-icon" aria-hidden="true"><Icon name={COLUMN_DETAILS[columnId].icon} size={17} /></span>
                <h2>{COLUMN_DETAILS[columnId].title}</h2>
                <span className="column-count">{columnCards.length}</span>
              </div>
              <p>{COLUMN_DETAILS[columnId].prompt}</p>
            </header>
            {retro.status === "open" && <button className="add-card-button" type="button" onClick={() => controller.addCard(columnId)}>
              <Icon name="plus" size={15} /> {columnId === "shoutouts" ? "Add a shoutout" : "Add a card"}
            </button>}
            <div className="column-cards">
              {columnCards.length === 0 && <div className="column-empty"><span className="column-empty__mark" aria-hidden="true"><Icon name={COLUMN_DETAILS[columnId].icon} size={20} /></span><strong>{columnId === "went-well" ? "Make room for the good stuff" : columnId === "could-improve" ? "A little honesty goes a long way" : "Good work deserves a shoutout"}</strong><span>{retro.status === "open" ? "Add the first thought. Others will follow." : "No notes were added here."}</span></div>}
              {columnCards.map(renderCard)}
              {draggedCard && <ColumnEndDropTarget columnId={columnId} />}
            </div>
          </ReflectionColumn>;
        })}
      </section>

      <Modal open={actionsOpen} onClose={() => setActionsOpen(false)} title="Action items" description="Turn the conversation into a next step. Add actions here and choose an owner." size="wide">
        <div className="action-items-panel__content">
          <p>{COLUMN_DETAILS.actions.prompt}</p>
          <div className="action-items-panel__cards">
            {actionCards.length === 0 && <p className="column-empty">No action items yet. Add a concrete next step when the team is ready.</p>}
            {actionCards.map(renderCard)}
          </div>
          {retro.status === "open" && <button className="add-card-button" type="button" onClick={() => {
            setActionsOpen(true);
            controller.addCard("actions");
          }}><Icon name="plus" size={15} /> Add an action item</button>}
        </div>
      </Modal>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true">{moveAnnouncement}</span>

      {Object.keys(view.orphans).length > 0 && <section className="recovered-section" aria-labelledby="recovered-heading">
        <div className="recovered-section__heading">
          <span className="recovered-section__symbol" aria-hidden="true"><Icon name="rotateCcw" size={15} /></span>
          <div><h2 id="recovered-heading">Drafts kept on this device</h2><p>These notes were not part of the saved board. Copy or download them before leaving.</p></div>
        </div>
        <div className="recovered-list">
          {Object.entries(view.orphans).map(([cardId, draft]) => <RecoveredDraft key={cardId} cardId={cardId} text={draft.text} />)}
        </div>
      </section>}


      <Modal open={nameOpen} onClose={() => setNameOpen(false)} title="Your display name" description="This name appears beside your notes on this retro.">
        <form className="form-stack" onSubmit={(event) => void saveName(event)}>
          <label className="field-label" htmlFor="participant-name">Display name</label>
          <input id="participant-name" className="text-input" maxLength={LIMITS.displayNameCharacters} value={name} autoFocus required onChange={(event) => setName(event.currentTarget.value)} />
          <div className="modal__actions">
            <button className="button button--quiet" type="button" onClick={() => setNameOpen(false)}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={nameSaving || !name.trim()}>{nameSaving ? "Saving…" : "Update name"}</button>
          </div>
        </form>
      </Modal>

      <Modal open={finishOpen} onClose={() => setFinishOpen(false)} title="Finish this retro?" description="We’ll ask every connected editor to save first. The board won’t close until their latest notes are safely synced.">
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={() => setFinishOpen(false)}>Not yet</button>
          <button className="button button--primary" type="button" onClick={() => {
            setFinishOpen(false);
            void controller.prepareFinish().catch((error: unknown) => controller.setError(error));
          }}>Prepare to finish</button>
        </div>
      </Modal>

      <Modal open={forceOpen} onClose={() => setForceOpen(false)} title="Finish with saved content?" description="Some connected editors haven’t confirmed their changes. Their unsaved drafts will not be added to the completed board.">
        <div className="warning-callout"><strong>This can’t be undone.</strong><span>Anyone who is offline can still copy or download their draft when they return.</span></div>
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={() => setForceOpen(false)}>Keep waiting</button>
          <button className="button button--danger" type="button" onClick={() => void confirmSavedContent()}>Finish with saved content</button>
        </div>
      </Modal>

      <Modal open={Boolean(deleteCard)} onClose={() => setDeleteCard(undefined)} title="Delete this card?" description="This removes the note from the shared retro for everyone.">
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={() => setDeleteCard(undefined)}>Keep card</button>
          <button className="button button--danger" type="button" onClick={() => {
            if (!deleteCard) return;
            void controller.deleteCard(deleteCard.id).then(() => setDeleteCard(undefined)).catch((error: unknown) => controller.setError(error));
          }}>Delete card</button>
        </div>
      </Modal>

      <Modal open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Some notes are still unsaved" description="Your drafts are kept in this tab for up to 24 hours, but the team won’t see them until the connection returns.">
        <div className="modal__actions modal__actions--spread">
          <button className="button button--quiet" type="button" onClick={() => setLeaveOpen(false)}>Stay on board</button>
          <button className="button button--secondary" type="button" onClick={() => void retrySave().then(() => { setLeaveOpen(false); onHome(); }).catch((error: unknown) => controller.setError(error))}>Retry saving</button>
          <button className="button button--danger-quiet" type="button" onClick={() => { controller.retainDrafts(); setLeaveOpen(false); onHome(); }}>Keep draft &amp; leave</button>
        </div>
      </Modal>
      {giphyOpen && <Suspense fallback={<Modal open onClose={() => setGiphyOpen(false)} title="Pick a GIF or sticker" description="Loading the GIPHY picker…"><p className="field-hint">Loading results…</p></Modal>}>
        <GiphyPicker
          open
          onClose={() => setGiphyOpen(false)}
          onSelect={(media) => controller.shareGiphy(media)}
        />
      </Suspense>}
      </main>
      <GiphyOverlay shares={view.giphyShares} />
      <DragOverlay dropAnimation={null}>{draggedCard && <div className="drag-card-preview" aria-hidden="true">
        <div className="drag-card-preview__eyebrow"><Icon name="grip" size={13} /> Moving card</div>
        <div className="drag-card-preview__identity">
          <span className={`avatar avatar--small avatar--${avatarTone(draggedCard.authorId)}`}>{initials(draggedCard.authorDisplayName)}</span>
          <span>{draggedCard.authorDisplayName}</span>
        </div>
        <p>{controller.textFor(draggedCard) || "Empty note"}</p>
        <strong className="drag-card-preview__destination">{dragDestinationLabel}</strong>
      </div>}</DragOverlay>
    </DndContext>
  );
}

function ReflectionColumn({ columnId, disabled, isDropDestination, children }: { columnId: ColumnId; disabled: boolean; isDropDestination: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId, disabled, data: { kind: "column", columnId } });
  return <div ref={setNodeRef} className={`board-column board-column--${columnId} ${isOver || isDropDestination ? "board-column--drop-target" : ""}`}>{children}</div>;
}

function ColumnEndDropTarget({ columnId }: { columnId: typeof BOARD_COLUMN_IDS[number] }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-end:${columnId}`,
    data: { kind: "column-end", columnId }
  });
  return <div ref={setNodeRef} className={`column-end-dropzone ${isOver ? "column-end-dropzone--over" : ""}`} aria-hidden="true">
    Drop at end of list
  </div>;
}

function BoardCard({
  card,
  isLocal,
  controller,
  view,
  actorId,
  isCaptain,
  readOnly,
  dropPosition,
  typingNames,
  onDelete
}: {
  card: Card;
  isLocal: boolean;
  controller: BoardController;
  view: BoardView;
  actorId: string;
  isCaptain: boolean;
  readOnly: boolean;
  dropPosition?: InsertionPosition;
  typingNames: string[];
  onDelete: () => void;
}) {
  const ownerInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const [ownerSaving, setOwnerSaving] = useState(false);
  const author = card.authorId === actorId;
  const editable = author && !readOnly;
  const canMove = (author || isCaptain) && !readOnly && !isLocal && card.columnId !== "actions";
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: card.id, disabled: !canMove, data: { columnId: card.columnId } });
  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({
    id: `card-drop:${card.id}`,
    data: { kind: "card", cardId: card.id, columnId: card.columnId },
    disabled: readOnly || isLocal || isDragging || card.columnId === "actions"
  });
  const { setNodeRef: setBeforeSlotRef } = useDroppable({
    id: `card-slot:${card.id}:before`,
    data: { kind: "card-slot", cardId: card.id, columnId: card.columnId, position: "before" },
    disabled: readOnly || isLocal || isDragging || card.columnId === "actions"
  });
  const { setNodeRef: setAfterSlotRef } = useDroppable({
    id: `card-slot:${card.id}:after`,
    data: { kind: "card-slot", cardId: card.id, columnId: card.columnId, position: "after" },
    disabled: readOnly || isLocal || isDragging || card.columnId === "actions"
  });
  const setCardNodeRef = useCallback((element: HTMLElement | null) => {
    setNodeRef(element);
    setDropNodeRef(element);
  }, [setNodeRef, setDropNodeRef]);
  const draft = view.drafts[card.id];
  const text = controller.textFor(card);
  const cardError = controller.errorFor(card.id);
  useEffect(() => {
    if (isLocal) {
      textInput.current?.focus({ preventScroll: true });
      textInput.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isLocal]);
  useLayoutEffect(() => {
    const element = textInput.current;
    if (!element) return;
    let width = -1;
    const resize = () => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      element.style.height = "0px";
      element.style.height = `${element.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    const parent = element.parentElement;
    if (parent) observer.observe(parent, { box: "content-box" });
    return () => observer.disconnect();
  }, [text]);

  const updateOwner = async () => {
    const ownerDraft = ownerInput.current?.value ?? card.actionOwnerName ?? "";
    if (ownerDraft.trim() === (card.actionOwnerName ?? "")) return;
    setOwnerSaving(true);
    try {
      await controller.setActionOwner(card.id, ownerDraft.trim());
      if (ownerInput.current) ownerInput.current.value = ownerDraft.trim();
    } catch (error) {
      controller.setError(error);
    } finally {
      setOwnerSaving(false);
    }
  };

  const status: AutosaveStatus | undefined = draft?.status ?? (isLocal ? "saving" : "saved");
  const unsynced = Boolean(draft && draft.status !== "saved") || isLocal;

  return (
    <article
      ref={setCardNodeRef}
      className={`idea-card ${isLocal ? "idea-card--draft" : ""} ${draft?.status === "conflict" ? "idea-card--conflict" : ""} ${isDragging ? "idea-card--dragging" : ""} ${isOver ? "idea-card--drop-target" : ""} ${dropPosition ? `idea-card--drop-${dropPosition}` : ""}`}
      data-card-id={card.id}
      data-card-sortable={!isLocal && !readOnly && card.columnId !== "actions" ? "true" : undefined}
    >
      <div ref={setBeforeSlotRef} className="idea-card__drop-zone idea-card__drop-zone--before" aria-hidden="true" />
      <div ref={setAfterSlotRef} className="idea-card__drop-zone idea-card__drop-zone--after" aria-hidden="true" />
      <div className="idea-card__topline">
        {canMove && <button
          id={`move-card-${card.id}`}
          className="card-drag-handle"
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag to move ${card.authorDisplayName}’s card`}
          title="Drag to reorder here or move to another column."
        ><Icon name="grip" size={14} /><span>Drag</span></button>}
        <span className={`avatar avatar--small avatar--${avatarTone(card.authorId)}`} aria-hidden="true">{initials(card.authorDisplayName)}</span>
        <span className="idea-card__author"><span className="idea-card__author-name">{card.authorDisplayName}</span>{author ? <span className="you-mark">you</span> : null}</span>
        {editable && <div className="idea-card__topline-actions">
          <span className={`save-state save-state--${status ?? "saved"} idea-card__save-state`} aria-live="polite">
            <span className="save-state__dot" /> {statusLabel(status)}
          </span>
          {!isLocal && <button className="icon-button idea-card__delete" type="button" aria-label="Delete this card" title="Delete card" onClick={onDelete}><Icon name="x" size={15} /></button>}
        </div>}
      </div>
      <label className="visually-hidden" htmlFor={`card-${card.id}`}>Card text by {card.authorDisplayName}</label>
      {editable && <span id={`card-keyboard-help-${card.id}`} className="visually-hidden">Press Enter to save this card. Press Shift+Enter to insert a new line.</span>}
      <textarea
        ref={textInput}
        id={`card-${card.id}`}
        className="idea-card__text"
        value={text}
        placeholder={editable ? "Add a thought…" : "This card has no text."}
        title={editable ? "Enter saves. Shift+Enter adds a new line." : undefined}
        aria-describedby={editable ? `card-keyboard-help-${card.id}` : undefined}
        aria-keyshortcuts={editable ? "Enter Shift+Enter" : undefined}
        maxLength={LIMITS.cardTextCharacters}
        readOnly={!editable}
        rows={1}
        onChange={(event) => controller.editCard(card.id, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (!editable || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        onCompositionStart={() => controller.compositionStart(card.id)}
        onCompositionEnd={(event) => controller.compositionEnd(card.id, event.currentTarget.value)}
        onBlur={() => {
          if (editable) {
            controller.stopEditing(card.id);
            void controller.flushCard(card.id);
          }
        }}
      />
      {editable && <div className={`idea-card__editor-meta ${status !== "saved" ? "idea-card__editor-meta--pending" : ""}`}>
        <span className="idea-card__keyboard-hint" aria-hidden="true">Enter saves · Shift+Enter adds line</span>
        {status !== "saved" && <>
          {draft?.error && draft.status !== "conflict" && <button className="text-button card-retry-link" type="button" onClick={() => void controller.retryCard(card.id).catch((error: unknown) => controller.setError(error))}>Retry save</button>}
          <span className="idea-card__length">{text.length}/{LIMITS.cardTextCharacters}</span>
        </>}
      </div>}
      {typingNames.length > 0 && <div className="card-typing-indicator" aria-live="polite" aria-atomic="true">
        <span className="card-typing-indicator__dot" aria-hidden="true" />
        {typingNames.map((name) => <span className="card-typing-indicator__name" key={name}>{name} typing…</span>)}
      </div>}
      {card.columnId === "actions" && <div className="owner-row">
        <span className="owner-row__label">Owner</span>
        {editable ? <input
          key={`${card.id}:${card.version}`}
          ref={ownerInput}
          className="owner-input"
          aria-label="Action owner name"
          maxLength={LIMITS.actionOwnerNameCharacters}
          placeholder="Add an owner"
          defaultValue={card.actionOwnerName ?? ""}
          disabled={ownerSaving}
          onBlur={() => void updateOwner()}
        /> : <span className="owner-row__value">{card.actionOwnerName || "Unassigned"}</span>}
      </div>}
      {draft?.status === "conflict" && draft.conflict && <div className="conflict-panel">
        <p>This card was saved differently in another tab.</p>
        <div className="conflict-panel__saved"><span>Saved text</span><blockquote>{draft.conflict.savedText || "(empty card)"}</blockquote></div>
        {!readOnly && <div className="conflict-panel__actions">
          <button className="text-button" type="button" onClick={() => controller.useMyDraft(card.id)}>Use my draft</button>
          <button className="text-button text-button--muted" type="button" onClick={() => controller.keepSavedText(card.id)}>Keep saved text</button>
        </div>}
      </div>}
      {readOnly && unsynced && <div className="draft-recovery-note">
        <span>This device has an unsaved version.</span>
        <span className="draft-recovery-note__actions"><CopyButton text={text} /> <DownloadButton text={text} title={card.authorDisplayName} /></span>
      </div>}
      {cardError && <div className={`card-inline-message ${cardError === "Creating card…" ? "" : "card-inline-message--error"}`} role="status">
        <span>{cardError}</span>
        {!readOnly && isLocal && cardError !== "Creating card…" && <button className="text-button" type="button" onClick={() => void controller.retryCreate(card.id)}>Retry</button>}
        {!readOnly && !isLocal && <button className="text-button" type="button" onClick={() => void controller.retryCard(card.id).catch((error: unknown) => controller.setError(error))}>Retry save</button>}
      </div>}
      <div className="idea-card__actions">
        <CardReactions card={card} actorId={actorId} controller={controller} reactions={view.retro.reactions} readOnly={readOnly || isLocal} />
      </div>
    </article>
  );
}

function CardReactions({ card, actorId, controller, reactions, readOnly }: {
  card: Card; actorId: string; controller: BoardController; reactions: Retro["reactions"]; readOnly: boolean;
}) {
  const pickerId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const selected = (emoji: ReactionEmoji) => (reactions[actorId] ?? []).some((entry) => entry.cardId === card.id && entry.emoji === emoji);
  const people = (emoji: ReactionEmoji) => Object.entries(reactions).filter(([, entries]) => entries.some((entry) => entry.cardId === card.id && entry.emoji === emoji))
    .map(([id]) => controller.view().retro.participants[id]?.displayName ?? "Participant");
  const react = async (emoji: ReactionEmoji) => {
    if (pending || readOnly) return;
    setPending(true);
    picker.current?.hidePopover();
    try { await controller.react(card.id, emoji, !selected(emoji)); }
    catch (error) { controller.setError(error); }
    finally { setPending(false); }
  };
  return <div className="card-reactions" role="group" aria-label={`Reactions to ${card.authorDisplayName}’s card`}>
    {REACTION_EMOJIS.map((emoji) => {
      const names = people(emoji);
      if (!names.length) return null;
      return <button key={emoji} type="button" className={`reaction-chip ${selected(emoji) ? "reaction-chip--selected" : ""}`}
        aria-label={`${REACTION_NAMES[emoji]}, ${names.length} ${names.length === 1 ? "reaction" : "reactions"}`} aria-pressed={selected(emoji)}
        title={`${REACTION_NAMES[emoji]} · ${names.join(", ")}`} disabled={readOnly || pending} onClick={() => void react(emoji)}>
        <span aria-hidden="true">{emoji}</span><span>{names.length}</span>
      </button>;
    })}
    {!readOnly && <>
      <button ref={trigger} className="reaction-add" type="button" popoverTarget={pickerId} disabled={pending} aria-label="Add a reaction" title="Add a reaction"><Icon name="smile" size={18} /><span aria-hidden="true"><Icon name="plus" size={8} /></span></button>
      <div id={pickerId} ref={picker} popover="auto" className="reaction-picker" aria-label="Choose a reaction"
        onToggle={(event) => {
          if (event.newState === "open") {
            const rect = trigger.current?.getBoundingClientRect();
            const element = picker.current;
            if (rect && element) {
              element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 300))}px`;
              element.style.top = `${rect.bottom + 8 + 132 > window.innerHeight ? Math.max(12, rect.top - 140) : rect.bottom + 8}px`;
              element.querySelector<HTMLButtonElement>("button")?.focus();
            }
          } else if (picker.current?.contains(document.activeElement)) trigger.current?.focus();
        }}>
        <p>A little reaction goes a long way</p>
        <div className="reaction-picker__grid">{REACTION_EMOJIS.map((emoji) => <button key={emoji} type="button" aria-label={REACTION_NAMES[emoji]} aria-pressed={selected(emoji)} title={REACTION_NAMES[emoji]} onClick={() => void react(emoji)}>{emoji}</button>)}</div>
      </div>
    </>}
  </div>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return <button className="text-button" type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>;
}

function DownloadButton({ text, title }: { text: string; title: string }) {
  return <button className="text-button" type="button" onClick={() => downloadText(`${safeFilename(title)}-draft.txt`, text, "text/plain;charset=utf-8")}>Download</button>;
}

function RecoveredDraft({ cardId, text }: { cardId: string; text: string }) {
  return <article className="recovered-card">
    <p>{text || <em>Empty draft</em>}</p>
    <span className="recovered-card__actions"><CopyButton text={text} /><DownloadButton text={text} title={`recovered-${cardId.slice(0, 8)}`} /></span>
  </article>;
}

export function JoinBoard({ retro, me, onJoined, onHome }: {
  retro: Retro;
  me: MeData;
  onJoined: (retro: Retro) => void;
  onHome: () => void;
}) {
  const [name, setName] = useState(() => preferredName(me.actorId, me.displayName));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string>();

  const join = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setJoining(true);
    setError(undefined);
    try {
      await api.joinRetro(retro.id, name.trim());
      rememberName(me.actorId, name.trim());
      onJoined(await api.retro(retro.id));
    } catch (joinError) {
      setError(userSafeError(joinError));
    } finally {
      setJoining(false);
    }
  };

  return <main className="join-page">
    <button className="back-link" type="button" onClick={onHome}><Icon name="arrowLeft" size={15} /> All retros</button>
    <section className="join-card">
      <div className="join-card__illustration" aria-hidden="true"><span><Icon name="trendUp" size={15} /></span><span><Icon name="circle" size={15} /></span><span><Icon name="squareCheck" size={15} /></span></div>
      <p className="eyebrow">You’re invited to reflect</p>
      <h1>{retro.title}</h1>
      <p className="join-card__copy">Choose the name your teammates will see beside your notes.</p>
      <form className="form-stack" onSubmit={(event) => void join(event)}>
        <label className="field-label" htmlFor="join-display-name">Display name</label>
        <input id="join-display-name" className="text-input" autoFocus autoComplete="name" maxLength={LIMITS.displayNameCharacters} required value={name} onChange={(event) => setName(event.currentTarget.value)} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button--primary button--large" type="submit" disabled={joining || !name.trim()}>{joining ? "Joining…" : "Join this retro"}</button>
      </form>
      <p className="join-card__privacy">Your identity is tied to your sign-in, not your display name.</p>
    </section>
  </main>;
}
